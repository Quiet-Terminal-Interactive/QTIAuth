#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { createLogger } from "@qtiauth/common";
import { ConfigError, defaultConfigPath, loadConfig, resolveSurfaces, type LoadedConfig, type ServiceName } from "@qtiauth/config";
import { createDb, migrateUp, migrationStatus } from "@qtiauth/db";
import { bootContext, createValkey, ledgerStore, type CliCommand, type CliContext, type ServiceContext, type ServiceDefinition } from "@qtiauth/service-kit";

type Loader = () => Promise<ServiceDefinition<any>>;

export const SERVICE_LOADERS: Partial<Record<ServiceName, Loader>> = {
  identity: async () => (await import("@qtiauth/identity")).identityService,
  notifier: async () => (await import("@qtiauth/notifier")).notifierService,
  oidc: async () => (await import("@qtiauth/oidc")).oidcService,
  safety: async () => (await import("@qtiauth/safety")).safetyService,
  support: async () => (await import("@qtiauth/support")).supportService,
  games: async () => (await import("@qtiauth/games")).gamesService,
  scheduler: async () => (await import("@qtiauth/scheduler")).schedulerService,
  backup: async () => (await import("@qtiauth/backup")).backupService,
};

interface Opts {
  service: ServiceName | null;
  configPath: string;
  args: string[];
}

function parseArgs(argv: string[]): Opts {
  const args: string[] = [];
  let service = (process.env.QTIAUTH_SERVICE as ServiceName | undefined) ?? null;
  let configPath = defaultConfigPath();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--service") service = argv[++i] as ServiceName;
    else if (a.startsWith("--service=")) service = a.slice(10) as ServiceName;
    else if (a === "--config") configPath = resolve(argv[++i]!);
    else if (a.startsWith("--config=")) configPath = resolve(a.slice(9));
    else args.push(a);
  }
  return { service, configPath, args };
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function loadDefs(only: ServiceName | null): Promise<ServiceDefinition<any>[]> {
  const names = only ? [only] : (Object.keys(SERVICE_LOADERS) as ServiceName[]);
  const out: ServiceDefinition<any>[] = [];
  for (const n of names) {
    const loader = SERVICE_LOADERS[n];
    if (loader) out.push(await loader());
  }
  return out;
}

function databaseUrl(def: ServiceDefinition<any>): string {
  const url = process.env.DATABASE_URL ?? process.env[`${def.name.toUpperCase()}_DATABASE_URL`];
  if (!url) throw new Error(`DATABASE_URL is not set for ${def.name}`);
  return url;
}

