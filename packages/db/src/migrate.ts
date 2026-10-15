import { sql, type Kysely, type Transaction } from "kysely";
import { assertIdentifier } from "./helpers.ts";

export interface Migration {
  id: string;
  up(db: Transaction<any>, ctx: MigrationContext): Promise<void>;
}

export interface MigrationContext {
  schema: string;
  env: NodeJS.ProcessEnv;
}

export interface MigrationStatus {
  applied: { id: string; applied_at: Date }[];
  pending: string[];
}

export class PendingMigrationsError extends Error {
  readonly pending: string[];
  constructor(service: string, pending: string[]) {
    super(
      `${pending.length} pending migration(s) for ${service} (${pending.join(", ")}) and migrations.auto_apply is false. ` +
        `Run: docker compose run --rm ${service} qtiauth migrate up`,
    );
    this.pending = pending;
  }
}

function lockKey(schema: string): string {
  return `qtiauth:migrate:${schema}`;
}

async function ensureTable(db: Kysely<any> | Transaction<any>, schema: string): Promise<void> {
  const exists = await sql<{ n: number }>`select count(*)::int as n from information_schema.schemata where schema_name = ${schema}`.execute(db);
  if (!exists.rows[0]?.n) await sql`create schema ${sql.id(schema)}`.execute(db);
  await sql`create table if not exists ${sql.id(schema, "qtiauth_migrations")} (id text primary key, applied_at timestamptz not null default now())`.execute(db);
}

function validate(migrations: Migration[]): void {
  const seen = new Set<string>();
  let prev = "";
  for (const m of migrations) {
    if (seen.has(m.id)) throw new Error(`Duplicate migration id ${m.id}`);
    if (m.id <= prev) throw new Error(`Migrations must be ordered: ${m.id} after ${prev}`);
    seen.add(m.id);
    prev = m.id;
  }
}

export async function migrationStatus(db: Kysely<any>, schema: string, migrations: Migration[]): Promise<MigrationStatus> {
  assertIdentifier(schema);
  validate(migrations);
  const exists = await sql<{ exists: boolean }>`select to_regclass(${`${schema}.qtiauth_migrations`}) is not null as exists`.execute(db);
  const applied = exists.rows[0]?.exists
    ? (await sql<{ id: string; applied_at: Date }>`select id, applied_at from ${sql.id(schema, "qtiauth_migrations")} order by id`.execute(db)).rows
    : [];
  const ids = new Set(applied.map((r) => r.id));
  return { applied, pending: migrations.filter((m) => !ids.has(m.id)).map((m) => m.id) };
}

export async function migrateUp(
  db: Kysely<any>,
  schema: string,
  migrations: Migration[],
  log: (msg: string, data?: Record<string, unknown>) => void = () => undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  assertIdentifier(schema);
  validate(migrations);
  const ran: string[] = [];
  await db.connection().execute(async (conn) => {
    await sql`select pg_advisory_lock(hashtext(${lockKey(schema)}))`.execute(conn);
    try {
      await ensureTable(conn, schema);
      const appliedRows = await sql<{ id: string }>`select id from ${sql.id(schema, "qtiauth_migrations")}`.execute(conn);
      const applied = new Set(appliedRows.rows.map((r) => r.id));
      for (const m of migrations) {
        if (applied.has(m.id)) continue;
        const started = Date.now();
        await conn.transaction().execute(async (trx) => {
          await sql`set local search_path to ${sql.id(schema)}, public`.execute(trx);
          await m.up(trx, { schema, env });
          await sql`insert into ${sql.id(schema, "qtiauth_migrations")} (id) values (${m.id})`.execute(trx);
        });
        ran.push(m.id);
        log("migration applied", { schema, migration: m.id, ms: Date.now() - started });
      }
    } finally {
      await sql`select pg_advisory_unlock(hashtext(${lockKey(schema)}))`.execute(conn);
    }
  });
  return ran;
}
