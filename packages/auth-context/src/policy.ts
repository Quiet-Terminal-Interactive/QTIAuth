import { hasPermission } from "@qtiauth/config";
import { ProblemError } from "@qtiauth/common";
import type { AccountState, AuthMode, IdentityClaims, RoutePolicy } from "./types.ts";

export const DEFAULT_POLICY: RoutePolicy = {
  auth: ["session"],
  permissions: [],
  scopes: [],
  allow_account_states: ["active"],
  allow_pending_legal: false,
  allow_pending_parental_consent: false,
  allow_pending_mfa_enrolment: false,
  allow_force_username_reset: true,
  allow_aal0: false,
  principals: ["user"],
  session_optional: false,
  rate_limit: [],
  rate_limit_keys: {},
  step_up: false,
  captcha: false,
  module: "core",
  mount: "api",
  body_limit: 1_000_000,
  raw_body: false,
  csrf: true,
};

export type PolicyInput = Partial<Omit<RoutePolicy, "auth" | "rate_limit">> & {
  auth?: AuthMode | AuthMode[];
  rate_limit?: string | string[];
};

export function normalizePolicy(input: PolicyInput): RoutePolicy {
  const auth = input.auth === undefined ? DEFAULT_POLICY.auth : Array.isArray(input.auth) ? input.auth : [input.auth];
  const rate = input.rate_limit === undefined ? [] : Array.isArray(input.rate_limit) ? input.rate_limit : [input.rate_limit];
  return { ...DEFAULT_POLICY, ...input, auth, rate_limit: rate };
}

export interface PolicyCheckOptions {
  stepUpWindowMs: number;
  now?: number;
}

export function stepUpSatisfied(claims: Pick<IdentityClaims, "aal" | "step_up_at" | "auth_time">, windowMs: number, now = Date.now()): boolean {
  const at = claims.step_up_at ?? (claims.aal >= 2 ? claims.auth_time : undefined);
  if (!at) return false;
  return now - at * 1000 <= windowMs;
}

export function checkPolicy(policy: RoutePolicy, claims: IdentityClaims, opts: PolicyCheckOptions): void {
  if (claims.auth === "session" && !policy.auth.includes("session") && policy.auth.includes("none") && policy.session_optional) return;
  if (!policy.auth.includes(claims.auth)) {
    if (claims.auth === "none" && !policy.auth.includes("none")) throw new ProblemError(401, "UNAUTHENTICATED");
    throw new ProblemError(401, "WRONG_CREDENTIAL_TYPE", `This route does not accept ${claims.auth} credentials`);
  }
  if (claims.auth === "session") {
    if (!claims.sub && !claims.gid) {
      if (policy.session_optional || policy.auth.includes("none")) return;
      throw new ProblemError(401, "UNAUTHENTICATED");
    }
    const principal = claims.principal ?? "user";
    if (!policy.principals.includes(principal)) throw new ProblemError(403, "WRONG_PRINCIPAL");
    if (principal === "user") checkUserState(policy, claims);
    if (claims.aal === 0 && !policy.allow_aal0) throw new ProblemError(403, "REAUTHENTICATION_REQUIRED");
    if (claims.mfa_enrolment_required && !policy.allow_pending_mfa_enrolment) throw new ProblemError(403, "MFA_ENROLMENT_REQUIRED");
    if (claims.pending_legal && !policy.allow_pending_legal) throw new ProblemError(403, "LEGAL_ACCEPTANCE_REQUIRED");
    if (claims.force_username_reset && !policy.allow_force_username_reset) throw new ProblemError(403, "USERNAME_RESET_REQUIRED");
    for (const p of policy.permissions) {
      if (!hasPermission(claims.perms, p)) throw new ProblemError(403, "PERMISSION_DENIED", undefined, { permission: p });
    }
    if (policy.step_up && !stepUpSatisfied(claims, opts.stepUpWindowMs, opts.now)) throw new ProblemError(403, "STEP_UP_REQUIRED");
    return;
  }
  if (claims.auth === "oauth" || claims.auth === "service" || claims.auth === "game_authoritative") {
    const scopes = new Set(claims.scopes ?? []);
    for (const s of policy.scopes) if (!scopes.has(s)) throw new ProblemError(403, "INSUFFICIENT_SCOPE", undefined, { scope: s });
    if (claims.auth !== "service" && claims.sub) checkUserState(policy, claims);
    if (claims.auth === "oauth" && claims.pending_legal && !policy.allow_pending_legal) throw new ProblemError(403, "LEGAL_ACCEPTANCE_REQUIRED");
  }
}

function checkUserState(policy: RoutePolicy, claims: IdentityClaims): void {
  const state = (claims.state ?? "active") as AccountState;
  if (state === "pending_parental_consent") {
    if (!policy.allow_pending_parental_consent) throw new ProblemError(403, "PARENTAL_CONSENT_PENDING");
    return;
  }
  if (!policy.allow_account_states.includes(state)) {
    const code =
      state === "banned"
        ? "ACCOUNT_BANNED"
        : state === "locked"
          ? "ACCOUNT_LOCKED"
          : state === "pending_email_verification"
            ? "EMAIL_VERIFICATION_REQUIRED"
            : state === "pending_deletion"
              ? "ACCOUNT_PENDING_DELETION"
              : "ACCOUNT_UNAVAILABLE";
    throw new ProblemError(403, code);
  }
}
