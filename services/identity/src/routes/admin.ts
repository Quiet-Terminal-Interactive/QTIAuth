import { z } from "zod";
import { sql } from "kysely";
import { ProblemError, decodeCursor, encodeCursor, uuidv7 } from "@qtiauth/common";
import { route, type AnyRoute, zReason } from "@qtiauth/service-kit";
import { ageBand } from "@qtiauth/auth-context";
import { cronSubject, makeEvent, EVENTS } from "@qtiauth/bus";
import type { Ctx } from "../lib/ctx.ts";
import { bandOf, requireUser, userSummary } from "../lib/users.ts";
import { banUser, lockUser, unbanUser, unlockUser } from "../lib/enforcement.ts";
import { revokeAllSessions, sessionList } from "../lib/sessions.ts";
import { usernameHistory } from "../lib/usernames.ts";
import { signInMethods } from "./me.ts";
import { userRoles } from "../lib/roles.ts";
import { checkText, getFilter, reloadCustomEntries } from "../lib/filter.ts";
import { zDob } from "./common.ts";

const tags = ["admin"];
const admin = (permissions: string[], extra: { step_up?: boolean } = {}) => ({
  auth: "session" as const,
  module: "admin" as const,
  permissions,
  rate_limit: ["admin"],
  step_up: extra.step_up ?? false,
});

function staff(id: { sub?: string }) {
  return { type: "staff" as const, id: id.sub! };
}

function dobRange(ctx: Ctx, band: string): { after?: string; onOrBefore?: string } {
  const b = ctx.config.age.boundaries;
  const now = new Date();
  const yearsAgo = (y: number) => {
    const d = new Date(Date.UTC(now.getUTCFullYear() - y, now.getUTCMonth(), now.getUTCDate()));
    return d.toISOString().slice(0, 10);
  };
  switch (band) {
    case "under_13":
      return { after: yearsAgo(b.teen) };
    case "13_to_15":
      return { onOrBefore: yearsAgo(b.teen), after: yearsAgo(b.older_teen) };
    case "16_to_17":
      return { onOrBefore: yearsAgo(b.older_teen), after: yearsAgo(b.adult) };
    default:
      return { onOrBefore: yearsAgo(b.adult) };
  }
}

