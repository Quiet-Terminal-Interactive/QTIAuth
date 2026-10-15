import { z } from "zod";
import { ProblemError, uuidv7 } from "@qtiauth/common";
import { route, type AnyRoute, zIdParam, zReason } from "@qtiauth/service-kit";
import { applyAction, assertUuid, ncaDeadline, openEvidence, referenceRetainUntil, releaseHold, reportView, staffActor, startEvidenceRetention, type Ctx } from "../lib.ts";
import { ncaSheet } from "../nca.ts";

const NCA_REQUEST_DEADLINE_MS = 7 * 86_400_000;

const tags = ["admin", "safety", "csea"];
const csea = (extra: { step_up?: boolean } = {}) => ({
  auth: "session" as const,
  permissions: ["safety.csea.access"],
  rate_limit: ["admin"],
  step_up: extra.step_up ?? false,
});

export function cseaRoutes(ctx: Ctx): AnyRoute[] {
  const cfg = ctx.config.safety;

  async function loadCase(caseId: string) {
    const c = await ctx.db.selectFrom("csea_cases").selectAll().where("id", "=", assertUuid(caseId, "CASE_NOT_FOUND")).executeTakeFirst();
    if (!c) throw new ProblemError(404, "CASE_NOT_FOUND");
    return c;
  }

  function caseView(c: Awaited<ReturnType<typeof loadCase>>) {
    return {
      id: c.id,
      report_id: c.report_id,
      status: c.status,
      deadline_at: c.deadline_at.toISOString(),
      overdue: c.status === "open" && c.deadline_at < new Date(),
      nca_priority: c.nca_priority,
      priority_reason: c.priority_reason,
      priority_assessed_at: c.priority_assessed_at?.toISOString() ?? null,
      nca_reference: c.nca_reference,
      nca_submitted_at: c.nca_submitted_at?.toISOString() ?? null,
      reported_elsewhere: c.foreign_body ? { body: c.foreign_body, reference: c.foreign_reference, reported_at: c.foreign_reported_at?.toISOString() ?? null } : null,
      reference_retain_until: c.reference_retain_until?.toISOString() ?? null,
      close_outcome: c.close_outcome,
      protective_action_id: c.protective_action_id,
      legal_hold: Boolean(c.hold_id),
      created_at: c.created_at.toISOString(),
      closed_at: c.closed_at?.toISOString() ?? null,
    };
  }

  function protectiveActionType(): string {
    const lock = Object.entries(cfg.actions).find(([, a]) => a.effect === "lock");
    if (!lock) throw new ProblemError(422, "NO_LOCK_ACTION_CONFIGURED");
    return lock[0];
  }

  function removalActionType(): string | null {
    return Object.entries(cfg.actions).find(([, a]) => a.effect === "remove_content")?.[0] ?? null;
  }

  function cseaRule(): string {
    if (cfg.rules["conduct.csea"]) return "conduct.csea";
    const first = Object.keys(cfg.rules)[0];
    if (!first) throw new ProblemError(422, "NO_RULES_CONFIGURED");
    return first;
  }

  return [
    route({
      method: "GET",
      path: "/api/v1/admin/safety/csea",
      summary: "CSEA cases",
      tags,
      ...csea(),
      query: z.object({ status: z.enum(["open", "submitted", "closed", "all"]).default("open") }),
      async handler({ query }) {
        let q = ctx.db.selectFrom("csea_cases").selectAll();
        if (query.status !== "all") q = q.where("status", "=", query.status);
        const rows = await q.orderBy("deadline_at").limit(200).execute();
        return { items: rows.map(caseView) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/safety/csea/:id",
      params: zIdParam,
      summary: "CSEA case detail with preserved evidence",
      description: "Every view is audited. Lists the fields the NCA reporting portal asks for.",
      tags,
      ...csea(),
      async handler({ params, id }) {
        const c = await loadCase(params.id);
        const report = await ctx.db.selectFrom("reports").selectAll().where("id", "=", c.report_id).executeTakeFirstOrThrow();
        const ev = await ctx.db.selectFrom("evidence").selectAll().where("case_id", "=", c.id).orderBy("created_at").execute();
        const [supplementary, requests, preservation] = await Promise.all([
          ctx.db.selectFrom("csea_supplementary").selectAll().where("case_id", "=", c.id).orderBy("submitted_at").execute(),
          ctx.db.selectFrom("csea_nca_requests").selectAll().where("case_id", "=", c.id).orderBy("received_at").execute(),
          ctx.db.selectFrom("preservation_requests").selectAll().where("case_id", "=", c.id).orderBy("created_at").execute(),
        ]);
        const previous = report.reported_user_id
          ? await ctx.db
            .selectFrom("csea_cases")
            .innerJoin("reports", "reports.id", "csea_cases.report_id")
            .select("csea_cases.nca_reference")
            .where("reports.reported_user_id", "=", report.reported_user_id)
            .where("csea_cases.id", "!=", c.id)
            .where("csea_cases.nca_reference", "is not", null)
            .execute()
          : [];
        await ctx.audit(ctx.db, { actor: staffActor(id.sub!), action: "safety.csea.case_viewed", target: { type: "csea_case", id: c.id }, ip: id.ip });
        const evidence = ev.map((e) => ({
          id: e.id,
          kind: e.kind,
          created_at: e.created_at.toISOString(),
          destroy_after: e.destroy_after?.toISOString() ?? null,
          destroyed: Boolean(e.destroyed_at),
          data: e.destroyed_at ? null : openEvidence(ctx, c.id, e.ciphertext),
        }));
        const opened = evidence.find((e) => e.kind === "case_opened" && e.data);
        const now = new Date();
        return {
          ...caseView(c),
          report: reportView(report, { full: false }),
          evidence,
          nca_sheet: ncaSheet(c, report, (opened?.data as Parameters<typeof ncaSheet>[2]) ?? null, previous.map((p) => p.nca_reference!)),
          supplementary: supplementary.map((s) => ({ id: s.id, nca_reference: s.nca_reference, submitted_at: s.submitted_at.toISOString(), note: s.note })),
          nca_requests: requests.map((r) => ({
            id: r.id,
            received_at: r.received_at.toISOString(),
            due_at: r.due_at.toISOString(),
            overdue: !r.responded_at && r.due_at < now,
            summary: r.summary,
            responded_at: r.responded_at?.toISOString() ?? null,
            response_note: r.response_note,
          })),
          preservation_requests: preservation.map((p) => ({ id: p.id, game_id: p.game_id, status: p.status, window_start: p.window_start.toISOString(), window_end: p.window_end.toISOString(), fulfilled_at: p.fulfilled_at?.toISOString() ?? null })),
          deadlines_ms: cfg.nca_deadlines,
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/csea/:id/submission",
      params: zIdParam,
      summary: "Record the NCA submission",
      description: "Starts the evidence retention period (at least one year from the report being sent) and keeps the reference for at least five years.",
      tags,
      ...csea({ step_up: true }),
      body: z.object({ nca_reference: z.string().trim().min(3).max(200), submitted_at: z.iso.datetime().optional() }),
      async handler({ params, body, id }) {
        const c = await loadCase(params.id);
        if (c.status !== "open") throw new ProblemError(409, c.status === "closed" ? "CASE_CLOSED" : "ALREADY_SUBMITTED", "Record later information as a supplementary report");
        if (!c.nca_priority) throw new ProblemError(409, "NCA_PRIORITY_REQUIRED", "Assess the priority level before reporting");
        const at = body.submitted_at ? new Date(body.submitted_at) : new Date();
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .updateTable("csea_cases")
            .set({ status: "submitted", nca_reference: body.nca_reference, nca_submitted_at: at, nca_submitted_by: id.sub!, reference_retain_until: referenceRetainUntil(ctx, at) })
            .where("id", "=", c.id)
            .execute();
          await startEvidenceRetention(ctx, trx, c.id, at);
          await ctx.audit(trx, { actor: staffActor(id.sub!), action: "safety.csea.nca_submitted", target: { type: "csea_case", id: c.id }, ip: id.ip });
        });
        return { status: "submitted" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/csea/:id/priority",
      params: zIdParam,
      summary: "Assess the NCA priority level",
      description: "1: immediate threat to a child's life or of serious harm (report immediately). 2: possible serious harm soon or urgent safeguarding (as soon as reasonably practicable). 3: neither (without undue delay). Sets the internal deadline from safety.nca_deadlines.",
      tags,
      ...csea(),
      body: z.object({ level: z.coerce.number().int().min(1).max(3), reason: zReason }),
      async handler({ params, body, id }) {
        const c = await loadCase(params.id);
        if (c.status !== "open") throw new ProblemError(409, "ALREADY_SUBMITTED");
        const level = body.level as 1 | 2 | 3;
        const deadline = ncaDeadline(ctx, c.created_at, level);
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .updateTable("csea_cases")
            .set({ nca_priority: level, priority_reason: body.reason, priority_assessed_at: new Date(), priority_assessed_by: id.sub!, deadline_at: deadline })
            .where("id", "=", c.id)
            .execute();
          await ctx.audit(trx, { actor: staffActor(id.sub!), action: "safety.csea.priority_assessed", target: { type: "csea_case", id: c.id }, reason: `Level ${level}: ${body.reason}`, ip: id.ip });
        });
        return { nca_priority: level, deadline_at: deadline.toISOString() };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/csea/:id/supplementary",
      params: zIdParam,
      summary: "Record a supplementary NCA report",
      description: "For information that wasn't available when the first report was made (SI 2026/268 reg 6(5)).",
      tags,
      ...csea({ step_up: true }),
      body: z.object({ nca_reference: z.string().trim().min(3).max(200), submitted_at: z.iso.datetime().optional(), note: z.string().trim().max(2000).optional() }),
      async handler({ params, body, id }) {
        const c = await loadCase(params.id);
        if (!c.nca_submitted_at) throw new ProblemError(409, "NCA_SUBMISSION_REQUIRED", "Record the first report before a supplementary one");
        const at = body.submitted_at ? new Date(body.submitted_at) : new Date();
        const retain = referenceRetainUntil(ctx, at);
        await ctx.db.transaction().execute(async (trx) => {
          await trx.insertInto("csea_supplementary").values({ id: uuidv7(), case_id: c.id, nca_reference: body.nca_reference, submitted_at: at, submitted_by: id.sub!, note: body.note ?? null }).execute();
          if (!c.reference_retain_until || c.reference_retain_until < retain) await trx.updateTable("csea_cases").set({ reference_retain_until: retain }).where("id", "=", c.id).execute();
          await startEvidenceRetention(ctx, trx, c.id, at);
          await ctx.audit(trx, { actor: staffActor(id.sub!), action: "safety.csea.nca_supplementary", target: { type: "csea_case", id: c.id }, ip: id.ip });
        });
        return { status: "recorded" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/csea/:id/reported-elsewhere",
      params: zIdParam,
      summary: "Record that the content was reported to a foreign body instead",
      description: "Content already reported to a qualifying body outside the UK (such as NCMEC) is not reported again to the NCA. If you report to a foreign body routinely, tell the NCA (SI 2026/268 reg 3(4)).",
      tags,
      ...csea({ step_up: true }),
      body: z.object({ body: z.string().trim().min(2).max(100), reference: z.string().trim().min(1).max(200), reported_at: z.iso.datetime().optional() }),
      async handler({ params, body, id }) {
        const c = await loadCase(params.id);
        if (c.status !== "open") throw new ProblemError(409, "ALREADY_SUBMITTED");
        const at = body.reported_at ? new Date(body.reported_at) : new Date();
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .updateTable("csea_cases")
            .set({ status: "submitted", foreign_body: body.body, foreign_reference: body.reference, foreign_reported_at: at, reference_retain_until: referenceRetainUntil(ctx, at) })
            .where("id", "=", c.id)
            .execute();
          await startEvidenceRetention(ctx, trx, c.id, at);
          await ctx.audit(trx, { actor: staffActor(id.sub!), action: "safety.csea.reported_elsewhere", target: { type: "csea_case", id: c.id }, reason: body.body, ip: id.ip });
        });
        return { status: "submitted" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/csea/:id/nca-requests",
      params: zIdParam,
      summary: "Log a request from the NCA",
      description: "Requests must be answered as soon as reasonably practicable and within seven days (SI 2026/268 reg 7).",
      tags,
      ...csea(),
      body: z.object({ summary: z.string().trim().min(3).max(2000), received_at: z.iso.datetime().optional() }),
      async handler({ params, body, id }) {
        const c = await loadCase(params.id);
        const received = body.received_at ? new Date(body.received_at) : new Date();
        const requestId = uuidv7();
        await ctx.db.transaction().execute(async (trx) => {
          await trx.insertInto("csea_nca_requests").values({ id: requestId, case_id: c.id, received_at: received, due_at: new Date(received.getTime() + NCA_REQUEST_DEADLINE_MS), summary: body.summary }).execute();
          await ctx.audit(trx, { actor: staffActor(id.sub!), action: "safety.csea.nca_request_logged", target: { type: "csea_case", id: c.id }, ip: id.ip });
        });
        return { id: requestId, due_at: new Date(received.getTime() + NCA_REQUEST_DEADLINE_MS).toISOString() };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/csea/:id/nca-requests/:request_id/respond",
      params: z.object({ id: z.string().min(1).max(128), request_id: z.string().min(1).max(128) }),
      summary: "Record the answer to an NCA request",
      tags,
      ...csea({ step_up: true }),
      body: z.object({ note: zReason }),
      async handler({ params, body, id }) {
        const c = await loadCase(params.id);
        const res = await ctx.db.transaction().execute(async (trx) => {
          const r = await trx
            .updateTable("csea_nca_requests")
            .set({ responded_at: new Date(), responded_by: id.sub!, response_note: body.note })
            .where("id", "=", assertUuid(params.request_id, "REQUEST_NOT_FOUND"))
            .where("case_id", "=", c.id)
            .where("responded_at", "is", null)
            .executeTakeFirst();
          if (!Number(r.numUpdatedRows)) throw new ProblemError(404, "REQUEST_NOT_FOUND");
          await ctx.audit(trx, { actor: staffActor(id.sub!), action: "safety.csea.nca_request_answered", target: { type: "csea_case", id: c.id }, ip: id.ip });
          return { status: "answered" };
        });
        return res;
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/csea/:id/protect",
      params: zIdParam,
      summary: "Immediate protective action",
      description: "One click: locks the account and requests removal of the reported content.",
      tags,
      ...csea({ step_up: true }),
      body: z.object({ duration: z.string().regex(/^\d+[smhdwy]$/).optional() }),
      async handler({ params, id }) {
        const c = await loadCase(params.id);
        const report = await ctx.db.selectFrom("reports").selectAll().where("id", "=", c.report_id).executeTakeFirstOrThrow();
        if (!report.reported_user_id) throw new ProblemError(422, "NO_REPORTED_USER");
        if (c.protective_action_id) throw new ProblemError(409, "ALREADY_PROTECTED");
        const removal = removalActionType();
        const result = await ctx.db.transaction().execute(async (trx) => {
          const lock = await applyAction(ctx, trx, { user_id: report.reported_user_id!, action_type: protectiveActionType(), rule: cseaRule(), note: `CSEA case ${c.id}`, report_id: report.id, game_id: report.game_id, moderator_id: id.sub! });
          let removed: string | null = null;
          if (removal && report.content?.id) {
            const r = await applyAction(ctx, trx, { user_id: report.reported_user_id!, action_type: removal, rule: cseaRule(), note: `CSEA case ${c.id}`, game_id: report.game_id, content: report.content, moderator_id: id.sub! });
            removed = r.id;
          }
          await trx.updateTable("csea_cases").set({ protective_action_id: lock.id }).where("id", "=", c.id).execute();
          return { lock_action_id: lock.id, removal_action_id: removed };
        });
        return { status: "protected", ...result };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/csea/:id/close",
      params: zIdParam,
      summary: "Close a CSEA case",
      description: "Evidence and the legal hold remain until the evidence retention period ends. An open case can only be closed as not CSEA after review.",
      tags,
      ...csea({ step_up: true }),
      body: z.object({ note: zReason, outcome: z.enum(["not_csea"]).optional() }),
      async handler({ params, body, id }) {
        const c = await loadCase(params.id);
        if (c.status === "closed") throw new ProblemError(409, "CASE_CLOSED");
        if (c.status === "open" && body.outcome !== "not_csea") throw new ProblemError(409, "NCA_SUBMISSION_REQUIRED", "Record the NCA submission before closing the case");
        const pending = await ctx.db.selectFrom("csea_nca_requests").select("id").where("case_id", "=", c.id).where("responded_at", "is", null).executeTakeFirst();
        if (pending) throw new ProblemError(409, "NCA_REQUEST_OPEN", "Answer the NCA's open requests before closing the case");
        const outcome = c.status === "open" ? "not_csea" : c.foreign_body && !c.nca_reference ? "reported_elsewhere" : "reported";
        await ctx.db.transaction().execute(async (trx) => {
          await trx.updateTable("csea_cases").set({ status: "closed", closed_at: new Date(), close_note: body.note, close_outcome: outcome }).where("id", "=", c.id).execute();
          if (outcome === "not_csea") await startEvidenceRetention(ctx, trx, c.id, new Date());
          await trx.updateTable("preservation_requests").set({ status: "cancelled" }).where("case_id", "=", c.id).where("status", "=", "pending").execute();
          await ctx.audit(trx, { actor: staffActor(id.sub!), action: "safety.csea.case_closed", target: { type: "csea_case", id: c.id }, reason: `${outcome}: ${body.note}` });
        });
        return { status: "closed", outcome };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/safety/holds",
      summary: "Active legal holds",
      tags,
      ...csea(),
      async handler() {
        const rows = await ctx.db.selectFrom("legal_holds").selectAll().where("released_at", "is", null).orderBy("placed_at", "desc").limit(500).execute();
        return { items: rows.map((h) => ({ ...h, placed_at: h.placed_at.toISOString(), released_at: null })) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/safety/holds/:id/release",
      params: zIdParam,
      summary: "Release a legal hold",
      tags,
      ...csea({ step_up: true }),
      body: z.object({ reason: zReason }),
      async handler({ params, body, id }) {
        const holdId = assertUuid(params.id, "HOLD_NOT_FOUND");
        await ctx.db.transaction().execute(async (trx) => {
          await releaseHold(ctx, trx, holdId, id.sub!);
          await ctx.audit(trx, { actor: staffActor(id.sub!), action: "safety.legal_hold.released", target: { type: "legal_hold", id: holdId }, reason: body.reason });
        });
        return { status: "released" };
      },
    }),
  ];
}
