export type AuthMode = "none" | "session" | "oauth" | "service" | "game_authoritative";

export const ACCOUNT_STATES = ["pending_email_verification", "pending_parental_consent", "active", "locked", "banned", "pending_deletion", "deleted"] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

export const AGE_BANDS = ["under_13", "13_to_15", "16_to_17", "adult"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export type Principal = "user" | "guardian";

export type RouteModule = "core" | "meta" | "identity" | "oidc" | "games" | "safety" | "support" | "admin" | "notifier";

export interface RoutePolicy {
  auth: AuthMode[];
  permissions: string[];
  scopes: string[];
  allow_account_states: AccountState[];
  allow_pending_legal: boolean;
  allow_pending_parental_consent: boolean;
  allow_pending_mfa_enrolment: boolean;
  allow_force_username_reset: boolean;
  allow_aal0: boolean;
  principals: Principal[];
  session_optional: boolean;
  rate_limit: string[];
  rate_limit_keys: { email?: string; account?: string; app?: string; game?: string };
  step_up: boolean;
  captcha: boolean;
  captcha_failures_policy?: string;
  module: RouteModule;
  mount: "api" | "root";
  body_limit: number;
  raw_body: boolean;
  csrf: boolean;
}

export interface ManifestRoute extends RoutePolicy {
  method: string;
  path: string;
  operation_id: string;
}

export interface NotificationCategory {
  id: string;
  label: string;
  description?: string;
  locked?: boolean;
  staff?: boolean;
  default?: boolean;
}

export interface ServiceManifest {
  service: string;
  instance_id: string;
  version: string;
  base_url: string;
  started_at: string;
  routes: ManifestRoute[];
  permissions: string[];
  notification_categories: NotificationCategory[];
  features: string[];
  jwks?: { keys: Record<string, unknown>[] };
  ready: boolean;
}

export interface Restriction {
  name: string;
  until: string | null;
  action_id?: string;
}

export interface ParentalControls {
  approve_third_party_apps: boolean;
  online_play: boolean;
  in_game_chat: boolean;
  user_generated_content: boolean;
  purchases: boolean;
  daily_playtime_minutes: number | null;
  leaderboards: boolean;
  public_profile: boolean;
  username_changes_require_approval: boolean;
}

export interface IdentityClaims {
  rid: string;
  htm: string;
  htu: string;
  auth: AuthMode;
  surface: string | null;
  origin: string | null;
  ip: string;
  port?: number | null;
  country: string | null;
  ua: string | null;
  locale: string | null;
  sub?: string;
  principal?: Principal;
  gid?: string;
  sid?: string;
  perms: string[];
  state?: AccountState;
  restrictions: Restriction[];
  age_band?: AgeBand | null;
  parental_controls?: ParentalControls | null;
  amr: string[];
  acr?: string;
  aal: 0 | 1 | 2;
  auth_time?: number;
  step_up_at?: number;
  client_id?: string;
  scopes?: string[];
  game_id?: string;
  server_client_id?: string;
  token_jti?: string;
  pending_legal?: boolean;
  mfa_enrolment_required?: boolean;
  force_username_reset?: boolean;
  bind_attempted?: boolean;
  cookie_scope?: string | null;
  trust_level?: "full" | "partial" | "challenge" | "blocked";
  trace_id?: string;
}

export interface Identity extends IdentityClaims {
  readonly isAuthenticated: boolean;
}

export const IDENTITY_HEADER = "x-qtiauth-identity";
export const SESSION_SET_HEADER = "x-qtiauth-session-set";
export const SESSION_CLEAR_HEADER = "x-qtiauth-session-clear";
export const CAPTCHA_STRIKE_HEADER = "x-qtiauth-captcha-strike";
export const PLAYER_TOKEN_HEADER = "x-qtiauth-player-token";
export const SURFACE_HEADER = "x-qtiauth-surface";
export const REQUEST_ID_HEADER = "x-request-id";
