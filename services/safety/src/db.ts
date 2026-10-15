import { sql, type ColumnType, type Generated, type Selectable } from "kysely";
import { createOutboxTables, type Migration } from "@qtiauth/db";

type NTs = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T> = ColumnType<T, string | T, string | T>;
type NJson<T> = ColumnType<T | null, string | T | null | undefined, string | T | null>;

export type Priority = "low" | "normal" | "high" | "critical";
export type ReportStatus = "open" | "in_review" | "actioned" | "dismissed";
export type ReportSource = "user" | "game" | "flag" | "staff";
export type Effect = "warn" | "restrict" | "force_username_reset" | "lock" | "ban" | "remove_content" | "proscribed_org_removal";
export type ActionStatus = "active" | "pending_approval" | "rejected" | "lifted" | "expired" | "completed";

export interface UploadInfo {
  uploaded_at?: string | null;
  ip?: string | null;
  port?: number | null;
  ip_at?: string | null;
  exif?: Record<string, unknown> | null;
  hash?: { algorithm: string; value: string } | null;
  platform?: string | null;
}

export interface ContentRef {
  id?: string | null;
  type?: string | null;
  url?: string | null;
  upload?: UploadInfo | null;
}

export type NcaPriority = 1 | 2 | 3;
export type CloseOutcome = "reported" | "reported_elsewhere" | "not_csea";

