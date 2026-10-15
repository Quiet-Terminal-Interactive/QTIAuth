import { ProblemError, isUuid, uuidv7 } from "@qtiauth/common";
import { EVENTS } from "@qtiauth/bus";
import { anyPermissionMatches, hasPermission } from "@qtiauth/config";
import type { Ctx } from "./lib/ctx.ts";
import { createBindingCode, exchangeBindingCode, resolveSession, userContext, type ResolveInput } from "./lib/sessions.ts";
import { bandOf, displayName, getUser, userSummary } from "./lib/users.ts";
import { checkText } from "./lib/filter.ts";
import { createGuardianRequest } from "./lib/parental.ts";
import { guardianEmailsFor } from "./lib/guardian-notify.ts";
import { IDENTITY_CATEGORIES } from "./routes/me.ts";
import { userGrants } from "./lib/roles.ts";
import { securityAlert, securityEvent } from "./lib/security.ts";
import { replayDeletionLedger, revokeRestoredSessions } from "./lib/deletion.ts";

export function registerRpc(ctx: Ctx): void {
  const bus = ctx.bus;

  bus.handle<ResolveInput, unknown>("identity.resolve_session", (req) => resolveSession(ctx, req));

  bus.handle<{ token_hash: string; target_origin: string; return_path: string }, unknown>("identity.create_binding_code", (req) => createBindingCode(ctx, req));

  bus.handle<{ code: string; origin: string; scope: string }, unknown>("identity.exchange_binding_code", (req) => exchangeBindingCode(ctx, req));

  bus.handle<{ user_id: string }, unknown>("identity.resolve_user", async (req) => {
    if (!isUuid(req.user_id)) return null;
    const user = await getUser(ctx.db, req.user_id);
    if (!user || user.state === "deleted") return null;
    return userContext(ctx, ctx.db, user);
  });

  bus.handle<{ user_id: string }, unknown>("identity.get_user_summary", async (req) => {
    if (!isUuid(req.user_id)) return null;
    const user = await getUser(ctx.db, req.user_id);
    return user ? userSummary(ctx, user) : null;
  });

  bus.handle<{ user_id: string }, unknown>("identity.csea_user_data", async (req) => {
    if (!isUuid(req.user_id)) return null;
    const user = await getUser(ctx.db, req.user_id);
    if (!user) return null;
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - 3);
    const event = (e: { type: string; ip: string | null; port: number | null; created_at: Date; data: unknown }) => ({ type: e.type, at: e.created_at.toISOString(), ip: e.ip, port: e.port, method: (e.data as { method?: string } | null)?.method ?? null });
    const registered = await ctx.db.selectFrom("security_events").select(["type", "ip", "port", "created_at", "data"]).where("user_id", "=", user.id).where("type", "=", "account.registered").orderBy("created_at").executeTakeFirst();
    const logins = await ctx.db
      .selectFrom("security_events")
      .select(["type", "ip", "port", "created_at", "data"])
      .where("user_id", "=", user.id)
      .where("type", "in", ["session.created", "session.reauthenticated", "session.signals_changed"])
      .where("created_at", ">=", since)
      .orderBy("created_at", "desc")
      .limit(5000)
      .execute();
    const identities = await ctx.db.selectFrom("identities").select(["type", "subject", "email", "email_verified", "created_at"]).where("user_id", "=", user.id).where("type", "!=", "password").execute();
    const guardians = await ctx.db.selectFrom("guardians").select(["user_id", "email", "status"]).where("child_user_id", "=", user.id).execute();
    const children = await ctx.db.selectFrom("guardians").select(["child_user_id", "status"]).where("user_id", "=", user.id).execute();
    const usernames = await ctx.db.selectFrom("username_history").select(["username", "claimed_at", "released_at"]).where("user_id", "=", user.id).orderBy("claimed_at", "desc").limit(50).execute();
    return {
      user_id: user.id,
      username: user.username,
      email: user.email,
      email_verified: Boolean(user.email_verified_at),
      dob: user.dob,
      state: user.state,
      created_at: user.created_at.toISOString(),
      registration: registered ? event(registered) : { type: "account.registered", at: user.created_at.toISOString(), ip: null, port: null, method: null },
      logins: logins.map(event),
      logins_since: since.toISOString(),
      linked_accounts: identities.map((i) => ({ type: i.type, subject: i.subject, email: i.email, email_verified: i.email_verified, linked_at: i.created_at.toISOString() })),
      guardians: guardians.map((g) => ({ user_id: g.user_id, email: g.email, status: g.status })),
      children: children.map((c) => ({ user_id: c.child_user_id, status: c.status })),
      username_history: usernames.map((u) => ({ username: u.username, from: u.claimed_at.toISOString(), to: u.released_at?.toISOString() ?? null })),
    };
  });

  bus.handle<{ ids: string[] }, Record<string, unknown>>("identity.get_users", async (req) => {
    const ids = (req.ids ?? []).filter(isUuid).slice(0, 500);
    if (!ids.length) return {};
    const rows = await ctx.db.selectFrom("users").selectAll().where("id", "in", ids).execute();
    return Object.fromEntries(rows.map((u) => [u.id, userSummary(ctx, u)]));
  });

  bus.handle<{ user_id: string; category?: string }, unknown>("identity.resolve_recipient", async (req) => {
    if (!isUuid(req.user_id)) return null;
    const user = await getUser(ctx.db, req.user_id);
    if (!user || !user.email || user.state === "deleted") return null;
    let allowed = true;
    const locked = IDENTITY_CATEGORIES.find((c) => c.id === req.category)?.locked ?? false;
    if (req.category && !locked && req.category !== "security" && req.category !== "legal") {
      const pref = await ctx.db.selectFrom("notification_prefs").select("enabled").where("user_id", "=", user.id).where("category", "=", req.category).executeTakeFirst();
      allowed = pref?.enabled ?? true;
    }
    return { user_id: user.id, email: user.email, name: displayName(user), locale: user.locale, allowed, state: user.state, age_band: bandOf(ctx, user) };
  });

  bus.handle<{ user_id: string }, unknown>("identity.resolve_guardians", async (req) => (isUuid(req.user_id) ? guardianEmailsFor(ctx.db, req.user_id) : []));

  bus.handle<{ text: string; context: string }, unknown>("identity.filter_text", async (req) => {
    const d = await checkText(ctx, ctx.db, String(req.text ?? "").slice(0, 2000), String(req.context ?? "unknown"));
    return { action: d.action, rule: d.rule, matched: d.matched };
  });

  bus.handle<{ user_id: string; scopes: string[] }, Record<string, unknown> | null>("identity.oidc_claims", async (req) => {
    if (!isUuid(req.user_id)) return null;
    const user = await getUser(ctx.db, req.user_id);
    if (!user || user.state === "deleted") return null;
    const scopes = new Set(req.scopes ?? []);
    const claims: Record<string, unknown> = {};
    for (const [scope, def] of Object.entries(ctx.config.oidc.scopes)) {
      if (!scopes.has(scope)) continue;
      for (const claim of def.claims) {
        switch (claim) {
          case "preferred_username":
            claims.preferred_username = user.username;
            break;
          case "username_updated_at":
            claims.username_updated_at = user.username_changed_at ? Math.floor(user.username_changed_at.getTime() / 1000) : null;
            break;
          case "email":
            claims.email = user.email;
            break;
          case "email_verified":
            claims.email_verified = Boolean(user.email_verified_at);
            break;
          case "age_band":
            claims.age_band = bandOf(ctx, user);
            break;
          case "age_assurance_strength":
            claims.age_assurance_strength = user.age_assurance_strength;
            break;
          case "parental_controls":
            claims.parental_controls = user.parental_controls ?? null;
            break;
          case "restrictions":
            claims.restrictions = (user.restrictions ?? []).filter((r) => !r.until || new Date(r.until) > new Date()).map((r) => ({ name: r.name, until: r.until }));
            break;
          default:
            break;
        }
      }
    }
    claims.locale = user.locale;
    return claims;
  });

  bus.handle<{ type: string; subject: string }, unknown>("identity.find_by_identity", async (req) => {
    const row = await ctx.db.selectFrom("identities").select(["user_id", "created_at"]).where("type", "=", req.type).where("subject", "=", req.subject).executeTakeFirst();
    return row ? { user_id: row.user_id, linked_at: row.created_at.toISOString() } : null;
  });

  bus.handle<{ user_id: string; steam_id: string; ip?: string | null }, unknown>("identity.link_steam", async (req) => {
    if (!isUuid(req.user_id) || !/^\d{17}$/.test(String(req.steam_id))) throw new ProblemError(422, "INVALID_STEAM_ID");
    return ctx.db.transaction().execute(async (trx) => {
      const user = await getUser(trx, req.user_id);
      if (!user || user.state === "deleted") throw new ProblemError(404, "USER_NOT_FOUND");
      const existing = await trx.selectFrom("identities").select(["user_id"]).where("type", "=", "steam").where("subject", "=", req.steam_id).executeTakeFirst();
      if (existing) {
        if (existing.user_id !== user.id) throw new ProblemError(409, "IDENTITY_IN_USE");
        return { status: "already_linked" };
      }
      const other = await trx.selectFrom("identities").select("id").where("type", "=", "steam").where("user_id", "=", user.id).executeTakeFirst();
      if (other) throw new ProblemError(409, "STEAM_ALREADY_LINKED");
      await trx.insertInto("identities").values({ id: uuidv7(), user_id: user.id, type: "steam", subject: req.steam_id, email: null, email_verified: false, data: JSON.stringify({ linked_via: "game_ticket" }), last_used_at: new Date() }).execute();
      await securityEvent(trx, { userId: user.id, type: "identity.connected", ip: req.ip ?? null, data: { provider: "steam", via: "game_ticket" } });
      await securityAlert(ctx, trx, user.id, "identity_connected", { provider: "Steam" }, { throttleKey: "idc-steam" });
      await ctx.audit(trx, { actor: { type: "user", id: user.id }, action: "identity.connected", target: { type: "user", id: user.id }, data: { provider: "steam", via: "game_ticket" } });
      await ctx.emit(trx, EVENTS.userUpdated, { user_id: user.id, reason: "steam_linked", steam_id: req.steam_id }, { subject: { type: "user", id: user.id } });
      return { status: "linked" };
    });
  });

  bus.handle<{ user_id: string; type: string }, unknown>("identity.user_identities", async (req) => {
    if (!isUuid(req.user_id)) return [];
    const rows = await ctx.db.selectFrom("identities").select(["subject", "created_at"]).where("user_id", "=", req.user_id).where("type", "=", req.type).execute();
    return rows.map((r) => ({ subject: r.subject, linked_at: r.created_at.toISOString() }));
  });

  bus.handle<{ type?: string; with_identity?: string; cursor?: string; limit?: number }, unknown>("identity.users_with_identity", async (req) => {
    const limit = Math.min(req.limit ?? 500, 1000);
    let q = ctx.db.selectFrom("identities").select(["user_id", "subject", "id"]).where("type", "=", req.with_identity ?? "steam");
    if (req.cursor) q = q.where("id", ">", req.cursor);
    const rows = await q.orderBy("id").limit(limit).execute();
    return { items: rows.map((r) => ({ user_id: r.user_id, subject: r.subject })), next_cursor: rows.length === limit ? rows[rows.length - 1]!.id : null };
  });

  bus.handle<{ user_id: string; type: "app_approval" | "username_change"; data: Record<string, unknown> }, unknown>("identity.request_guardian_approval", async (req) => {
    const user = await getUser(ctx.db, req.user_id);
    if (!user) throw new ProblemError(404, "USER_NOT_FOUND");
    const controls = user.parental_controls;
    const optional = user.guardian_controls_optional_at && user.guardian_controls_optional_at <= new Date();
    if (!controls || optional || (req.type === "app_approval" && !controls.approve_third_party_apps)) return { required: false };
    const requestId = await ctx.db.transaction().execute((trx) => createGuardianRequest(ctx, trx, user, req.type, req.data, user.id));
    return { required: true, request_id: requestId };
  });

  bus.handle<{ request_id: string }, unknown>("identity.guardian_request_status", async (req) => {
    if (!isUuid(req.request_id)) return null;
    const r = await ctx.db.selectFrom("guardian_requests").select(["status", "type", "decided_at"]).where("id", "=", req.request_id).executeTakeFirst();
    return r ? { status: r.status, type: r.type, decided_at: r.decided_at?.toISOString() ?? null } : null;
  });

  bus.handle<{ cursor?: string; limit?: number }, unknown>("identity.list_notice_recipients", async (req) => {
    const limit = Math.min(req.limit ?? 500, 1000);
    let q = ctx.db.selectFrom("users").select(["id", "email", "locale", "username", "dob", "parental_controls"]).where("state", "in", ["active", "locked", "banned", "pending_parental_consent"]).where("email", "is not", null);
    if (req.cursor) q = q.where("id", ">", req.cursor);
    const rows = await q.orderBy("id").limit(limit).execute();
    const items = [];
    for (const u of rows) {
      const guardians = u.parental_controls ? await guardianEmailsFor(ctx.db, u.id) : [];
      items.push({ user_id: u.id, email: u.email, locale: u.locale, name: u.username ?? u.email!.split("@")[0], age_band: bandOf(ctx, u), guardians: guardians.map((g) => ({ id: g.id, email: g.email })) });
    }
    return { items, next_cursor: rows.length === limit ? rows[rows.length - 1]!.id : null };
  });

  bus.handle<{ permission: string; category?: string }, unknown>("identity.staff_recipients", async (req) => {
    const rows = await ctx.db
      .selectFrom("user_roles")
      .innerJoin("users", "users.id", "user_roles.user_id")
      .select(["users.id", "users.email", "users.locale", "users.username", "users.state"])
      .distinct()
      .where("users.state", "=", "active")
      .execute();
    const out = [];
    for (const u of rows) {
      const grants = await userGrants(ctx.db, u.id);
      if (!hasPermission(grants, req.permission)) continue;
      if (req.category) {
        const pref = await ctx.db.selectFrom("notification_prefs").select("enabled").where("user_id", "=", u.id).where("category", "=", req.category).executeTakeFirst();
        if (pref && !pref.enabled) continue;
      }
      out.push({ user_id: u.id, email: u.email, locale: u.locale, name: u.username ?? u.email });
    }
    return out;
  });

  bus.handle<{ user_id: string; permission: string }, unknown>("identity.has_permission", async (req) => {
    const grants = await userGrants(ctx.db, req.user_id);
    return { allowed: hasPermission(grants, req.permission), staff_2fa_required: anyPermissionMatches(grants, ctx.config.security.require_2fa_for_permissions) };
  });

  bus.handle<{ session_id: string }, unknown>("identity.session_info", async (req) => {
    if (!isUuid(req.session_id)) return null;
    const s = await ctx.db.selectFrom("sessions").select(["id", "user_id", "revoked_at", "expires_at"]).where("id", "=", req.session_id).executeTakeFirst();
    return s ? { session_id: s.id, user_id: s.user_id, active: !s.revoked_at && s.expires_at > new Date() } : null;
  });

  bus.handle<{ entries: { user_id: string; deleted_at: string }[] }, unknown>("identity.replay_deletion_ledger", async (req) => {
    const replayed = await replayDeletionLedger(ctx, (req.entries ?? []).filter((e) => isUuid(e.user_id)));
    return { replayed };
  });

  bus.handle<{ user_ids: string[] }, unknown>("identity.erasure_pending", async (req) => {
    const ids = (req.user_ids ?? []).filter(isUuid);
    if (!ids.length) return { pending: [] };
    const rows = await ctx.db.selectFrom("erasures").select("user_id").where("user_id", "in", ids).where("completed_at", "is", null).execute();
    return { pending: rows.map((r) => r.user_id) };
  });

  bus.handle<Record<string, never>, unknown>("identity.revoke_restored_sessions", async () => ({ revoked: await revokeRestoredSessions(ctx) }));
}
