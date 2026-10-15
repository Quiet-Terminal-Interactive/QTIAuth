import { sql, type ColumnType, type Generated, type Selectable } from "kysely";
import { createOutboxTables, type Migration } from "@qtiauth/db";

type NTs = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T> = ColumnType<T, string | T, string | T>;

export type ClientKind = "first_party" | "third_party" | "game" | "game_server";

export interface OidcDB {
  clients: {
    id: string;
    name: string;
    description: string;
    type: "confidential" | "public";
    kind: ClientKind;
    secret_hash: string | null;
    owner_user_id: string | null;
    game_id: string | null;
    verified: Generated<boolean>;
    suspended_at: NTs;
    suspended_reason: string | null;
    redirect_uris: Json<string[]>;
    post_logout_redirect_uris: Json<string[]>;
    grant_types: Json<string[]>;
    scopes: Json<string[]>;
    backchannel_logout_uri: string | null;
    backchannel_logout_session_required: Generated<boolean>;
    require_par: Generated<boolean>;
    homepage_url: string | null;
    logo_url: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    deleted_at: NTs;
  };
  consents: {
    user_id: string;
    client_id: string;
    scopes: Json<string[]>;
    guardian_approved: Generated<boolean>;
    granted_at: Generated<Date>;
    updated_at: Generated<Date>;
    last_used_at: NTs;
  };
  authorization_requests: {
    id: string;
    client_id: string;
    redirect_uri: string;
    scopes: Json<string[]>;
    state: string | null;
    nonce: string | null;
    code_challenge: string;
    response_mode: string;
    prompt: string | null;
    max_age: number | null;
    par: Generated<boolean>;
    status: "pending" | "awaiting_guardian" | "completed" | "denied";
    user_id: string | null;
    guardian_request_id: string | null;
    created_at: Generated<Date>;
    expires_at: Ts;
  };
  auth_codes: {
    code_hash: string;
    client_id: string;
    user_id: string;
    session_id: string | null;
    redirect_uri: string;
    scopes: Json<string[]>;
    nonce: string | null;
    code_challenge: string;
    auth_time: number | null;
    acr: string | null;
    amr: Json<string[]>;
    expires_at: Ts;
    used_at: NTs;
    created_at: Generated<Date>;
  };
  refresh_tokens: {
    id: string;
    token_hash: string;
    family_id: string;
    client_id: string;
    user_id: string;
    session_id: string | null;
    scopes: Json<string[]>;
    offline: boolean;
    auth_time: number | null;
    acr: string | null;
    amr: Json<string[]>;
    created_at: Generated<Date>;
    expires_at: Ts;
    rotated_at: NTs;
    revoked_at: NTs;
    revoke_reason: string | null;
  };
  issued_tokens: {
    jti: string;
    client_id: string;
    user_id: string | null;
    session_id: string | null;
    family_id: string | null;
    expires_at: Ts;
    revoked_at: NTs;
    created_at: Generated<Date>;
  };
  device_codes: {
    id: string;
    device_code_hash: string;
    user_code: string;
    client_id: string;
    scopes: Json<string[]>;
    status: "pending" | "approved" | "denied" | "used";
    user_id: string | null;
    session_id: string | null;
    auth_time: number | null;
    acr: string | null;
    amr: ColumnType<string[], string | string[] | undefined, string | string[]>;
    interval_s: number;
    last_polled_at: NTs;
    created_at: Generated<Date>;
    expires_at: Ts;
  };
  session_clients: {
    session_id: string;
    client_id: string;
    user_id: string;
    first_at: Generated<Date>;
  };
  backchannel_deliveries: {
    id: string;
    client_id: string;
    session_id: string | null;
    user_id: string;
    reason: string;
    status: "pending" | "retrying" | "success" | "failed";
    attempts: Generated<number>;
    next_attempt_at: NTs;
    last_status: number | null;
    last_error: string | null;
    created_at: Generated<Date>;
    completed_at: NTs;
  };
}

export type Client = Selectable<OidcDB["clients"]>;

