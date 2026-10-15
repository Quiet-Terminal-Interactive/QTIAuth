import { ProblemError, sleep, inc } from "@qtiauth/common";
import { CAPTCHA_STRIKE_HEADER, type IdentityClaims } from "@qtiauth/auth-context";
import { reply, type Reply } from "@qtiauth/service-kit";
import type { User } from "../db/types.ts";
import type { Ctx, Exec } from "./ctx.ts";
import { createSession, metaFrom, type RequestMeta } from "./sessions.ts";
import { issueToken, consumeToken } from "./tokens.ts";
import { hasSecondFactor } from "./mfa.ts";
import { getUser, bandOf } from "./users.ts";

export async function failureDelay(ctx: Ctx, keys: string[]): Promise<number> {
  let worst = 0;
  for (const k of keys) {
    const n = Number((await ctx.valkey.get(`authfail:${k}`).catch(() => null)) ?? 0);
    worst = Math.max(worst, n);
  }
  const after = ctx.config.password.failure_delay_after;
  if (worst <= after) return 0;
  return Math.min(ctx.config.password.failure_delay_max, 250 * 2 ** (worst - after - 1));
}

export async function recordFailure(ctx: Ctx, keys: string[]): Promise<void> {
  for (const k of keys) {
    const key = `authfail:${k}`;
    const n = await ctx.valkey.incr(key).catch(() => 0);
    if (n === 1) await ctx.valkey.pexpire(key, 15 * 60_000).catch(() => undefined);
  }
}

export async function clearFailures(ctx: Ctx, keys: string[]): Promise<void> {
  if (keys.length) await ctx.valkey.del(...keys.map((k) => `authfail:${k}`)).catch(() => undefined);
}

export async function applyProgressiveDelay(ctx: Ctx, keys: string[]): Promise<void> {
  const ms = await failureDelay(ctx, keys);
  if (ms > 0) await sleep(ms);
}

export function invalidCredentials(): ProblemError {
  return new ProblemError(401, "INVALID_CREDENTIALS", "Email or password incorrect", {}, { [CAPTCHA_STRIKE_HEADER]: "1" });
}

export interface SignedInBody {
  status: "signed_in";
  user: { id: string; username: string | null; state: string; age_band: string | null; needs_username: boolean };
  aal: number;
}

export function signedInBody(ctx: Ctx, user: User, aal: number): SignedInBody {
  return {
    status: "signed_in",
    user: { id: user.id, username: user.username, state: user.state, age_band: bandOf(ctx, user), needs_username: !user.username || user.force_username_reset },
    aal,
  };
}

export async function finishPrimaryAuth(
  ctx: Ctx,
  db: Exec,
  user: User,
  opts: { method: string; amr: string[]; aal: 1 | 2; id: IdentityClaims; skipMfa?: boolean },
): Promise<Reply> {
  if (user.state === "deleted") throw invalidCredentials();
  if (user.state === "pending_email_verification") throw new ProblemError(403, "EMAIL_VERIFICATION_REQUIRED");
  const factors = await hasSecondFactor(db, user.id);
  if (opts.aal < 2 && !opts.skipMfa && (factors.totp || factors.passkeys > 0)) {
    const { token } = await issueToken(db, "mfa_pending", { userId: user.id, data: { method: opts.method, amr: opts.amr }, ttlMs: 10 * 60_000 });
    const methods = [...(factors.totp ? ["totp"] : []), ...(factors.passkeys > 0 ? ["passkey"] : []), ...(factors.recovery_codes > 0 ? ["recovery_code"] : [])];
    return reply(200, { status: "mfa_required", mfa_token: token, methods });
  }
  const created = await createSession(ctx, db, { userId: user.id, aal: opts.aal, amr: opts.amr, method: opts.method, meta: metaFrom(opts.id) });
  inc("qtiauth_auth_sign_ins_total", { method: opts.method, result: "success" }, 1, "Sign-in attempts");
  const fresh = (await getUser(db, user.id)) ?? user;
  return reply(200, signedInBody(ctx, fresh, opts.aal), created.headers);
}

export async function consumeMfaToken(db: Exec, token: string): Promise<{ userId: string; method: string; amr: string[] }> {
  const row = await consumeToken(db, "mfa_pending", token);
  return { userId: row.user_id!, method: String(row.data.method ?? "password"), amr: (row.data.amr as string[]) ?? [] };
}

export function metaOf(id: IdentityClaims): RequestMeta {
  return metaFrom(id);
}

export function recentAuth(ctx: Ctx, id: IdentityClaims): boolean {
  const window = ctx.config.security.step_up_window;
  const now = Date.now();
  if (id.step_up_at && now - id.step_up_at * 1000 <= window) return true;
  return Boolean(id.auth_time && now - id.auth_time * 1000 <= window);
}

export function stepUpOk(ctx: Ctx, id: IdentityClaims): boolean {
  return Boolean(id.step_up_at && Date.now() - id.step_up_at * 1000 <= ctx.config.security.step_up_window);
}

export function requireRecentAuth(ctx: Ctx, id: IdentityClaims): void {
  if (!recentAuth(ctx, id)) throw new ProblemError(403, "STEP_UP_REQUIRED");
}

export function requireStepUp(ctx: Ctx, id: IdentityClaims): void {
  if (!stepUpOk(ctx, id)) throw new ProblemError(403, "STEP_UP_REQUIRED");
}
