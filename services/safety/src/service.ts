import { sql } from "kysely";
import { ProblemError, inc, isUuid, setGauge } from "@qtiauth/common";
import { EVENTS } from "@qtiauth/bus";
import { defineService } from "@qtiauth/service-kit";
import { migrations, type SafetyDB } from "./db.ts";
import { actionView, appealView, createAppeal, liftAction, releaseHold, type Ctx } from "./lib.ts";
import { userRoutes } from "./routes/user.ts";
import { adminRoutes, userHistory } from "./routes/admin.ts";
import { cseaRoutes } from "./routes/csea.ts";

let gaugeTimer: NodeJS.Timeout | null = null;

async function slaCheck(ctx: Ctx): Promise<void> {
  const due = await ctx.db.selectFrom("reports").selectAll().where("status", "in", ["open", "in_review"]).where("sla_breached_at", "is", null).where("sla_due_at", "<", new Date()).limit(1000).execute();
  for (const r of due) {
    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable("reports").set({ sla_breached_at: new Date() }).where("id", "=", r.id).execute();
      if (!r.csea) {
        await ctx.emit(trx, EVENTS.safetyReportSlaBreached, { report_id: r.id, type: r.type, priority: r.priority, sla_due_at: r.sla_due_at.toISOString() }, { subject: { type: "report", id: r.id } });
      }
    });
    inc("qtiauth_safety_sla_breaches_total", { type: r.csea ? "csea" : r.type }, 1, "Report SLA breaches");
  }
}

async function expireActions(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.selectFrom("actions").selectAll().where("status", "=", "active").where("expires_at", "is not", null).where("expires_at", "<=", new Date()).limit(1000).execute();
  for (const a of rows) {
    await ctx.db.transaction().execute((trx) => liftAction(ctx, trx, a, null, "expired", "expired"));
  }
}

async function destroyEvidence(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.selectFrom("evidence").select(["id", "case_id"]).where("destroyed_at", "is", null).where("destroy_after", "<=", new Date()).limit(500).execute();
  for (const e of rows) {
    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable("evidence").set({ ciphertext: "", destroyed_at: new Date() }).where("id", "=", e.id).execute();
      await ctx.audit(trx, { actor: { type: "system", id: "safety-retention" }, action: "safety.csea.evidence_destroyed", target: { type: "csea_case", id: e.case_id } });
      const remaining = await trx.selectFrom("evidence").select("id").where("case_id", "=", e.case_id).where("destroyed_at", "is", null).executeTakeFirst();
      if (!remaining) {
        const c = await trx.selectFrom("csea_cases").select("hold_id").where("id", "=", e.case_id).executeTakeFirst();
        if (c?.hold_id) await releaseHold(ctx, trx, c.hold_id, null);
      }
    });
  }
  return rows.length;
}

async function purgeCases(ctx: Ctx): Promise<number> {
  const now = new Date();
  const rows = await ctx.db
    .selectFrom("csea_cases")
    .select(["id", "report_id"])
    .where("status", "=", "closed")
    .where((eb) => eb.or([eb("reference_retain_until", "<", now), eb.and([eb("reference_retain_until", "is", null), eb("close_outcome", "=", "not_csea")])]))
    .where((eb) => eb.not(eb.exists(eb.selectFrom("evidence").select("id").whereRef("evidence.case_id", "=", "csea_cases.id").where("destroyed_at", "is", null))))
    .limit(500)
    .execute();
  for (const c of rows) {
    await ctx.db.transaction().execute(async (trx) => {
      for (const table of ["csea_supplementary", "csea_nca_requests", "preservation_requests", "evidence"] as const) await trx.deleteFrom(table).where("case_id", "=", c.id).execute();
      await trx.updateTable("reports").set({ case_id: null }).where("id", "=", c.report_id).execute();
      await trx.deleteFrom("csea_cases").where("id", "=", c.id).execute();
      await trx.deleteFrom("reports").where("id", "=", c.report_id).execute();
      await ctx.audit(trx, { actor: { type: "system", id: "safety-retention" }, action: "safety.csea.case_purged", target: { type: "csea_case", id: c.id } });
    });
  }
  return rows.length;
}

