import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { decodeKey, decryptStream, deriveSubkey, encryptStream, humanCode, sha256, type Logger } from "@qtiauth/common";
import type { Config } from "@qtiauth/config";
import type { Storage } from "@qtiauth/service-kit";

export const SCHEMAS = ["identity", "notify", "oidc", "safety", "support", "games"] as const;

export interface BackupManifest {
  id: string;
  created_at: string;
  qtiauth_version: string;
  schemas: { name: string; file: string; bytes: number; sha256: string }[];
  storage_manifest: { file: string; objects: number; bytes: number; sha256: string } | null;
  format: 1;
}

export interface BackupStore {
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  listIds(): Promise<string[]>;
  deleteBackup(id: string): Promise<void>;
}

class VolumeStore implements BackupStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  async put(key: string, body: Buffer): Promise<void> {
    const p = join(this.root, key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body, { mode: 0o600 });
  }
  async get(key: string): Promise<Buffer> {
    return readFile(join(this.root, key));
  }
  async listIds(): Promise<string[]> {
    try {
      await stat(this.root);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const d of await readdir(this.root)) {
      try {
        await stat(join(this.root, d, "manifest.json"));
        out.push(d);
      } catch {
        continue;
      }
    }
    return out.sort();
  }
  async deleteBackup(id: string): Promise<void> {
    await rm(join(this.root, id), { recursive: true, force: true });
  }
}

class S3Store implements BackupStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  constructor(d: Config["backups"]["destination"]) {
    this.client = new S3Client({ region: d.region, forcePathStyle: d.force_path_style, ...(d.endpoint ? { endpoint: d.endpoint } : {}), credentials: { accessKeyId: d.access_key_id ?? "", secretAccessKey: d.secret_access_key ?? "" } });
    this.bucket = d.bucket ?? "qtiauth-backups";
    this.prefix = d.prefix.replace(/\/?$/, "/");
  }
  async put(key: string, body: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.prefix + key, Body: body }));
  }
  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  async listIds(): Promise<string[]> {
    const ids = new Set<string>();
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) {
        const rest = o.Key?.slice(this.prefix.length) ?? "";
        if (rest.endsWith("/manifest.json")) ids.add(rest.split("/")[0]!);
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return [...ids].sort();
  }
  async deleteBackup(id: string): Promise<void> {
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: `${this.prefix}${id}/`, ContinuationToken: token }));
      const keys = (r.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys } }));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }
}

export function backupStore(cfg: Config): BackupStore {
  const d = cfg.backups.destination;
  return d.type === "s3" ? new S3Store(d) : new VolumeStore(d.path);
}

export function backupKey(cfg: Config): Buffer {
  const m = cfg.secrets.backup_encryption_key ?? cfg.backups.encryption_key;
  if (!m) throw new Error("BACKUP_ENCRYPTION_KEY is not set; backups cannot be written or read");
  return deriveSubkey(decodeKey(m), "backups");
}

export function newBackupId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${humanCode(4, 0, "abcdefghjkmnpqrstuvwxyz23456789")}`;
}

export function run(cmd: string, args: string[], input?: Buffer, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${cmd} exited with ${code}: ${Buffer.concat(err).toString().slice(0, 2000)}`));
    });
    if (input) p.stdin.end(input);
    else p.stdin.end();
  });
}

function pgEnv(url: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const u = new URL(url);
  return {
    args: ["--host", u.hostname, "--port", u.port || "5432", "--username", decodeURIComponent(u.username), "--dbname", u.pathname.slice(1)],
    env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password) },
  };
}

export async function existingSchemas(query: (sql: string, params: unknown[]) => Promise<{ rows: { schema_name: string }[] }>): Promise<string[]> {
  const r = await query("select schema_name from information_schema.schemata where schema_name = any($1)", [[...SCHEMAS]]);
  return SCHEMAS.filter((s) => r.rows.some((x) => x.schema_name === s));
}

export interface RunBackupInput {
  cfg: Config;
  databaseUrl: string;
  schemas: string[];
  storage: Storage | null;
  log: Logger;
  version: string;
}

export async function runBackup(input: RunBackupInput): Promise<BackupManifest> {
  const { cfg, databaseUrl, log } = input;
  const key = backupKey(cfg);
  const store = backupStore(cfg);
  const id = newBackupId();
  const manifest: BackupManifest = { id, created_at: new Date().toISOString(), qtiauth_version: input.version, schemas: [], storage_manifest: null, format: 1 };
  const pg = pgEnv(databaseUrl);
  for (const schema of input.schemas) {
    const dump = await run(cfg.backups.pg_dump_path, [...pg.args, "--format=custom", `--schema=${schema}`], undefined, pg.env);
    const enc = encryptStream(key, dump);
    const file = `${schema}.dump.enc`;
    await store.put(`${id}/${file}`, enc);
    manifest.schemas.push({ name: schema, file, bytes: enc.length, sha256: sha256(enc) });
    log.info({ id, schema, bytes: enc.length }, "schema backed up");
  }
  if (input.storage) {
    const objects = await input.storage.list("");
    const enc = encryptStream(key, Buffer.from(JSON.stringify({ bucket: input.storage.bucket, objects })));
    await store.put(`${id}/storage-manifest.json.enc`, enc);
    manifest.storage_manifest = { file: "storage-manifest.json.enc", objects: objects.length, bytes: objects.reduce((n, o) => n + o.size, 0), sha256: sha256(enc) };
  }
  await store.put(`${id}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)));
  return manifest;
}

export async function readManifest(cfg: Config, id: string): Promise<BackupManifest> {
  if (!/^[0-9TZ]+-[a-z0-9]{4}$/.test(id)) throw new Error(`Invalid backup id ${id}`);
  return JSON.parse((await backupStore(cfg).get(`${id}/manifest.json`)).toString()) as BackupManifest;
}

export async function readSchemaDump(cfg: Config, manifest: BackupManifest, schema: string): Promise<Buffer> {
  const entry = manifest.schemas.find((s) => s.name === schema);
  if (!entry) throw new Error(`Backup ${manifest.id} has no ${schema} schema`);
  const enc = await backupStore(cfg).get(`${manifest.id}/${entry.file}`);
  if (sha256(enc) !== entry.sha256) throw new Error(`Checksum mismatch for ${entry.file}`);
  return decryptStream(backupKey(cfg), enc);
}

export async function restoreSchema(cfg: Config, databaseUrl: string, schema: string, dump: Buffer, opts: { drop?: (schema: string) => Promise<void> } = {}): Promise<void> {
  if (opts.drop) await opts.drop(schema);
  const pg = pgEnv(databaseUrl);
  await run(cfg.backups.pg_restore_path, [...pg.args, "--exit-on-error", "--single-transaction"], dump, pg.env);
}

export async function pruneBackups(cfg: Config, log: Logger, now = Date.now()): Promise<string[]> {
  const store = backupStore(cfg);
  const removed: string[] = [];
  const ids = await store.listIds();
  for (const id of ids) {
    try {
      const m = await readManifest(cfg, id);
      if (now - new Date(m.created_at).getTime() > cfg.backups.retention) {
        await store.deleteBackup(id);
        removed.push(id);
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, id }, "could not read backup manifest during pruning");
    }
  }
  return removed;
}

export async function listBackups(cfg: Config): Promise<BackupManifest[]> {
  const out: BackupManifest[] = [];
  for (const id of await backupStore(cfg).listIds()) out.push(await readManifest(cfg, id).catch(() => ({ id, created_at: "unknown", qtiauth_version: "?", schemas: [], storage_manifest: null, format: 1 }) as BackupManifest));
  return out;
}
