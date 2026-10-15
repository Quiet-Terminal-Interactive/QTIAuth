import { sql, type Kysely, type Transaction, type RawBuilder } from "kysely";

export function json<T>(value: T): RawBuilder<T> {
  return sql<T>`${JSON.stringify(value)}::jsonb`;
}

export function textArray(values: string[]): RawBuilder<string[]> {
  return sql<string[]>`${values}::text[]`;
}

export async function withTransaction<DB, T>(db: Kysely<DB>, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
  return db.transaction().execute(fn);
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === "23505" && (!constraint || e.constraint === constraint);
}

export async function ping(db: Kysely<any>): Promise<void> {
  await sql`select 1`.execute(db);
}

export async function sweepOlderThan(db: Kysely<any>, table: string, column: string, olderThan: Date, extraWhere?: RawBuilder<unknown>): Promise<number> {
  const r = extraWhere
    ? await sql`delete from ${sql.table(table)} where ${sql.ref(column)} < ${olderThan} and ${extraWhere}`.execute(db)
    : await sql`delete from ${sql.table(table)} where ${sql.ref(column)} < ${olderThan}`.execute(db);
  return Number(r.numAffectedRows ?? 0);
}

export function assertIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid SQL identifier ${name}`);
  return name;
}