export const migrations: Migration[] = [
  {
    id: "0001_init",
    async up(db) {
      await createOutboxTables(db);
      await sql`
        create table clients (
          id text primary key,
          name text not null,
          description text not null default '',
          type text not null check (type in ('confidential','public')),
          kind text not null,
          secret_hash text,
          owner_user_id uuid,
          game_id text,
          verified boolean not null default false,
          suspended_at timestamptz,
          suspended_reason text,
          redirect_uris jsonb not null default '[]',
          post_logout_redirect_uris jsonb not null default '[]',
          grant_types jsonb not null default '[]',
          scopes jsonb not null default '[]',
          backchannel_logout_uri text,
          backchannel_logout_session_required boolean not null default false,
          require_par boolean not null default false,
          homepage_url text,
          logo_url text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          deleted_at timestamptz
        )`.execute(db);
      await sql`create index clients_owner on clients (owner_user_id) where deleted_at is null`.execute(db);
      await sql`create index clients_game on clients (game_id) where game_id is not null`.execute(db);
      await sql`
        create table consents (
          user_id uuid not null,
          client_id text not null references clients(id) on delete cascade,
          scopes jsonb not null,
          guardian_approved boolean not null default false,
          granted_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          last_used_at timestamptz,
          primary key (user_id, client_id)
        )`.execute(db);
      await sql`
        create table authorization_requests (
          id text primary key,
          client_id text not null references clients(id) on delete cascade,
          redirect_uri text not null,
          scopes jsonb not null,
          state text,
          nonce text,
          code_challenge text not null,
          response_mode text not null default 'query',
          prompt text,
          max_age int,
          par boolean not null default false,
          status text not null,
          user_id uuid,
          guardian_request_id uuid,
          created_at timestamptz not null default now(),
          expires_at timestamptz not null
        )`.execute(db);
      await sql`
        create table auth_codes (
          code_hash text primary key,
          client_id text not null,
          user_id uuid not null,
          session_id uuid,
          redirect_uri text not null,
          scopes jsonb not null,
          nonce text,
          code_challenge text not null,
          auth_time bigint,
          acr text,
          amr jsonb not null default '[]',
          expires_at timestamptz not null,
          used_at timestamptz,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`
        create table refresh_tokens (
          id text primary key,
          token_hash text not null unique,
          family_id text not null,
          client_id text not null,
          user_id uuid not null,
          session_id uuid,
          scopes jsonb not null,
          offline boolean not null,
          auth_time bigint,
          acr text,
          amr jsonb not null default '[]',
          created_at timestamptz not null default now(),
          expires_at timestamptz not null,
          rotated_at timestamptz,
          revoked_at timestamptz,
          revoke_reason text
        )`.execute(db);
      await sql`create index refresh_tokens_family on refresh_tokens (family_id)`.execute(db);
      await sql`create index refresh_tokens_session on refresh_tokens (session_id) where revoked_at is null`.execute(db);
      await sql`create index refresh_tokens_user on refresh_tokens (user_id, client_id) where revoked_at is null`.execute(db);
      await sql`
        create table issued_tokens (
          jti text primary key,
          client_id text not null,
          user_id uuid,
          session_id uuid,
          family_id text,
          expires_at timestamptz not null,
          revoked_at timestamptz,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index issued_tokens_family on issued_tokens (family_id) where family_id is not null`.execute(db);
      await sql`create index issued_tokens_user on issued_tokens (user_id, expires_at)`.execute(db);
      await sql`create index issued_tokens_client on issued_tokens (client_id, expires_at)`.execute(db);
      await sql`
        create table device_codes (
          id text primary key,
          device_code_hash text not null unique,
          user_code text not null unique,
          client_id text not null references clients(id) on delete cascade,
          scopes jsonb not null,
          status text not null,
          user_id uuid,
          session_id uuid,
          auth_time bigint,
          acr text,
          amr jsonb not null default '[]',
          interval_s int not null,
          last_polled_at timestamptz,
          created_at timestamptz not null default now(),
          expires_at timestamptz not null
        )`.execute(db);
      await sql`
        create table session_clients (
          session_id uuid not null,
          client_id text not null,
          user_id uuid not null,
          first_at timestamptz not null default now(),
          primary key (session_id, client_id)
        )`.execute(db);
      await sql`create index session_clients_user on session_clients (user_id)`.execute(db);
      await sql`
        create table backchannel_deliveries (
          id text primary key,
          client_id text not null,
          session_id uuid,
          user_id uuid not null,
          reason text not null,
          status text not null,
          attempts int not null default 0,
          next_attempt_at timestamptz,
          last_status int,
          last_error text,
          created_at timestamptz not null default now(),
          completed_at timestamptz
        )`.execute(db);
      await sql`create index backchannel_due on backchannel_deliveries (next_attempt_at) where status in ('pending','retrying')`.execute(db);
      await sql`create index backchannel_client on backchannel_deliveries (client_id, created_at desc)`.execute(db);
    },
  },
];
