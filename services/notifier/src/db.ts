import { sql, type ColumnType, type Generated } from "kysely";
import { createOutboxTables, type Migration } from "@qtiauth/db";

type NTs = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T> = ColumnType<T, string | T, string | T>;

export interface NotifierDB {
  email_deliveries: {
    id: string;
    template: string;
    sender: string;
    to_email: string | null;
    to_hash: string;
    user_id: string | null;
    priority: string;
    status: "queued" | "sent" | "failed" | "skipped" | "suppressed" | "bounced" | "complained" | "delivered";
    provider: string;
    provider_message_id: string | null;
    attempts: Generated<number>;
    last_error: string | null;
    created_at: Generated<Date>;
    sent_at: NTs;
  };
  suppressions: {
    email_hash: string;
    reason: string;
    source: string;
    created_at: Generated<Date>;
  };
  webhook_endpoints: {
    id: string;
    url: string;
    description: string;
    events: Json<string[]>;
    format: "standard" | "discord" | "slack";
    secret_enc: string;
    previous_secret_enc: string | null;
    previous_secret_expires_at: NTs;
    enabled: boolean;
    disabled_reason: string | null;
    consecutive_failures: Generated<number>;
    seeded: boolean;
    created_by: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  webhook_deliveries: {
    id: string;
    endpoint_id: string;
    event_id: string;
    event_type: string;
    payload: Json<Record<string, unknown>>;
    status: "pending" | "retrying" | "success" | "failed";
    attempts: Generated<number>;
    next_attempt_at: NTs;
    last_status_code: number | null;
    request_body: string | null;
    response_body: string | null;
    duration_ms: number | null;
    error: string | null;
    replay_of: string | null;
    created_at: Generated<Date>;
    completed_at: NTs;
  };
  notice_runs: {
    id: string;
    kind: string;
    data: Json<Record<string, unknown>>;
    cursor: string | null;
    sent: Generated<number>;
    done: Generated<boolean>;
    created_at: Generated<Date>;
  };
}

export const migrations: Migration[] = [
  {
    id: "0001_init",
    async up(db) {
      await createOutboxTables(db);
      await sql`
        create table email_deliveries (
          id text primary key,
          template text not null,
          sender text not null,
          to_email text,
          to_hash text not null,
          user_id uuid,
          priority text not null,
          status text not null,
          provider text not null,
          provider_message_id text,
          attempts int not null default 0,
          last_error text,
          created_at timestamptz not null default now(),
          sent_at timestamptz
        )`.execute(db);
      await sql`create index email_deliveries_created on email_deliveries (created_at desc)`.execute(db);
      await sql`create index email_deliveries_user on email_deliveries (user_id) where user_id is not null`.execute(db);
      await sql`create index email_deliveries_provider_id on email_deliveries (provider_message_id) where provider_message_id is not null`.execute(db);
      await sql`
        create table suppressions (
          email_hash text primary key,
          reason text not null,
          source text not null,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`
        create table webhook_endpoints (
          id text primary key,
          url text not null,
          description text not null default '',
          events jsonb not null default '[]',
          format text not null,
          secret_enc text not null,
          previous_secret_enc text,
          previous_secret_expires_at timestamptz,
          enabled boolean not null default true,
          disabled_reason text,
          consecutive_failures int not null default 0,
          seeded boolean not null default false,
          created_by uuid,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )`.execute(db);
      await sql`
        create table webhook_deliveries (
          id text primary key,
          endpoint_id text not null references webhook_endpoints(id) on delete cascade,
          event_id text not null,
          event_type text not null,
          payload jsonb not null,
          status text not null,
          attempts int not null default 0,
          next_attempt_at timestamptz,
          last_status_code int,
          request_body text,
          response_body text,
          duration_ms int,
          error text,
          replay_of text,
          created_at timestamptz not null default now(),
          completed_at timestamptz
        )`.execute(db);
      await sql`create unique index webhook_deliveries_unique on webhook_deliveries (endpoint_id, event_id) where replay_of is null`.execute(db);
      await sql`create index webhook_deliveries_due on webhook_deliveries (next_attempt_at) where status in ('pending', 'retrying')`.execute(db);
      await sql`create index webhook_deliveries_endpoint on webhook_deliveries (endpoint_id, created_at desc)`.execute(db);
      await sql`
        create table notice_runs (
          id text primary key,
          kind text not null,
          data jsonb not null default '{}',
          cursor text,
          sent int not null default 0,
          done boolean not null default false,
          created_at timestamptz not null default now()
        )`.execute(db);
    },
  },
];
