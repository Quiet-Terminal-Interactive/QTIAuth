import { mkdir, readdir, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import type { Config } from "@qtiauth/config";

export interface LedgerEntry {
  user_id: string;
  deleted_at: string;
}

export interface LedgerStore {
  write(entry: LedgerEntry): Promise<void>;
  list(): Promise<LedgerEntry[]>;
  remove(userId: string): Promise<void>;
}

class VolumeLedger implements LedgerStore {
  private readonly dir: string;
  constructor(root: string) {
    this.dir = join(root, "deletion-ledger");
  }
  async write(entry: LedgerEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${entry.user_id}.json`), JSON.stringify(entry));
  }
  async list(): Promise<LedgerEntry[]> {
    try {
      await stat(this.dir);
    } catch {
      return [];
    }
    const out: LedgerEntry[] = [];
    for (const f of await readdir(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        out.push(JSON.parse(await readFile(join(this.dir, f), "utf8")) as LedgerEntry);
      } catch {
        continue;
      }
    }
    return out;
  }
  async remove(userId: string): Promise<void> {
    await rm(join(this.dir, `${userId}.json`), { force: true });
  }
}

class S3Ledger implements LedgerStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  constructor(d: Config["backups"]["destination"]) {
    this.client = new S3Client({
      region: d.region,
      forcePathStyle: d.force_path_style,
      ...(d.endpoint ? { endpoint: d.endpoint } : {}),
      credentials: { accessKeyId: d.access_key_id ?? "", secretAccessKey: d.secret_access_key ?? "" },
    });
    this.bucket = d.bucket ?? "qtiauth-backups";
    this.prefix = `${d.prefix.replace(/\/?$/, "/")}deletion-ledger/`;
  }
  async write(entry: LedgerEntry): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${entry.user_id}.json`, Body: JSON.stringify(entry), ContentType: "application/json" }));
  }
  async list(): Promise<LedgerEntry[]> {
    const out: LedgerEntry[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) {
        if (!o.Key) continue;
        const body = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: o.Key }));
        out.push(JSON.parse(await body.Body!.transformToString()) as LedgerEntry);
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async remove(userId: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: `${this.prefix}${userId}.json` }));
  }
}

export function ledgerStore(cfg: Config): LedgerStore {
  const d = cfg.backups.destination;
  return d.type === "s3" ? new S3Ledger(d) : new VolumeLedger(d.path);
}
