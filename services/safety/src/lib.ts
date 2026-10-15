import { ProblemError, decodeKey, decrypt, deriveSubkey, encrypt, humanCode, inc, isUuid, observe, uuidv7 } from "@qtiauth/common";
import { surfaceUrl } from "@qtiauth/config";
import { EVENTS } from "@qtiauth/bus";
import type { Actor } from "@qtiauth/bus";
import type { ServiceContext, Exec as KitExec } from "@qtiauth/service-kit";
import type { Action, Appeal, ContentRef, CseaCase, Effect, Priority, Report, ReportSource, SafetyDB } from "./db.ts";

export type Ctx = ServiceContext<SafetyDB>;
export type Exec = KitExec<SafetyDB>;

const REFERENCE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

export function priorityRank(p: Priority): number {
  return PRIORITY_RANK[p];
}

export function staffActor(id: string): Actor {
  return { type: "staff", id };
}

export function newReference(prefix: string): string {
  return `${prefix}-${humanCode(8, 4, REFERENCE_ALPHABET)}`;
}

export function formatDuration(ms: number | null): string {
  if (!ms) return "permanent";
  const units: [number, string][] = [
    [86_400_000 * 365, "year"],
    [86_400_000 * 7, "week"],
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [size, name] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export function classify(ctx: Ctx, type: string, subtype: string | null): { priority: Priority; slaMs: number; csea: boolean } {
  const t = ctx.config.safety.taxonomy[type];
  if (!t) throw new ProblemError(422, "UNKNOWN_REPORT_TYPE", undefined, { type });
  if (subtype && !t.subtypes[subtype]) throw new ProblemError(422, "UNKNOWN_REPORT_SUBTYPE", undefined, { subtype });
  const priority = (subtype ? t.subtypes[subtype]?.priority : undefined) ?? t.priority;
  return { priority, slaMs: t.sla, csea: t.csea };
}

function evidenceKey(ctx: Ctx): Buffer {
  const m = ctx.config.secrets.app_encryption_key;
  if (!m) throw new ProblemError(503, "ENCRYPTION_KEY_MISSING", "APP_ENCRYPTION_KEY is required to store CSEA evidence");
  return deriveSubkey(decodeKey(m), "safety-evidence");
}

export function sealEvidence(ctx: Ctx, caseId: string, data: unknown): string {
  return encrypt(evidenceKey(ctx), JSON.stringify(data), `evidence:${caseId}`);
}

export function openEvidence(ctx: Ctx, caseId: string, ciphertext: string): unknown {
  return JSON.parse(decrypt(evidenceKey(ctx), ciphertext, `evidence:${caseId}`).toString());
}

export interface NewReport {
  source: ReportSource;
  type: string;
  subtype: string | null;
  reporter_user_id: string | null;
  reporter_client_id: string | null;
  game_id: string | null;
  reported_user_id: string | null;
  content: ContentRef | null;
  snapshot: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  description: string | null;
  flag_id?: string | null;
}

export interface CseaMetadata {
  reported_user: unknown;
  reported_user_data: unknown;
  reporter_user_id: string | null;
  collected_at: string;
}

export async function cseaMetadata(ctx: Ctx, reportedUserId: string | null, reporterUserId: string | null): Promise<CseaMetadata> {
  const [reported, data] = reportedUserId
    ? await Promise.all([
      ctx.rpcOptional<unknown>("identity.get_user_summary", { user_id: reportedUserId }, null).catch(() => null),
      ctx.rpcOptional<unknown>("identity.csea_user_data", { user_id: reportedUserId }, null).catch(() => null),
    ])
    : [null, null];
  return { reported_user: reported, reported_user_data: data, reporter_user_id: reporterUserId, collected_at: new Date().toISOString() };
}

const YEAR_MS = 365 * 86_400_000;

export function retainUntil(from: Date, configuredMs: number, minYears: number): Date {
  const statutory = new Date(from);
  statutory.setUTCFullYear(statutory.getUTCFullYear() + minYears);
  return new Date(Math.max(from.getTime() + configuredMs, statutory.getTime()));
}

export function evidenceRetainUntil(ctx: Ctx, from: Date): Date {
  return retainUntil(from, ctx.config.safety.csea_evidence_retention, 1);
}

export function referenceRetainUntil(ctx: Ctx, from: Date): Date {
  return retainUntil(from, Math.max(ctx.config.safety.csea_reference_retention, 5 * YEAR_MS), 5);
}

export function ncaDeadline(ctx: Ctx, from: Date, priority: 1 | 2 | 3 | null): Date {
  const d = ctx.config.safety.nca_deadlines;
  const ms = priority === 1 ? d.priority_1 : priority === 2 ? d.priority_2 : priority === 3 ? d.priority_3 : d.unassessed;
  return new Date(from.getTime() + ms);
}

export async function startEvidenceRetention(ctx: Ctx, trx: Exec, caseId: string, from: Date): Promise<void> {
  const until = evidenceRetainUntil(ctx, from);
  await trx
    .updateTable("evidence")
    .set({ destroy_after: until })
    .where("case_id", "=", caseId)
    .where("destroyed_at", "is", null)
    .where((eb) => eb.or([eb("destroy_after", "is", null), eb("destroy_after", "<", until)]))
    .execute();
}

export const RELATED_DATA_WINDOW_MS = 14 * 86_400_000;

export async function createReport(ctx: Ctx, trx: Exec, input: NewReport, meta: CseaMetadata | null): Promise<Report> {
  const c = classify(ctx, input.type, input.subtype);
  const now = new Date();
  const report = await trx
    .insertInto("reports")
    .values({
      id: uuidv7(),
      reference: newReference("R"),
      source: input.source,
      reporter_user_id: input.reporter_user_id,
      reporter_client_id: input.reporter_client_id,
      game_id: input.game_id,
      type: input.type,
      subtype: input.subtype,
      priority: c.priority,
      csea: c.csea,
      status: "open",
      reported_user_id: input.reported_user_id,
      content: input.content ? JSON.stringify(input.content) : null,
      snapshot: input.snapshot ? JSON.stringify(input.snapshot) : null,
      context: input.context ? JSON.stringify(input.context) : null,
      description: input.description,
      flag_id: input.flag_id ?? null,
      sla_due_at: new Date(now.getTime() + c.slaMs),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  inc("qtiauth_safety_reports_total", { type: c.csea ? "csea" : input.type, source: input.source }, 1, "Reports by type and source");
  if (input.reporter_user_id) {
    await ctx.email(trx, { template: "report_acknowledged", to: { user_id: input.reporter_user_id }, vars: { reference: report.reference }, sender: "security", dedupe_key: `report-ack-${report.id}` });
  }
  if (c.csea) {
    await openCseaCase(ctx, trx, report, meta ?? (await cseaMetadata(ctx, report.reported_user_id, report.reporter_user_id)), "system");
    return (await trx.selectFrom("reports").selectAll().where("id", "=", report.id).executeTakeFirstOrThrow()) as Report;
  }
  await ctx.emit(
    trx,
    EVENTS.safetyReportCreated,
    { report_id: report.id, type: report.type, subtype: report.subtype, priority: report.priority, source: report.source, reported_user_id: report.reported_user_id, game_id: report.game_id, sla_due_at: report.sla_due_at.toISOString(), csea: false },
    { subject: { type: "report", id: report.id }, actor: input.reporter_user_id ? { type: "user", id: input.reporter_user_id } : { type: "service", id: input.reporter_client_id ?? "safety" } },
  );
  return report;
}

export async function openCseaCase(ctx: Ctx, trx: Exec, report: Report, meta: CseaMetadata, openedBy: string): Promise<CseaCase> {
  const existing = await trx.selectFrom("csea_cases").selectAll().where("report_id", "=", report.id).executeTakeFirst();
  if (existing) return existing;
  const caseId = uuidv7();
  const holdId = report.reported_user_id ? uuidv7() : null;
  const evidence = {
    report: { id: report.id, reference: report.reference, type: report.type, subtype: report.subtype, source: report.source, game_id: report.game_id, created_at: report.created_at.toISOString() },
    content: report.content,
    snapshot: report.snapshot,
    context: report.context,
    description: report.description,
    metadata: meta,
  };
  const row = await trx
    .insertInto("csea_cases")
    .values({ id: caseId, report_id: report.id, status: "open", deadline_at: ncaDeadline(ctx, new Date(), null), hold_id: holdId, created_by: openedBy })
    .returningAll()
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("evidence")
    .values({ id: uuidv7(), case_id: caseId, user_id: report.reported_user_id, ciphertext: sealEvidence(ctx, caseId, evidence), destroy_after: null })
    .execute();
  if (report.game_id && report.reported_user_id) {
    const uploaded = report.content?.upload?.uploaded_at ? new Date(report.content.upload.uploaded_at) : report.created_at;
    await trx
      .insertInto("preservation_requests")
      .values({
        id: uuidv7(),
        case_id: caseId,
        game_id: report.game_id,
        user_id: report.reported_user_id,
        content: report.content ? JSON.stringify(report.content) : null,
        window_start: new Date(Math.min(uploaded.getTime(), report.created_at.getTime()) - RELATED_DATA_WINDOW_MS),
        window_end: new Date(),
      })
      .execute();
  }
  await trx
    .updateTable("reports")
    .set({ csea: true, case_id: caseId, snapshot: null, context: null, description: null, priority: "critical", updated_at: new Date() })
    .where("id", "=", report.id)
    .execute();
  if (report.reported_user_id && holdId) await placeHold(ctx, trx, { id: holdId, user_id: report.reported_user_id, case_id: caseId, reason: "csea_case", reference: caseId, placed_by: openedBy });
  await ctx.emit(trx, EVENTS.safetyCseaCaseOpened, { case_id: caseId }, { subject: { type: "csea_case", id: caseId } });
  await ctx.audit(trx, { actor: openedBy === "system" ? { type: "system", id: "safety" } : staffActor(openedBy), action: "safety.csea.case_opened", target: { type: "csea_case", id: caseId } });
  inc("qtiauth_safety_csea_cases_opened_total", {}, 1, "CSEA cases opened");
  return row;
}

export async function placeHold(ctx: Ctx, trx: Exec, h: { id?: string; user_id: string; case_id: string | null; reason: string; reference: string | null; placed_by: string }): Promise<string> {
  const id = h.id ?? uuidv7();
  await trx.insertInto("legal_holds").values({ id, user_id: h.user_id, case_id: h.case_id, reason: h.reason, reference: h.reference, placed_by: h.placed_by }).execute();
  await ctx.emit(trx, EVENTS.safetyLegalHoldPlaced, { hold_id: id, user_id: h.user_id, reason: h.reason, reference: h.reference ?? undefined }, { subject: { type: "user", id: h.user_id } });
  return id;
}

export async function releaseHold(ctx: Ctx, trx: Exec, holdId: string, by: string | null): Promise<void> {
  const h = await trx.selectFrom("legal_holds").selectAll().where("id", "=", holdId).where("released_at", "is", null).executeTakeFirst();
  if (!h) return;
  await trx.updateTable("legal_holds").set({ released_at: new Date(), released_by: by }).where("id", "=", holdId).execute();
  await ctx.emit(trx, EVENTS.safetyLegalHoldReleased, { hold_id: holdId, user_id: h.user_id, reason: h.reason }, { subject: { type: "user", id: h.user_id } });
}

export interface ApplyInput {
  user_id: string;
  action_type: string;
  rule: string;
  duration_ms?: number | null;
  note?: string | null;
  report_id?: string | null;
  game_id?: string | null;
  content?: ContentRef | null;
  moderator_id: string;
}

const COMPLETES_IMMEDIATELY: Effect[] = ["warn", "remove_content", "force_username_reset"];
const PERMANENT_BAN: Effect[] = ["ban", "proscribed_org_removal"];

export async function applyAction(ctx: Ctx, trx: Exec, input: ApplyInput): Promise<Action> {
  const def = ctx.config.safety.actions[input.action_type];
  if (!def) throw new ProblemError(422, "UNKNOWN_ACTION_TYPE", undefined, { action_type: input.action_type });
  if (!ctx.config.safety.rules[input.rule]) throw new ProblemError(422, "UNKNOWN_RULE", "Choose a rule from the configured list", { rule: input.rule });
  const durationMs = input.duration_ms ?? def.default_duration ?? null;
  if (def.requires_duration && !durationMs) throw new ProblemError(422, "DURATION_REQUIRED");
  if (def.effect === "remove_content" && !input.content?.id) throw new ProblemError(422, "CONTENT_REQUIRED");
  const needsSecond = PERMANENT_BAN.includes(def.effect) && ctx.config.safety.bans.require_second_approval;
  const status = needsSecond ? "pending_approval" : COMPLETES_IMMEDIATELY.includes(def.effect) ? "completed" : "active";
  const usesExpiry = def.effect === "lock" || def.effect === "restrict";
  const action = await trx
    .insertInto("actions")
    .values({
      id: uuidv7(),
      user_id: input.user_id,
      action_type: input.action_type,
      effect: def.effect,
      restrictions: JSON.stringify(def.restrictions),
      rule: input.rule,
      reason_code: def.reason_code ?? null,
      note: input.note ?? null,
      report_id: input.report_id ?? null,
      game_id: input.game_id ?? null,
      content: input.content ? JSON.stringify(input.content) : null,
      moderator_id: input.moderator_id,
      status,
      duration_ms: usesExpiry ? durationMs : null,
      expires_at: usesExpiry && durationMs && !needsSecond ? new Date(Date.now() + durationMs) : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await ctx.audit(trx, {
    actor: staffActor(input.moderator_id),
    action: needsSecond ? "safety.action.proposed" : "safety.action.applied",
    target: { type: "user", id: input.user_id },
    reason: input.note ?? null,
    data: { action_id: action.id, action_type: input.action_type, rule: input.rule, report_id: input.report_id ?? null },
  });
  if (input.report_id) await markActioned(ctx, trx, input.report_id, input.moderator_id);
  if (!needsSecond) await activate(ctx, trx, action);
  return action;
}

export async function approveAction(ctx: Ctx, trx: Exec, action: Action, approverId: string): Promise<Action> {
  if (action.status !== "pending_approval") throw new ProblemError(409, "ACTION_NOT_PENDING");
  if (action.moderator_id === approverId) throw new ProblemError(403, "SECOND_APPROVER_REQUIRED", "A different moderator must approve a permanent ban");
  const updated = await trx
    .updateTable("actions")
    .set({ status: "active", approved_by: approverId, expires_at: action.duration_ms ? new Date(Date.now() + action.duration_ms) : null })
    .where("id", "=", action.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await ctx.audit(trx, { actor: staffActor(approverId), action: "safety.action.approved", target: { type: "user", id: action.user_id }, data: { action_id: action.id } });
  await activate(ctx, trx, updated);
  return updated;
}

async function activate(ctx: Ctx, trx: Exec, action: Action): Promise<void> {
  const actor = staffActor(action.approved_by ?? action.moderator_id);
  await ctx.emit(
    trx,
    EVENTS.safetyActionApplied,
    {
      action_id: action.id,
      user_id: action.user_id,
      effect: action.effect,
      restrictions: action.restrictions,
      expires_at: action.expires_at?.toISOString() ?? null,
      reason_code: action.reason_code,
      rule: action.rule,
      game_id: action.game_id,
    },
    { actor, subject: { type: "user", id: action.user_id } },
  );
  if (action.effect === "remove_content") {
    await ctx.emit(
      trx,
      EVENTS.safetyContentRemovalRequested,
      { action_id: action.id, user_id: action.user_id, game_id: action.game_id, content: action.content, report_id: action.report_id },
      { actor, subject: { type: "content", id: action.content?.id ?? action.id } },
    );
  }
  inc("qtiauth_safety_actions_total", { type: action.action_type, effect: action.effect }, 1, "Moderation actions by type");
  await sendStatement(ctx, trx, action);
}

async function sendStatement(ctx: Ctx, trx: Exec, action: Action): Promise<void> {
  const def = ctx.config.safety.actions[action.action_type];
  const rule = ctx.config.safety.rules[action.rule];
  await ctx.email(trx, {
    template: "statement_of_reasons",
    to: { user_id: action.user_id },
    vars: {
      action: def?.label ?? action.action_type,
      rule_title: rule?.title ?? action.rule,
      rule_text: rule?.text ?? "",
      duration: action.effect === "lock" || action.effect === "restrict" ? formatDuration(action.duration_ms) : action.effect === "ban" || action.effect === "proscribed_org_removal" ? "until lifted" : "",
      appeal_url: appealUrl(ctx, action.id),
      restrictions: action.restrictions.join(", "),
    },
    sender: "security",
    priority: "high",
    dedupe_key: `sor-${action.id}`,
  });
}

export function appealUrl(ctx: Ctx, actionId: string): string {
  return surfaceUrl(ctx.surfaces.account, `/safety/appeal/${actionId}`);
}

async function markActioned(ctx: Ctx, trx: Exec, reportId: string, moderatorId: string): Promise<void> {
  const r = await trx.selectFrom("reports").selectAll().where("id", "=", reportId).executeTakeFirst();
  if (!r) throw new ProblemError(404, "REPORT_NOT_FOUND");
  if (r.status === "actioned" || r.status === "dismissed") return;
  const now = new Date();
  await trx
    .updateTable("reports")
    .set({ status: "actioned", resolution: "actioned", resolved_at: now, resolved_by: moderatorId, first_action_at: r.first_action_at ?? now, updated_at: now })
    .where("id", "=", reportId)
    .execute();
  observe("qtiauth_safety_time_to_action_seconds", (now.getTime() - r.created_at.getTime()) / 1000, { type: r.csea ? "csea" : r.type }, [60, 600, 3600, 4 * 3600, 86_400, 3 * 86_400, 7 * 86_400], "Time from report to first action");
  if (!r.csea) {
    await ctx.emit(trx, EVENTS.safetyReportActioned, { report_id: r.id, type: r.type, priority: r.priority, status: "actioned" }, { actor: staffActor(moderatorId), subject: { type: "report", id: r.id } });
  }
  await notifyReporter(ctx, trx, r, "We reviewed the content you reported and took action under our rules.");
}

export async function dismissReport(ctx: Ctx, trx: Exec, r: Report, moderatorId: string, note: string): Promise<void> {
  if (r.status === "actioned" || r.status === "dismissed") throw new ProblemError(409, "REPORT_ALREADY_RESOLVED");
  const now = new Date();
  await trx
    .updateTable("reports")
    .set({ status: "dismissed", resolution: "dismissed", resolution_note: note, resolved_at: now, resolved_by: moderatorId, first_action_at: r.first_action_at ?? now, updated_at: now })
    .where("id", "=", r.id)
    .execute();
  await ctx.audit(trx, { actor: staffActor(moderatorId), action: "safety.report.dismissed", target: { type: "report", id: r.id }, reason: note });
  if (!r.csea) await ctx.emit(trx, EVENTS.safetyReportDismissed, { report_id: r.id, type: r.type, priority: r.priority, status: "dismissed" }, { actor: staffActor(moderatorId), subject: { type: "report", id: r.id } });
  inc("qtiauth_safety_reports_dismissed_total", { type: r.csea ? "csea" : r.type }, 1, "Reports dismissed");
  await notifyReporter(ctx, trx, r, "We reviewed the content you reported and did not find a breach of our rules.");
}

async function notifyReporter(ctx: Ctx, trx: Exec, r: Report, outcome: string): Promise<void> {
  if (!r.reporter_user_id || r.reporter_notified_at) return;
  await ctx.email(trx, { template: "report_outcome", to: { user_id: r.reporter_user_id }, vars: { reference: r.reference, outcome }, sender: "security", dedupe_key: `report-outcome-${r.id}` });
  await trx.updateTable("reports").set({ reporter_notified_at: new Date() }).where("id", "=", r.id).execute();
}

export async function liftAction(ctx: Ctx, trx: Exec, action: Action, by: string | null, reason: string, status: "lifted" | "expired" = "lifted"): Promise<void> {
  if (action.status !== "active" && action.status !== "pending_approval") throw new ProblemError(409, "ACTION_NOT_ACTIVE");
  const wasActive = action.status === "active";
  await trx
    .updateTable("actions")
    .set({ status: action.status === "pending_approval" ? "rejected" : status, lifted_at: new Date(), lifted_by: by, lift_reason: reason })
    .where("id", "=", action.id)
    .execute();
  if (wasActive) await ctx.emit(trx, EVENTS.safetyActionLifted, { action_id: action.id, user_id: action.user_id, effect: action.effect, reason: status }, { actor: by ? staffActor(by) : { type: "system", id: "safety" }, subject: { type: "user", id: action.user_id } });
  if (by) await ctx.audit(trx, { actor: staffActor(by), action: action.status === "pending_approval" ? "safety.action.rejected" : "safety.action.lifted", target: { type: "user", id: action.user_id }, reason, data: { action_id: action.id } });
}

export async function createAppeal(ctx: Ctx, trx: Exec, input: { action: Action; user_id: string; statement: string; ticket_id?: string | null; ticket_number?: number | null }): Promise<Appeal> {
  const a = input.action;
  if (a.user_id !== input.user_id) throw new ProblemError(404, "ACTION_NOT_FOUND");
  if (a.status === "rejected" || a.status === "pending_approval") throw new ProblemError(409, "ACTION_NOT_APPEALABLE");
  const open = await trx.selectFrom("appeals").select("id").where("action_id", "=", a.id).where("status", "=", "open").executeTakeFirst();
  if (open) throw new ProblemError(409, "APPEAL_ALREADY_OPEN", undefined, { appeal_id: open.id });
  const appeal = await trx
    .insertInto("appeals")
    .values({ id: uuidv7(), reference: newReference("A"), action_id: a.id, user_id: input.user_id, statement: input.statement, ticket_id: input.ticket_id ?? null, ticket_number: input.ticket_number ?? null })
    .returningAll()
    .executeTakeFirstOrThrow();
  await ctx.emit(trx, EVENTS.safetyAppealCreated, { appeal_id: appeal.id, action_id: a.id, user_id: a.user_id, effect: a.effect, ticket_id: appeal.ticket_id }, { actor: { type: "user", id: input.user_id }, subject: { type: "appeal", id: appeal.id } });
  if (!input.ticket_id) await ctx.email(trx, { template: "appeal_received", to: { user_id: input.user_id }, vars: { reference: appeal.reference }, sender: "security", dedupe_key: `appeal-ack-${appeal.id}` });
  inc("qtiauth_safety_appeals_total", { event: "opened", effect: a.effect }, 1, "Appeals opened and resolved");
  return appeal;
}

export async function resolveAppeal(ctx: Ctx, trx: Exec, appeal: Appeal, by: string, outcome: "lift" | "uphold", note: string): Promise<void> {
  if (appeal.status !== "open") throw new ProblemError(409, "APPEAL_ALREADY_RESOLVED");
  const action = await trx.selectFrom("actions").selectAll().where("id", "=", appeal.action_id).executeTakeFirstOrThrow();
  if (outcome === "lift" && (action.status === "active" || action.status === "pending_approval")) await liftAction(ctx, trx, action, by, `appeal ${appeal.reference}: ${note}`);
  const status = outcome === "lift" ? "lifted" : "upheld";
  await trx.updateTable("appeals").set({ status, resolved_by: by, resolution_note: note, resolved_at: new Date() }).where("id", "=", appeal.id).execute();
  await ctx.audit(trx, { actor: staffActor(by), action: "safety.appeal.resolved", target: { type: "appeal", id: appeal.id }, reason: note, data: { outcome: status, action_id: action.id } });
  await ctx.emit(trx, EVENTS.safetyAppealResolved, { appeal_id: appeal.id, action_id: action.id, user_id: appeal.user_id, status, ticket_id: appeal.ticket_id }, { actor: staffActor(by), subject: { type: "appeal", id: appeal.id } });
  await ctx.email(trx, {
    template: "appeal_resolved",
    to: { user_id: appeal.user_id },
    vars: { outcome: outcome === "lift" ? "We've lifted the action on your account." : "We've reviewed your appeal and the action stays in place.", details: note },
    sender: "security",
    dedupe_key: `appeal-resolved-${appeal.id}`,
  });
  inc("qtiauth_safety_appeals_total", { event: status, effect: action.effect }, 1, "Appeals opened and resolved");
}

export function reportView(r: Report, opts: { full: boolean }) {
  return {
    id: r.id,
    reference: r.reference,
    source: r.source,
    type: r.type,
    subtype: r.subtype,
    priority: r.priority,
    csea: r.csea,
    status: r.status,
    reported_user_id: r.reported_user_id,
    reporter_user_id: opts.full ? r.reporter_user_id : undefined,
    reporter_client_id: opts.full ? r.reporter_client_id : undefined,
    game_id: r.game_id,
    content: r.content,
    snapshot: opts.full && !r.csea ? r.snapshot : undefined,
    context: opts.full && !r.csea ? r.context : undefined,
    description: opts.full && !r.csea ? r.description : undefined,
    assigned_to: r.assigned_to,
    sla_due_at: r.sla_due_at.toISOString(),
    sla_breached: Boolean(r.sla_breached_at) || (r.status !== "actioned" && r.status !== "dismissed" && r.sla_due_at < new Date()),
    resolution: r.resolution,
    resolution_note: opts.full ? r.resolution_note : undefined,
    case_id: r.case_id,
    created_at: r.created_at.toISOString(),
    resolved_at: r.resolved_at?.toISOString() ?? null,
  };
}

export function actionView(ctx: Ctx, a: Action, opts: { staff: boolean }) {
  const rule = ctx.config.safety.rules[a.rule];
  return {
    id: a.id,
    user_id: a.user_id,
    action_type: a.action_type,
    label: ctx.config.safety.actions[a.action_type]?.label ?? a.action_type,
    effect: a.effect,
    restrictions: a.restrictions,
    rule: a.rule,
    rule_title: rule?.title ?? a.rule,
    rule_text: rule?.text ?? "",
    status: a.status,
    expires_at: a.expires_at?.toISOString() ?? null,
    game_id: a.game_id,
    created_at: a.created_at.toISOString(),
    lifted_at: a.lifted_at?.toISOString() ?? null,
    ...(opts.staff
      ? { note: a.note, report_id: a.report_id, content: a.content, moderator_id: a.moderator_id, approved_by: a.approved_by, lifted_by: a.lifted_by, lift_reason: a.lift_reason, reason_code: a.reason_code }
      : {}),
  };
}

export function appealView(a: Appeal) {
  return {
    id: a.id,
    reference: a.reference,
    action_id: a.action_id,
    user_id: a.user_id,
    statement: a.statement,
    ticket_id: a.ticket_id,
    ticket_number: a.ticket_number,
    status: a.status,
    resolution_note: a.resolution_note,
    created_at: a.created_at.toISOString(),
    resolved_at: a.resolved_at?.toISOString() ?? null,
  };
}

export function sortQueue<T extends { priority: Priority; sla_due_at: Date }>(rows: T[]): T[] {
  return rows.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.sla_due_at.getTime() - b.sla_due_at.getTime());
}

export function assertUuid(v: string, code = "NOT_FOUND"): string {
  if (!isUuid(v)) throw new ProblemError(404, code);
  return v;
}

