import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityService } from "../../services/identity/src/service.ts";
import { safetyService } from "../../services/safety/src/service.ts";
import { signupAndVerify, staffClient, startStack, waitUntil, type Client, type Stack } from "./harness.ts";

let stack: Stack;
let mod: Client;
let mod2: Client;
let officer: Client;

beforeAll(async () => {
  stack = await startStack([identityService, safetyService], {
    safety: { bans: { require_second_approval: true }, csea_alert_emails: ["csea@example.com"] },
  });
  mod = (await staffClient(stack, "mod@example.com", ["moderator"])).client;
  mod2 = (await staffClient(stack, "mod2@example.com", ["moderator"])).client;
  officer = (await staffClient(stack, "officer@example.com", ["moderator"], { csea_officer: ["safety.csea.access"] })).client;
});

afterAll(async () => {
  await stack?.stop();
});

async function userId(c: Client): Promise<string> {
  return (await c.get("/api/v1/me")).body.id;
}

describe("reporting and moderation", () => {
  it("queues a report, applies a lock with a statement of reasons, and lets the user appeal", async () => {
    const reporter = await signupAndVerify(stack, "reporter@example.com");
    const target = await signupAndVerify(stack, "target@example.com");
    const targetId = await userId(target);

    const self = await reporter.post("/api/v1/safety/reports", { type: "harassment", subtype: "harassment", reported_user_id: await userId(reporter) });
    expect(self.body.code).toBe("CANNOT_REPORT_SELF");

    const r = await reporter.post("/api/v1/safety/reports", { type: "harassment", subtype: "doxxing", reported_user_id: targetId, description: "posted my address" });
    expect(r.status).toBe(200);
    expect(r.body.reference).toMatch(/^R-/);
    await stack.waitForEmail((e) => e.template === "report_acknowledged" && e.vars.reference === r.body.reference);

    const queue = await mod.get("/api/v1/admin/safety/reports");
    expect(queue.status).toBe(200);
    const item = queue.body.items.find((i: { id: string }) => i.id === r.body.report_id);
    expect(item.priority).toBe("high");
    expect(item.description).toBeUndefined();

    const detail = await mod.get(`/api/v1/admin/safety/reports/${r.body.report_id}`);
    expect(detail.body.description).toBe("posted my address");

    const badRule = await mod.post("/api/v1/admin/safety/actions", { user_id: targetId, action_type: "lock", rule: "made.up", report_id: r.body.report_id });
    expect(badRule.body.code).toBe("UNKNOWN_RULE");

    const lock = await mod.post("/api/v1/admin/safety/actions", { user_id: targetId, action_type: "lock", rule: "conduct.harassment", duration: "3d", report_id: r.body.report_id });
    expect(lock.status).toBe(200);
    expect(lock.body.status).toBe("active");
    await stack.waitForEmail((e) => e.template === "statement_of_reasons" && e.to.user_id === targetId && e.vars.duration === "3 days");
    await stack.waitForEmail((e) => e.template === "report_outcome" && e.vars.reference === r.body.reference);
    await waitUntil(async () => (await target.get("/api/v1/me")).body.state === "locked");

    const mine = await target.get("/api/v1/safety/actions/mine");
    expect(mine.status).toBe(200);
    expect(mine.body.items[0].can_appeal).toBe(true);
    expect(mine.body.items[0].note).toBeUndefined();

    const appeal = await target.post("/api/v1/safety/appeals", { action_id: lock.body.id, statement: "That was not me, my account was shared." });
    expect(appeal.status).toBe(200);
    const dup = await target.post("/api/v1/safety/appeals", { action_id: lock.body.id, statement: "Please look again at this one." });
    expect(dup.body.code).toBe("APPEAL_ALREADY_OPEN");

    const resolved = await mod2.post(`/api/v1/admin/safety/appeals/${appeal.body.id}/resolve`, { outcome: "lift", note: "Shared account confirmed" });
    expect(resolved.status).toBe(200);
    await stack.waitForEmail((e) => e.template === "appeal_resolved" && e.to.user_id === targetId);
    await waitUntil(async () => (await target.get("/api/v1/me")).body.state === "active");
  });

  it("needs a second moderator for a permanent ban", async () => {
    const target = await signupAndVerify(stack, "banme@example.com");
    const targetId = await userId(target);
    const ban = await mod.post("/api/v1/admin/safety/actions", { user_id: targetId, action_type: "ban", rule: "conduct.fraud" });
    expect(ban.body.status).toBe("pending_approval");
    const selfApprove = await mod.post(`/api/v1/admin/safety/actions/${ban.body.id}/approve`);
    expect(selfApprove.body.code).toBe("SECOND_APPROVER_REQUIRED");
    const approved = await mod2.post(`/api/v1/admin/safety/actions/${ban.body.id}/approve`);
    expect(approved.body.status).toBe("active");
    await waitUntil(async () => (await target.get("/api/v1/me")).body.state === "banned");
  });

  it("restricts and dismisses", async () => {
    const reporter = await signupAndVerify(stack, "rep2@example.com");
    const target = await signupAndVerify(stack, "chatty@example.com");
    const targetId = await userId(target);
    const r = await reporter.post("/api/v1/safety/reports", { type: "hate", subtype: "hate_speech", reported_user_id: targetId });
    const dismissed = await mod.post(`/api/v1/admin/safety/reports/${r.body.report_id}/dismiss`, { reason: "No breach found" });
    expect(dismissed.status).toBe(200);
    const again = await mod.post(`/api/v1/admin/safety/reports/${r.body.report_id}/dismiss`, { reason: "No breach found" });
    expect(again.body.code).toBe("REPORT_ALREADY_RESOLVED");
    const restrict = await mod.post("/api/v1/admin/safety/actions", { user_id: targetId, action_type: "restrict_chat", rule: "conduct.hate", duration: "1d" });
    expect(restrict.status).toBe(200);
    await waitUntil(async () => {
      const me = await target.get("/api/v1/me");
      return (me.body.restrictions ?? []).some((x: { name: string }) => x.name === "chat");
    });
    const mine = await reporter.get("/api/v1/safety/reports");
    expect(mine.body.items[0].outcome).toBe("no_action");
  });
});