async function updateGauges(ctx: Ctx): Promise<void> {
  const depth = await ctx.db.selectFrom("reports").select(["priority", sql<number>`count(*)::int`.as("n")]).where("status", "in", ["open", "in_review"]).where("csea", "=", false).groupBy("priority").execute();
  for (const p of ["low", "normal", "high", "critical"]) setGauge("qtiauth_safety_queue_depth", depth.find((d) => d.priority === p)?.n ?? 0, { priority: p }, "Unresolved reports by priority");
  const cases = await ctx.db.selectFrom("csea_cases").select(sql<number>`count(*)::int`.as("n")).where("status", "!=", "closed").executeTakeFirst();
  setGauge("qtiauth_safety_csea_cases_open", cases?.n ?? 0, {}, "Open CSEA cases (count only)");
  const ncaOverdue = await ctx.db.selectFrom("csea_nca_requests").select(sql<number>`count(*)::int`.as("n")).where("responded_at", "is", null).where("due_at", "<", new Date()).executeTakeFirst();
  setGauge("qtiauth_safety_csea_nca_requests_overdue", ncaOverdue?.n ?? 0, {}, "NCA requests past the seven-day deadline (count only)");
  const submissionOverdue = await ctx.db.selectFrom("csea_cases").select(sql<number>`count(*)::int`.as("n")).where("status", "=", "open").where("deadline_at", "<", new Date()).executeTakeFirst();
  setGauge("qtiauth_safety_csea_submissions_overdue", submissionOverdue?.n ?? 0, {}, "CSEA cases past their NCA submission target (count only)");
  const appeals = await ctx.db.selectFrom("appeals").select(sql<number>`count(*)::int`.as("n")).where("status", "=", "open").executeTakeFirst();
  setGauge("qtiauth_safety_appeals_open", appeals?.n ?? 0, {}, "Open appeals");
}

