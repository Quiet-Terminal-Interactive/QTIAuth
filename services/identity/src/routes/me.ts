import { z } from "zod";
import { ProblemError, uuidv7 } from "@qtiauth/common";
import { reply, route, type AnyRoute } from "@qtiauth/service-kit";
import { SESSION_CLEAR_HEADER, type NotificationCategory } from "@qtiauth/auth-context";
import { EVENTS } from "@qtiauth/bus";
import type { Ctx, Exec } from "../lib/ctx.ts";
import type { User } from "../db/types.ts";
import { accountUrl, openSession, zEmailIn, zPassword, zToken, RESTRICTED_STATES } from "./common.ts";
import { bandOf, countAccountsForEmail, displayName, normalizeEmail, requireUser, ageYears } from "../lib/users.ts";
import { assertAcceptablePassword, hashPassword, verifyPassword } from "../lib/passwords.ts";
import { consumeToken, issueToken, invalidateTokens } from "../lib/tokens.ts";
import { acceptDocuments, pendingDocumentsFor } from "../lib/legal.ts";
import { assertCanChange, assertUsernameAvailable, applyUsername, usernameHistory } from "../lib/usernames.ts";
import { recentAuth, requireRecentAuth, requireStepUp, stepUpOk } from "../lib/auth.ts";
import { decryptTotpSecret, encryptTotpSecret, generateRecoveryCodes, hasSecondFactor } from "../lib/mfa.ts";
import { completeRegistration, registrationOptions } from "../lib/passkeys.ts";
import { revokeAllSessions, revokeSession, sessionList } from "../lib/sessions.ts";
import { securityAlert, securityEvent } from "../lib/security.ts";
import { enabledProviders } from "../lib/social/providers.ts";
import { generateTotpSecret, otpauthUri, verifyTotp } from "../lib/totp.ts";
import { exportStatus, requestExport } from "../lib/exports.ts";
import { requestDeletion } from "../lib/deletion.ts";
import { completeAssurance, runAssurance } from "../lib/age.ts";
import { createGuardianRequest, removeGuardianLinks, sendConsentEmail, startGuardianConsent } from "../lib/parental.ts";
import { userRoles } from "../lib/roles.ts";

const tags = ["account"];

export const IDENTITY_CATEGORIES: NotificationCategory[] = [
  { id: "security", label: "Security alerts", description: "New sign-ins, password and two-factor changes", locked: true, default: true },
  { id: "legal", label: "Legal updates", description: "Changes to the terms and privacy policy", locked: true, default: true },
  { id: "account", label: "Account updates", description: "Username changes and account notices", default: true },
];

export async function signInMethods(ctx: Ctx, db: Exec, user: User) {
  const identities = await db.selectFrom("identities").selectAll().where("user_id", "=", user.id).orderBy("created_at").execute();
  const passkeys = await db.selectFrom("passkeys").select(["id", "name", "created_at", "last_used_at", "backed_up", "device_type"]).where("user_id", "=", user.id).orderBy("created_at").execute();
  const providers = enabledProviders(ctx);
  const magicLink = ctx.config.features.auth.magic_link.enabled && Boolean(user.email_verified_at);
  const usable = identities.filter((i) => i.type === "password" ? ctx.config.features.auth.password.enabled : providers.has(i.type.startsWith("oidc:") ? i.type : i.type));
  const count = usable.length + (ctx.config.features.auth.passkeys.enabled ? passkeys.length : 0) + (magicLink ? 1 : 0);
  return {
    count,
    magic_link: magicLink,
    identities: identities.map((i) => ({
      id: i.id,
      type: i.type,
      email: i.email,
      email_verified: i.email_verified,
      display_name: (i.data as { display_name?: string }).display_name ?? null,
      created_at: i.created_at.toISOString(),
      last_used_at: i.last_used_at?.toISOString() ?? null,
      unlink_allowed_at: i.unlink_allowed_at?.toISOString() ?? null,
    })),
    passkeys: passkeys.map((p) => ({ id: p.id, name: p.name, created_at: p.created_at.toISOString(), last_used_at: p.last_used_at?.toISOString() ?? null, synced: p.backed_up, device_type: p.device_type })),
  };
}

function lastMethodError(ctx: Ctx): ProblemError {
  return new ProblemError(409, "LAST_SIGN_IN_METHOD", "This is your last available sign-in method. Either add another to remove this one or, if you are attempting to delete your account, go to Delete account.", {
    delete_account_url: accountUrl(ctx, "/settings/delete"),
  });
}

async function categories(ctx: Ctx): Promise<NotificationCategory[]> {
  const fromGateway = await ctx.rpcOptional<NotificationCategory[]>("gateway.notification_categories", {}, []).catch(() => [] as NotificationCategory[]);
  const all = new Map<string, NotificationCategory>();
  for (const c of [...IDENTITY_CATEGORIES, ...fromGateway]) all.set(c.id, c);
  return [...all.values()];
}

