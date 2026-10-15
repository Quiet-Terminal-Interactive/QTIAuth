import pg from "pg";
import { inc, observe, setGauge } from "@qtiauth/common";
import { EVENTS, makeEvent } from "@qtiauth/bus";
import { defineService, VERSION, type CliCommand, type ServiceContext } from "@qtiauth/service-kit";
import { existingSchemas, listBackups, pruneBackups, readManifest, readSchemaDump, restoreSchema, runBackup, type BackupManifest } from "./lib.ts";

export function backupDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.BACKUP_DATABASE_URL ?? env.DATABASE_URL;
  if (!url) throw new Error("BACKUP_DATABASE_URL (or DATABASE_URL) is not set for backup");
  return url;
}

async function withPool<T>(url: string, fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

export async function backupNow(ctx: ServiceContext): Promise<BackupManifest> {
  const url = backupDatabaseUrl();
  const started = performance.now();
  try {
    const schemas = await withPool(url, (pool) => existingSchemas((q, p) => pool.query(q, p)));
    const manifest = await runBackup({ cfg: ctx.config, databaseUrl: url, schemas, storage: ctx.storage, log: ctx.log, version: ctx.version });
    const bytes = manifest.schemas.reduce((n, s) => n + s.bytes, 0);
    inc("qtiauth_backup_runs_total", { result: "ok" }, 1, "Backup runs");
    setGauge("qtiauth_backup_last_success_timestamp_seconds", Date.now() / 1000, {}, "Time of the last successful backup");
    setGauge("qtiauth_backup_last_size_bytes", bytes, {}, "Size of the last backup");
    await ctx.bus.publishEvent(makeEvent(EVENTS.backupCompleted, { backup_id: manifest.id, schemas: manifest.schemas.map((s) => s.name), bytes }, { subject: { type: "backup", id: manifest.id }, actor: { type: "system", id: "backup" } }));
    const removed = await pruneBackups(ctx.config, ctx.log);
    ctx.log.info({ id: manifest.id, bytes, pruned: removed.length }, "backup complete");
    return manifest;
  } catch (err) {
    inc("qtiauth_backup_runs_total", { result: "error" }, 1, "Backup runs");
    await ctx.bus.publishEvent(makeEvent(EVENTS.backupFailed, { error: (err as Error).message.slice(0, 500) }, { subject: { type: "backup", id: "run" }, actor: { type: "system", id: "backup" } })).catch(() => undefined);
    throw err;
  } finally {
    observe("qtiauth_backup_run_seconds", (performance.now() - started) / 1000, {}, [10, 60, 300, 900, 1800, 3600], "Backup duration");
  }
}

export async function verifyBackup(ctx: { config: ServiceContext["config"] }, id: string, print: (l: string) => void): Promise<boolean> {
  const manifest = await readManifest(ctx.config, id);
  const url = new URL(backupDatabaseUrl());
  const scratch = `qtiauth_verify_${Date.now()}`;
  await withPool(url.toString(), (pool) => pool.query(`create database ${scratch}`));
  const scratchUrl = new URL(url.toString());
  scratchUrl.pathname = `/${scratch}`;
  let ok = true;
  try {
    for (const s of manifest.schemas) {
      try {
        const dump = await readSchemaDump(ctx.config, manifest, s.name);
        await restoreSchema(ctx.config, scratchUrl.toString(), s.name, dump);
        const counts = await withPool(scratchUrl.toString(), async (pool) => {
          const tables = await pool.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE'", [s.name]);
          const migrations = await pool.query<{ n: string }>(`select count(*) as n from "${s.name}".qtiauth_migrations`);
          return { tables: tables.rows.length, migrations: Number(migrations.rows[0]?.n ?? 0) };
        });
        print(`  ${s.name}: OK (${counts.tables} tables, ${counts.migrations} migrations applied)`);
      } catch (err) {
        ok = false;
        print(`  ${s.name}: FAILED ${(err as Error).message}`);
      }
    }
  } finally {
    await withPool(url.toString(), (pool) => pool.query(`drop database if exists ${scratch} with (force)`)).catch(() => undefined);
  }
  return ok;
}

const cli: Record<string, CliCommand> = {
  "backup run": {
    description: "Take a backup now",
    async run(_args, c) {
      const ctx = await c.boot();
      const m = await backupNow(ctx);
      c.print(`Backup ${m.id} written (${m.schemas.map((s) => s.name).join(", ")}).`);
      return 0;
    },
  },
  "backup list": {
    description: "List backups at the destination",
    async run(_args, c) {
      const rows = await listBackups(c.config);
      if (!rows.length) c.print("No backups.");
      for (const m of rows) c.print(`${m.id}\t${m.created_at}\t${m.qtiauth_version}\t${m.schemas.map((s) => s.name).join(",")}\t${m.schemas.reduce((n, s) => n + s.bytes, 0)} bytes`);
      return 0;
    },
  },
  "backup verify": {
    description: "Restore a backup into a scratch database and check it, without touching the live stack",
    usage: "qtiauth backup verify <id>",
    async run(args, c) {
      const id = args[0];
      if (!id) return 2;
      c.print(`Verifying ${id}:`);
      const ok = await verifyBackup(c, id, c.print);
      c.print(ok ? "Backup verified." : "Backup verification FAILED.");
      return ok ? 0 : 1;
    },
  },
};

export const backupService = defineService({
  name: "backup",
  version: VERSION,
  cron: {
    "backup.run": async (ctx) => {
      await backupNow(ctx);
    },
  },
  async healthWarnings(ctx) {
    const w = [];
    if (!ctx.config.secrets.backup_encryption_key && !ctx.config.backups.encryption_key) w.push({ code: "NO_BACKUP_KEY", severity: "error" as const, message: "BACKUP_ENCRYPTION_KEY is not set, so backups cannot run." });
    const latest = (await listBackups(ctx.config).catch(() => [])).at(-1);
    if (!latest || Date.now() - new Date(latest.created_at).getTime() > 2 * 86_400_000) w.push({ code: "BACKUP_STALE", severity: "warning" as const, message: latest ? `The last backup is from ${latest.created_at}.` : "No backups have been taken yet." });
    return w;
  },
  cli,
});
