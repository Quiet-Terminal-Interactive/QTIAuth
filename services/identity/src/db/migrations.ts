import { sql } from "kysely";
import { createOutboxTables, type Migration } from "@qtiauth/db";

export const migrations: Migration[] = [
  {
    id: "0001_init",
    async up(db, ctx) {
      await createOutboxTables(db);
      await sql`
        create table users (
          id uuid primary key,
          email text,
          email_normalized text,
          email_verified_at timestamptz,
          state text not null check (state in ('pending_email_verification','pending_parental_consent','active','locked','banned','pending_deletion','deleted')),
          previous_state text,
          dob date,
          locale text,
          username text,
          username_canonical text,
          username_changed_at timestamptz,
          force_username_reset boolean not null default false,
          public_profile boolean not null default false,
          leaderboard_visible boolean not null default true,
          parental_controls jsonb,
          restrictions jsonb not null default '[]',
          age_assurance_strength text not null default 'self_declared',
          locked_until timestamptz,
          lock_reason text,
          banned_at timestamptz,
          ban_reason text,
          deletion_requested_at timestamptz,
          deletion_due_at timestamptz,
          deleted_at timestamptz,
          graduated_at timestamptz,
          guardian_controls_optional_at timestamptz,
          guardian_email_changes int not null default 0,
          last_sign_in_at timestamptz,
          last_sign_in_method text,
          age_band_cached text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          search tsvector generated always as (
            setweight(to_tsvector('simple', coalesce(username, '')), 'A') ||
            setweight(to_tsvector('simple', coalesce(replace(replace(email, '@', ' '), '.', ' '), '')), 'B')
          ) stored
        )`.execute(db);
      await sql`create unique index users_username_canonical on users (username_canonical) where username_canonical is not null`.execute(db);
      await sql`create index users_email_normalized on users (email_normalized) where state <> 'deleted'`.execute(db);
      await sql`create index users_state on users (state)`.execute(db);
      await sql`create index users_search on users using gin (search)`.execute(db);
      await sql`create index users_deletion_due on users (deletion_due_at) where state = 'pending_deletion'`.execute(db);
      await sql`create index users_created on users (created_at desc, id desc)`.execute(db);

      await sql`
        create table identities (
          id uuid primary key,
          user_id uuid not null references users(id) on delete cascade,
          type text not null,
          subject text,
          email text,
          email_verified boolean not null default false,
          secret text,
          data jsonb not null default '{}',
          created_at timestamptz not null default now(),
          last_used_at timestamptz,
          unlink_allowed_at timestamptz
        )`.execute(db);
      await sql`create unique index identities_provider_subject on identities (type, subject) where subject is not null`.execute(db);
      await sql`create unique index identities_user_password on identities (user_id) where type = 'password'`.execute(db);
      await sql`create index identities_user on identities (user_id)`.execute(db);

      await sql`
        create table passkeys (
          id uuid primary key,
          user_id uuid not null references users(id) on delete cascade,
          credential_id text not null unique,
          public_key text not null,
          counter bigint not null default 0,
          transports jsonb not null default '[]',
          name text not null,
          aaguid text,
          backed_up boolean not null default false,
          device_type text,
          created_at timestamptz not null default now(),
          last_used_at timestamptz
        )`.execute(db);
      await sql`create index passkeys_user on passkeys (user_id)`.execute(db);

      await sql`
        create table totp (
          user_id uuid primary key references users(id) on delete cascade,
          secret_enc text not null,
          confirmed_at timestamptz,
          last_used_step bigint,
          created_at timestamptz not null default now()
        )`.execute(db);

      await sql`
        create table recovery_codes (
          id uuid primary key,
          user_id uuid not null references users(id) on delete cascade,
          code_hash text not null,
          used_at timestamptz,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index recovery_codes_user on recovery_codes (user_id)`.execute(db);

      await sql`
        create table guardians (
          id uuid primary key,
          child_user_id uuid not null references users(id) on delete cascade,
          email text not null,
          email_normalized text not null,
          display_name text,
          user_id uuid,
          status text not null check (status in ('pending','active','declined','removed')),
          dob date,
          invited_by uuid,
          approved_at timestamptz,
          removed_at timestamptz,
          last_reminded_at timestamptz,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index guardians_child on guardians (child_user_id)`.execute(db);
      await sql`create index guardians_email on guardians (email_normalized)`.execute(db);
      await sql`create index guardians_user on guardians (user_id) where user_id is not null`.execute(db);

      await sql`
        create table sessions (
          id uuid primary key,
          user_id uuid references users(id) on delete cascade,
          guardian_id uuid,
          principal text not null default 'user',
          created_at timestamptz not null default now(),
          last_active_at timestamptz not null default now(),
          expires_at timestamptz not null,
          idle_expires_at timestamptz not null,
          revoked_at timestamptz,
          revoke_reason text,
          aal smallint not null,
          amr jsonb not null default '[]',
          auth_method text not null,
          auth_time timestamptz not null,
          step_up_at timestamptz,
          ip inet,
          ip_subnet text,
          country text,
          user_agent text,
          device text,
          device_key text,
          tls_fingerprint text,
          client_signals jsonb not null default '{}',
          baseline jsonb not null default '{}',
          trust_level text not null default 'full',
          last_ip inet,
          last_country text
        )`.execute(db);
      await sql`create index sessions_user_active on sessions (user_id, created_at) where revoked_at is null`.execute(db);
      await sql`create index sessions_guardian on sessions (guardian_id) where guardian_id is not null`.execute(db);
      await sql`create index sessions_expiry on sessions (expires_at)`.execute(db);

      await sql`
        create table session_bindings (
          id uuid primary key,
          session_id uuid not null references sessions(id) on delete cascade,
          token_hash text not null unique,
          scope text not null,
          created_at timestamptz not null default now(),
          last_used_at timestamptz,
          revoked_at timestamptz
        )`.execute(db);
      await sql`create index session_bindings_session on session_bindings (session_id)`.execute(db);

      await sql`
        create table known_devices (
          user_id uuid not null references users(id) on delete cascade,
          device_key text not null,
          first_seen_at timestamptz not null default now(),
          last_seen_at timestamptz not null default now(),
          primary key (user_id, device_key)
        )`.execute(db);

      await sql`
        create table security_events (
          id uuid primary key,
          user_id uuid,
          session_id uuid,
          type text not null,
          ip inet,
          country text,
          user_agent text,
          data jsonb not null default '{}',
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index security_events_user on security_events (user_id, created_at desc)`.execute(db);
      await sql`create index security_events_created on security_events (created_at)`.execute(db);

      await sql`
        create table tokens (
          id uuid primary key,
          kind text not null,
          token_hash text not null unique,
          user_id uuid,
          email text,
          data jsonb not null default '{}',
          expires_at timestamptz not null,
          used_at timestamptz,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index tokens_user_kind on tokens (user_id, kind)`.execute(db);
      await sql`create index tokens_expires on tokens (expires_at)`.execute(db);

      await sql`
        create table legal_documents (
          id text not null,
          version text not null,
          effective_at timestamptz not null,
          material boolean not null,
          requires_acceptance boolean not null default true,
          title text not null,
          summary text,
          body text not null,
          body_hash text not null,
          published_at timestamptz not null default now(),
          effective_notified_at timestamptz,
          primary key (id, version)
        )`.execute(db);

      await sql`
        create table legal_acceptances (
          id uuid primary key,
          user_id uuid not null references users(id) on delete cascade,
          document_id text not null,
          version text not null,
          accepted_at timestamptz not null default now(),
          ip inet,
          method text not null,
          guardian_id uuid,
          unique (user_id, document_id, version)
        )`.execute(db);

      await sql`
        create table username_history (
          id uuid primary key,
          user_id uuid not null,
          username text not null,
          canonical text not null,
          claimed_at timestamptz not null,
          released_at timestamptz,
          hold_until timestamptz,
          reason text
        )`.execute(db);
      await sql`create index username_history_user on username_history (user_id, claimed_at desc)`.execute(db);
      await sql`create index username_history_hold on username_history (canonical, hold_until) where hold_until is not null`.execute(db);

      await sql`
        create table guardian_requests (
          id uuid primary key,
          child_user_id uuid not null references users(id) on delete cascade,
          type text not null,
          status text not null default 'pending',
          data jsonb not null default '{}',
          requested_by uuid,
          decided_by uuid,
          decided_at timestamptz,
          last_reminded_at timestamptz,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index guardian_requests_child on guardian_requests (child_user_id, status)`.execute(db);

      await sql`
        create table age_assurance_results (
          id uuid primary key,
          user_id uuid not null references users(id) on delete cascade,
          provider text not null,
          strength text not null,
          outcome text not null,
          trigger text not null,
          vendor_ref text,
          data jsonb not null default '{}',
          created_at timestamptz not null default now()
        )`.execute(db);

      await sql`
        create table roles (
          name text primary key,
          description text not null default '',
          permissions jsonb not null default '[]',
          builtin boolean not null default false,
          updated_at timestamptz not null default now()
        )`.execute(db);
      await sql`
        create table user_roles (
          user_id uuid not null references users(id) on delete cascade,
          role text not null references roles(name) on delete cascade,
          granted_by uuid,
          granted_at timestamptz not null default now(),
          primary key (user_id, role)
        )`.execute(db);

      await sql`
        create table audit_log (
          id bigserial primary key,
          event_id text not null unique,
          occurred_at timestamptz not null,
          service text not null,
          actor_type text not null,
          actor_id text not null,
          action text not null,
          target_type text,
          target_id text,
          reason text,
          ip text,
          data jsonb not null default '{}',
          prev_hash text not null,
          hash text not null
        )`.execute(db);
      await sql`create index audit_log_actor on audit_log (actor_id, id desc)`.execute(db);
      await sql`create index audit_log_target on audit_log (target_id, id desc)`.execute(db);
      await sql`create index audit_log_action on audit_log (action, id desc)`.execute(db);
      await sql`create index audit_log_occurred on audit_log (occurred_at)`.execute(db);
      await sql`
        create function audit_log_guard() returns trigger language plpgsql as $$
        begin
          if tg_op = 'UPDATE' then
            raise exception 'audit_log is append-only';
          end if;
          if tg_op = 'DELETE' then
            if coalesce(current_setting('qtiauth.audit_retention', true), '') <> 'on' then
              raise exception 'audit_log is append-only';
            end if;
            if old.occurred_at > now() - (current_setting('qtiauth.audit_retention_interval', true))::interval then
              raise exception 'audit_log rows inside the retention period cannot be deleted';
            end if;
          end if;
          return old;
        end $$`.execute(db);
      await sql`create trigger audit_log_no_update before update or delete on audit_log for each row execute function audit_log_guard()`.execute(db);
      await sql`create trigger audit_log_no_truncate before truncate on audit_log execute function audit_log_guard()`.execute(db);
      const auditRole = ctx.env.AUDIT_DB_ROLE;
      if (auditRole && /^[a-z_][a-z0-9_]*$/.test(auditRole)) {
        await sql`grant usage on schema ${sql.id(ctx.schema)} to ${sql.id(auditRole)}`.execute(db);
        await sql`grant select, insert on audit_log to ${sql.id(auditRole)}`.execute(db);
        await sql`grant usage on sequence audit_log_id_seq to ${sql.id(auditRole)}`.execute(db);
      }

      await sql`
        create table filter_decisions (
          id uuid primary key,
          input_hash text not null,
          raw_input text,
          normalized text not null,
          rule text not null,
          matched text,
          action text not null,
          context text not null,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index filter_decisions_created on filter_decisions (created_at desc)`.execute(db);
      await sql`create index filter_decisions_rule on filter_decisions (rule, created_at desc)`.execute(db);

      await sql`
        create table filter_entries (
          id uuid primary key,
          list text not null check (list in ('allow','block')),
          word text not null,
          note text,
          created_by uuid,
          created_at timestamptz not null default now(),
          unique (list, word)
        )`.execute(db);

      await sql`
        create table notification_prefs (
          user_id uuid not null references users(id) on delete cascade,
          category text not null,
          enabled boolean not null,
          updated_at timestamptz not null default now(),
          primary key (user_id, category)
        )`.execute(db);

      await sql`
        create table data_exports (
          id uuid primary key,
          user_id uuid not null,
          requested_by uuid not null,
          status text not null,
          object_key text,
          size_bytes bigint,
          parts jsonb not null default '{}',
          error text,
          requested_at timestamptz not null default now(),
          completed_at timestamptz,
          expires_at timestamptz
        )`.execute(db);
      await sql`create index data_exports_user on data_exports (user_id, requested_at desc)`.execute(db);

      await sql`
        create table erasures (
          user_id uuid primary key,
          started_at timestamptz not null default now(),
          expected jsonb not null default '[]',
          completed jsonb not null default '[]',
          legal_hold boolean not null default false,
          completed_at timestamptz
        )`.execute(db);

      await sql`
        create table deletion_ledger_outbox (
          user_id uuid primary key,
          deleted_at timestamptz not null,
          written_at timestamptz,
          attempts int not null default 0,
          last_error text
        )`.execute(db);

      await sql`
        create table legal_holds (
          id uuid primary key,
          user_id uuid not null,
          reason text not null,
          reference text,
          placed_by text not null,
          created_at timestamptz not null default now(),
          released_at timestamptz
        )`.execute(db);
      await sql`create index legal_holds_user on legal_holds (user_id) where released_at is null`.execute(db);

      await sql`
        create table enforcements (
          action_id text primary key,
          user_id uuid not null,
          effect text not null,
          restrictions jsonb not null default '[]',
          expires_at timestamptz,
          lifted_at timestamptz,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index enforcements_user on enforcements (user_id) where lifted_at is null`.execute(db);
    },
  },
  {
    id: "0002_security_event_ports",
    async up(db) {
      await sql`alter table security_events add column port integer`.execute(db);
    },
  },
];
