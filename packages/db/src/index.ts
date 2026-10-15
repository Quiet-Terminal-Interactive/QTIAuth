import pg from "pg";
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { assertIdentifier } from "./helpers.ts";

export { sql, Kysely };
export type { Transaction };

pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => v);

export interface DbOptions {
  url: string;
  schema: string;
  max?: number;
  applicationName?: string;
  role?: string;
}

export interface Database<DB> {
  db: Kysely<DB>;
  pool: pg.Pool;
  schema: string;
  close(): Promise<void>;
}

export function createDb<DB>(opts: DbOptions): Database<DB> {
  const schema = assertIdentifier(opts.schema);
  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? `qtiauth-${schema}`,
    options: `-c search_path=${schema},public${opts.role ? ` -c role=${assertIdentifier(opts.role)}` : ""}`,
  });
  pool.on("error", () => undefined);
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  return {
    db,
    pool,
    schema,
    async close() {
      await db.destroy();
    },
  };
}

export type AnyDb = Kysely<any>;
export type Executor<DB = any> = Kysely<DB> | Transaction<DB>;

export * from "./migrate.ts";
export * from "./outbox.ts";
export * from "./helpers.ts";