export function meRoutes(ctx: Ctx): AnyRoute[] {
  const f = ctx.config.features.auth;
  return [
    route({
      method: "GET",
      path: "/api/v1/me",
      summary: "The signed-in account",
      tags,
      ...openSession,
      allow_account_states: ["pending_email_verification", "pending_parental_consent", "active", "locked", "banned", "pending_deletion"],
      async handler({ id }) {
        const user = await requireUser(ctx.db, id.sub!);
        const methods = await signInMethods(ctx, ctx.db, user);
        const factors = await hasSecondFactor(ctx.db, user.id);
        const pendingLegal = await pendingDocumentsFor(ctx.db, user);
        const guardians = await ctx.db.selectFrom("guardians").select(["id", "email", "status"]).where("child_user_id", "=", user.id).where("status", "in", ["pending", "active"]).execute();
        return {
          id: user.id,
          email: user.email,
          email_verified: Boolean(user.email_verified_at),
          username: user.username,
          needs_username: !user.username || user.force_username_reset,
          force_username_reset: user.force_username_reset,
          state: user.state,
          locked_until: user.locked_until?.toISOString() ?? null,
          deletion_due_at: user.deletion_due_at?.toISOString() ?? null,
          age_band: bandOf(ctx, user),
          age_assurance_strength: user.age_assurance_strength,
          locale: user.locale,
          created_at: user.created_at.toISOString(),
          public_profile: user.public_profile,
          leaderboard_visible: user.leaderboard_visible,
          restrictions: id.restrictions,
          parental_controls: user.parental_controls,
          guardians: guardians.map((g) => ({ id: g.id, email: g.email, status: g.status })),
          sign_in_methods: { count: methods.count, magic_link: methods.magic_link, types: methods.identities.map((i) => i.type), passkeys: methods.passkeys.length },
          two_factor: { totp: factors.totp, passkeys: factors.passkeys, recovery_codes_remaining: factors.recovery_codes },
          session: { id: id.sid, aal: id.aal, amr: id.amr, step_up_valid: stepUpOk(ctx, id), trust_level: id.trust_level ?? "full" },
          pending_legal: pendingLegal.map((d) => ({ id: d.id, version: d.version, title: d.title, summary: d.summary })),
          mfa_enrolment_required: Boolean(id.mfa_enrolment_required),
          permissions: id.perms,
          roles: await userRoles(ctx.db, user.id),
        };
      },
    }),

    route({
      method: "PATCH",
      path: "/api/v1/me",
      summary: "Update profile preferences",
      description: "Under-18 accounts default to a private profile and hidden leaderboard entries. Children with guardian controls need their guardian to change these.",
      tags,
      rate_limit: ["account_write"],
      body: z.object({ locale: z.string().max(20).optional(), public_profile: z.boolean().optional(), leaderboard_visible: z.boolean().optional() }),
      async handler({ body, id }) {
        const user = await requireUser(ctx.db, id.sub!);
        const guarded = user.parental_controls && !(user.guardian_controls_optional_at && user.guardian_controls_optional_at <= new Date());
        if (guarded && (body.public_profile !== undefined || body.leaderboard_visible !== undefined)) throw new ProblemError(403, "GUARDIAN_CONTROLLED");
        if (body.locale && !ctx.config.branding.locales.includes(body.locale)) throw new ProblemError(422, "UNSUPPORTED_LOCALE");
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .updateTable("users")
            .set({
              ...(body.locale ? { locale: body.locale } : {}),
              ...(body.public_profile !== undefined ? { public_profile: body.public_profile } : {}),
              ...(body.leaderboard_visible !== undefined ? { leaderboard_visible: body.leaderboard_visible } : {}),
              updated_at: new Date(),
            })
            .where("id", "=", user.id)
            .execute();
          await ctx.emit(trx, EVENTS.userUpdated, { user_id: user.id, reason: "profile", ...body }, { actor: { type: "user", id: user.id }, subject: { type: "user", id: user.id } });
        });
        return { status: "updated" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/email",
      summary: "Change email address",
      description: "Sends a confirmation link to the new address and a notice with a 7-day revert link to the old one. Requires step-up.",
      tags,
      step_up: true,
      rate_limit: ["magic_link_ip"],
      body: z.object({ new_email: zEmailIn }),
      async handler({ body, id }) {
        const user = await requireUser(ctx.db, id.sub!);
        const normalized = normalizeEmail(ctx.config, body.new_email);
        if (normalized === user.email_normalized) throw new ProblemError(422, "EMAIL_UNCHANGED");
        await ctx.db.transaction().execute(async (trx) => {
          if ((await countAccountsForEmail(trx, normalized)) >= ctx.config.accounts.max_per_email) throw new ProblemError(409, "EMAIL_ACCOUNT_LIMIT");
          await invalidateTokens(trx, user.id, ["email_change"]);
          const { token } = await issueToken(trx, "email_change", { userId: user.id, email: body.new_email, data: { old_email: user.email }, ttlMs: ctx.config.accounts.verification_ttl });
          await ctx.email(trx, {
            template: "email_change_confirm",
            to: { email: body.new_email },
            locale: user.locale,
            vars: { name: displayName(user), confirm_url: accountUrl(ctx, "/email/confirm", { token }) },
            sender: "security",
            priority: "high",
          });
        });
        return { status: "confirmation_sent" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/email/confirm",
      summary: "Confirm a new email address",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_verify"],
      body: z.object({ token: zToken }),
      async handler({ body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const t = await consumeToken(trx, "email_change", body.token);
          const user = await requireUser(trx, t.user_id!);
          const oldEmail = user.email;
          const normalized = normalizeEmail(ctx.config, t.email!);
          if ((await countAccountsForEmail(trx, normalized)) >= ctx.config.accounts.max_per_email) throw new ProblemError(409, "EMAIL_ACCOUNT_LIMIT");
          await trx.updateTable("users").set({ email: t.email, email_normalized: normalized, email_verified_at: new Date(), updated_at: new Date() }).where("id", "=", user.id).execute();
          await trx.updateTable("identities").set({ email: t.email, email_verified: true }).where("user_id", "=", user.id).where("type", "=", "password").execute();
          const { token } = await issueToken(trx, "email_revert", { userId: user.id, email: oldEmail, data: { new_email: t.email }, ttlMs: ctx.config.accounts.email_change_revert_ttl });
          if (oldEmail) {
            await ctx.email(trx, {
              template: "email_changed_notice",
              to: { email: oldEmail },
              locale: user.locale,
              vars: { name: displayName(user), new_email: t.email, revert_url: accountUrl(ctx, "/email/revert", { token }) },
              sender: "security",
              priority: "high",
              bypass_suppression: true,
            });
          }
          await securityEvent(trx, { userId: user.id, type: "email.changed", ip: id.ip, port: id.port, country: id.country, userAgent: id.ua });
          await ctx.audit(trx, { actor: { type: "user", id: user.id }, action: "email.changed", target: { type: "user", id: user.id }, ip: id.ip });
          await ctx.emit(trx, EVENTS.userUpdated, { user_id: user.id, reason: "email" }, { actor: { type: "user", id: user.id }, subject: { type: "user", id: user.id } });
        });
        return { status: "email_changed" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/email/revert",
      summary: "Undo an email change (\"this wasn't me\")",
      description: "Restores the previous address, signs the account out everywhere and asks for a password reset.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_verify"],
      body: z.object({ token: zToken }),
      async handler({ body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const t = await consumeToken(trx, "email_revert", body.token);
          const user = await requireUser(trx, t.user_id!);
          await trx.updateTable("users").set({ email: t.email, email_normalized: normalizeEmail(ctx.config, t.email!), email_verified_at: new Date(), updated_at: new Date() }).where("id", "=", user.id).execute();
          await trx.updateTable("identities").set({ email: t.email }).where("user_id", "=", user.id).where("type", "=", "password").execute();
          await invalidateTokens(trx, user.id, ["email_change", "magic_link", "password_reset"]);
          await revokeAllSessions(ctx, trx, user.id, "email_reverted", { type: "user", id: user.id });
          await securityEvent(trx, { userId: user.id, type: "email.reverted", ip: id.ip, port: id.port, country: id.country, userAgent: id.ua });
          await ctx.audit(trx, { actor: { type: "user", id: user.id }, action: "email.reverted", target: { type: "user", id: user.id }, ip: id.ip });
          const { token } = await issueToken(trx, "password_reset", { userId: user.id, email: t.email, ttlMs: ctx.config.password.reset_ttl * 4 });
          await ctx.email(trx, {
            template: "email_reverted",
            to: { email: t.email! },
            locale: user.locale,
            vars: { name: displayName(user), reset_url: accountUrl(ctx, "/reset-password", { token }) },
            sender: "security",
            priority: "high",
            bypass_suppression: true,
          });
        });
        return { status: "email_reverted" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/password",
      summary: "Set or change the password",
      description: "Changing needs the current password or a valid step-up. Adding a password to an account without one needs step-up (magic link or passkey).",
      tags,
      rate_limit: ["auth_password"],
      body: z.object({ current_password: zPassword.optional(), new_password: zPassword }),
      async handler({ body, id }) {
        if (!f.password.enabled) throw new ProblemError(404, "FEATURE_DISABLED");
        const user = await requireUser(ctx.db, id.sub!);
        const existing = await ctx.db.selectFrom("identities").select(["id", "secret"]).where("user_id", "=", user.id).where("type", "=", "password").executeTakeFirst();
        if (existing) {
          const currentOk = body.current_password && existing.secret ? await verifyPassword(existing.secret, body.current_password) : false;
          if (!currentOk && !stepUpOk(ctx, id)) throw new ProblemError(403, body.current_password ? "INVALID_CREDENTIALS" : "STEP_UP_REQUIRED");
        } else {
          requireStepUp(ctx, id);
        }
        await assertAcceptablePassword(ctx.config, body.new_password, { email: user.email, username: user.username });
        const hash = await hashPassword(ctx.config, body.new_password);
        await ctx.db.transaction().execute(async (trx) => {
          if (existing) await trx.updateTable("identities").set({ secret: hash }).where("id", "=", existing.id).execute();
          else await trx.insertInto("identities").values({ id: uuidv7(), user_id: user.id, type: "password", subject: null, email: user.email, email_verified: Boolean(user.email_verified_at), secret: hash, data: "{}" }).execute();
          await revokeAllSessions(ctx, trx, user.id, "password_changed", { type: "user", id: user.id }, id.sid);
          await securityEvent(trx, { userId: user.id, sessionId: id.sid, type: existing ? "password.changed" : "password.added", ip: id.ip, port: id.port, country: id.country, userAgent: id.ua });
          await securityAlert(ctx, trx, user.id, existing ? "password_changed" : "password_added", {}, { throttleKey: `pw-${Date.now()}` });
          await ctx.audit(trx, { actor: { type: "user", id: user.id }, action: existing ? "password.changed" : "password.added", target: { type: "user", id: user.id }, ip: id.ip });
        });
        return { status: existing ? "password_changed" : "password_added" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/me/username/check",
      summary: "Check whether a username is available",
      tags,
      rate_limit: ["account_write"],
      allow_force_username_reset: true,
      query: z.object({ username: z.string().min(1).max(64) }),
      async handler({ query, id }) {
        try {
          await assertUsernameAvailable(ctx, ctx.db, query.username, id.sub!);
          return { available: true };
        } catch (e) {
          if (e instanceof ProblemError && (e.code === "USERNAME_NOT_AVAILABLE" || e.code === "USERNAME_INVALID")) return { available: false, code: e.code };
          throw e;
        }
      },
    }),

    route({
      method: "PUT",
      path: "/api/v1/me/username",
      summary: "Claim or change the username",
      description: "Subject to the cooldown, yearly limit, release holds and the text filter. Children whose guardian requires it get a pending approval instead.",
      tags,
      rate_limit: ["account_write"],
      allow_force_username_reset: true,
      body: z.object({ username: z.string().min(1).max(64) }),
      async handler({ body, id }) {
        const user = await requireUser(ctx.db, id.sub!);
        await assertCanChange(ctx, ctx.db, user);
        return ctx.db.transaction().execute(async (trx) => {
          const canonical = await assertUsernameAvailable(ctx, trx, body.username, user.id);
          if (user.username && user.parental_controls?.username_changes_require_approval && !user.force_username_reset) {
            const requestId = await createGuardianRequest(ctx, trx, user, "username_change", { username: body.username }, user.id);
            return reply(202, { status: "pending_guardian_approval", request_id: requestId });
          }
          await applyUsername(ctx, trx, user, body.username, canonical, user.force_username_reset ? "forced_reset" : "change", { type: "user", id: user.id });
          return { status: "updated", username: body.username };
        });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/me/username/history",
      summary: "Username history",
      tags,
      async handler({ id }) {
        return { items: await usernameHistory(ctx.db, id.sub!) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/me/sessions",
      summary: "Active sessions",
      tags,
      ...openSession,
      async handler({ id }) {
        return { items: await sessionList(ctx.db, id.sub!, id.sid) };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/me/sessions/:id",
      summary: "Revoke a session",
      tags,
      ...openSession,
      rate_limit: ["account_write"],
      params: z.object({ id: z.uuid() }),
      async handler({ params, id }) {
        const s = await ctx.db.selectFrom("sessions").select(["id", "user_id"]).where("id", "=", params.id).executeTakeFirst();
        if (!s || s.user_id !== id.sub) throw new ProblemError(404, "SESSION_NOT_FOUND");
        await ctx.db.transaction().execute((trx) => revokeSession(ctx, trx, s.id, "user_revoked", { type: "user", id: id.sub! }));
        return params.id === id.sid ? reply(200, { status: "revoked" }, { [SESSION_CLEAR_HEADER]: "1" }) : { status: "revoked" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/sessions/revoke-others",
      summary: "Sign out of every other session",
      tags,
      ...openSession,
      rate_limit: ["account_write"],
      async handler({ id }) {
        const n = await ctx.db.transaction().execute((trx) => revokeAllSessions(ctx, trx, id.sub!, "user_revoked_others", { type: "user", id: id.sub! }, id.sid));
        return { revoked: n };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/sessions/revoke-all",
      summary: "Sign out everywhere, including here",
      tags,
      ...openSession,
      rate_limit: ["account_write"],
      async handler({ id }) {
        const n = await ctx.db.transaction().execute((trx) => revokeAllSessions(ctx, trx, id.sub!, "user_revoked_all", { type: "user", id: id.sub! }));
        return reply(200, { revoked: n }, { [SESSION_CLEAR_HEADER]: "1" });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/me/sign-in-methods",
      summary: "Sign-in methods on this account",
      tags,
      ...openSession,
      async handler({ id }) {
        const user = await requireUser(ctx.db, id.sub!);
        const methods = await signInMethods(ctx, ctx.db, user);
        const providers = [...enabledProviders(ctx).values()].map((p) => ({ id: p.id, name: p.name, icon: p.icon, connected: methods.identities.some((i) => i.type === p.identityType) }));
        return { ...methods, providers, totp: (await hasSecondFactor(ctx.db, user.id)).totp };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/me/identities/:id",
      summary: "Remove a sign-in method",
      description: "Refuses to remove the last available sign-in method. Steam links have an unlink cooldown.",
      tags,
      rate_limit: ["account_write"],
      params: z.object({ id: z.uuid() }),
      async handler({ params, id }) {
        requireRecentAuth(ctx, id);
        const user = await requireUser(ctx.db, id.sub!);
        const identity = await ctx.db.selectFrom("identities").selectAll().where("id", "=", params.id).where("user_id", "=", user.id).executeTakeFirst();
        if (!identity) throw new ProblemError(404, "IDENTITY_NOT_FOUND");
        const methods = await signInMethods(ctx, ctx.db, user);
        if (methods.count <= 1) throw lastMethodError(ctx);
        if (identity.type === "steam") {
          const cooldown = ctx.config.features.games.steam.unlink_cooldown;
          if (Date.now() - identity.created_at.getTime() < cooldown) {
            throw new ProblemError(429, "UNLINK_COOLDOWN", undefined, { available_at: new Date(identity.created_at.getTime() + cooldown).toISOString() });
          }
        }
        await ctx.db.transaction().execute(async (trx) => {
          await trx.deleteFrom("identities").where("id", "=", identity.id).execute();
          await securityEvent(trx, { userId: user.id, type: "identity.removed", ip: id.ip, port: id.port, country: id.country, userAgent: id.ua, data: { type: identity.type } });
          await securityAlert(ctx, trx, user.id, "identity_removed", { provider: identity.type }, { throttleKey: `idr-${identity.id}` });
          await ctx.audit(trx, { actor: { type: "user", id: user.id }, action: "identity.removed", target: { type: "user", id: user.id }, data: { type: identity.type } });
          if (identity.type === "steam") await ctx.emit(trx, EVENTS.userUpdated, { user_id: user.id, reason: "steam_unlinked", steam_id: identity.subject }, { subject: { type: "user", id: user.id } });
        });
        return { status: "removed" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/passkeys/options",
      summary: "Start registering a passkey",
      tags,
      ...openSession,
      allow_aal0: false,
      rate_limit: ["account_write"],
      async handler({ id }) {
        if (!f.passkeys.enabled) throw new ProblemError(404, "FEATURE_DISABLED");
        requireRecentAuth(ctx, id);
        const user = await requireUser(ctx.db, id.sub!);
        return registrationOptions(ctx, ctx.db, user);
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/passkeys",
      summary: "Finish registering a passkey",
      tags,
      ...openSession,
      allow_aal0: false,
      rate_limit: ["account_write"],
      body: z.object({ challenge_id: z.string().max(64), response: z.record(z.string(), z.unknown()), name: z.string().max(64).default("Passkey") }),
      async handler({ body, id }) {
        if (!f.passkeys.enabled) throw new ProblemError(404, "FEATURE_DISABLED");
        requireRecentAuth(ctx, id);
        const passkeyId = await ctx.db.transaction().execute(async (trx) => {
          const pid = await completeRegistration(ctx, trx, id.sub!, body.challenge_id, body.response as never, body.name);
          await securityEvent(trx, { userId: id.sub!, type: "passkey.added", ip: id.ip, port: id.port, country: id.country, userAgent: id.ua });
          await securityAlert(ctx, trx, id.sub!, "passkey_added", { name: body.name }, { throttleKey: `pk-${pid}` });
          await ctx.audit(trx, { actor: { type: "user", id: id.sub! }, action: "2fa.passkey_added", target: { type: "user", id: id.sub! } });
          await ctx.emit(trx, EVENTS.userUpdated, { user_id: id.sub, reason: "2fa" }, { subject: { type: "user", id: id.sub! } });
          return pid;
        });
        return { id: passkeyId };
      },
    }),

    route({
      method: "PATCH",
      path: "/api/v1/me/passkeys/:id",
      summary: "Rename a passkey",
      tags,
      rate_limit: ["account_write"],
      params: z.object({ id: z.uuid() }),
      body: z.object({ name: z.string().min(1).max(64) }),
      async handler({ params, body, id }) {
        const r = await ctx.db.updateTable("passkeys").set({ name: body.name }).where("id", "=", params.id).where("user_id", "=", id.sub!).executeTakeFirst();
        if (!Number(r.numUpdatedRows)) throw new ProblemError(404, "PASSKEY_NOT_FOUND");
        return { status: "updated" };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/me/passkeys/:id",
      summary: "Remove a passkey",
      tags,
      step_up: true,
      rate_limit: ["account_write"],
      params: z.object({ id: z.uuid() }),
      async handler({ params, id }) {
        const user = await requireUser(ctx.db, id.sub!);
        const pk = await ctx.db.selectFrom("passkeys").select("id").where("id", "=", params.id).where("user_id", "=", user.id).executeTakeFirst();
        if (!pk) throw new ProblemError(404, "PASSKEY_NOT_FOUND");
        if ((await signInMethods(ctx, ctx.db, user)).count <= 1) throw lastMethodError(ctx);
        await ctx.db.transaction().execute(async (trx) => {
          await trx.deleteFrom("passkeys").where("id", "=", pk.id).execute();
          await securityEvent(trx, { userId: user.id, type: "passkey.removed", ip: id.ip, port: id.port, country: id.country, userAgent: id.ua });
          await securityAlert(ctx, trx, user.id, "passkey_removed", {}, { throttleKey: `pkr-${pk.id}` });
          await ctx.audit(trx, { actor: { type: "user", id: user.id }, action: "2fa.passkey_removed", target: { type: "user", id: user.id } });
          await ctx.emit(trx, EVENTS.userUpdated, { user_id: user.id, reason: "2fa" }, { subject: { type: "user", id: user.id } });
        });
        return { status: "removed" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/totp/setup",
      summary: "Start setting up an authenticator app",
      tags,
      ...openSession,
      allow_aal0: false,
      rate_limit: ["account_write"],
      async handler({ id }) {
        if (!f.totp.enabled) throw new ProblemError(404, "FEATURE_DISABLED");
        requireRecentAuth(ctx, id);
        const user = await requireUser(ctx.db, id.sub!);
        const existing = await ctx.db.selectFrom("totp").select("confirmed_at").where("user_id", "=", user.id).executeTakeFirst();
        if (existing?.confirmed_at) throw new ProblemError(409, "TOTP_ALREADY_ENABLED");
        const secret = generateTotpSecret();
        await ctx.db
          .insertInto("totp")
          .values({ user_id: user.id, secret_enc: encryptTotpSecret(ctx, user.id, secret) })
          .onConflict((oc) => oc.column("user_id").doUpdateSet({ secret_enc: encryptTotpSecret(ctx, user.id, secret), confirmed_at: null, last_used_step: null }))
          .execute();
        const issuer = ctx.config.security.totp_issuer ?? ctx.config.branding.product_name;
        return { secret, otpauth_uri: otpauthUri(issuer, user.username ?? user.email ?? user.id, secret) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/totp/confirm",
      summary: "Confirm the authenticator app with a code",
      description: "Enables TOTP and returns recovery codes if the account has none.",
      tags,
      ...openSession,
      allow_aal0: false,
      rate_limit: ["totp_verify"],
      body: z.object({ code: z.string().max(12) }),
      async handler({ body, id }) {
        const row = await ctx.db.selectFrom("totp").selectAll().where("user_id", "=", id.sub!).executeTakeFirst();
        if (!row || row.confirmed_at) throw new ProblemError(409, "TOTP_NOT_PENDING");
        const step = verifyTotp(decryptTotpSecret(ctx, id.sub!, row.secret_enc), body.code.replace(/\s+/g, ""));
        if (step === null) throw new ProblemError(422, "INVALID_CODE");
        return ctx.db.transaction().execute(async (trx) => {
          await trx.updateTable("totp").set({ confirmed_at: new Date(), last_used_step: step }).where("user_id", "=", id.sub!).execute();
          const remaining = (await hasSecondFactor(trx, id.sub!)).recovery_codes;
          const codes = remaining ? null : await generateRecoveryCodes(ctx, trx, id.sub!);
          await trx.updateTable("sessions").set({ aal: 2, step_up_at: new Date() }).where("id", "=", id.sid!).execute();
          await securityEvent(trx, { userId: id.sub!, type: "totp.enabled", ip: id.ip, port: id.port, country: id.country, userAgent: id.ua });
          await securityAlert(ctx, trx, id.sub!, "totp_enabled", {}, { throttleKey: "totp-on" });
          await ctx.audit(trx, { actor: { type: "user", id: id.sub! }, action: "2fa.totp_enabled", target: { type: "user", id: id.sub! } });
          await ctx.emit(trx, EVENTS.userUpdated, { user_id: id.sub, reason: "2fa" }, { subject: { type: "user", id: id.sub! } });
          return { status: "enabled", recovery_codes: codes };
        });
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/me/totp",
      summary: "Turn off the authenticator app",
      tags,
      step_up: true,
      rate_limit: ["account_write"],
      async handler({ id }) {
        await ctx.db.transaction().execute(async (trx) => {
          await trx.deleteFrom("totp").where("user_id", "=", id.sub!).execute();
          const factors = await hasSecondFactor(trx, id.sub!);
          if (!factors.passkeys) await trx.deleteFrom("recovery_codes").where("user_id", "=", id.sub!).execute();
          await securityEvent(trx, { userId: id.sub!, type: "totp.disabled", ip: id.ip, port: id.port, country: id.country, userAgent: id.ua });
          await securityAlert(ctx, trx, id.sub!, "totp_disabled", {}, { throttleKey: "totp-off" });
          await ctx.audit(trx, { actor: { type: "user", id: id.sub! }, action: "2fa.totp_disabled", target: { type: "user", id: id.sub! } });
          await ctx.emit(trx, EVENTS.userUpdated, { user_id: id.sub, reason: "2fa" }, { subject: { type: "user", id: id.sub! } });
        });
        return { status: "disabled" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/recovery-codes",
      summary: "Generate new recovery codes",
      description: "Replaces any existing codes. Each code works once.",
      tags,
      ...openSession,
      allow_aal0: false,
      rate_limit: ["account_write"],
      async handler({ id }) {
        if (!(await hasSecondFactor(ctx.db, id.sub!)).totp && !(await hasSecondFactor(ctx.db, id.sub!)).passkeys) throw new ProblemError(409, "NO_SECOND_FACTOR");
        if (!stepUpOk(ctx, id) && !recentAuth(ctx, id)) throw new ProblemError(403, "STEP_UP_REQUIRED");
        return ctx.db.transaction().execute(async (trx) => {
          const codes = await generateRecoveryCodes(ctx, trx, id.sub!);
          await securityEvent(trx, { userId: id.sub!, type: "recovery_codes.regenerated", ip: id.ip, port: id.port, country: id.country, userAgent: id.ua });
          await ctx.audit(trx, { actor: { type: "user", id: id.sub! }, action: "2fa.recovery_codes_regenerated", target: { type: "user", id: id.sub! } });
          return { recovery_codes: codes };
        });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/me/security-events",
      summary: "Recent security events",
      tags,
      ...openSession,
      query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }),
      async handler({ query, id }) {
        const rows = await ctx.db.selectFrom("security_events").selectAll().where("user_id", "=", id.sub!).orderBy("created_at", "desc").limit(query.limit).execute();
        return { items: rows.map((r) => ({ id: r.id, type: r.type, country: r.country, user_agent: r.user_agent, created_at: r.created_at.toISOString(), data: r.data })) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/me/notifications",
      summary: "Notification preferences",
      description: "Security and legal notifications cannot be turned off.",
      tags,
      ...openSession,
      async handler({ id }) {
        const prefs = await ctx.db.selectFrom("notification_prefs").selectAll().where("user_id", "=", id.sub!).execute();
        const cats = await categories(ctx);
        const staff = id.perms.length > 0;
        return {
          items: cats
            .filter((c) => !c.staff || staff)
            .map((c) => ({ ...c, enabled: c.locked ? true : (prefs.find((p) => p.category === c.id)?.enabled ?? c.default ?? true) })),
        };
      },
    }),

    route({
      method: "PUT",
      path: "/api/v1/me/notifications",
      summary: "Update a notification preference",
      tags,
      rate_limit: ["account_write"],
      body: z.object({ category: z.string().max(64), enabled: z.boolean() }),
      async handler({ body, id }) {
        const cat = (await categories(ctx)).find((c) => c.id === body.category);
        if (!cat) throw new ProblemError(404, "UNKNOWN_CATEGORY");
        if (cat.locked) throw new ProblemError(403, "CATEGORY_LOCKED");
        await ctx.db
          .insertInto("notification_prefs")
          .values({ user_id: id.sub!, category: body.category, enabled: body.enabled })
          .onConflict((oc) => oc.columns(["user_id", "category"]).doUpdateSet({ enabled: body.enabled, updated_at: new Date() }))
          .execute();
        return { status: "updated" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/me/legal",
      summary: "Legal documents awaiting acceptance",
      tags,
      ...openSession,
      allow_account_states: [...RESTRICTED_STATES, "pending_deletion"],
      async handler({ id }) {
        const pending = await pendingDocumentsFor(ctx.db, { id: id.sub! });
        const accepted = await ctx.db.selectFrom("legal_acceptances").select(["document_id", "version", "accepted_at", "method"]).where("user_id", "=", id.sub!).orderBy("accepted_at", "desc").execute();
        const guardianManaged = Boolean((await requireUser(ctx.db, id.sub!)).parental_controls);
        return {
          pending: pending.map((d) => ({ id: d.id, version: d.version, title: d.title, summary: d.summary, effective_at: d.effective_at.toISOString() })),
          accepted: accepted.map((a) => ({ document_id: a.document_id, version: a.version, accepted_at: a.accepted_at.toISOString(), method: a.method })),
          guardian_accepts: guardianManaged && ageYears((await requireUser(ctx.db, id.sub!)).dob!) < ctx.config.parental.consent_age,
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/legal/accept",
      summary: "Accept legal documents",
      description: "Accounts under the consent age cannot accept for themselves; their guardian accepts on their behalf.",
      tags,
      ...openSession,
      allow_account_states: [...RESTRICTED_STATES],
      rate_limit: ["account_write"],
      body: z.object({ documents: z.array(z.object({ id: z.string().max(64), version: z.string().max(64) })).min(1).max(20) }),
      async handler({ body, id }) {
        const user = await requireUser(ctx.db, id.sub!);
        if (user.dob && ageYears(user.dob) < ctx.config.parental.consent_age && user.parental_controls) throw new ProblemError(403, "GUARDIAN_MUST_ACCEPT");
        await ctx.db.transaction().execute((trx) => acceptDocuments(ctx, trx, user.id, body.documents, { ip: id.ip, method: "re_acceptance" }));
        return { status: "accepted" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/export",
      summary: "Request a data export",
      description: "Every enabled service contributes its part. A download link valid for 7 days is emailed when it is ready.",
      tags,
      ...openSession,
      allow_account_states: [...RESTRICTED_STATES],
      rate_limit: ["account_write"],
      async handler({ id }) {
        const exportId = await ctx.db.transaction().execute((trx) => requestExport(ctx, trx, id.sub!, id.sub!));
        return reply(202, { id: exportId, status: "pending" });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/me/export",
      summary: "Data export status",
      tags,
      ...openSession,
      allow_account_states: [...RESTRICTED_STATES],
      async handler({ id }) {
        return { items: await exportStatus(ctx.db, id.sub!) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/delete",
      summary: "Delete the account",
      description: "Schedules deletion after accounts.deletion_grace and signs out everywhere. Signing in again during the grace period cancels it. Requires step-up.",
      tags,
      ...openSession,
      allow_account_states: [...RESTRICTED_STATES],
      step_up: true,
      rate_limit: ["account_write"],
      async handler({ id }) {
        const user = await requireUser(ctx.db, id.sub!);
        const due = await ctx.db.transaction().execute((trx) => requestDeletion(ctx, trx, user, { type: "user", id: user.id }));
        return reply(200, { status: "pending_deletion", due_at: due.toISOString() }, { [SESSION_CLEAR_HEADER]: "1" });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/age-assurance",
      summary: "Start age assurance",
      description: "Runs the configured age assurance provider for a trigger such as claim_adult_band.",
      tags,
      rate_limit: ["account_write"],
      body: z.object({ trigger: z.string().max(64), provider: z.string().max(64).optional() }),
      async handler({ body, id }) {
        const user = await requireUser(ctx.db, id.sub!);
        return ctx.db.transaction().execute((trx) => runAssurance(ctx, trx, user, body.trigger, accountUrl(ctx, "/settings/age"), body.provider));
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/age-assurance/callback",
      summary: "Finish vendor age assurance",
      tags,
      rate_limit: ["account_write"],
      body: z.object({ trigger: z.string().max(64), provider: z.string().max(64), payload: z.record(z.string(), z.unknown()) }),
      async handler({ body, id }) {
        const user = await requireUser(ctx.db, id.sub!);
        return ctx.db.transaction().execute((trx) => completeAssurance(ctx, trx, user, body.trigger, body.provider, body.payload));
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/me/parental",
      summary: "Parental consent status (for the account holder)",
      tags,
      ...openSession,
      allow_account_states: ["pending_parental_consent", "active", "locked", "banned"],
      async handler({ id }) {
        const user = await requireUser(ctx.db, id.sub!);
        const guardians = await ctx.db.selectFrom("guardians").select(["id", "email", "status", "approved_at", "created_at"]).where("child_user_id", "=", user.id).where("status", "in", ["pending", "active"]).execute();
        const removal = await ctx.db.selectFrom("guardian_requests").select(["id", "status", "created_at"]).where("child_user_id", "=", user.id).where("type", "=", "removal").where("status", "=", "pending").executeTakeFirst();
        const band = bandOf(ctx, user);
        return {
          state: user.state,
          guardians: guardians.map((g) => ({ id: g.id, email: g.email, status: g.status, approved_at: g.approved_at?.toISOString() ?? null })),
          controls: user.parental_controls,
          controls_optional: Boolean(user.guardian_controls_optional_at && user.guardian_controls_optional_at <= new Date()),
          guardian_email_changes_left: Math.max(0, ctx.config.parental.max_guardian_email_changes - user.guardian_email_changes),
          removal_request: removal ? { id: removal.id, created_at: removal.created_at.toISOString() } : null,
          can_remove_without_approval: band === "adult",
          can_request_removal: Boolean(user.graduated_at) || band !== "under_13",
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/parental/resend",
      summary: "Resend the consent request to the guardian",
      tags,
      ...openSession,
      allow_account_states: ["pending_parental_consent"],
      rate_limit: ["magic_link_ip"],
      async handler({ id }) {
        const user = await requireUser(ctx.db, id.sub!);
        const g = await ctx.db.selectFrom("guardians").selectAll().where("child_user_id", "=", user.id).where("status", "=", "pending").orderBy("created_at", "desc").executeTakeFirst();
        if (!g) throw new ProblemError(404, "NO_PENDING_GUARDIAN");
        await ctx.db.transaction().execute((trx) => sendConsentEmail(ctx, trx, user, g));
        return { status: "sent" };
      },
    }),

    route({
      method: "PUT",
      path: "/api/v1/me/parental/guardian-email",
      summary: "Change the guardian email while waiting for consent",
      tags,
      ...openSession,
      allow_account_states: ["pending_parental_consent"],
      rate_limit: ["magic_link_ip"],
      body: z.object({ email: zEmailIn }),
      async handler({ body, id }) {
        const user = await requireUser(ctx.db, id.sub!);
        if (user.guardian_email_changes >= ctx.config.parental.max_guardian_email_changes) throw new ProblemError(429, "GUARDIAN_EMAIL_CHANGE_LIMIT");
        await ctx.db.transaction().execute(async (trx) => {
          await trx.updateTable("guardians").set({ status: "declined" }).where("child_user_id", "=", user.id).where("status", "=", "pending").execute();
          await trx.updateTable("users").set({ guardian_email_changes: user.guardian_email_changes + 1 }).where("id", "=", user.id).execute();
          await startGuardianConsent(ctx, trx, user, body.email);
        });
        return { status: "sent" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/parental/removal-request",
      summary: "Ask to remove the guardian link",
      description: "A guardian must approve. At the adult band the link can be removed directly instead.",
      tags,
      ...openSession,
      rate_limit: ["account_write"],
      async handler({ id }) {
        const user = await requireUser(ctx.db, id.sub!);
        if (!(await ctx.db.selectFrom("guardians").select("id").where("child_user_id", "=", user.id).where("status", "=", "active").executeTakeFirst())) throw new ProblemError(404, "NO_GUARDIANS");
        if (bandOf(ctx, user) === "under_13" && !user.graduated_at) throw new ProblemError(403, "TOO_YOUNG_TO_REQUEST_REMOVAL");
        const requestId = await ctx.db.transaction().execute((trx) => createGuardianRequest(ctx, trx, user, "removal", {}, user.id));
        return reply(202, { status: "pending_guardian_approval", request_id: requestId });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/me/parental/remove",
      summary: "Remove the guardian link (adults only)",
      tags,
      ...openSession,
      rate_limit: ["account_write"],
      async handler({ id }) {
        const user = await requireUser(ctx.db, id.sub!);
        if (bandOf(ctx, user) !== "adult") throw new ProblemError(403, "GUARDIAN_APPROVAL_REQUIRED");
        await ctx.db.transaction().execute((trx) => removeGuardianLinks(ctx, trx, user, { type: "user", id: user.id }));
        return { status: "removed" };
      },
    }),
  ];
}
