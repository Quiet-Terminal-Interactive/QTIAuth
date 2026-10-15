import { sql, type Kysely, type Transaction } from "kysely";

export interface OutboxRow {
  id: number;
  event_id: string;
  subject: string;
  payload: unknown;
  headers: Record<string, string> | null;
  created_at: Date;
  sent_at: Date | null;
  attempts: number;
  last_error: string | null;
}

export async function createOutboxTables(db: Transaction<any>): Promise<void> {
  await sql`
    create table outbox (
      id bigserial primary key,
      event_id text not null unique,
      subject text not null,
      payload jsonb not null,
      headers jsonb,
      created_at timestamptz not null default now(),
      sent_at timestamptz,
      attempts int not null default 0,
      last_error text
    )`.execute(db);
  await sql`create index outbox_unsent on outbox (id) where sent_at is null`.execute(db);
  await sql`
    create table processed_events (
      consumer text not null,
      event_id text not null,
      processed_at timestamptz not null default now(),
      primary key (consumer, event_id)
    )`.execute(db);
  await sql`create index processed_events_at on processed_events (processed_at)`.execute(db);
  await sql`
    create table service_keys (
      kid text primary key,
      purpose text not null,
      alg text not null,
      public_jwk jsonb not null,
      private_enc text not null,
      created_at timestamptz not null default now(),
      activates_at timestamptz not null default now(),
      retires_at timestamptz,
      expires_at timestamptz
    )`.execute(db);
  await sql`create index service_keys_purpose on service_keys (purpose, created_at desc)`.execute(db);
}

export interface OutboxEvent {
  event_id: string;
  subject: string;
  payload: unknown;
  headers?: Record<string, string>;
}

export async function insertOutbox(db: Kysely<any> | Transaction<any>, events: OutboxEvent | OutboxEvent[]): Promise<void> {
  const list = Array.isArray(events) ? events : [events];
  if (!list.length) return;
  await db
    .insertInto("outbox")
    .values(
      list.map((e) => ({
        event_id: e.event_id,
        subject: e.subject,
        payload: JSON.stringify(e.payload),
        headers: e.headers ? JSON.stringify(e.headers) : null,
      })),
    )
    .execute();
  await sql`select pg_notify('qtiauth_outbox', '')`.execute(db);
}

export async function claimOutbox(db: Kysely<any>, limit: number, handle: (rows: OutboxRow[]) => Promise<{ sent: number[]; failed: { id: number; error: string }[] }>): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const rows = (await sql<OutboxRow>`select * from outbox where sent_at is null order by id limit ${limit} for update skip locked`.execute(trx)).rows;
    if (!rows.length) return 0;
    const result = await handle(rows);
    if (result.sent.length) await sql`update outbox set sent_at = now(), attempts = attempts + 1 where id = any(${result.sent})`.execute(trx);
    for (const f of result.failed) await sql`update outbox set attempts = attempts + 1, last_error = ${f.error} where id = ${f.id}`.execute(trx);
    return result.sent.length;
  });
}

export async function outboxStats(db: Kysely<any>): Promise<{ backlog: number; oldest_age_seconds: number }> {
  const r = await sql<{ backlog: number; oldest: Date | null }>`select count(*)::int as backlog, min(created_at) as oldest from outbox where sent_at is null`.execute(db);
  const row = r.rows[0];
  return { backlog: row?.backlog ?? 0, oldest_age_seconds: row?.oldest ? Math.max(0, (Date.now() - new Date(row.oldest).getTime()) / 1000) : 0 };
}

export async function markProcessed(db: Kysely<any> | Transaction<any>, consumer: string, eventId: string): Promise<boolean> {
  const r = await sql`insert into processed_events (consumer, event_id) values (${consumer}, ${eventId}) on conflict do nothing`.execute(db);
  return Number(r.numAffectedRows ?? 0) > 0;
}