export const safetyService = defineService<SafetyDB>({
  name: "safety",
  schema: "safety",
  migrations,
  permissions: ["safety.reports.read", "safety.actions.apply", "safety.appeals.resolve", "safety.flags.read", "safety.csea.access"],
  notificationCategories: [
    { id: "safety.reports", label: "Updates on reports you made", locked: true },
    { id: "staff.high_priority_report", label: "High-priority reports", staff: true, default: true },
  ],
  policyDefaults: { module: "safety" },
  features: (ctx) => ["safety.reports", "safety.moderation", "safety.appeals", "safety.csea", ...(ctx.config.safety.bans.require_second_approval ? ["safety.two_person_bans"] : [])],
  routes: (ctx) => [...userRoutes(ctx as Ctx), ...adminRoutes(ctx as Ctx), ...cseaRoutes(ctx as Ctx)],
  async start(ctx) {
    const c = ctx as Ctx;
    c.bus.handle<{ user_id: string }, unknown>("safety.user_history", async (req) => (isUuid(req.user_id) ? userHistory(c, req.user_id, false) : null));

    c.bus.handle<{ user_id: string }, unknown>("safety.appealable_actions", async (req) => {
      if (!isUuid(req.user_id)) return { items: [] };
      const rows = await c.db.selectFrom("actions").selectAll().where("user_id", "=", req.user_id).where("status", "in", ["active", "completed"]).orderBy("created_at", "desc").limit(50).execute();
      const open = await c.db.selectFrom("appeals").select("action_id").where("user_id", "=", req.user_id).where("status", "=", "open").execute();
      const openIds = new Set(open.map((o) => o.action_id));
      return { items: rows.map((a) => ({ ...actionView(c, a, { staff: false }), appeal_open: openIds.has(a.id) })) };
    });

    c.bus.handle<{ user_id: string; action_id: string; statement: string; ticket_id: string; ticket_number: number }, unknown>("safety.register_appeal", async (req) => {
      if (!isUuid(req.action_id)) throw new ProblemError(404, "ACTION_NOT_FOUND");
      const action = await c.db.selectFrom("actions").selectAll().where("id", "=", req.action_id).executeTakeFirst();
      if (!action) throw new ProblemError(404, "ACTION_NOT_FOUND");
      const appeal = await c.db.transaction().execute((trx) => createAppeal(c, trx, { action, user_id: req.user_id, statement: req.statement, ticket_id: req.ticket_id, ticket_number: req.ticket_number }));
      return appealView(appeal);
    });

    await updateGauges(c).catch(() => undefined);
    gaugeTimer = setInterval(() => void updateGauges(c).catch(() => undefined), 30_000);
    gaugeTimer.unref();
  },
  async shutdown() {
    if (gaugeTimer) clearInterval(gaugeTimer);
  },
  cron: {
    "safety.sla_check": (ctx) => slaCheck(ctx as Ctx),
    "safety.expire_actions": (ctx) => expireActions(ctx as Ctx),
  },
  async retention(ctx) {
    const c = ctx as Ctx;
    const cutoff = new Date(Date.now() - c.config.retention.resolved_reports);
    const old = await c.db.selectFrom("reports").select("id").where("csea", "=", false).where("resolved_at", "<", cutoff).limit(10_000).execute();
    const ids = old.map((r) => r.id);
    if (ids.length) {
      await c.db.deleteFrom("flags").where("report_id", "in", ids).execute();
      await c.db.deleteFrom("reports").where("id", "in", ids).execute();
    }
    const flags = await c.db.deleteFrom("flags").where("status", "=", "dismissed").where("created_at", "<", cutoff).executeTakeFirst();
    const destroyed = await destroyEvidence(c);
    return { resolved_reports: ids.length, dismissed_flags: Number(flags.numDeletedRows), csea_evidence_destroyed: destroyed, csea_cases_purged: await purgeCases(c) };
  },
  async exportUser(ctx, userId) {
    const c = ctx as Ctx;
    const made = await c.db.selectFrom("reports").select(["reference", "type", "status", "created_at", "resolved_at"]).where("reporter_user_id", "=", userId).execute();
    const actions = await c.db.selectFrom("actions").selectAll().where("user_id", "=", userId).execute();
    const appeals = await c.db.selectFrom("appeals").selectAll().where("user_id", "=", userId).execute();
    return { reports_made: made, moderation_actions: actions.map((a) => actionView(c, a, { staff: false })), appeals: appeals.map(appealView) };
  },
  async eraseUser(ctx, userId, opts) {
    const c = ctx as Ctx;
    await c.db.transaction().execute(async (trx) => {
      await trx.updateTable("reports").set({ reporter_user_id: null }).where("reporter_user_id", "=", userId).execute();
      await trx.updateTable("reports").set({ reported_user_id: null, snapshot: null, context: null, description: null }).where("reported_user_id", "=", userId).where("csea", "=", false).execute();
      if (!opts.legalHold) await trx.updateTable("reports").set({ reported_user_id: null }).where("reported_user_id", "=", userId).execute();
      await trx.updateTable("flags").set({ user_id: null, snapshot: null }).where("user_id", "=", userId).execute();
      await trx.deleteFrom("appeals").where("user_id", "=", userId).execute();
      if (!opts.legalHold) {
        await trx.updateTable("csea_cases").set({ protective_action_id: null }).where("protective_action_id", "in", trx.selectFrom("actions").select("id").where("user_id", "=", userId)).execute();
        await trx.deleteFrom("actions").where("user_id", "=", userId).execute();
        await trx.deleteFrom("legal_holds").where("user_id", "=", userId).where("released_at", "is not", null).execute();
      }
    });
  },
  async healthWarnings(ctx) {
    const w = [];
    if (ctx.config.safety.accountable_person.name === "Not configured") w.push({ code: "NO_ACCOUNTABLE_PERSON", severity: "warning" as const, message: "safety.accountable_person is not configured (Online Safety Act ICU A2)." });
    if (!ctx.config.safety.csea_alert_emails.length) w.push({ code: "NO_CSEA_ALERT_EMAILS", severity: "warning" as const, message: "safety.csea_alert_emails is empty, so nobody is alerted when a CSEA case opens." });
    if (!ctx.config.secrets.app_encryption_key) w.push({ code: "NO_EVIDENCE_KEY", severity: "error" as const, message: "APP_ENCRYPTION_KEY is not set, so CSEA evidence cannot be preserved." });
    const requests = await ctx.db.selectFrom("csea_nca_requests").select(sql<number>`count(*)::int`.as("n")).where("responded_at", "is", null).where("due_at", "<", new Date()).executeTakeFirst();
    if (requests?.n) w.push({ code: "NCA_REQUEST_OVERDUE", severity: "error" as const, message: `${requests.n} NCA request(s) are past the seven-day response deadline.` });
    const overdue = await ctx.db.selectFrom("csea_cases").select(sql<number>`count(*)::int`.as("n")).where("status", "=", "open").where("deadline_at", "<", new Date()).executeTakeFirst();
    if (overdue?.n) w.push({ code: "CSEA_SUBMISSION_OVERDUE", severity: "error" as const, message: `${overdue.n} CSEA case(s) are past the NCA submission deadline.` });
    return w;
  },
});
