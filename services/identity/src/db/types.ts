import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";
import type { AccountState, ParentalControls, Restriction } from "@qtiauth/auth-context";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T> = ColumnType<T, string | T, string | T>;

export interface UsersTable {
  id: string;
  email: string | null;
  email_normalized: string | null;
  email_verified_at: NullableTimestamp;
  state: AccountState;
  previous_state: AccountState | null;
  dob: string | null;
  locale: string | null;
  username: string | null;
  username_canonical: string | null;
  username_changed_at: NullableTimestamp;
  force_username_reset: Generated<boolean>;
  public_profile: Generated<boolean>;
  leaderboard_visible: Generated<boolean>;
  parental_controls: Json<ParentalControls | null>;
  restrictions: Json<Restriction[]>;
  age_assurance_strength: Generated<string>;
  locked_until: NullableTimestamp;
  lock_reason: string | null;
  banned_at: NullableTimestamp;
  ban_reason: string | null;
  deletion_requested_at: NullableTimestamp;
  deletion_due_at: NullableTimestamp;
  deleted_at: NullableTimestamp;
  graduated_at: NullableTimestamp;
  guardian_controls_optional_at: NullableTimestamp;
  guardian_email_changes: Generated<number>;
  last_sign_in_at: NullableTimestamp;
  last_sign_in_method: string | null;
  age_band_cached: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface IdentitiesTable {
  id: string;
  user_id: string;
  type: string;
  subject: string | null;
  email: string | null;
  email_verified: Generated<boolean>;
  secret: string | null;
  data: Json<Record<string, unknown>>;
  created_at: Generated<Date>;
  last_used_at: NullableTimestamp;
  unlink_allowed_at: NullableTimestamp;
}

export interface PasskeysTable {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: Json<string[]>;
  name: string;
  aaguid: string | null;
  backed_up: Generated<boolean>;
  device_type: string | null;
  created_at: Generated<Date>;
  last_used_at: NullableTimestamp;
}

export interface TotpTable {
  user_id: string;
  secret_enc: string;
  confirmed_at: NullableTimestamp;
  last_used_step: number | null;
  created_at: Generated<Date>;
}

export interface RecoveryCodesTable {
  id: string;
  user_id: string;
  code_hash: string;
  used_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface SessionsTable {
  id: string;
  user_id: string | null;
  guardian_id: string | null;
  principal: "user" | "guardian";
  created_at: Generated<Date>;
  last_active_at: Timestamp;
  expires_at: Timestamp;
  idle_expires_at: Timestamp;
  revoked_at: NullableTimestamp;
  revoke_reason: string | null;
  aal: number;
  amr: Json<string[]>;
  auth_method: string;
  auth_time: Timestamp;
  step_up_at: NullableTimestamp;
  ip: string | null;
  ip_subnet: string | null;
  country: string | null;
  user_agent: string | null;
  device: string | null;
  device_key: string | null;
  tls_fingerprint: string | null;
  client_signals: Json<Record<string, string>>;
  baseline: Json<Record<string, string | null>>;
  trust_level: Generated<string>;
  last_ip: string | null;
  last_country: string | null;
}

export interface SessionBindingsTable {
  id: string;
  session_id: string;
  token_hash: string;
  scope: string;
  created_at: Generated<Date>;
  last_used_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
}

export interface KnownDevicesTable {
  user_id: string;
  device_key: string;
  first_seen_at: Generated<Date>;
  last_seen_at: Timestamp;
}

export interface SecurityEventsTable {
  id: string;
  user_id: string | null;
  session_id: string | null;
  type: string;
  ip: string | null;
  port: number | null;
  country: string | null;
  user_agent: string | null;
  data: Json<Record<string, unknown>>;
  created_at: Generated<Date>;
}

export interface TokensTable {
  id: string;
  kind: string;
  token_hash: string;
  user_id: string | null;
  email: string | null;
  data: Json<Record<string, unknown>>;
  expires_at: Timestamp;
  used_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface LegalDocumentsTable {
  id: string;
  version: string;
  effective_at: Timestamp;
  material: boolean;
  requires_acceptance: boolean;
  title: string;
  summary: string | null;
  body: string;
  body_hash: string;
  published_at: Generated<Date>;
  effective_notified_at: NullableTimestamp;
}

export interface LegalAcceptancesTable {
  id: string;
  user_id: string;
  document_id: string;
  version: string;
  accepted_at: Generated<Date>;
  ip: string | null;
  method: string;
  guardian_id: string | null;
}

export interface UsernameHistoryTable {
  id: string;
  user_id: string;
  username: string;
  canonical: string;
  claimed_at: Timestamp;
  released_at: NullableTimestamp;
  hold_until: NullableTimestamp;
  reason: string | null;
}

export interface GuardiansTable {
  id: string;
  child_user_id: string;
  email: string;
  email_normalized: string;
  display_name: string | null;
  user_id: string | null;
  status: "pending" | "active" | "declined" | "removed";
  dob: string | null;
  invited_by: string | null;
  approved_at: NullableTimestamp;
  removed_at: NullableTimestamp;
  last_reminded_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface GuardianRequestsTable {
  id: string;
  child_user_id: string;
  type: "removal" | "app_approval" | "username_change" | "legal_acceptance";
  status: "pending" | "approved" | "denied" | "cancelled" | "expired";
  data: Json<Record<string, unknown>>;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: NullableTimestamp;
  last_reminded_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface AgeAssuranceResultsTable {
  id: string;
  user_id: string;
  provider: string;
  strength: string;
  outcome: string;
  trigger: string;
  vendor_ref: string | null;
  data: Json<Record<string, unknown>>;
  created_at: Generated<Date>;
}

export interface RolesTable {
  name: string;
  description: string;
  permissions: Json<string[]>;
  builtin: boolean;
  updated_at: Generated<Date>;
}

export interface UserRolesTable {
  user_id: string;
  role: string;
  granted_by: string | null;
  granted_at: Generated<Date>;
}

export interface AuditLogTable {
  id: Generated<number>;
  event_id: string;
  occurred_at: Timestamp;
  service: string;
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  ip: string | null;
  data: Json<Record<string, unknown>>;
  prev_hash: string;
  hash: string;
}

export interface FilterDecisionsTable {
  id: string;
  input_hash: string;
  raw_input: string | null;
  normalized: string;
  rule: string;
  matched: string | null;
  action: string;
  context: string;
  created_at: Generated<Date>;
}

export interface FilterEntriesTable {
  id: string;
  list: "allow" | "block";
  word: string;
  note: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface NotificationPrefsTable {
  user_id: string;
  category: string;
  enabled: boolean;
  updated_at: Generated<Date>;
}

export interface DataExportsTable {
  id: string;
  user_id: string;
  requested_by: string;
  status: "pending" | "running" | "ready" | "emailed" | "failed" | "expired";
  object_key: string | null;
  size_bytes: number | null;
  parts: Json<Record<string, string>>;
  error: string | null;
  requested_at: Generated<Date>;
  completed_at: NullableTimestamp;
  expires_at: NullableTimestamp;
}

export interface ErasuresTable {
  user_id: string;
  started_at: Generated<Date>;
  expected: Json<string[]>;
  completed: Json<string[]>;
  legal_hold: boolean;
  completed_at: NullableTimestamp;
}

export interface DeletionLedgerOutboxTable {
  user_id: string;
  deleted_at: Timestamp;
  written_at: NullableTimestamp;
  attempts: Generated<number>;
  last_error: string | null;
}

export interface LegalHoldsTable {
  id: string;
  user_id: string;
  reason: string;
  reference: string | null;
  placed_by: string;
  created_at: Generated<Date>;
  released_at: NullableTimestamp;
}

export interface EnforcementsTable {
  action_id: string;
  user_id: string;
  effect: string;
  restrictions: Json<string[]>;
  expires_at: NullableTimestamp;
  lifted_at: NullableTimestamp;
  created_at: Generated<Date>;
}

export interface IdentityDB {
  users: UsersTable;
  identities: IdentitiesTable;
  passkeys: PasskeysTable;
  totp: TotpTable;
  recovery_codes: RecoveryCodesTable;
  sessions: SessionsTable;
  session_bindings: SessionBindingsTable;
  known_devices: KnownDevicesTable;
  security_events: SecurityEventsTable;
  tokens: TokensTable;
  legal_documents: LegalDocumentsTable;
  legal_acceptances: LegalAcceptancesTable;
  username_history: UsernameHistoryTable;
  guardians: GuardiansTable;
  guardian_requests: GuardianRequestsTable;
  age_assurance_results: AgeAssuranceResultsTable;
  roles: RolesTable;
  user_roles: UserRolesTable;
  audit_log: AuditLogTable;
  filter_decisions: FilterDecisionsTable;
  filter_entries: FilterEntriesTable;
  notification_prefs: NotificationPrefsTable;
  data_exports: DataExportsTable;
  erasures: ErasuresTable;
  deletion_ledger_outbox: DeletionLedgerOutboxTable;
  legal_holds: LegalHoldsTable;
  enforcements: EnforcementsTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;
export type Session = Selectable<SessionsTable>;
export type Guardian = Selectable<GuardiansTable>;
export type TokenRow = Selectable<TokensTable>;