export function adminRoutes(ctx: Ctx): AnyRoute[] {
  return [
    route({
      method: "GET",
      path: "/api/v1/admin/users",
      summary: "Search and filter users",
      tags,
      ...admin(["users.read"]),
      query: z.object({
        q: z.string().max(200).optional(),
        state: z.enum(["pending_email_verification", "pending_parental_consent", "active", "locked", "banned", "pending_deletion", "deleted"]).optional(),
        age_band: z.enum(["under_13", "13_to_15", "16_to_17", "adult"]).optional(),
        role: z.string().max(64).optional(),
        created_from: z.iso.datetime().optional(),
        created_to: z.iso.datetime().optional(),
        cursor: z.string().max(512).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      }),
      async handler({ query }) {
        let q = ctx.db.selectFrom("users").selectAll();
        if (query.q) {
          const term = query.q.trim();
          q = q.where((eb) =>
            eb.or([
              eb(sql`search`, "@@", sql`plainto_tsquery('simple', ${term})`),
              eb("email_normalized", "=", term.toLowerCase()),
              eb("username_canonical", "like", `${term.toLowerCase().replace(/[%_\\]/g, "\\$&")}%`),
              ...(/^[0-9a-f-]{36}$/i.test(term) ? [eb("id", "=", term)] : []),
            ]),
          );
        }
        if (query.state) q = q.where("state", "=", query.state);
        if (query.age_band) {
          const r = dobRange(ctx, query.age_band);
          if (r.after) q = q.where("dob", ">", r.after);
          if (r.onOrBefore) q = q.where("dob", "<=", r.onOrBefore);
        }
        if (query.role) q = q.where("id", "in", ctx.db.selectFrom("user_roles").select("user_id").where("role", "=", query.role));
        if (query.created_from) q = q.where("created_at", ">=", new Date(query.created_from));
        if (query.created_to) q = q.where("created_at", "<=", new Date(query.created_to));
        const cur = decodeCursor<{ c: string; i: string }>(query.cursor);
        if (cur) q = q.where((eb) => eb.or([eb("created_at", "<", new Date(cur.c)), eb.and([eb("created_at", "=", new Date(cur.c)), eb("id", "<", cur.i)])]));
        const rows = await q.orderBy("created_at", "desc").orderBy("id", "desc").limit(query.limit + 1).execute();
        const items = rows.slice(0, query.limit);
        const last = items[items.length - 1];
        return {
          items: items.map((u) => ({ ...userSummary(ctx, u), email: u.email })),
          next_cursor: rows.length > query.limit && last ? encodeCursor({ c: last.created_at.toISOString(), i: last.id }) : null,
        };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/users/:id",
      summary: "User detail",
      description: "Assembled over the bus: moderation history, entitlements and tickets appear when those services are running. Secrets are never included.",
      tags,
      ...admin(["users.read"]),
      params: z.object({ id: z.uuid() }),
      async handler({ params, id }) {
        const user = await requireUser(ctx.db, params.id);
        const methods = await signInMethods(ctx, ctx.db, user);
        const events = await ctx.db.selectFrom("security_events").selectAll().where("user_id", "=", user.id).orderBy("created_at", "desc").limit(100).execute();
        const guardians = await ctx.db.selectFrom("guardians").select(["id", "email", "status", "approved_at", "created_at"]).where("child_user_id", "=", user.id).execute();
        const [moderation, entitlements, tickets] = await Promise.all([
          ctx.rpcOptional<unknown>("safety.user_history", { user_id: user.id }, null).catch(() => ({ error: "unavailable" })),
          ctx.rpcOptional<unknown>("games.user_entitlements", { user_id: user.id }, null).catch(() => ({ error: "unavailable" })),
          ctx.rpcOptional<unknown>("support.user_tickets", { user_id: user.id }, null).catch(() => ({ error: "unavailable" })),
        ]);
        await ctx.db.transaction().execute((trx) => ctx.audit(trx, { actor: staff(id), action: "admin.user_viewed", target: { type: "user", id: user.id } }));
        return {
          profile: {
            ...userSummary(ctx, user),
            email: user.email,
            dob: user.dob,
            locked_until: user.locked_until?.toISOString() ?? null,
            lock_reason: user.lock_reason,
            banned_at: user.banned_at?.toISOString() ?? null,
            ban_reason: user.ban_reason,
            restrictions: user.restrictions,
            force_username_reset: user.force_username_reset,
            deletion_due_at: user.deletion_due_at?.toISOString() ?? null,
            last_sign_in_at: user.last_sign_in_at?.toISOString() ?? null,
            last_sign_in_method: user.last_sign_in_method,
            age_assurance_strength: user.age_assurance_strength,
            parental_controls: user.parental_controls,
          },
          sign_in_methods: methods,
          roles: await userRoles(ctx.db, user.id),
          sessions: await sessionList(ctx.db, user.id),
          security_events: events.map((e) => ({ id: e.id, type: e.type, ip: e.ip, country: e.country, user_agent: e.user_agent, data: e.data, created_at: e.created_at.toISOString() })),
          username_history: await usernameHistory(ctx.db, user.id),
          guardians: guardians.map((g) => ({ ...g, approved_at: g.approved_at?.toISOString() ?? null, created_at: g.created_at.toISOString() })),
          moderation,
          entitlements,
          tickets,
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/users/:id/ban",
      summary: "Ban a user",
      tags,
      ...admin(["users.ban"], { step_up: true }),
      params: z.object({ id: z.uuid() }),
      body: z.object({ reason: zReason }),
      async handler({ params, body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const user = await requireUser(trx, params.id);
          await banUser(ctx, trx, user, body.reason, staff(id));
          await ctx.audit(trx, { actor: staff(id), action: "user.banned", target: { type: "user", id: user.id }, reason: body.reason, ip: id.ip });
        });
        return { status: "banned" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/users/:id/unban",
      summary: "Lift a ban",
      tags,
      ...admin(["users.ban"], { step_up: true }),
      params: z.object({ id: z.uuid() }),
      body: z.object({ reason: zReason }),
      async handler({ params, body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const user = await requireUser(trx, params.id);
          await unbanUser(ctx, trx, user, staff(id));
          await ctx.audit(trx, { actor: staff(id), action: "user.unbanned", target: { type: "user", id: user.id }, reason: body.reason, ip: id.ip });
        });
        return { status: "active" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/users/:id/lock",
      summary: "Lock a user (optionally until a time)",
      tags,
      ...admin(["users.lock"], { step_up: true }),
      params: z.object({ id: z.uuid() }),
      body: z.object({ reason: zReason, until: z.iso.datetime().optional() }),
      async handler({ params, body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const user = await requireUser(trx, params.id);
          await lockUser(ctx, trx, user, body.until ? new Date(body.until) : null, body.reason, staff(id));
          await ctx.audit(trx, { actor: staff(id), action: "user.locked", target: { type: "user", id: user.id }, reason: body.reason, ip: id.ip, data: { until: body.until ?? null } });
        });
        return { status: "locked" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/users/:id/unlock",
      summary: "Unlock a user",
      tags,
      ...admin(["users.lock"], { step_up: true }),
      params: z.object({ id: z.uuid() }),
      body: z.object({ reason: zReason }),
      async handler({ params, body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const user = await requireUser(trx, params.id);
          await unlockUser(ctx, trx, user, staff(id));
          await ctx.audit(trx, { actor: staff(id), action: "user.unlocked", target: { type: "user", id: user.id }, reason: body.reason, ip: id.ip });
        });
        return { status: "active" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/users/:id/revoke-sessions",
      summary: "Force re-authentication (revoke every session)",
      tags,
      ...admin(["users.sessions"], { step_up: true }),
      params: z.object({ id: z.uuid() }),
      body: z.object({ reason: zReason }),
      async handler({ params, body, id }) {
        const n = await ctx.db.transaction().execute(async (trx) => {
          const user = await requireUser(trx, params.id);
          const count = await revokeAllSessions(ctx, trx, user.id, "staff_revoked", staff(id));
          await ctx.audit(trx, { actor: staff(id), action: "user.sessions_revoked", target: { type: "user", id: user.id }, reason: body.reason, ip: id.ip, data: { count } });
          return count;
        });
        return { revoked: n };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/users/:id/force-username-reset",
      summary: "Make the user pick a new username on next sign-in",
      tags,
      ...admin(["users.force_username_reset"], { step_up: true }),
      params: z.object({ id: z.uuid() }),
      body: z.object({ reason: zReason }),
      async handler({ params, body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const user = await requireUser(trx, params.id);
          await trx.updateTable("users").set({ force_username_reset: true, updated_at: new Date() }).where("id", "=", user.id).execute();
          await ctx.emit(trx, EVENTS.userUpdated, { user_id: user.id, reason: "force_username_reset" }, { actor: staff(id), subject: { type: "user", id: user.id } });
          await ctx.audit(trx, { actor: staff(id), action: "user.force_username_reset", target: { type: "user", id: user.id }, reason: body.reason, ip: id.ip });
        });
        return { status: "ok" };
      },
    }),

    route({
      method: "PATCH",
      path: "/api/v1/admin/users/:id/dob",
      summary: "Correct a date of birth",
      description: "Staff only, audited, needs a reason. Users cannot edit their own date of birth.",
      tags,
      ...admin(["users.edit_dob"], { step_up: true }),
      params: z.object({ id: z.uuid() }),
      body: z.object({ dob: zDob, reason: zReason }),
      async handler({ params, body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const user = await requireUser(trx, params.id);
          const before = bandOf(ctx, user);
          const after = ageBand(body.dob, ctx.config.age.boundaries);
          await trx.updateTable("users").set({ dob: body.dob, age_band_cached: after, updated_at: new Date() }).where("id", "=", user.id).execute();
          if (before !== after) await ctx.emit(trx, EVENTS.userAgeBandChanged, { user_id: user.id, from: before, to: after, reason: "dob_corrected" }, { actor: staff(id), subject: { type: "user", id: user.id } });
          await ctx.emit(trx, EVENTS.userUpdated, { user_id: user.id, reason: "dob" }, { actor: staff(id), subject: { type: "user", id: user.id } });
          await ctx.audit(trx, { actor: staff(id), action: "user.dob_changed", target: { type: "user", id: user.id }, reason: body.reason, ip: id.ip, data: { band_before: before, band_after: after } });
        });
        return { status: "updated" };
      },
    }),

    route({
      method: "PUT",
      path: "/api/v1/admin/users/:id/roles",
      summary: "Set a user's roles",
      tags,
      ...admin(["roles.manage"], { step_up: true }),
      params: z.object({ id: z.uuid() }),
      body: z.object({ roles: z.array(z.string().max(64)).max(20), reason: zReason }),
      async handler({ params, body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const user = await requireUser(trx, params.id);
          const known = await trx.selectFrom("roles").select("name").execute();
          for (const r of body.roles) if (!known.some((k) => k.name === r)) throw new ProblemError(422, "UNKNOWN_ROLE", undefined, { role: r });
          const before = await userRoles(trx, user.id);
          await trx.deleteFrom("user_roles").where("user_id", "=", user.id).execute();
          for (const r of body.roles) await trx.insertInto("user_roles").values({ user_id: user.id, role: r, granted_by: id.sub! }).execute();
          await ctx.emit(trx, EVENTS.rolesChanged, { user_id: user.id, roles: body.roles }, { actor: staff(id), subject: { type: "user", id: user.id } });
          await ctx.emit(trx, EVENTS.userUpdated, { user_id: user.id, reason: "roles" }, { actor: staff(id), subject: { type: "user", id: user.id } });
          await ctx.audit(trx, { actor: staff(id), action: "user.roles_changed", target: { type: "user", id: user.id }, reason: body.reason, ip: id.ip, data: { before, after: body.roles } });
        });
        return { status: "updated" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/roles",
      summary: "Roles and their permissions",
      tags,
      ...admin(["roles.manage"]),
      async handler() {
        const roles = await ctx.db.selectFrom("roles").selectAll().orderBy("name").execute();
        const permissions = await ctx.rpcOptional<string[]>("gateway.permissions", {}, []);
        return { items: roles.map((r) => ({ name: r.name, description: r.description, permissions: r.permissions, builtin: r.builtin })), known_permissions: permissions };
      },
    }),

    route({
      method: "PUT",
      path: "/api/v1/admin/roles/:name",
      summary: "Create or update a role",
      description: "safety.csea.access is never matched by a wildcard and must be listed explicitly.",
      tags,
      ...admin(["roles.manage"], { step_up: true }),
      params: z.object({ name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/) }),
      body: z.object({ description: z.string().max(200).default(""), permissions: z.array(z.string().regex(/^(\*|[a-z_]+(\.[a-z_]+)*(\.\*)?)$/)).max(200), reason: zReason }),
      async handler({ params, body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const before = await trx.selectFrom("roles").selectAll().where("name", "=", params.name).executeTakeFirst();
          await trx
            .insertInto("roles")
            .values({ name: params.name, description: body.description, permissions: JSON.stringify(body.permissions), builtin: false })
            .onConflict((oc) => oc.column("name").doUpdateSet({ description: body.description, permissions: JSON.stringify(body.permissions), updated_at: new Date() }))
            .execute();
          const holders = await trx.selectFrom("user_roles").select("user_id").where("role", "=", params.name).execute();
          for (const h of holders) await ctx.emit(trx, EVENTS.userUpdated, { user_id: h.user_id, reason: "roles" }, { actor: staff(id), subject: { type: "user", id: h.user_id } });
          await ctx.audit(trx, { actor: staff(id), action: before ? "role.updated" : "role.created", target: { type: "role", id: params.name }, reason: body.reason, ip: id.ip, data: { before: before?.permissions ?? null, after: body.permissions } });
        });
        return { status: "saved" };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/admin/roles/:name",
      summary: "Delete a role",
      tags,
      ...admin(["roles.manage"], { step_up: true }),
      params: z.object({ name: z.string().max(64) }),
      body: z.object({ reason: zReason }),
      async handler({ params, body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const holders = await trx.selectFrom("user_roles").select("user_id").where("role", "=", params.name).execute();
          const r = await trx.deleteFrom("roles").where("name", "=", params.name).executeTakeFirst();
          if (!Number(r.numDeletedRows)) throw new ProblemError(404, "ROLE_NOT_FOUND");
          for (const h of holders) await ctx.emit(trx, EVENTS.userUpdated, { user_id: h.user_id, reason: "roles" }, { actor: staff(id), subject: { type: "user", id: h.user_id } });
          await ctx.audit(trx, { actor: staff(id), action: "role.deleted", target: { type: "role", id: params.name }, reason: body.reason, ip: id.ip });
        });
        return { status: "deleted" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/audit",
      summary: "Audit log",
      tags,
      ...admin(["audit.read"]),
      query: z.object({
        actor: z.string().max(128).optional(),
        action: z.string().max(128).optional(),
        target: z.string().max(128).optional(),
        service: z.string().max(32).optional(),
        from: z.iso.datetime().optional(),
        to: z.iso.datetime().optional(),
        cursor: z.string().max(256).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      async handler({ query }) {
        let q = ctx.db.selectFrom("audit_log").selectAll();
        if (query.actor) q = q.where("actor_id", "=", query.actor);
        if (query.action) q = query.action.endsWith("*") ? q.where("action", "like", `${query.action.slice(0, -1)}%`) : q.where("action", "=", query.action);
        if (query.target) q = q.where("target_id", "=", query.target);
        if (query.service) q = q.where("service", "=", query.service);
        if (query.from) q = q.where("occurred_at", ">=", new Date(query.from));
        if (query.to) q = q.where("occurred_at", "<=", new Date(query.to));
        const cur = decodeCursor<{ i: number }>(query.cursor);
        if (cur) q = q.where("id", "<", cur.i);
        const rows = await q.orderBy("id", "desc").limit(query.limit + 1).execute();
        const items = rows.slice(0, query.limit);
        return {
          items: items.map((r) => ({ ...r, occurred_at: r.occurred_at.toISOString() })),
          next_cursor: rows.length > query.limit ? encodeCursor({ i: items[items.length - 1]!.id }) : null,
        };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/text-filter/decisions",
      summary: "Recent text filter decisions",
      description: "Recent blocks and unknowns, for tuning the lists.",
      tags,
      ...admin(["text_filter.manage"]),
      query: z.object({ rule: z.string().max(32).optional(), action: z.enum(["allow", "block"]).optional(), context: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }),
      async handler({ query }) {
        let q = ctx.db.selectFrom("filter_decisions").selectAll();
        if (query.rule) q = q.where("rule", "=", query.rule);
        if (query.action) q = q.where("action", "=", query.action);
        if (query.context) q = q.where("context", "=", query.context);
        const rows = await q.orderBy("created_at", "desc").limit(query.limit).execute();
        return { items: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })), stats: getFilter().stats() };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/text-filter/entries",
      summary: "Custom allow and block entries",
      tags,
      ...admin(["text_filter.manage"]),
      async handler() {
        const rows = await ctx.db.selectFrom("filter_entries").selectAll().orderBy("list").orderBy("word").execute();
        return { items: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/text-filter/entries",
      summary: "Add an allow or block entry",
      tags,
      ...admin(["text_filter.manage"], { step_up: true }),
      body: z.object({ list: z.enum(["allow", "block"]), word: z.string().min(1).max(100), note: z.string().max(500).optional() }),
      async handler({ body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .insertInto("filter_entries")
            .values({ id: uuidv7(), list: body.list, word: body.word.trim(), note: body.note ?? null, created_by: id.sub! })
            .onConflict((oc) => oc.columns(["list", "word"]).doNothing())
            .execute();
          await ctx.audit(trx, { actor: staff(id), action: "text_filter.entry_added", target: { type: "filter_entry", id: `${body.list}:${body.word}` }, ip: id.ip });
        });
        await reloadCustomEntries(ctx);
        ctx.bus.publish("qtiauth.identity.filter.reload", {});
        return { status: "added" };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/admin/text-filter/entries/:id",
      summary: "Remove an allow or block entry",
      tags,
      ...admin(["text_filter.manage"], { step_up: true }),
      params: z.object({ id: z.uuid() }),
      async handler({ params, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const r = await trx.deleteFrom("filter_entries").where("id", "=", params.id).returningAll().executeTakeFirst();
          if (!r) throw new ProblemError(404, "ENTRY_NOT_FOUND");
          await ctx.audit(trx, { actor: staff(id), action: "text_filter.entry_removed", target: { type: "filter_entry", id: `${r.list}:${r.word}` }, ip: id.ip });
        });
        await reloadCustomEntries(ctx);
        ctx.bus.publish("qtiauth.identity.filter.reload", {});
        return { status: "removed" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/text-filter/test",
      summary: "Test text against the filter",
      tags,
      ...admin(["text_filter.manage"]),
      body: z.object({ text: z.string().max(200) }),
      async handler({ body }) {
        const d = await checkText(ctx, ctx.db, body.text, "admin_test");
        return { action: d.action, rule: d.rule, matched: d.matched, normalized: d.normalized };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/retention/sweep",
      summary: "Run the retention sweep now",
      description: "Publishes the retention.sweep job so every running service sweeps its own data.",
      tags,
      ...admin(["system.retention"], { step_up: true }),
      async handler({ id }) {
        const env = makeEvent(cronSubject("retention.sweep"), { manual: true, requested_by: id.sub }, { subject: { type: "job", id: "retention.sweep" }, actor: staff(id) });
        await ctx.bus.publishEvent(env);
        await ctx.db.transaction().execute((trx) => ctx.audit(trx, { actor: staff(id), action: "retention.sweep_triggered", ip: id.ip }));
        return { status: "queued" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/legal-holds",
      summary: "Active legal holds",
      tags,
      ...admin(["safety.csea.access"]),
      async handler() {
        const rows = await ctx.db.selectFrom("legal_holds").selectAll().where("released_at", "is", null).orderBy("created_at", "desc").execute();
        return { items: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), released_at: null })) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/staff-without-2fa",
      summary: "Staff accounts that have not enrolled in two-factor",
      tags,
      ...admin(["users.read"]),
      async handler() {
        const rows = await sql<{ id: string; username: string | null; email: string | null }>`
          select u.id, u.username, u.email from users u
          where exists (select 1 from user_roles r where r.user_id = u.id)
            and not exists (select 1 from totp t where t.user_id = u.id and t.confirmed_at is not null)
            and not exists (select 1 from passkeys p where p.user_id = u.id)
            and u.state <> 'deleted'`.execute(ctx.db);
        return { items: rows.rows };
      },
    }),
  ];
}