export interface SafetyDB {
  reports: {
    id: string;
    reference: string;
    source: ReportSource;
    reporter_user_id: string | null;
    reporter_client_id: string | null;
    game_id: string | null;
    type: string;
    subtype: string | null;
    priority: Priority;
    csea: boolean;
    status: ReportStatus;
    reported_user_id: string | null;
    content: NJson<ContentRef>;
    snapshot: NJson<Record<string, unknown>>;
    context: NJson<Record<string, unknown>>;
    description: string | null;
    flag_id: string | null;
    assigned_to: string | null;
    sla_due_at: Ts;
    sla_breached_at: NTs;
    first_action_at: NTs;
    resolved_at: NTs;
    resolved_by: string | null;
    resolution: string | null;
    resolution_note: string | null;
    case_id: string | null;
    reporter_notified_at: NTs;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  flags: {
    id: string;
    client_id: string | null;
    game_id: string | null;
    user_id: string | null;
    classifier: string;
    score: number;
    labels: Json<string[]>;
    content: NJson<ContentRef>;
    snapshot: NJson<Record<string, unknown>>;
    status: "pending" | "reported" | "dismissed";
    report_id: string | null;
    reviewed_by: string | null;
    created_at: Generated<Date>;
  };
  actions: {
    id: string;
    user_id: string;
    action_type: string;
    effect: Effect;
    restrictions: Json<string[]>;
    rule: string;
    reason_code: string | null;
    note: string | null;
    report_id: string | null;
    game_id: string | null;
    content: NJson<ContentRef>;
    moderator_id: string;
    approved_by: string | null;
    status: ActionStatus;
    duration_ms: number | null;
    expires_at: NTs;
    lifted_at: NTs;
    lifted_by: string | null;
    lift_reason: string | null;
    created_at: Generated<Date>;
  };
  appeals: {
    id: string;
    reference: string;
    action_id: string;
    user_id: string;
    statement: string;
    ticket_id: string | null;
    ticket_number: number | null;
    status: Generated<"open" | "upheld" | "lifted">;
    resolved_by: string | null;
    resolution_note: string | null;
    created_at: Generated<Date>;
    resolved_at: NTs;
  };
  csea_cases: {
    id: string;
    report_id: string;
    status: "open" | "submitted" | "closed";
    deadline_at: Ts;
    nca_priority: NcaPriority | null;
    priority_reason: string | null;
    priority_assessed_at: NTs;
    priority_assessed_by: string | null;
    foreign_body: string | null;
    foreign_reference: string | null;
    foreign_reported_at: NTs;
    reference_retain_until: NTs;
    close_outcome: CloseOutcome | null;
    nca_reference: string | null;
    nca_submitted_at: NTs;
    nca_submitted_by: string | null;
    protective_action_id: string | null;
    hold_id: string | null;
    created_by: string;
    created_at: Generated<Date>;
    closed_at: NTs;
    close_note: string | null;
  };
  evidence: {
    id: string;
    case_id: string;
    user_id: string | null;
    ciphertext: string;
    kind: Generated<"case_opened" | "preservation">;
    destroy_after: NTs;
    destroyed_at: NTs;
    created_at: Generated<Date>;
  };
  csea_supplementary: {
    id: string;
    case_id: string;
    nca_reference: string;
    submitted_at: Ts;
    submitted_by: string;
    note: string | null;
    created_at: Generated<Date>;
  };
  csea_nca_requests: {
    id: string;
    case_id: string;
    received_at: Ts;
    due_at: Ts;
    summary: string;
    responded_at: NTs;
    responded_by: string | null;
    response_note: string | null;
    created_at: Generated<Date>;
  };
  preservation_requests: {
    id: string;
    case_id: string;
    game_id: string;
    user_id: string;
    content: NJson<ContentRef>;
    window_start: Ts;
    window_end: Ts;
    status: Generated<"pending" | "fulfilled" | "cancelled">;
    fulfilled_at: NTs;
    fulfilled_by: string | null;
    created_at: Generated<Date>;
  };
  legal_holds: {
    id: string;
    user_id: string;
    case_id: string | null;
    reason: string;
    reference: string | null;
    placed_by: string;
    placed_at: Generated<Date>;
    released_at: NTs;
    released_by: string | null;
  };
}

export type Report = Selectable<SafetyDB["reports"]>;
export type Action = Selectable<SafetyDB["actions"]>;
export type Appeal = Selectable<SafetyDB["appeals"]>;
export type CseaCase = Selectable<SafetyDB["csea_cases"]>;
export type Flag = Selectable<SafetyDB["flags"]>;

export const migrations: Migration[] = [
  {
    id: "0001_init",
    async up(db) {
      await createOutboxTables(db);
      await sql`
        create table reports (
          id uuid primary key,
          reference text not null unique,
          source text not null check (source in ('user','game','flag','staff')),
          reporter_user_id uuid,
          reporter_client_id text,
          game_id text,
          type text not null,
          subtype text,
          priority text not null check (priority in ('low','normal','high','critical')),
          csea boolean not null default false,
          status text not null default 'open' check (status in ('open','in_review','actioned','dismissed')),
          reported_user_id uuid,
          content jsonb,
          snapshot jsonb,
          context jsonb,
          description text,
          flag_id uuid,
          assigned_to uuid,
          sla_due_at timestamptz not null,
          sla_breached_at timestamptz,
          first_action_at timestamptz,
          resolved_at timestamptz,
          resolved_by uuid,
          resolution text,
          resolution_note text,
          case_id uuid,
          reporter_notified_at timestamptz,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index reports_queue on reports (status, priority, sla_due_at) where status in ('open','in_review')`.execute(db);
      await sql`create index reports_reported_user on reports (reported_user_id, created_at desc)`.execute(db);
      await sql`create index reports_reporter on reports (reporter_user_id, created_at desc)`.execute(db);
      await sql`create index reports_resolved on reports (resolved_at) where resolved_at is not null`.execute(db);
      await sql`
        create table flags (
          id uuid primary key,
          client_id text,
          game_id text,
          user_id uuid,
          classifier text not null,
          score double precision not null,
          labels jsonb not null default '[]',
          content jsonb,
          snapshot jsonb,
          status text not null default 'pending' check (status in ('pending','reported','dismissed')),
          report_id uuid,
          reviewed_by uuid,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index flags_pending on flags (created_at desc) where status = 'pending'`.execute(db);
      await sql`
        create table actions (
          id uuid primary key,
          user_id uuid not null,
          action_type text not null,
          effect text not null,
          restrictions jsonb not null default '[]',
          rule text not null,
          reason_code text,
          note text,
          report_id uuid,
          game_id text,
          content jsonb,
          moderator_id uuid not null,
          approved_by uuid,
          status text not null check (status in ('active','pending_approval','rejected','lifted','expired','completed')),
          duration_ms bigint,
          expires_at timestamptz,
          lifted_at timestamptz,
          lifted_by uuid,
          lift_reason text,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index actions_user on actions (user_id, created_at desc)`.execute(db);
      await sql`create index actions_moderator on actions (moderator_id, created_at desc)`.execute(db);
      await sql`create index actions_expiring on actions (expires_at) where status = 'active' and expires_at is not null`.execute(db);
      await sql`
        create table appeals (
          id uuid primary key,
          reference text not null unique,
          action_id uuid not null references actions(id),
          user_id uuid not null,
          statement text not null,
          ticket_id text,
          ticket_number bigint,
          status text not null default 'open' check (status in ('open','upheld','lifted')),
          resolved_by uuid,
          resolution_note text,
          created_at timestamptz not null default now(),
          resolved_at timestamptz
        )`.execute(db);
      await sql`create unique index appeals_one_open on appeals (action_id) where status = 'open'`.execute(db);
      await sql`create index appeals_open on appeals (created_at) where status = 'open'`.execute(db);
      await sql`
        create table csea_cases (
          id uuid primary key,
          report_id uuid not null unique,
          status text not null default 'open' check (status in ('open','submitted','closed')),
          deadline_at timestamptz not null,
          nca_reference text,
          nca_submitted_at timestamptz,
          nca_submitted_by uuid,
          protective_action_id uuid,
          hold_id uuid,
          created_by text not null,
          created_at timestamptz not null default now(),
          closed_at timestamptz,
          close_note text
        )`.execute(db);
      await sql`
        create table evidence (
          id uuid primary key,
          case_id uuid not null references csea_cases(id),
          user_id uuid,
          ciphertext text not null,
          destroy_after timestamptz not null,
          destroyed_at timestamptz,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index evidence_destroy on evidence (destroy_after) where destroyed_at is null`.execute(db);
      await sql`
        create table legal_holds (
          id uuid primary key,
          user_id uuid not null,
          case_id uuid,
          reason text not null,
          reference text,
          placed_by text not null,
          placed_at timestamptz not null default now(),
          released_at timestamptz,
          released_by uuid
        )`.execute(db);
      await sql`create index legal_holds_user on legal_holds (user_id) where released_at is null`.execute(db);
    },
  },
  {
    id: "0002_csea_regulations",
    async up(db) {
      await sql`
        alter table csea_cases
          add column nca_priority smallint check (nca_priority between 1 and 3),
          add column priority_reason text,
          add column priority_assessed_at timestamptz,
          add column priority_assessed_by uuid,
          add column foreign_body text,
          add column foreign_reference text,
          add column foreign_reported_at timestamptz,
          add column reference_retain_until timestamptz,
          add column close_outcome text check (close_outcome in ('reported','reported_elsewhere','not_csea'))`.execute(db);
      await sql`update csea_cases set close_outcome = 'reported' where status = 'closed'`.execute(db);
      await sql`update csea_cases set reference_retain_until = nca_submitted_at + interval '5 years' where nca_submitted_at is not null`.execute(db);
      await sql`alter table evidence alter column destroy_after drop not null`.execute(db);
      await sql`alter table evidence add column kind text not null default 'case_opened' check (kind in ('case_opened','preservation'))`.execute(db);
      await sql`update evidence e set destroy_after = null from csea_cases c where c.id = e.case_id and c.nca_submitted_at is null and e.destroyed_at is null`.execute(db);
      await sql`update evidence e set destroy_after = greatest(e.destroy_after, c.nca_submitted_at + interval '1 year') from csea_cases c where c.id = e.case_id and c.nca_submitted_at is not null and e.destroyed_at is null`.execute(db);
      await sql`
        create table csea_supplementary (
          id uuid primary key,
          case_id uuid not null references csea_cases(id),
          nca_reference text not null,
          submitted_at timestamptz not null,
          submitted_by uuid not null,
          note text,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index csea_supplementary_case on csea_supplementary (case_id)`.execute(db);
      await sql`
        create table csea_nca_requests (
          id uuid primary key,
          case_id uuid not null references csea_cases(id),
          received_at timestamptz not null,
          due_at timestamptz not null,
          summary text not null,
          responded_at timestamptz,
          responded_by uuid,
          response_note text,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index csea_nca_requests_open on csea_nca_requests (due_at) where responded_at is null`.execute(db);
      await sql`
        create table preservation_requests (
          id uuid primary key,
          case_id uuid not null references csea_cases(id),
          game_id text not null,
          user_id uuid not null,
          content jsonb,
          window_start timestamptz not null,
          window_end timestamptz not null,
          status text not null default 'pending' check (status in ('pending','fulfilled','cancelled')),
          fulfilled_at timestamptz,
          fulfilled_by text,
          created_at timestamptz not null default now()
        )`.execute(db);
      await sql`create index preservation_requests_game on preservation_requests (game_id, created_at) where status = 'pending'`.execute(db);
    },
  },
];
