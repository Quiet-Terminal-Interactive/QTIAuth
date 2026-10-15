import { z } from "zod";
import { sql } from "kysely";
import { ProblemError, decodeCursor, encodeCursor, parseDuration } from "@qtiauth/common";
import { hasPermission } from "@qtiauth/config";
import { route, type AnyRoute, zIdParam, zReason } from "@qtiauth/service-kit";
import type { IdentityClaims } from "@qtiauth/auth-context";
import {
  actionView,
  appealView,
  applyAction,
  approveAction,
  assertUuid,
  classify,
  createReport,
  cseaMetadata,
  dismissReport,
  liftAction,
  openCseaCase,
  reportView,
  resolveAppeal,
  staffActor,
  type Ctx,
} from "../lib.ts";
import type { Report } from "../db.ts";
import { zContent } from "./user.ts";

const tags = ["admin", "safety"];
const staff = (permissions: string[], extra: { step_up?: boolean } = {}) => ({
  auth: "session" as const,
  permissions,
  rate_limit: ["admin"],
  step_up: extra.step_up ?? false,
});

const zDuration = z
  .string()
  .regex(/^(\d+(?:\.\d+)?(ms|s|m|h|d|w|y)\s*)+$/)
  .transform((v) => parseDuration(v));

export function canSeeCsea(id: IdentityClaims): boolean {
  return hasPermission(id.perms, "safety.csea.access");
}