describe("CSEA", () => {
  it("opens a restricted case with encrypted evidence and a legal hold", async () => {
    const reporter = await signupAndVerify(stack, "csea-rep@example.com");
    const target = await signupAndVerify(stack, "csea-target@example.com");
    const targetId = await userId(target);
    const r = await reporter.post("/api/v1/safety/reports", { type: "csea", subtype: "grooming", reported_user_id: targetId, snapshot: { message: "redacted test content" }, content: { id: "msg-1", type: "chat_message" } });
    expect(r.status).toBe(200);

    const modQueue = await mod.get("/api/v1/admin/safety/reports?status=all");
    expect(modQueue.body.items.some((i: { id: string }) => i.id === r.body.report_id)).toBe(false);
    expect((await mod.get(`/api/v1/admin/safety/reports/${r.body.report_id}`)).status).toBe(404);
    expect((await mod.get("/api/v1/admin/safety/csea")).status).toBe(403);

    const cases = await officer.get("/api/v1/admin/safety/csea");
    const c = cases.body.items.find((x: { report_id: string }) => x.report_id === r.body.report_id);
    expect(c.legal_hold).toBe(true);
    const detail = await officer.get(`/api/v1/admin/safety/csea/${c.id}`);
    expect(detail.body.evidence[0].data.snapshot.message).toBe("redacted test content");
    expect(detail.body.report.snapshot).toBeUndefined();
    const sheet = Object.fromEntries(detail.body.nca_sheet.map((f: { id: string }) => [f.id, f]));
    expect(sheet.username.source).toBe("qtiauth");
    expect(sheet.registration_ip.value).toMatch(/ · port \d+ · \d\d\/\d\d\/\d{4} /);
    expect(sheet.login_ips.value).toMatch(/port \d+/);
    expect(sheet.billing_name.source).toBe("not_held");
    expect(detail.body.evidence[0].destroy_after).toBeNull();

    const row = await stack.services.get("safety")!.ctx.db.selectFrom("reports").select(["snapshot", "description"]).where("id", "=", r.body.report_id).executeTakeFirst();
    expect(row?.snapshot).toBeNull();

    const closeEarly = await officer.post(`/api/v1/admin/safety/csea/${c.id}/close`, { note: "closing too early" });
    expect(closeEarly.body.code).toBe("NCA_SUBMISSION_REQUIRED");
    const protect = await officer.post(`/api/v1/admin/safety/csea/${c.id}/protect`, {});
    expect(protect.status).toBe(200);
    expect(protect.body.removal_action_id).toBeTruthy();
    await waitUntil(async () => (await target.get("/api/v1/me")).body.state === "locked");
    const unassessed = await officer.post(`/api/v1/admin/safety/csea/${c.id}/submission`, { nca_reference: "NCA-TEST-0001" });
    expect(unassessed.body.code).toBe("NCA_PRIORITY_REQUIRED");
    const prio = await officer.post(`/api/v1/admin/safety/csea/${c.id}/priority`, { level: 2, reason: "Grooming, no immediate threat" });
    expect(prio.status).toBe(200);
    const sentAt = new Date("2026-05-01T12:00:00Z");
    const sub = await officer.post(`/api/v1/admin/safety/csea/${c.id}/submission`, { nca_reference: "NCA-TEST-0001", submitted_at: sentAt.toISOString() });
    expect(sub.status).toBe(200);
    const supp = await officer.post(`/api/v1/admin/safety/csea/${c.id}/supplementary`, { nca_reference: "NCA-TEST-0002", note: "Game chat logs" });
    expect(supp.status).toBe(200);
    const request = await officer.post(`/api/v1/admin/safety/csea/${c.id}/nca-requests`, { summary: "Asked for account creation details" });
    expect(new Date(request.body.due_at).getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect((await officer.post(`/api/v1/admin/safety/csea/${c.id}/close`, { note: "all done here" })).body.code).toBe("NCA_REQUEST_OPEN");
    expect((await officer.post(`/api/v1/admin/safety/csea/${c.id}/nca-requests/${request.body.id}/respond`, { note: "Sent via the portal" })).status).toBe(200);
    const after = await officer.get(`/api/v1/admin/safety/csea/${c.id}`);
    expect(new Date(after.body.evidence[0].destroy_after).getTime()).toBeGreaterThan(Date.now() + 364 * 86_400_000);
    expect(new Date(after.body.reference_retain_until).getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 5);
    expect(after.body.supplementary).toHaveLength(1);
    const closed = await officer.post(`/api/v1/admin/safety/csea/${c.id}/close`, { note: "all done here" });
    expect(closed.body.outcome).toBe("reported");
    const holds = await stack.services.get("identity")!.ctx.db.selectFrom("legal_holds").selectAll().where("user_id", "=", targetId).execute();
    expect(holds.length).toBe(1);
  });
});

describe("intake", () => {
  it("rejects session callers on service-only intake routes", async () => {
    const c = await signupAndVerify(stack, "intake@example.com");
    const r = await c.post("/api/v1/safety/intake/flags", { classifier: "x", score: 0.9, type: "hate" });
    expect(r.status).toBe(401);
  });

  it("serves the taxonomy without signing in", async () => {
    const r = await stack.client().get("/api/v1/safety/taxonomy");
    expect(r.status).toBe(200);
    expect(r.body.types.length).toBe(9);
  });
});
