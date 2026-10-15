import type { IdentityClaims } from "@qtiauth/auth-context";
import { hasPermission, joinPath, type LoadedConfig, type ResolvedSurface, type SurfaceName } from "@qtiauth/config";
import type { Api, Problem } from "./api.ts";
import type { Translate } from "./i18n/index.ts";

export interface Features {
  product: { name: string; company: string; support_email: string; website_url: string | null; footer_links: { label: string; href: string }[] };
  surfaces: Record<SurfaceName, { origin: string; base_path: string; api_path: string; url: string; modules: string[] }>;
  same_site: { a: SurfaceName; b: SurfaceName; same_site: boolean; same_origin: boolean }[];
  modules: Record<string, boolean>;
  auth: {
    password: boolean;
    magic_link: boolean;
    passkeys: boolean;
    totp: boolean;
    social: string[];
    password_policy: { min_length: number; max_length: number };
  };
  usernames: { min_length: number; max_length: number; charset: string };
  age: { consent_age: number; min_signup_age: number };
  captcha: { provider: string; site_key: string | null };
  legal: { public_history: boolean; required_at_signup: string[] };
  features: {
    data_export: boolean;
    developer_portal: boolean;
    device_flow: boolean;
    games: { licensing: boolean; steam: boolean; leaderboards: boolean; playtime: boolean; cloud_saves: boolean; keys: boolean } | null;
    support: { tickets: boolean; kb: boolean; guest_tickets: boolean; attachments: boolean } | null;
    safety: boolean;
  };
}

export interface Me {
  id: string;
  email: string | null;
  email_verified: boolean;
  username: string | null;
  needs_username: boolean;
  force_username_reset: boolean;
  state: string;
  locked_until: string | null;
  deletion_due_at: string | null;
  age_band: string | null;
  locale: string | null;
  created_at: string;
  public_profile: boolean;
  leaderboard_visible: boolean | null;
  restrictions: { name: string; until: string | null }[];
  parental_controls: Record<string, unknown> | null;
  guardians: { id: string; email: string; status: string }[];
  sign_in_methods: { count: number; magic_link: boolean; types: string[]; passkeys: number };
  two_factor: { totp: boolean; passkeys: number; recovery_codes_remaining: number };
  session: { id: string; aal: number; amr: string[]; step_up_valid: boolean; trust_level: string };
  pending_legal: { id: string; version: string; title: string; summary: string | null }[];
  mfa_enrolment_required: boolean;
  permissions: string[];
  roles: string[];
}

export type FormValues = Record<string, string>;

export interface RequestContext {
  cfg: LoadedConfig;
  surface: ResolvedSurface;
  surfaces: Record<SurfaceName, ResolvedSurface>;
  origin: string;
  claims: IdentityClaims;
  api: Api;
  t: Translate;
  locale: string;
  nonce: string;
  themeVersion: string;
  path: string;
  fullPath: string;
  query: URLSearchParams;
  method: string;
  form: FormValues;
  formAll: Record<string, string[]>;
  cspHosts: string[];
  features(): Promise<Features>;
  me(): Promise<Me | null>;
}

export function signedIn(rc: RequestContext): boolean {
  return Boolean(rc.claims.sub) && rc.claims.principal !== "guardian";
}

export function isGuardian(rc: RequestContext): boolean {
  return rc.claims.principal === "guardian" && Boolean(rc.claims.gid);
}

export function can(rc: RequestContext, permission: string): boolean {
  return hasPermission(rc.claims.perms ?? [], permission);
}

export function canAny(rc: RequestContext, prefix: string): boolean {
  return (rc.claims.perms ?? []).some((p) => p.startsWith(prefix));
}

export function href(rc: RequestContext, path: string, query?: Record<string, string | number | null | undefined>): string {
  const base = joinPath(rc.surface.basePath, path);
  return withQuery(path.endsWith("/") && path !== "/" ? `${base}/` : base, query);
}

export function surfaceHref(rc: RequestContext, name: SurfaceName, path: string, query?: Record<string, string | number | null | undefined>): string {
  const s = rc.surfaces[name];
  const p = joinPath(s.basePath, path);
  const sameOrigin = s.origins.includes(rc.origin);
  return withQuery(sameOrigin ? p : s.origin + p, query);
}

export function withQuery(url: string, query?: Record<string, string | number | null | undefined>): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  const s = params.toString();
  return s ? `${url}${url.includes("?") ? "&" : "?"}${s}` : url;
}

export function currentUrl(rc: RequestContext): string {
  const q = rc.query.toString();
  return q ? `${rc.fullPath}?${q}` : rc.fullPath;
}

export function safeReturn(rc: RequestContext, target: string | null | undefined, fallback = "/"): string {
  if (!target) return href(rc, fallback);
  if (target.startsWith("/") && !target.startsWith("//") && !target.includes("\\")) return target;
  try {
    const u = new URL(target);
    for (const s of Object.values(rc.surfaces)) if (s.origins.includes(u.origin)) return u.toString();
  } catch {
    return href(rc, fallback);
  }
  return href(rc, fallback);
}

export class RedirectSignal {
  readonly location: string;
  constructor(location: string) {
    this.location = location;
  }
}

export class ProblemSignal {
  readonly problem: Problem;
  constructor(problem: Problem) {
    this.problem = problem;
  }
}

export function loginLocation(rc: RequestContext): string {
  if (rc.surface.name === "account") return href(rc, "/login", { return: currentUrl(rc) });
  if (!rc.claims.bind_attempted) return surfaceHref(rc, "account", "/auth/bind", { target: rc.surface.name, origin: rc.origin, return: currentUrl(rc) });
  return href(rc, "/signed-out", { return: currentUrl(rc) });
}

export interface GateAllow {
  legal?: boolean;
  consent?: boolean;
  mfa?: boolean;
  username?: boolean;
  aal0?: boolean;
  restricted?: boolean;
  deletion?: boolean;
}

export function gateLocation(rc: RequestContext, allow: GateAllow = {}): string | null {
  const c = rc.claims;
  if (!c.sub) return loginLocation(rc);
  const acc = (p: string, q?: Record<string, string>) => surfaceHref(rc, "account", p, q);
  const ret = { return: currentUrl(rc) };
  if (c.aal === 0 && !allow.aal0) return acc("/auth/reauth", ret);
  if (c.state === "pending_parental_consent" && !allow.consent) return acc("/waiting");
  if ((c.state === "locked" || c.state === "banned") && !allow.restricted) return acc("/standing");
  if (c.state === "pending_deletion" && !allow.deletion) return acc("/settings/privacy");
  if (c.pending_legal && !allow.legal) return acc("/legal/accept", ret);
  if (c.mfa_enrolment_required && !allow.mfa) return acc("/settings/security", { enrol: "1" });
  if (c.force_username_reset && !allow.username) return acc("/welcome/username", ret);
  return null;
}

export function requireUser(rc: RequestContext, allow: GateAllow = {}): void {
  const loc = gateLocation(rc, allow);
  if (loc) throw new RedirectSignal(loc);
}

export function requirePermission(rc: RequestContext, permission: string): void {
  requireUser(rc);
  if (!can(rc, permission)) throw new ProblemSignal({ status: 403, code: "PERMISSION_DENIED" });
}

export function initials(name: string | null | undefined): string {
  const n = (name ?? "?").replace(/[^A-Za-z0-9]/g, "");
  return (n.slice(0, 1) || "?").toUpperCase();
}
