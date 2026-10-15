import { z } from "zod";
import { ProblemError, inc } from "@qtiauth/common";
import { reply, route, type AnyRoute, setJson, takeJson } from "@qtiauth/service-kit";
import { SESSION_CLEAR_HEADER } from "@qtiauth/auth-context";
import { EVENTS } from "@qtiauth/bus";
import type { Ctx } from "../lib/ctx.ts";
import type { User } from "../db/types.ts";
import { accountUrl, openSession, zDob, zEmailIn, zLegalAcceptance, zPassword, zToken, ALL_STATES } from "./common.ts";
import { countAccountsForEmail, displayName, getUser, insertUser, needsParentalConsent, normalizeEmail, requireUser, setState, usersByEmail, ageYears } from "../lib/users.ts";
import { assertAcceptablePassword, dummyVerify, hashPassword, needsRehash, verifyPassword } from "../lib/passwords.ts";
import { consumeToken, issueToken, invalidateTokens, peekToken } from "../lib/tokens.ts";
import { assertSignupAcceptance, acceptDocuments } from "../lib/legal.ts";
import { assertUsernameAvailable, applyUsername } from "../lib/usernames.ts";
import { startGuardianConsent } from "../lib/parental.ts";
import { applyProgressiveDelay, clearFailures, consumeMfaToken, finishPrimaryAuth, invalidCredentials, metaOf, recordFailure, signedInBody } from "../lib/auth.ts";
import { checkTotp, hasSecondFactor, useRecoveryCode } from "../lib/mfa.ts";
import { authenticationOptions, verifyAuthentication } from "../lib/passkeys.ts";
import { createSession, markReauthenticated, revokeAllSessions, revokeSession } from "../lib/sessions.ts";
import { securityAlert, securityEvent } from "../lib/security.ts";
import { callbackUri, enabledProviders, newFlowSecrets, type FlowState, type ProviderProfile } from "../lib/social/providers.ts";
import { runAssurance } from "../lib/age.ts";
import { uuidv7, randomToken } from "@qtiauth/common";

const tags = ["auth"];

function requireFeature(on: boolean): void {
  if (!on) throw new ProblemError(404, "FEATURE_DISABLED");
}

async function sendVerification(ctx: Ctx, db: Parameters<typeof issueToken>[0], user: User, data: Record<string, unknown> = {}): Promise<void> {
  await invalidateTokens(db, user.id, ["email_verify"]);
  const { token } = await issueToken(db, "email_verify", { userId: user.id, email: user.email, data, ttlMs: ctx.config.accounts.verification_ttl });
  await ctx.email(db, {
    template: "verify_email",
    to: { email: user.email!, name: displayName(user) },
    locale: user.locale,
    vars: { name: displayName(user), verify_url: accountUrl(ctx, "/verify-email", { token }) },
    sender: "auth",
    priority: "high",
    bypass_suppression: false,
  });
}

function checkAge(ctx: Ctx, dob: string): void {
  if (ageYears(dob) < ctx.config.accounts.min_signup_age) throw new ProblemError(422, "AGE_NOT_ALLOWED");
}

async function createAccount(
  ctx: Ctx,
  db: Parameters<typeof insertUser>[1],
  input: {
    email: string;
    emailVerified: boolean;
    dob: string;
    locale: string | null;
    username?: string | null;
    guardianEmail?: string | null;
    accepted: { id: string; version: string }[];
    ip: string | null;
    port?: number | null;
    country?: string | null;
    ua?: string | null;
    identity?: { type: string; subject: string | null; email: string | null; email_verified: boolean; secret?: string | null; data?: Record<string, unknown> };
    method: string;
  },
): Promise<User> {
  checkAge(ctx, input.dob);
  const child = needsParentalConsent(ctx, input.dob);
  if (child && !input.guardianEmail) throw new ProblemError(422, "GUARDIAN_EMAIL_REQUIRED", undefined, { consent_age: ctx.config.parental.consent_age });
  const accepted = child ? [] : await assertSignupAcceptance(ctx, db, input.accepted);
  let canonical: string | null = null;
  if (input.username) canonical = await assertUsernameAvailable(ctx, db, input.username, null);
  const state = !input.emailVerified ? "pending_email_verification" : child ? "pending_parental_consent" : "active";
  let user = await insertUser(ctx, db, { email: input.email, emailVerified: input.emailVerified, dob: input.dob, locale: input.locale, state });
  if (input.username && canonical) {
    await applyUsername(ctx, db, user, input.username, canonical, "initial", { type: "user", id: user.id });
    user = (await getUser(db, user.id))!;
  }
  if (input.identity) {
    await db
      .insertInto("identities")
      .values({
        id: uuidv7(),
        user_id: user.id,
        type: input.identity.type,
        subject: input.identity.subject,
        email: input.identity.email,
        email_verified: input.identity.email_verified,
        secret: input.identity.secret ?? null,
        data: JSON.stringify(input.identity.data ?? {}),
        last_used_at: new Date(),
      })
      .execute();
  }
  await securityEvent(db, { userId: user.id, type: "account.registered", ip: input.ip, port: input.port ?? null, country: input.country ?? null, userAgent: input.ua ?? null, data: { method: input.method } });
  if (!child) await acceptDocuments(ctx, db, user.id, accepted, { ip: input.ip, method: "signup" });
  await runAssurance(ctx, db, user, "signup", accountUrl(ctx, "/"));
  await ctx.emit(db, EVENTS.userCreated, { user_id: user.id, method: input.method, age_band: user.age_band_cached, state }, { actor: { type: "user", id: user.id }, subject: { type: "user", id: user.id } });
  inc("qtiauth_auth_signups_total", { method: input.method, age_band: user.age_band_cached ?? "unknown" }, 1, "Signups");
  if (child && input.emailVerified && input.guardianEmail) await startGuardianConsent(ctx, db, user, input.guardianEmail);
  return user;
}