export function adminRoutes(ctx: Ctx): AnyRoute[] {
  const cfg = ctx.config.safety;

  async function loadReport(reportId: string, id: IdentityClaims): Promise<Report> {
    const r = await ctx.db.selectFrom("reports").selectAll().where("id", "=", assertUuid(reportId, "REPORT_NOT_FOUND")).executeTakeFirst();
    if (!r) throw new ProblemError(404, "REPORT_NOT_FOUND");
    if (r.csea && !canSeeCsea(id)) throw new ProblemError(404, "REPORT_NOT_FOUND");
    return r;
  }

  async function users(ids: (string | null | undefined)[]): Promise<Record<string, unknown>> {
    const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (!unique.length) return {};
    return ctx.rpcOptional<Record<string, unknown>>("identity.get_users", { ids: unique }, {});
  }

  return [
    route({
      method: "GET",
      path: "/api/v1/admin/safety/overview",
      summary: "Moderation configuration and queue summary",
      tags,
      ...staff(["safety.reports.read"]),
      async handler({ id }) {
        const csea = canSeeCsea(id);
        const counts = await ctx.db
          .selectFrom("reports")
          .select(["priority", sql<number>`count(*)::int`.as("n"), sql<number>`count(*) filter (where sla_due_at < now())::int`.as("overdue")])
          .where("status", "in", ["open", "in_review"])
          .$if(!csea, (q) => q.where("csea", "=", false))
          .groupBy("priority")
          .execute();
        const appeals = await ctx.db.selectFrom("appeals").select(sql<number>`count(*)::int`.as("n")).where("status", "=", "open").executeTakeFirst();
        const flags = await ctx.db.selectFrom("flags").select(sql<number>`count(*)::int`.as("n")).where("status", "=", "pending").executeTakeFirst();
        const pending = await ctx.db.selectFrom("actions").select(sql<number>`count(*)::int`.as("n")).where("status", "=", "pending_approval").executeTakeFirst();
        const cases = csea ? await ctx.db.selectFrom("csea_cases").select(sql<number>`count(*)::int`.as("n")).where("status", "=", "open").executeTakeFirst() : null;
        return {
          queue: Object.fromEntries(counts.map((c) => [c.priority, { open: c.n, overdue: c.overdue }])),
          open_appeals: appeals?.n ?? 0,
          pending_flags: flags?.n ?? 0,
          pending_approvals: pending?.n ?? 0,
          open_csea_cases: cases ? cases.n : null,
          accountable_person: cfg.accountable_person,
          two_person_bans: cfg.bans.require_second_approval,
          taxonomy: Object.entries(cfg.taxonomy).map(([k, t]) => ({ id: k, label: t.label, osa_category: t.osa_category, priority: t.priority, sla_ms: t.sla, csea: t.csea, subtypes: Object.entries(t.subtypes).map(([s, v]) => ({ id: s, label: v.label, priority: v.priority ?? t.priority })) })),
          actions: Object.entries(cfg.actions).map(([k, a]) => ({ id: k, label: a.label, effect: a.effect, restrictions: a.restrictions, requires_duration: a.requires_duration, default_duration_ms: a.default_duration ?? null })),
          rules: Object.entries(cfg.rules).map(([k, r]) => ({ id: k, title: r.title, text: r.text })),
        };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/safety/reports",
      summary: "Moderation queue",
      description: "Sorted by priority, then SLA due time. CSEA reports appear only for holders of safety.csea.access.",
      tags,
      ...staff(["safety.reports.read"]),
      query: z.object({
        status: z.enum(["open", "in_review", "actioned", "dismissed", "unresolved", "all"]).default("unresolved"),
        priority: z.enum(["low", "normal", "high", "critical"]).optional(),
        type: z.string().max(64).optional(),
        source: z.enum(["user", "game", "flag", "staff"]).optional(),
        reported_user_id: z.uuid().optional(),
        assigned_to: z.union([z.uuid(), z.literal("me"), z.literal("none")]).optional(),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      async handler({ query, id }) {
        const offset = Number(decodeCursor<{ o: number }>(query.cursor)?.o ?? 0);
        let q = ctx.db.selectFrom("reports").selectAll();
        if (query.status === "unresolved") q = q.where("status", "in", ["open", "in_review"]);
        else if (query.status !== "all") q = q.where("status", "=", query.status);
        if (!canSeeCsea(id)) q = q.where("csea", "=", false);
        if (query.priority) q = q.where("priority", "=", query.priority);
        if (query.type) q = q.where("type", "=", query.type);
        if (query.source) q = q.where("source", "=", query.source);
        if (query.reported_user_id) q = q.where("reported_user_id", "=", query.reported_user_id);
        if (query.assigned_to === "me") q = q.where("assigned_to", "=", id.sub!);
        else if (query.assigned_to === "none") q = q.where("assigned_to", "is", null);
        else if (query.assigned_to) q = q.where("assigned_to", "=", query.assigned_to);
        const rows = await q
          .orderBy(sql`case priority when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`)
          .orderBy("sla_due_at")
          .orderBy("id")
          .offset(offset)
          .limit(query.limit + 1)
          .execute();
        const page = rows.slice(0, query.limit);
        const u = await users(page.map((r) => r.reported_user_id));
        return {
          items: page.map((r) => ({ ...reportView(r, { full: false }), reported_user: r.reported_user_id ? (u[r.reported_user_id] ?? null) : null, type_label: cfg.taxonomy[r.type]?.label ?? r.type })),
          next_cursor: rows.length > query.limit ? encodeCursor({ o: offset + query.limit }) : null,
        };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/safety/reports/:id",
      params: zIdParam,
      summary: "Report detail",
      tags,
      ...staff(["safety.reports.read"]),
      async handler({ params, id }) {
        const r = await loadReport(params.id, id);
        if (r.csea) await ctx.audit(ctx.db, { actor: staffActor(id.sub!), action: "safety.csea.report_viewed", target: { type: "report", id: r.id }, ip: id.ip });
        const actions = r.reported_user_id ? await ctx.db.selectFrom("actions").selectAll().where("user_id", "=", r.reported_user_id).orderBy("created_at", "desc").limit(20).execute() : [];
        const related = r.reported_user_id
          ? await ctx.db
              .selectFrom("reports")
              .select(["id", "reference", "type", "status", "created_at"])
              .where("reported_user_id", "=", r.reported_user_id)
              .where("id", "!=", r.id)
              .$if(!canSeeCsea(id), (q) => q.where("csea", "=", false))
              .orderBy("created_at", "desc")
              .limit(20)
              .execute()
          : [];
        const u = await users([r.reported_user_id, r.reporter_user_id, r.assigned_to]);
        return {
          ...reportView(r, { full: true }),
          type_label: cfg.taxonomy[r.type]?.label ?? r.type,
          reported_user: r.reported_user_id ? (u[r.reported_user_id] ?? null) : null,
          reporter: r.reporter_user_id ? (u[r.reporter_user_id] ?? null) : null,
          assignee: r.assigned_to ? (u[r.assigned_to] ?? null) : null,
          user_actions: actions.map((a) => actionView(ctx, a, { staff: true })),
          related_reports: related.map((x) => ({ ...x, created_at: x.created_at.toISOString() })),
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/reports/:id/assign",
      params: zIdParam,
      summary: "Assign a report",
      tags,
      ...staff(["safety.reports.read"]),
      body: z.object({ assignee: z.union([z.uuid(), z.literal("me")]).nullable() }),
      async handler({ params, body, id }) {
        const r = await loadReport(params.id, id);
        const assignee = body.assignee === "me" ? id.sub! : body.assignee;
        await ctx.db
          .updateTable("reports")
          .set({ assigned_to: assignee, status: r.status === "open" && assignee ? "in_review" : r.status, updated_at: new Date() })
          .where("id", "=", r.id)
          .execute();
        return { status: "assigned", assigned_to: assignee };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/reports/:id/dismiss",
      params: zIdParam,
      summary: "Dismiss a report with no action",
      tags,
      ...staff(["safety.actions.apply"]),
      body: z.object({ reason: zReason }),
      async handler({ params, body, id }) {
        const r = await loadReport(params.id, id);
        await ctx.db.transaction().execute((trx) => dismissReport(ctx, trx, r, id.sub!, body.reason));
        return { status: "dismissed" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/reports/:id/reclassify",
      params: zIdParam,
      summary: "Change a report's type",
      description: "Reclassifying into a CSEA-flagged type opens a CSEA case, moves the snapshot into the evidence store and places a legal hold.",
      tags,
      ...staff(["safety.actions.apply"]),
      body: z.object({ type: z.string().max(64), subtype: z.string().max(64).nullable().optional(), reason: zReason }),
      async handler({ params, body, id }) {
        const r = await loadReport(params.id, id);
        const c = classify(ctx, body.type, body.subtype ?? null);
        const meta = c.csea && !r.csea ? await cseaMetadata(ctx, r.reported_user_id, r.reporter_user_id) : null;
        await ctx.db.transaction().execute(async (trx) => {
          const updated = await trx
            .updateTable("reports")
            .set({ type: body.type, subtype: body.subtype ?? null, priority: c.priority, sla_due_at: new Date(r.created_at.getTime() + c.slaMs), updated_at: new Date() })
            .where("id", "=", r.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          await ctx.audit(trx, { actor: staffActor(id.sub!), action: "safety.report.reclassified", target: { type: "report", id: r.id }, reason: body.reason, data: { from: r.type, to: body.type } });
          if (meta) await openCseaCase(ctx, trx, updated, meta, id.sub!);
        });
        return { status: "reclassified", csea: c.csea };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/reports",
      summary: "Open a report on behalf of staff",
      tags,
      ...staff(["safety.actions.apply"]),
      body: z.object({ type: z.string().max(64), subtype: z.string().max(64).nullable().optional(), reported_user_id: z.uuid().nullable().optional(), content: zContent, description: z.string().max(4000).nullable().optional(), game_id: z.string().max(80).nullable().optional() }),
      async handler({ body, id }) {
        const c = classify(ctx, body.type, body.subtype ?? null);
        const meta = c.csea ? await cseaMetadata(ctx, body.reported_user_id ?? null, null) : null;
        const r = await ctx.db.transaction().execute((trx) =>
          createReport(
            ctx,
            trx,
            {
              source: "staff",
              type: body.type,
              subtype: body.subtype ?? null,
              reporter_user_id: null,
              reporter_client_id: null,
              game_id: body.game_id ?? null,
              reported_user_id: body.reported_user_id ?? null,
              content: body.content ?? null,
              snapshot: null,
              context: { opened_by: id.sub },
              description: body.description ?? null,
            },
            meta,
          ),
        );
        return { report_id: r.id, reference: r.reference };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/actions",
      summary: "Apply a moderation action",
      description: "Staff must choose a configured rule. The user receives a statement of reasons. Permanent bans need a second moderator when safety.bans.require_second_approval is on.",
      tags,
      ...staff(["safety.actions.apply"], { step_up: true }),
      body: z.object({
        user_id: z.uuid(),
        action_type: z.string().max(64),
        rule: z.string().max(100),
        duration: zDuration.optional(),
        note: z.string().trim().max(4000).optional(),
        report_id: z.uuid().optional(),
        game_id: z.string().max(80).optional(),
        content: zContent,
      }),
      async handler({ body, id }) {
        if (body.user_id === id.sub) throw new ProblemError(422, "CANNOT_ACTION_SELF");
        if (body.report_id) await loadReport(body.report_id, id);
        const exists = await ctx.rpc<unknown | null>("identity.get_user_summary", { user_id: body.user_id });
        if (!exists) throw new ProblemError(404, "USER_NOT_FOUND");
        const action = await ctx.db.transaction().execute((trx) =>
          applyAction(ctx, trx, {
            user_id: body.user_id,
            action_type: body.action_type,
            rule: body.rule,
            duration_ms: body.duration ?? null,
            note: body.note ?? null,
            report_id: body.report_id ?? null,
            game_id: body.game_id ?? null,
            content: body.content ?? null,
            moderator_id: id.sub!,
          }),
        );
        return actionView(ctx, action, { staff: true });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/safety/actions",
      summary: "Moderation history per user or per moderator",
      tags,
      ...staff(["safety.reports.read"]),
      query: z.object({
        user_id: z.uuid().optional(),
        moderator_id: z.uuid().optional(),
        status: z.enum(["active", "pending_approval", "rejected", "lifted", "expired", "completed"]).optional(),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      async handler({ query }) {
        const c = decodeCursor<{ t: string; id: string }>(query.cursor);
        let q = ctx.db.selectFrom("actions").selectAll();
        if (query.user_id) q = q.where("user_id", "=", query.user_id);
        if (query.moderator_id) q = q.where((eb) => eb.or([eb("moderator_id", "=", query.moderator_id!), eb("approved_by", "=", query.moderator_id!)]));
        if (query.status) q = q.where("status", "=", query.status);
        if (c) q = q.where((eb) => eb.or([eb("created_at", "<", new Date(c.t)), eb.and([eb("created_at", "=", new Date(c.t)), eb("id", "<", c.id)])]));
        const rows = await q.orderBy("created_at", "desc").orderBy("id", "desc").limit(query.limit + 1).execute();
        const page = rows.slice(0, query.limit);
        const last = page[page.length - 1];
        const u = await users(page.flatMap((a) => [a.user_id, a.moderator_id]));
        return {
          items: page.map((a) => ({ ...actionView(ctx, a, { staff: true }), user: u[a.user_id] ?? null, moderator: u[a.moderator_id] ?? null })),
          next_cursor: rows.length > query.limit && last ? encodeCursor({ t: last.created_at.toISOString(), id: last.id }) : null,
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/actions/:id/approve",
      params: zIdParam,
      summary: "Second-moderator approval of a permanent ban",
      tags,
      ...staff(["safety.actions.apply"], { step_up: true }),
      async handler({ params, id }) {
        const a = await ctx.db.selectFrom("actions").selectAll().where("id", "=", assertUuid(params.id, "ACTION_NOT_FOUND")).executeTakeFirst();
        if (!a) throw new ProblemError(404, "ACTION_NOT_FOUND");
        const updated = await ctx.db.transaction().execute((trx) => approveAction(ctx, trx, a, id.sub!));
        return actionView(ctx, updated, { staff: true });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/actions/:id/lift",
      params: zIdParam,
      summary: "Lift an action, or reject a pending one",
      tags,
      ...staff(["safety.actions.apply"], { step_up: true }),
      body: z.object({ reason: zReason }),
      async handler({ params, body, id }) {
        const a = await ctx.db.selectFrom("actions").selectAll().where("id", "=", assertUuid(params.id, "ACTION_NOT_FOUND")).executeTakeFirst();
        if (!a) throw new ProblemError(404, "ACTION_NOT_FOUND");
        await ctx.db.transaction().execute((trx) => liftAction(ctx, trx, a, id.sub!, body.reason));
        return { status: a.status === "pending_approval" ? "rejected" : "lifted" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/safety/appeals",
      summary: "Appeals",
      tags,
      ...staff(["safety.appeals.resolve"]),
      query: z.object({ status: z.enum(["open", "upheld", "lifted", "all"]).default("open"), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      async handler({ query }) {
        let q = ctx.db.selectFrom("appeals").innerJoin("actions", "actions.id", "appeals.action_id").selectAll("appeals").select(["actions.action_type", "actions.effect", "actions.rule", "actions.status as action_status"]);
        if (query.status !== "all") q = q.where("appeals.status", "=", query.status);
        const rows = await q.orderBy("appeals.created_at", query.status === "open" ? "asc" : "desc").limit(query.limit).execute();
        const u = await users(rows.map((r) => r.user_id));
        return {
          items: rows.map((r) => ({
            ...appealView(r),
            user: u[r.user_id] ?? null,
            action: { action_type: r.action_type, label: cfg.actions[r.action_type]?.label ?? r.action_type, effect: r.effect, rule: r.rule, status: r.action_status },
          })),
        };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/safety/appeals/:id",
      params: zIdParam,
      summary: "Appeal detail",
      tags,
      ...staff(["safety.appeals.resolve"]),
      async handler({ params }) {
        const ap = await ctx.db.selectFrom("appeals").selectAll().where("id", "=", assertUuid(params.id, "APPEAL_NOT_FOUND")).executeTakeFirst();
        if (!ap) throw new ProblemError(404, "APPEAL_NOT_FOUND");
        const action = await ctx.db.selectFrom("actions").selectAll().where("id", "=", ap.action_id).executeTakeFirstOrThrow();
        const u = await users([ap.user_id, action.moderator_id]);
        return { ...appealView(ap), user: u[ap.user_id] ?? null, action: { ...actionView(ctx, action, { staff: true }), moderator: u[action.moderator_id] ?? null } };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/appeals/:id/resolve",
      params: zIdParam,
      summary: "Resolve an appeal",
      description: "Lift the action or leave it in place. The user is notified either way.",
      tags,
      ...staff(["safety.appeals.resolve"], { step_up: true }),
      body: z.object({ outcome: z.enum(["lift", "uphold"]), note: zReason }),
      async handler({ params, body, id }) {
        const ap = await ctx.db.selectFrom("appeals").selectAll().where("id", "=", assertUuid(params.id, "APPEAL_NOT_FOUND")).executeTakeFirst();
        if (!ap) throw new ProblemError(404, "APPEAL_NOT_FOUND");
        await ctx.db.transaction().execute((trx) => resolveAppeal(ctx, trx, ap, id.sub!, body.outcome, body.note));
        return { status: body.outcome === "lift" ? "lifted" : "upheld" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/safety/flags",
      summary: "Automated flags below the auto-report threshold",
      tags,
      ...staff(["safety.flags.read"]),
      query: z.object({ status: z.enum(["pending", "reported", "dismissed"]).default("pending"), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      async handler({ query }) {
        const rows = await ctx.db.selectFrom("flags").selectAll().where("status", "=", query.status).orderBy("score", "desc").orderBy("created_at", "desc").limit(query.limit).execute();
        return {
          threshold: cfg.flag_auto_report_threshold,
          items: rows.map((f) => ({ ...f, snapshot: f.labels.some((l) => cfg.taxonomy[l]?.csea) ? null : f.snapshot, created_at: f.created_at.toISOString() })),
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/flags/:id/review",
      params: zIdParam,
      summary: "Turn a flag into a report, or dismiss it",
      tags,
      ...staff(["safety.flags.read"]),
      body: z.object({ decision: z.enum(["report", "dismiss"]), type: z.string().max(64).optional(), subtype: z.string().max(64).nullable().optional() }),
      async handler({ params, body, id }) {
        const f = await ctx.db.selectFrom("flags").selectAll().where("id", "=", assertUuid(params.id, "FLAG_NOT_FOUND")).executeTakeFirst();
        if (!f || f.status !== "pending") throw new ProblemError(404, "FLAG_NOT_FOUND");
        if (body.decision === "dismiss") {
          await ctx.db.updateTable("flags").set({ status: "dismissed", reviewed_by: id.sub! }).where("id", "=", f.id).execute();
          return { status: "dismissed" };
        }
        const type = body.type ?? f.labels[0];
        if (!type) throw new ProblemError(422, "TYPE_REQUIRED");
        const c = classify(ctx, type, body.subtype ?? null);
        const meta = c.csea ? await cseaMetadata(ctx, f.user_id, null) : null;
        const r = await ctx.db.transaction().execute(async (trx) => {
          const report = await createReport(
            ctx,
            trx,
            {
              source: "flag",
              type,
              subtype: body.subtype ?? null,
              reporter_user_id: null,
              reporter_client_id: f.client_id,
              game_id: f.game_id,
              reported_user_id: f.user_id,
              content: f.content,
              snapshot: f.snapshot,
              context: { classifier: f.classifier, score: f.score, labels: f.labels, reviewed_by: id.sub },
              description: null,
              flag_id: f.id,
            },
            meta,
          );
          await trx.updateTable("flags").set({ status: "reported", report_id: report.id, reviewed_by: id.sub! }).where("id", "=", f.id).execute();
          return report;
        });
        return { status: "reported", report_id: r.id };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/safety/users/:id/history",
      params: zIdParam,
      summary: "Moderation history for a user",
      tags,
      ...staff(["safety.reports.read"]),
      async handler({ params, id }) {
        const userId = assertUuid(params.id, "USER_NOT_FOUND");
        return userHistory(ctx, userId, canSeeCsea(id));
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/safety/stats",
      summary: "Moderation metrics",
      tags,
      ...staff(["safety.reports.read"]),
      query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
      async handler({ query, id }) {
        const since = new Date(Date.now() - query.days * 86_400_000);
        const csea = canSeeCsea(id);
        const byType = await ctx.db
          .selectFrom("reports")
          .select([
            "type",
            sql<number>`count(*)::int`.as("received"),
            sql<number>`count(*) filter (where status = 'actioned')::int`.as("actioned"),
            sql<number>`count(*) filter (where status = 'dismissed')::int`.as("dismissed"),
            sql<number>`count(*) filter (where sla_breached_at is not null)::int`.as("sla_breaches"),
            sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from first_action_at - created_at)) filter (where first_action_at is not null)`.as("median_time_to_action_s"),
          ])
          .where("created_at", ">=", since)
          .$if(!csea, (q) => q.where("csea", "=", false))
          .groupBy("type")
          .execute();
        const actions = await ctx.db.selectFrom("actions").select(["action_type", sql<number>`count(*)::int`.as("n")]).where("created_at", ">=", since).groupBy("action_type").execute();
        const appeals = await ctx.db.selectFrom("appeals").select(["status", sql<number>`count(*)::int`.as("n")]).where("created_at", ">=", since).groupBy("status").execute();
        return {
          since: since.toISOString(),
          reports: byType.map((r) => ({ ...r, median_time_to_action_s: r.median_time_to_action_s === null ? null : Math.round(Number(r.median_time_to_action_s)) })),
          actions: Object.fromEntries(actions.map((a) => [a.action_type, a.n])),
          appeals: Object.fromEntries(appeals.map((a) => [a.status, a.n])),
        };
      },
    }),
  ];
}

export async function userHistory(ctx: Ctx, userId: string, includeCsea: boolean) {
  const reports = await ctx.db
    .selectFrom("reports")
    .selectAll()
    .where("reported_user_id", "=", userId)
    .$if(!includeCsea, (q) => q.where("csea", "=", false))
    .orderBy("created_at", "desc")
    .limit(100)
    .execute();
  const actions = await ctx.db.selectFrom("actions").selectAll().where("user_id", "=", userId).orderBy("created_at", "desc").limit(100).execute();
  const appeals = await ctx.db.selectFrom("appeals").selectAll().where("user_id", "=", userId).orderBy("created_at", "desc").limit(100).execute();
  const holds = await ctx.db.selectFrom("legal_holds").select(["id", "placed_at"]).where("user_id", "=", userId).where("released_at", "is", null).execute();
  return {
    reports_against: reports.map((r) => reportView(r, { full: false })),
    reports_made: Number((await ctx.db.selectFrom("reports").select(sql<number>`count(*)::int`.as("n")).where("reporter_user_id", "=", userId).executeTakeFirst())?.n ?? 0),
    actions: actions.map((a) => actionView(ctx, a, { staff: true })),
    appeals: appeals.map(appealView),
    legal_hold: holds.length > 0,
  };
}