async function configCheck(o: Opts): Promise<number> {
  let cfg: LoadedConfig;
  try {
    cfg = loadConfig(o.configPath);
  } catch (err) {
    if (err instanceof ConfigError) {
      print(err.message);
      return 1;
    }
    throw err;
  }
  const problems: string[] = [];
  try {
    const { compileSchedule } = await import("@qtiauth/scheduler");
    compileSchedule(cfg.schedule);
  } catch (err) {
    problems.push((err as Error).message);
  }
  try {
    const { TemplateStore } = await import("@qtiauth/notifier/templates");
    const r = await new TemplateStore(cfg, resolveSurfaces(cfg)).load();
    print(`Email templates: ${r.loaded} loaded, ${r.overrides} overridden.`);
  } catch (err) {
    problems.push(`Email templates: ${(err as Error).message}`);
  }
  if (problems.length) {
    print(`Configuration has problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    return 1;
  }
  print(`Configuration OK: ${cfg.configPath}`);
  return 0;
}

async function migrate(o: Opts, up: boolean): Promise<number> {
  const defs = (await loadDefs(o.service === null || (o.service as string) === "all" ? null : o.service)).filter((d) => d.schema);
  if (!defs.length) {
    print("No service with a database schema selected. Use --service <name> or --service all.");
    return 2;
  }
  const log = createLogger("cli", process.env.LOG_LEVEL ?? "warn");
  let pending = 0;
  for (const def of defs) {
    const database = createDb({ url: databaseUrl(def), schema: def.schema!, max: 1 });
    try {
      if (up) {
        const ran = await migrateUp(database.db, def.schema!, def.migrations ?? [], (msg, data) => log.info(data ?? {}, msg));
        print(`${def.name}: ${ran.length ? `applied ${ran.join(", ")}` : "up to date"}`);
      } else {
        const s = await migrationStatus(database.db, def.schema!, def.migrations ?? []);
        pending += s.pending.length;
        print(`${def.name}: ${s.applied.length} applied, ${s.pending.length} pending${s.pending.length ? ` (${s.pending.join(", ")})` : ""}`);
      }
    } finally {
      await database.close();
    }
  }
  return !up && pending ? 3 : 0;
}

async function backupRestore(o: Opts, cfg: LoadedConfig): Promise<number> {
  const id = o.args[0];
  if (!id || !o.args.includes("--yes")) {
    print("Usage: qtiauth backup restore <id> --yes\nThis replaces live data. The stack is put into maintenance mode while it runs.");
    return 2;
  }
  const lib = await import("@qtiauth/backup/lib");
  const { backupDatabaseUrl } = await import("@qtiauth/backup");
  const manifest = await lib.readManifest(cfg, id);
  const url = backupDatabaseUrl();
  const valkey = createValkey(cfg.infrastructure.valkey_url);
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const defs = await loadDefs(null);
  let ctx: ServiceContext | null = null;
  try {
    print("1/6 Entering maintenance mode");
    if (valkey.status !== "ready") await new Promise<void>((resolve, reject) => {
      valkey.once("ready", () => resolve());
      setTimeout(() => reject(new Error("Valkey is unreachable")), 10_000).unref();
    });
    await valkey.set("qtiauth:maintenance", id);
    print("2/6 Restoring schemas");
    for (const s of manifest.schemas) {
      const dump = await lib.readSchemaDump(cfg, manifest, s.name);
      await lib.restoreSchema(cfg, url, s.name, dump, { drop: async (schema) => void (await pool.query(`drop schema if exists "${schema.replace(/"/g, "")}" cascade`)) });
      print(`    ${s.name} restored`);
    }
    print("3/6 Running migrations for the current service versions");
    for (const def of defs.filter((d) => d.schema && manifest.schemas.some((s) => s.name === d.schema))) {
      const own = process.env.DATABASE_URL ?? process.env[`${def.name.toUpperCase()}_DATABASE_URL`];
      const database = own ? createDb({ url: own, schema: def.schema!, max: 1 }) : createDb({ url, schema: def.schema!, max: 1, role: def.schema! });
      try {
        const ran = await migrateUp(database.db, def.schema!, def.migrations ?? []);
        print(`    ${def.name}: ${ran.length ? ran.join(", ") : "up to date"}`);
      } finally {
        await database.close();
      }
    }
    const identity = defs.find((d) => d.name === "identity")!;
    ctx = await bootContext({ ...identity, schema: undefined, migrations: [] }, { config: cfg, skipMigrations: true, log: createLogger("cli", "warn") });
    const entries = await ledgerStore(cfg).list();
    print(`4/6 Replaying the deletion ledger (${entries.length} entries)`);
    const { replayed } = await ctx.rpc<{ replayed: string[] }>("identity.replay_deletion_ledger", { entries }, { timeoutMs: 600_000 });
    if (replayed.length) {
      print(`    re-erasing ${replayed.length} user(s) found in the restored data`);
      const deadline = Date.now() + 15 * 60_000;
      for (;;) {
        const { pending } = await ctx.rpc<{ pending: string[] }>("identity.erasure_pending", { user_ids: replayed });
        if (!pending.length) break;
        if (Date.now() > deadline) throw new Error(`${pending.length} erasures did not complete; check that every service is running`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    print("5/6 Revoking every restored session and binding");
    const { revoked } = await ctx.rpc<{ revoked: number }>("identity.revoke_restored_sessions", {});
    print(`    ${revoked} session(s) revoked`);
    print("6/6 Clearing caches and leaving maintenance mode");
    await valkey.flushdb();
    print(`Restore of ${id} complete.`);
    return 0;
  } catch (err) {
    print(`Restore FAILED: ${(err as Error).message}\nThe stack is still in maintenance mode. Fix the problem and run the restore again.`);
    return 1;
  } finally {
    await pool.end();
    valkey.disconnect();
    if (ctx) {
      await ctx.bus.close().catch(() => undefined);
      ctx.valkey.disconnect();
      await ctx.database?.close();
    }
  }
}

const BUILTIN: Record<string, { description: string; usage?: string }> = {
  "config check": { description: "Validate qtiauth.yaml, the schedule and the email templates without starting anything" },
  "config schema": { description: "Write the configuration JSON Schema", usage: "qtiauth config schema [out.json]" },
  "migrate status": { description: "Show applied and pending migrations", usage: "qtiauth migrate status [--service <name>|all]" },
  "migrate up": { description: "Apply pending migrations", usage: "qtiauth migrate up [--service <name>|all]" },
  "backup restore": { description: "Restore a backup onto the live stack (maintenance mode, ledger replay, session revocation)", usage: "qtiauth backup restore <id> --yes" },
};

async function help(o: Opts): Promise<number> {
  print("qtiauth <command> [--service <name>] [--config <path>]\n");
  for (const [name, c] of Object.entries(BUILTIN)) print(`  ${name.padEnd(18)} ${c.description}`);
  for (const def of await loadDefs(o.service)) {
    for (const [name, c] of Object.entries(def.cli ?? {})) print(`  ${name.padEnd(18)} ${c.description}${o.service ? "" : ` [${def.name}]`}`);
  }
  return 0;
}

async function serviceCommand(o: Opts, cfg: LoadedConfig): Promise<number> {
  const defs = await loadDefs(o.service);
  for (const n of [2, 1]) {
    const name = o.args.slice(0, n).join(" ");
    const owners = defs.filter((d) => d.cli?.[name]);
    if (!owners.length) continue;
    if (owners.length > 1) {
      print(`"${name}" exists in ${owners.map((d) => d.name).join(" and ")}; pass --service.`);
      return 2;
    }
    const def = owners[0]!;
    const cmd: CliCommand = def.cli![name]!;
    const booted: ServiceContext[] = [];
    const cli: CliContext = {
      config: cfg,
      log: createLogger("cli", process.env.LOG_LEVEL ?? "warn"),
      service: def.name,
      async boot() {
        const ctx = await bootContext(def, { config: cfg, skipMigrations: true, log: createLogger(def.name, "warn") });
        booted.push(ctx);
        return ctx;
      },
      print,
    };
    try {
      return (await cmd.run(o.args.slice(n), cli)) ?? 0;
    } finally {
      for (const ctx of booted) {
        await ctx.bus.close().catch(() => undefined);
        ctx.valkey.disconnect();
        await ctx.database?.close();
      }
    }
  }
  print(`Unknown command: ${o.args.join(" ")}. Run qtiauth help.`);
  return 2;
}

export async function cli(argv: string[]): Promise<number> {
  const o = parseArgs(argv);
  const cmd = o.args.slice(0, 2).join(" ");
  if (!o.args.length || o.args[0] === "help" || o.args[0] === "--help") return help(o);
  if (cmd === "config check") return configCheck(o);
  if (cmd === "config schema") {
    const { writeFileSync } = await import("node:fs");
    const { configJsonSchema } = await import("@qtiauth/config");
    const out = resolve(o.args[2] ?? "config/qtiauth.schema.json");
    writeFileSync(out, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
    print(`Wrote ${out}`);
    return 0;
  }
  if (cmd === "migrate status") return migrate(o, false);
  if (cmd === "migrate up") return migrate(o, true);
  let cfg: LoadedConfig;
  try {
    cfg = loadConfig(o.configPath);
  } catch (err) {
    print(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (cmd === "backup restore") return backupRestore({ ...o, args: o.args.slice(2) }, cfg);
  return serviceCommand(o, cfg);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      print(err instanceof Error ? (err.stack ?? err.message) : String(err));
      process.exit(1);
    });
}