async function grantBootstrapRoles(ctx: Ctx, db: Parameters<typeof insertUser>[1], userId: string, roles: string[]): Promise<void> {
  for (const role of roles) {
    await db.insertInto("user_roles").values({ user_id: userId, role, granted_by: null }).onConflict((oc) => oc.doNothing()).execute();
  }
  await ctx.audit(db, { actor: { type: "system", id: "bootstrap" }, action: "roles.bootstrap_granted", target: { type: "user", id: userId }, data: { roles } });
}

export function authRoutes(ctx: Ctx): AnyRoute[] {
  const f = ctx.config.features.auth;
  return [
    route({
      method: "POST",
      path: "/api/v1/auth/signup",
      summary: "Sign up with a password",
      description: "Creates an account that must verify its email before it becomes active. The response is identical whether or not the email already has accounts.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_signup"],
      captcha: true,
      body: z.object({
        email: zEmailIn,
        password: zPassword,
        dob: zDob,
        username: z.string().max(64).optional(),
        guardian_email: zEmailIn.optional(),
        accept_legal: zLegalAcceptance,
        bootstrap_token: zToken.optional(),
      }),
      response: z.object({ status: z.literal("verification_sent").or(z.literal("signed_in")) }),
      async handler({ body, id }) {
        requireFeature(f.password.enabled);
        await assertAcceptablePassword(ctx.config, body.password, { email: body.email, username: body.username });
        return ctx.db.transaction().execute(async (trx) => {
          if (body.bootstrap_token) {
            const t = await consumeToken(trx, "admin_bootstrap", body.bootstrap_token);
            if (normalizeEmail(ctx.config, t.email ?? "") !== normalizeEmail(ctx.config, body.email)) throw new ProblemError(422, "BOOTSTRAP_EMAIL_MISMATCH");
            const user = await createAccount(ctx, trx, {
              email: body.email,
              emailVerified: true,
              dob: body.dob,
              locale: id.locale,
              username: body.username,
              accepted: body.accept_legal,
              ip: id.ip,
              port: id.port ?? null,
              country: id.country,
              ua: id.ua,
              identity: { type: "password", subject: null, email: body.email, email_verified: true, secret: await hashPassword(ctx.config, body.password) },
              method: "password",
            });
            await grantBootstrapRoles(ctx, trx, user.id, (t.data.roles as string[]) ?? ["admin"]);
            const created = await createSession(ctx, trx, { userId: user.id, aal: 1, amr: ["pwd"], method: "password", meta: metaOf(id) });
            return reply(200, signedInBody(ctx, user, 1), created.headers);
          }
          const normalized = normalizeEmail(ctx.config, body.email);
          if ((await countAccountsForEmail(trx, normalized)) >= ctx.config.accounts.max_per_email) {
            await ctx.email(trx, { template: "signup_limit_reached", to: { email: body.email }, locale: id.locale, vars: { login_url: accountUrl(ctx, "/login") }, sender: "auth", priority: "high" });
            await hashPassword(ctx.config, body.password);
            return { status: "verification_sent" as const };
          }
          checkAge(ctx, body.dob);
          if (needsParentalConsent(ctx, body.dob) && !body.guardian_email) throw new ProblemError(422, "GUARDIAN_EMAIL_REQUIRED", undefined, { consent_age: ctx.config.parental.consent_age });
          const user = await createAccount(ctx, trx, {
            email: body.email,
            emailVerified: false,
            dob: body.dob,
            locale: id.locale,
            username: body.username,
            guardianEmail: body.guardian_email,
            accepted: body.accept_legal,
            ip: id.ip,
            port: id.port ?? null,
            country: id.country,
            ua: id.ua,
            identity: { type: "password", subject: null, email: body.email, email_verified: false, secret: await hashPassword(ctx.config, body.password) },
            method: "password",
          });
          await sendVerification(ctx, trx, user, body.guardian_email ? { guardian_email: body.guardian_email } : {});
          return { status: "verification_sent" as const };
        });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/verify-email",
      summary: "Verify an email address",
      description: "Consumes an email verification link. Activates the account (or moves it to parental consent) and signs the user in.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_verify"],
      body: z.object({ token: zToken }),
      async handler({ body, id }) {
        return ctx.db.transaction().execute(async (trx) => {
          const t = await consumeToken(trx, "email_verify", body.token);
          let user = await requireUser(trx, t.user_id!);
          if (user.email !== t.email) throw new ProblemError(400, "INVALID_OR_EXPIRED_TOKEN");
          await trx.updateTable("users").set({ email_verified_at: new Date() }).where("id", "=", user.id).execute();
          await trx.updateTable("identities").set({ email_verified: true }).where("user_id", "=", user.id).where("email", "=", user.email).execute();
          if (user.state === "pending_email_verification") {
            const child = needsParentalConsent(ctx, user.dob!);
            user = await setState(ctx, trx, user, child ? "pending_parental_consent" : "active", { type: "user", id: user.id }, { email_verified_at: new Date() });
            const guardianEmail = typeof t.data.guardian_email === "string" ? t.data.guardian_email : null;
            if (child && guardianEmail) await startGuardianConsent(ctx, trx, user, guardianEmail);
          }
          const pwd = await trx.selectFrom("identities").select("id").where("user_id", "=", user.id).where("type", "=", "password").executeTakeFirst();
          return finishPrimaryAuth(ctx, trx, user, { method: pwd ? "email_verification" : "magic_link", amr: ["email"], aal: 1, id });
        });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/verify-email/resend",
      summary: "Resend the verification email",
      description: "Always responds the same way, whether or not the email has an unverified account.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["magic_link_email", "magic_link_ip"],
      rate_limit_keys: { email: "email" },
      body: z.object({ email: zEmailIn }),
      async handler({ body }) {
        await ctx.db.transaction().execute(async (trx) => {
          const users = await usersByEmail(trx, normalizeEmail(ctx.config, body.email));
          for (const u of users.filter((x) => x.state === "pending_email_verification" && x.email?.toLowerCase() === body.email.toLowerCase())) {
            const prev = await trx.selectFrom("tokens").select("data").where("user_id", "=", u.id).where("kind", "=", "email_verify").orderBy("created_at", "desc").executeTakeFirst();
            await sendVerification(ctx, trx, u, (prev?.data as Record<string, unknown>) ?? {});
          }
        });
        return { status: "sent_if_exists" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/login",
      summary: "Sign in with email (or username) and password",
      description: "Returns signed_in, or mfa_required with a short-lived token for the second factor. Failures always say INVALID_CREDENTIALS and take the same time whether or not the account exists.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_password"],
      rate_limit_keys: { account: "identifier" },
      captcha: true,
      allow_account_states: [...ALL_STATES],
      body: z.object({ identifier: z.string().min(1).max(254), password: zPassword }),
      async handler({ body, id }) {
        requireFeature(f.password.enabled);
        const ident = body.identifier.trim();
        const isEmail = ident.includes("@");
        const candidates = isEmail
          ? await usersByEmail(ctx.db, normalizeEmail(ctx.config, ident))
          : await ctx.db.selectFrom("users").selectAll().where("username_canonical", "=", ident.normalize("NFKC").toLowerCase()).where("state", "<>", "deleted").execute();
        const keys = [`ip:${id.ip}`, ...candidates.map((c) => `acct:${c.id}`), `ident:${ident.toLowerCase()}`];
        await applyProgressiveDelay(ctx, keys);
        let matched: { user: User; hash: string; identityId: string } | null = null;
        const withPassword = candidates.length
          ? await ctx.db.selectFrom("identities").select(["id", "user_id", "secret"]).where("type", "=", "password").where("user_id", "in", candidates.map((c) => c.id)).execute()
          : [];
        if (!withPassword.length) await dummyVerify(ctx.config, body.password);
        for (const pi of withPassword) {
          if (pi.secret && (await verifyPassword(pi.secret, body.password))) {
            matched = { user: candidates.find((c) => c.id === pi.user_id)!, hash: pi.secret, identityId: pi.id };
            break;
          }
        }
        if (!matched) {
          await recordFailure(ctx, keys);
          inc("qtiauth_auth_password_failures_total", {}, 1, "Password sign-in failures");
          inc("qtiauth_auth_sign_ins_total", { method: "password", result: "failure" }, 1, "Sign-in attempts");
          for (const c of candidates) {
            await securityEvent(ctx.db, { userId: c.id, type: "login.password_failed", ip: id.ip, port: id.port, country: id.country, userAgent: id.ua });
          }
          throw invalidCredentials();
        }
        await clearFailures(ctx, keys);
        const { user } = matched;
        return ctx.db.transaction().execute(async (trx) => {
          if (needsRehash(ctx.config, matched!.hash)) {
            await trx.updateTable("identities").set({ secret: await hashPassword(ctx.config, body.password) }).where("id", "=", matched!.identityId).execute();
          }
          await trx.updateTable("identities").set({ last_used_at: new Date() }).where("id", "=", matched!.identityId).execute();
          return finishPrimaryAuth(ctx, trx, user, { method: "password", amr: ["pwd"], aal: 1, id });
        });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/mfa/passkey-options",
      summary: "Get passkey options for the second-factor step",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["totp_verify"],
      body: z.object({ mfa_token: zToken }),
      async handler({ body }) {
        const t = await peekToken(ctx.db, "mfa_pending", body.mfa_token);
        if (!t?.user_id) throw new ProblemError(400, "INVALID_OR_EXPIRED_TOKEN");
        return authenticationOptions(ctx, ctx.db, t.user_id);
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/mfa/verify",
      summary: "Complete sign-in with a second factor",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["totp_verify"],
      captcha: true,
      allow_account_states: [...ALL_STATES],
      body: z.object({
        mfa_token: zToken,
        method: z.enum(["totp", "recovery_code", "passkey"]),
        code: z.string().max(32).optional(),
        challenge_id: z.string().max(64).optional(),
        response: z.record(z.string(), z.unknown()).optional(),
      }),
      async handler({ body, id }) {
        const t = await peekToken(ctx.db, "mfa_pending", body.mfa_token);
        if (!t?.user_id) throw new ProblemError(400, "INVALID_OR_EXPIRED_TOKEN");
        const userId = t.user_id;
        const keys = [`mfa:${userId}`, `ip:${id.ip}`];
        await applyProgressiveDelay(ctx, keys);
        let ok = false;
        let factor = body.method;
        if (body.method === "totp" && body.code) ok = await checkTotp(ctx, ctx.db, userId, body.code);
        if (body.method === "recovery_code" && body.code) ok = await useRecoveryCode(ctx.db, userId, body.code);
        if (body.method === "passkey" && body.challenge_id && body.response) {
          const r = await verifyAuthentication(ctx, ctx.db, body.challenge_id, body.response as never);
          ok = r.userId === userId;
          factor = "passkey";
        }
        if (!ok) {
          await recordFailure(ctx, keys);
          throw new ProblemError(401, "INVALID_SECOND_FACTOR", undefined, {}, { "x-qtiauth-captcha-strike": "1" });
        }
        await clearFailures(ctx, keys);
        return ctx.db.transaction().execute(async (trx) => {
          const pending = await consumeMfaToken(trx, body.mfa_token);
          const user = await requireUser(trx, pending.userId);
          if (factor === "recovery_code") {
            const remaining = (await hasSecondFactor(trx, user.id)).recovery_codes;
            await securityAlert(ctx, trx, user.id, "recovery_code_used", { remaining });
          }
          const amr = [...pending.amr, factor === "totp" ? "otp" : factor === "passkey" ? "hwk" : "rc", "mfa"];
          return finishPrimaryAuth(ctx, trx, user, { method: pending.method, amr, aal: 2, id, skipMfa: true });
        });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/magic-link/start",
      summary: "Send a sign-in link",
      description: "Emails a single-use sign-in link. The response is identical whether or not an account exists; a link for an unknown email starts signup.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["magic_link_email", "magic_link_ip", "magic_link_ip_day"],
      rate_limit_keys: { email: "email" },
      captcha: true,
      body: z.object({ email: zEmailIn, return_to: z.string().max(512).optional() }),
      async handler({ body, id }) {
        requireFeature(f.magic_link.enabled);
        await ctx.db.transaction().execute(async (trx) => {
          const normalized = normalizeEmail(ctx.config, body.email);
          const users = (await usersByEmail(trx, normalized)).filter((u) => u.state !== "pending_email_verification" || u.email?.toLowerCase() === body.email.toLowerCase());
          const { token } = await issueToken(trx, "magic_link", {
            email: body.email.trim(),
            data: { user_ids: users.map((u) => u.id), return_to: body.return_to ?? null },
            ttlMs: ctx.config.magic_link.ttl,
          });
          await ctx.email(trx, {
            template: users.length ? "magic_link" : "magic_link_signup",
            to: { email: body.email.trim() },
            locale: users[0]?.locale ?? id.locale,
            vars: { link_url: accountUrl(ctx, "/auth/magic", { token }), expires_minutes: Math.round(ctx.config.magic_link.ttl / 60_000) },
            sender: "auth",
            priority: "high",
          });
          inc("qtiauth_magic_links_total", { result: "sent" }, 1, "Magic links");
        });
        return { status: "sent_if_exists" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/magic-link/verify",
      summary: "Use a sign-in link",
      description: "Called by the Confirm sign-in page (a POST, so email scanners that prefetch links do not consume the token).",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_verify"],
      allow_account_states: [...ALL_STATES],
      body: z.object({ token: zToken }),
      async handler({ body, id }) {
        requireFeature(f.magic_link.enabled);
        return ctx.db.transaction().execute(async (trx) => {
          let t;
          try {
            t = await consumeToken(trx, "magic_link", body.token);
          } catch (e) {
            inc("qtiauth_magic_links_total", { result: "expired" }, 1, "Magic links");
            throw e;
          }
          inc("qtiauth_magic_links_total", { result: "used" }, 1, "Magic links");
          const email = t.email!;
          const ids = (t.data.user_ids as string[]) ?? [];
          const users = (await Promise.all(ids.map((u) => getUser(trx, u)))).filter((u): u is User => Boolean(u && u.state !== "deleted"));
          for (const u of users) {
            if (!u.email_verified_at && u.email?.toLowerCase() === email.toLowerCase()) {
              await trx.updateTable("users").set({ email_verified_at: new Date() }).where("id", "=", u.id).execute();
              if (u.state === "pending_email_verification") {
                await setState(ctx, trx, u, needsParentalConsent(ctx, u.dob!) ? "pending_parental_consent" : "active", { type: "user", id: u.id });
              }
            }
          }
          const fresh = (await Promise.all(users.map((u) => getUser(trx, u.id)))).filter((u): u is User => Boolean(u));
          if (!fresh.length) {
            const { token } = await issueToken(trx, "signup_continue", { email, data: { method: "magic_link", return_to: t.data.return_to ?? null }, ttlMs: ctx.config.accounts.signup_continue_ttl });
            return { status: "signup_required", signup_token: token, email, needs_email: false };
          }
          if (fresh.length > 1) {
            const { token } = await issueToken(trx, "account_choice", { email, data: { user_ids: fresh.map((u) => u.id) }, ttlMs: 10 * 60_000 });
            return {
              status: "choose_account",
              choice_token: token,
              accounts: fresh.map((u) => ({ id: u.id, username: u.username, created_at: u.created_at.toISOString() })),
              can_create: fresh.length < ctx.config.accounts.max_per_email,
            };
          }
          return finishPrimaryAuth(ctx, trx, fresh[0]!, { method: "magic_link", amr: ["email"], aal: 1, id });
        });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/account-choice",
      summary: "Choose which account to sign in to",
      description: "When one email has several accounts, the sign-in link lets the user pick one, or start a new account if the limit allows.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_verify"],
      allow_account_states: [...ALL_STATES],
      body: z.object({ choice_token: zToken, user_id: z.string().max(64) }),
      async handler({ body, id }) {
        return ctx.db.transaction().execute(async (trx) => {
          const t = await consumeToken(trx, "account_choice", body.choice_token);
          const ids = (t.data.user_ids as string[]) ?? [];
          if (body.user_id === "new") {
            if (ids.length >= ctx.config.accounts.max_per_email) throw new ProblemError(409, "ACCOUNT_LIMIT_REACHED");
            const { token } = await issueToken(trx, "signup_continue", { email: t.email, data: { method: "magic_link" }, ttlMs: ctx.config.accounts.signup_continue_ttl });
            return { status: "signup_required", signup_token: token, email: t.email, needs_email: false };
          }
          if (!ids.includes(body.user_id)) throw new ProblemError(400, "INVALID_ACCOUNT_CHOICE");
          const user = await requireUser(trx, body.user_id);
          return finishPrimaryAuth(ctx, trx, user, { method: "magic_link", amr: ["email"], aal: 1, id });
        });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/signup/complete",
      summary: "Finish signing up after a sign-in link or provider sign-in",
      description: "Collects date of birth (and a guardian email for under-age users) after the email or provider identity has been proven.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_general"],
      body: z.object({
        signup_token: zToken,
        dob: zDob,
        username: z.string().max(64).optional(),
        guardian_email: zEmailIn.optional(),
        email: zEmailIn.optional(),
        accept_legal: zLegalAcceptance,
      }),
      async handler({ body, id }) {
        return ctx.db.transaction().execute(async (trx) => {
          const t = await consumeToken(trx, "signup_continue", body.signup_token);
          const provider = t.data.provider as (ProviderProfile & { provider: string; identity_type: string }) | undefined;
          let email = t.email;
          let verified = true;
          if (provider && (!provider.email || !provider.email_verified)) {
            email = body.email ?? provider.email;
            verified = false;
            if (!email) throw new ProblemError(422, "EMAIL_REQUIRED");
          }
          if (!email) throw new ProblemError(422, "EMAIL_REQUIRED");
          const normalized = normalizeEmail(ctx.config, email);
          if ((await countAccountsForEmail(trx, normalized)) >= ctx.config.accounts.max_per_email) throw new ProblemError(409, "ACCOUNT_LIMIT_REACHED");
          if (provider) {
            const linked = await trx.selectFrom("identities").select("user_id").where("type", "=", provider.identity_type).where("subject", "=", provider.subject).executeTakeFirst();
            if (linked) throw new ProblemError(409, "IDENTITY_IN_USE");
          }
          const dob = provider?.birthdate ?? body.dob;
          const user = await createAccount(ctx, trx, {
            email,
            emailVerified: verified,
            dob,
            locale: id.locale,
            username: body.username,
            guardianEmail: body.guardian_email,
            accepted: body.accept_legal,
            ip: id.ip,
            port: id.port ?? null,
            country: id.country,
            ua: id.ua,
            identity: provider
              ? { type: provider.identity_type, subject: provider.subject, email: provider.email, email_verified: provider.email_verified, data: { display_name: provider.display_name, ...provider.data } }
              : undefined,
            method: provider ? provider.provider : "magic_link",
          });
          if (!verified) {
            await sendVerification(ctx, trx, user, body.guardian_email ? { guardian_email: body.guardian_email } : {});
            return { status: "verification_sent" };
          }
          const created = await createSession(ctx, trx, { userId: user.id, aal: 1, amr: [provider ? "fed" : "email"], method: provider ? provider.provider : "magic_link", meta: metaOf(id) });
          return reply(200, signedInBody(ctx, (await getUser(trx, user.id))!, 1), created.headers);
        });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/passkey/options",
      summary: "Start a passkey sign-in",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_general"],
      async handler() {
        requireFeature(f.passkeys.enabled);
        return authenticationOptions(ctx, ctx.db, null);
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/passkey/verify",
      summary: "Finish a passkey sign-in",
      description: "A passkey counts as two factors (aal2).",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_password"],
      allow_account_states: [...ALL_STATES],
      body: z.object({ challenge_id: z.string().max(64), response: z.record(z.string(), z.unknown()) }),
      async handler({ body, id }) {
        requireFeature(f.passkeys.enabled);
        const r = await verifyAuthentication(ctx, ctx.db, body.challenge_id, body.response as never);
        return ctx.db.transaction().execute(async (trx) => {
          const user = await requireUser(trx, r.userId);
          return finishPrimaryAuth(ctx, trx, user, { method: "passkey", amr: ["hwk", "user"], aal: 2, id });
        });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/password/forgot",
      summary: "Send a password reset link",
      description: "Always responds the same way. The link is single-use and expires after password.reset_ttl.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["password_reset"],
      rate_limit_keys: { email: "email" },
      captcha: true,
      body: z.object({ email: zEmailIn }),
      async handler({ body }) {
        requireFeature(f.password.enabled);
        await ctx.db.transaction().execute(async (trx) => {
          const users = (await usersByEmail(trx, normalizeEmail(ctx.config, body.email))).filter((u) => u.email_verified_at);
          for (const u of users) {
            await invalidateTokens(trx, u.id, ["password_reset"]);
            const { token } = await issueToken(trx, "password_reset", { userId: u.id, email: u.email, ttlMs: ctx.config.password.reset_ttl });
            await ctx.email(trx, {
              template: "password_reset",
              to: { user_id: u.id },
              locale: u.locale,
              vars: { name: displayName(u), reset_url: accountUrl(ctx, "/reset-password", { token }), expires_minutes: Math.round(ctx.config.password.reset_ttl / 60_000), username: u.username },
              sender: "security",
              priority: "high",
            });
          }
        });
        return { status: "sent_if_exists" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/password/reset",
      summary: "Set a new password from a reset link",
      description: "Revokes every other session unless keep_other_sessions is true. The checkbox for that is unticked by default.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_verify"],
      allow_account_states: [...ALL_STATES],
      body: z.object({ token: zToken, password: zPassword, keep_other_sessions: z.boolean().default(false) }),
      async handler({ body, id }) {
        const peek = await peekToken(ctx.db, "password_reset", body.token);
        if (!peek?.user_id) throw new ProblemError(400, "INVALID_OR_EXPIRED_TOKEN");
        const user = await requireUser(ctx.db, peek.user_id);
        await assertAcceptablePassword(ctx.config, body.password, { email: user.email, username: user.username });
        const hash = await hashPassword(ctx.config, body.password);
        await ctx.db.transaction().execute(async (trx) => {
          await consumeToken(trx, "password_reset", body.token);
          const existing = await trx.selectFrom("identities").select("id").where("user_id", "=", user.id).where("type", "=", "password").executeTakeFirst();
          if (existing) await trx.updateTable("identities").set({ secret: hash }).where("id", "=", existing.id).execute();
          else await trx.insertInto("identities").values({ id: uuidv7(), user_id: user.id, type: "password", subject: null, email: user.email, email_verified: true, secret: hash, data: "{}" }).execute();
          if (!body.keep_other_sessions) await revokeAllSessions(ctx, trx, user.id, "password_reset", { type: "user", id: user.id }, id.sid);
          await securityEvent(trx, { userId: user.id, type: "password.reset", ip: id.ip, port: id.port, country: id.country, userAgent: id.ua, data: { kept_sessions: body.keep_other_sessions } });
          await securityAlert(ctx, trx, user.id, "password_changed", { method: "reset" }, { throttleKey: `pw-${Date.now()}` });
          await ctx.audit(trx, { actor: { type: "user", id: user.id }, action: "password.reset", target: { type: "user", id: user.id }, ip: id.ip });
        });
        return { status: "password_reset" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/logout",
      summary: "Sign out",
      description: "Ends the session on every surface and host.",
      tags,
      ...openSession,
      allow_account_states: [...ALL_STATES],
      principals: ["user", "guardian"],
      rate_limit: ["account_write"],
      async handler({ id }) {
        if (id.sid) await ctx.db.transaction().execute((trx) => revokeSession(ctx, trx, id.sid!, "logout", { type: id.principal === "guardian" ? "guardian" : "user", id: id.sub ?? id.gid ?? "unknown" }));
        return reply(200, { status: "signed_out" }, { [SESSION_CLEAR_HEADER]: "1" });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/step-up/options",
      summary: "Start a step-up or re-authentication",
      description: "Lists the methods that satisfy step-up for this account, and starts the chosen one (passkey challenge or emailed link).",
      tags,
      ...openSession,
      rate_limit: ["totp_verify"],
      body: z.object({ method: z.enum(["passkey", "totp", "recovery_code", "password", "magic_link"]).optional() }),
      async handler({ body, id }) {
        const userId = id.sub!;
        const user = await requireUser(ctx.db, userId);
        const factors = await hasSecondFactor(ctx.db, userId);
        const pwd = await ctx.db.selectFrom("identities").select("id").where("user_id", "=", userId).where("type", "=", "password").executeTakeFirst();
        const strong = factors.totp || factors.passkeys > 0;
        const methods = [
          ...(factors.passkeys > 0 ? ["passkey"] : []),
          ...(factors.totp ? ["totp"] : []),
          ...(factors.recovery_codes > 0 && strong ? ["recovery_code"] : []),
          ...(!strong && pwd ? ["password"] : []),
          ...(f.magic_link.enabled && user.email_verified_at && (!strong || id.aal === 0) ? ["magic_link"] : []),
        ];
        if (!body.method) return { methods };
        if (!methods.includes(body.method)) throw new ProblemError(400, "STEP_UP_METHOD_NOT_AVAILABLE", undefined, { methods });
        if (body.method === "passkey") return { methods, ...(await authenticationOptions(ctx, ctx.db, userId, { session_id: id.sid })) };
        if (body.method === "magic_link") {
          await ctx.db.transaction().execute(async (trx) => {
            const { token } = await issueToken(trx, "step_up_link", { userId, email: user.email, data: { session_id: id.sid }, ttlMs: ctx.config.magic_link.ttl });
            await ctx.email(trx, {
              template: "step_up_link",
              to: { user_id: userId },
              locale: user.locale,
              vars: { name: displayName(user), link_url: accountUrl(ctx, "/auth/confirm", { token }) },
              sender: "security",
              priority: "high",
            });
          });
          return { methods, status: "link_sent" };
        }
        return { methods };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/auth/step-up/verify",
      summary: "Complete a step-up or re-authentication",
      tags,
      ...openSession,
      rate_limit: ["totp_verify"],
      body: z.object({
        method: z.enum(["passkey", "totp", "recovery_code", "password", "magic_link"]),
        password: zPassword.optional(),
        code: z.string().max(32).optional(),
        token: zToken.optional(),
        challenge_id: z.string().max(64).optional(),
        response: z.record(z.string(), z.unknown()).optional(),
      }),
      async handler({ body, id }) {
        const userId = id.sub!;
        const factors = await hasSecondFactor(ctx.db, userId);
        const strong = factors.totp || factors.passkeys > 0;
        const keys = [`stepup:${userId}`];
        await applyProgressiveDelay(ctx, keys);
        let ok = false;
        let aal: 1 | 2 = 1;
        let elevates = false;
        if (body.method === "passkey" && body.challenge_id && body.response) {
          const r = await verifyAuthentication(ctx, ctx.db, body.challenge_id, body.response as never);
          ok = r.userId === userId;
          aal = 2;
          elevates = true;
        } else if (body.method === "totp" && body.code) {
          ok = await checkTotp(ctx, ctx.db, userId, body.code);
          if (ok && body.password) {
            const pi = await ctx.db.selectFrom("identities").select("secret").where("user_id", "=", userId).where("type", "=", "password").executeTakeFirst();
            ok = Boolean(pi?.secret && (await verifyPassword(pi.secret, body.password)));
          }
          aal = 2;
          elevates = true;
        } else if (body.method === "recovery_code" && body.code && strong) {
          ok = await useRecoveryCode(ctx.db, userId, body.code);
          aal = 2;
          elevates = true;
        } else if (body.method === "password" && body.password) {
          const pi = await ctx.db.selectFrom("identities").select("secret").where("user_id", "=", userId).where("type", "=", "password").executeTakeFirst();
          ok = Boolean(pi?.secret && (await verifyPassword(pi.secret, body.password)));
          elevates = !strong;
          if (strong) ok = false;
        } else if (body.method === "magic_link" && body.token) {
          const t = await peekToken(ctx.db, "step_up_link", body.token);
          ok = Boolean(t && t.user_id === userId && t.data.session_id === id.sid);
          if (ok) await consumeToken(ctx.db, "step_up_link", body.token);
          elevates = !strong;
        }
        inc("qtiauth_step_up_prompts_total", { method: body.method, result: ok ? "success" : "failure" }, 1, "Step-up attempts");
        if (!ok) {
          await recordFailure(ctx, keys);
          throw new ProblemError(401, "STEP_UP_FAILED");
        }
        await clearFailures(ctx, keys);
        await ctx.db.transaction().execute(async (trx) => {
          await markReauthenticated(ctx, trx, id.sid!, aal, body.method, metaOf(id));
          if (!elevates) await trx.updateTable("sessions").set({ step_up_at: null }).where("id", "=", id.sid!).where("aal", "<", 2).execute();
        });
        return { status: "ok", step_up: elevates, aal };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/auth/social/:provider/start",
      summary: "Start sign-in (or connect) with a social or upstream provider",
      description: "Redirects to the provider. intent=connect needs a signed-in session and only links when the user explicitly chose it.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_general"],
      params: z.object({ provider: z.string().max(80) }),
      query: z.object({ intent: z.enum(["login", "connect"]).default("login"), return_to: z.string().max(512).optional() }),
      async handler({ params, query, id }) {
        const provider = enabledProviders(ctx).get(params.provider);
        if (!provider) throw new ProblemError(404, "PROVIDER_NOT_ENABLED");
        if (query.intent === "login" && provider.id === "steam" && !f.social.steam.enabled) throw new ProblemError(404, "PROVIDER_NOT_ENABLED");
        if (query.intent === "connect" && (!id.sub || id.auth !== "session")) throw new ProblemError(401, "UNAUTHENTICATED");
        const state = randomToken(24);
        const secrets = newFlowSecrets();
        const flow: FlowState = {
          provider: provider.id,
          intent: query.intent,
          user_id: query.intent === "connect" ? id.sub! : null,
          session_id: query.intent === "connect" ? (id.sid ?? null) : null,
          return_to: safeReturn(query.return_to),
          verifier: secrets.verifier,
          nonce: secrets.nonce,
          redirect_uri: callbackUri(ctx, provider.id),
        };
        await setJson(ctx.valkey, `social:${state}`, flow, 10 * 60_000);
        return reply(302, undefined, { location: await provider.authorizeUrl(state, flow), "cache-control": "no-store" });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/auth/social/:provider/callback",
      summary: "Provider callback",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_general"],
      allow_account_states: [...ALL_STATES],
      params: z.object({ provider: z.string().max(80) }),
      async handler({ params, id, c }) {
        const url = new URL(c.req.url);
        const state = url.searchParams.get("state") ?? "";
        const flow = await takeJson<FlowState>(ctx.valkey, `social:${state}`);
        const fail = (code: string) => reply(302, undefined, { location: accountUrl(ctx, "/auth/social/result", { error: code }), "cache-control": "no-store" });
        if (!flow || flow.provider !== params.provider) return fail("STATE_MISMATCH");
        const provider = enabledProviders(ctx).get(params.provider);
        if (!provider) return fail("PROVIDER_NOT_ENABLED");
        let profile: ProviderProfile;
        try {
          profile = await provider.callback(url.searchParams, flow);
        } catch (err) {
          ctx.log.warn({ provider: params.provider, problem_code: (err as ProblemError).code }, "social callback failed");
          return fail((err as ProblemError).code ?? "PROVIDER_ERROR");
        }
        const existing = await ctx.db.selectFrom("identities").selectAll().where("type", "=", provider.identityType).where("subject", "=", profile.subject).executeTakeFirst();
        if (flow.intent === "connect") {
          if (!flow.user_id || id.sub !== flow.user_id) return fail("SESSION_CHANGED");
          if (existing && existing.user_id !== flow.user_id) return fail("IDENTITY_IN_USE");
          if (!existing) {
            await ctx.db.transaction().execute(async (trx) => {
              await trx
                .insertInto("identities")
                .values({
                  id: uuidv7(),
                  user_id: flow.user_id!,
                  type: provider.identityType,
                  subject: profile.subject,
                  email: profile.email,
                  email_verified: profile.email_verified,
                  data: JSON.stringify({ display_name: profile.display_name, ...profile.data }),
                  last_used_at: new Date(),
                })
                .execute();
              await securityEvent(trx, { userId: flow.user_id, type: "identity.connected", ip: id.ip, port: id.port, country: id.country, userAgent: id.ua, data: { provider: provider.id } });
              await securityAlert(ctx, trx, flow.user_id!, "identity_connected", { provider: provider.name }, { throttleKey: `idc-${provider.id}` });
              await ctx.audit(trx, { actor: { type: "user", id: flow.user_id! }, action: "identity.connected", target: { type: "user", id: flow.user_id! }, data: { provider: provider.id } });
              if (provider.id === "steam") await ctx.emit(trx, EVENTS.userUpdated, { user_id: flow.user_id, reason: "steam_linked", steam_id: profile.subject }, { subject: { type: "user", id: flow.user_id! } });
            });
          }
          return reply(302, undefined, { location: accountUrl(ctx, "/auth/social/result", { status: "connected", provider: provider.id, return_to: flow.return_to }), "cache-control": "no-store" });
        }
        if (existing) {
          return ctx.db.transaction().execute(async (trx) => {
            const user = await getUser(trx, existing.user_id);
            if (!user || user.state === "deleted") return fail("ACCOUNT_UNAVAILABLE");
            await trx.updateTable("identities").set({ last_used_at: new Date() }).where("id", "=", existing.id).execute();
            const r = await finishPrimaryAuth(ctx, trx, user, { method: provider.id, amr: ["fed"], aal: 1, id });
            const body = r.body as { status: string; mfa_token?: string };
            const params: Record<string, string> = { status: body.status, return_to: flow.return_to };
            if (body.mfa_token) params.mfa_token = body.mfa_token;
            return reply(302, undefined, { ...r.headers, location: accountUrl(ctx, "/auth/social/result", params), "cache-control": "no-store" });
          });
        }
        const { token } = await issueToken(ctx.db, "signup_continue", {
          email: profile.email_verified ? profile.email : null,
          data: { provider: { ...profile, provider: provider.id, identity_type: provider.identityType }, return_to: flow.return_to },
          ttlMs: ctx.config.accounts.signup_continue_ttl,
        });
        return reply(302, undefined, {
          location: accountUrl(ctx, "/signup/complete", {
            token,
            provider: provider.id,
            needs_email: String(!profile.email_verified || !profile.email),
            needs_dob: String(!profile.birthdate),
            ...(profile.email ? { email: profile.email } : {}),
          }),
          "cache-control": "no-store",
        });
      },
    }),
  ];
}

export function safeReturn(input: string | undefined): string {
  if (!input) return "/";
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\")) return "/";
  return input.slice(0, 512);
}
