import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cronSubject, makeEvent } from "@qtiauth/bus";
import { identityService } from "../../services/identity/src/service.ts";
import { safetyService } from "../../services/safety/src/service.ts";
import { supportService } from "../../services/support/src/service.ts";
import { signupAndVerify, staffClient, startStack, waitUntil, type Client, type Stack } from "./harness.ts";

let stack: Stack;
let agent: Client;
let editor: Client;
let mod: Client;
const S = "/support/api/v1";

beforeAll(async () => {
  stack = await startStack([identityService, safetyService, supportService]);
  agent = (await staffClient(stack, "agent@example.com", ["support_agent"])).client;
  editor = (await staffClient(stack, "editor@example.com", ["kb_editor"])).client;
  mod = (await staffClient(stack, "smod@example.com", ["moderator"])).client;
});

afterAll(async () => {
  await stack?.stop();
});

describe("tickets", () => {
  it("runs a ticket from creation to rating", async () => {
    const user = await signupAndVerify(stack, "helpme@example.com");
    const cats = await stack.client().get(`${S}/support/categories`);
    expect(cats.body.categories.find((c: { id: string }) => c.id === "appeal").appeal).toBe(true);

    const t = await user.post(`${S}/support/tickets`, { category: "account", subject: "Cannot change my email", body: "It says step-up required" });
    expect(t.status).toBe(200);
    expect(t.body.number).toBeGreaterThanOrEqual(1000);
    await stack.waitForEmail((e) => e.template === "ticket_created" && e.vars.number === t.body.number);

    const queue = await agent.get(`${S}/admin/support/tickets`);
    expect(queue.body.items.some((i: { number: number }) => i.number === t.body.number)).toBe(true);
    expect((await user.get(`${S}/admin/support/tickets`)).status).toBe(403);

    await agent.post(`${S}/admin/support/tickets/${t.body.number}/replies`, { body: "Looks like a known issue", internal: true });
    await agent.post(`${S}/admin/support/tickets/${t.body.number}/replies`, { body: "Please sign in again and retry." });
    await stack.waitForEmail((e) => e.template === "ticket_reply" && e.vars.number === t.body.number);

    const view = await user.get(`${S}/support/tickets/${t.body.number}`);
    expect(view.body.status).toBe("waiting_on_user");
    expect(view.body.messages.map((m: { body: string }) => m.body)).toEqual(["It says step-up required", "Please sign in again and retry."]);
    expect(view.body.messages[1].author_id).toBeNull();

    await user.post(`${S}/support/tickets/${t.body.number}/replies`, { body: "That worked, thanks" });
    expect((await user.get(`${S}/support/tickets/${t.body.number}`)).body.status).toBe("open");
    const early = await user.post(`${S}/support/tickets/${t.body.number}/rating`, { rating: 5 });
    expect(early.body.code).toBe("TICKET_NOT_CLOSED");
    await user.post(`${S}/support/tickets/${t.body.number}/close`);
    expect((await user.post(`${S}/support/tickets/${t.body.number}/rating`, { rating: 5 })).status).toBe(200);

    const other = await signupAndVerify(stack, "nosy@example.com");
    expect((await other.get(`${S}/support/tickets/${t.body.number}`)).status).toBe(404);

    const metrics = await agent.get(`${S}/admin/support/metrics`);
    expect(metrics.body.csat_distribution["5"]).toBeGreaterThanOrEqual(1);
  });

  it("lets guests open and follow a ticket after verifying their email", async () => {
    const g = stack.client();
    await g.post(`${S}/support/guest/start`, { email: "guest@example.com" });
    const mail = await stack.waitForEmail((e) => e.template === "guest_ticket_code" && e.to.email === "guest@example.com");
    const wrong = await g.post(`${S}/support/guest/tickets`, { email: "guest@example.com", code: "000000", category: "account", subject: "Locked out", body: "I lost my phone" });
    expect(wrong.body.code).toBe("INVALID_CODE");
    const appeal = await g.post(`${S}/support/guest/tickets`, { email: "guest@example.com", code: String(mail.vars.code), category: "appeal", subject: "Locked out", body: "I lost my phone" });
    expect(appeal.body.code).toBe("CATEGORY_NOT_GUEST_ALLOWED");
    const ok = await g.post(`${S}/support/guest/tickets`, { email: "guest@example.com", code: String(mail.vars.code), category: "account", subject: "Locked out", body: "I lost my phone" });
    expect(ok.status).toBe(200);
    const link = await stack.waitForEmail((e) => e.template === "guest_ticket_link" && e.vars.number === ok.body.number);
    const token = new URL(String(link.vars.ticket_url)).searchParams.get("token")!;
    expect((await g.get(`${S}/support/guest/tickets/${ok.body.number}?token=wrong`)).status).toBe(404);
    const view = await g.get(`${S}/support/guest/tickets/${ok.body.number}?token=${token}`);
    expect(view.body.subject).toBe("Locked out");
    expect((await g.post(`${S}/support/guest/tickets/${ok.body.number}/replies`, { token, body: "Any update?" })).status).toBe(200);
    const reused = await g.post(`${S}/support/guest/tickets`, { email: "guest@example.com", code: String(mail.vars.code), category: "account", subject: "Again", body: "again" });
    expect(reused.body.code).toBe("INVALID_CODE");
  });

  it("auto-closes tickets waiting on the user", async () => {
    const user = await signupAndVerify(stack, "quiet@example.com");
    const t = await user.post(`${S}/support/tickets`, { category: "technical", subject: "Game crashes", body: "On launch" });
    await agent.post(`${S}/admin/support/tickets/${t.body.number}/replies`, { body: "Can you send logs?" });
    const db = stack.services.get("support")!.ctx.db;
    await db.updateTable("tickets").set({ last_staff_reply_at: new Date(Date.now() - 8 * 86_400_000), last_user_activity_at: new Date(Date.now() - 9 * 86_400_000) }).where("number", "=", t.body.number).execute();
    await stack.bus.publishEvent(makeEvent(cronSubject("support.auto_close"), {}, { subject: { type: "cron", id: "support.auto_close" } }));
    await waitUntil(async () => (await user.get(`${S}/support/tickets/${t.body.number}`)).body.status === "closed", 15_000);
  });
});

describe("appeals through support", () => {
  it("opens an appeal ticket for a locked user and closes it when the appeal is resolved", async () => {
    const user = await signupAndVerify(stack, "appealer@example.com");
    const userId = (await user.get("/api/v1/me")).body.id;
    const lock = await mod.post("/api/v1/admin/safety/actions", { user_id: userId, action_type: "lock", rule: "conduct.cheating", duration: "7d" });
    await waitUntil(async () => (await user.get("/api/v1/safety/reports")).body.code === "ACCOUNT_LOCKED");

    const normal = await user.post(`${S}/support/tickets`, { category: "games", subject: "Where is my DLC", body: "missing" });
    expect(normal.body.code).toBe("APPEAL_CATEGORY_REQUIRED");
    const noAction = await user.post(`${S}/support/tickets`, { category: "appeal", subject: "Unfair lock", body: "I didn't cheat" });
    expect(noAction.body.code).toBe("ACTION_REQUIRED");

    const t = await user.post(`${S}/support/tickets`, { category: "appeal", subject: "Unfair lock", body: "I didn't cheat", action_id: lock.body.id });
    expect(t.status).toBe(200);
    expect(t.body.appeal_id).toBeTruthy();
    const dup = await user.post(`${S}/support/tickets`, { category: "appeal", subject: "Unfair lock", body: "Please", action_id: lock.body.id });
    expect(dup.body.code).toBe("APPEAL_ALREADY_OPEN");

    const r = await mod.post(`/api/v1/admin/safety/appeals/${t.body.appeal_id}/resolve`, { outcome: "lift", note: "Replay showed no cheating" });
    expect(r.status).toBe(200);
    await waitUntil(async () => (await user.get(`${S}/support/tickets/${t.body.number}`)).body.status === "closed");
    await waitUntil(async () => (await user.get("/api/v1/me")).body.state === "active");
  });

  it("opens a ticket when appealing through the safety form", async () => {
    const user = await signupAndVerify(stack, "appealer2@example.com");
    const userId = (await user.get("/api/v1/me")).body.id;
    const warn = await mod.post("/api/v1/admin/safety/actions", { user_id: userId, action_type: "warn", rule: "conduct.harassment" });
    const ap = await user.post("/api/v1/safety/appeals", { action_id: warn.body.id, statement: "This was a misunderstanding in chat." });
    expect(ap.body.ticket_number).toBeGreaterThan(0);
    const tickets = await user.get(`${S}/support/tickets`);
    expect(tickets.body.items[0].appeal_id).toBe(ap.body.id);
  });
});

describe("knowledge base", () => {
  it("publishes, searches, records feedback once and keeps revisions", async () => {
    const cat = await editor.post(`${S}/admin/support/kb/categories`, { name: "Account help", icon: "user" });
    expect(cat.body.slug).toBe("account-help");
    const draft = await editor.post(`${S}/admin/support/kb/articles`, { title: "Resetting your password", category_id: cat.body.id, body: "# Reset\n\nUse the **forgot password** link.\n<script>alert(1)</script>", tags: ["password", "sign-in"] });
    expect(draft.status).toBe(200);
    const anon = stack.client();
    expect((await anon.get(`${S}/support/kb/articles/${draft.body.slug}`)).status).toBe(404);

    await editor.put(`${S}/admin/support/kb/articles/${draft.body.id}`, { title: "Resetting your password", category_id: cat.body.id, body: "# Reset\n\nUse the **forgot password** link on the sign-in page.\n<script>alert(1)</script>", tags: ["password", "sign-in"], status: "published" });
    const article = await anon.get(`${S}/support/kb/articles/${draft.body.slug}`);
    expect(article.status).toBe(200);
    expect(article.body.html).toContain("<strong>forgot password</strong>");
    expect(article.body.html).not.toContain("<script>");

    const search = await anon.get(`${S}/support/kb/search?q=password`);
    expect(search.body.items[0].slug).toBe(draft.body.slug);
    const suggest = await anon.get(`${S}/support/kb/suggest?q=${encodeURIComponent("forgot my password")}`);
    expect(suggest.body.items.length).toBe(1);

    await anon.post(`${S}/support/kb/articles/${draft.body.slug}/feedback`, { helpful: true });
    await anon.post(`${S}/support/kb/articles/${draft.body.slug}/feedback`, { helpful: true });
    expect((await anon.get(`${S}/support/kb/articles/${draft.body.slug}`)).body.helpful).toEqual({ yes: 1, no: 0 });

    const revs = await editor.get(`${S}/admin/support/kb/articles/${draft.body.id}/revisions`);
    expect(revs.body.items.length).toBe(2);
    const first = revs.body.items[1].id;
    const diff = await editor.get(`${S}/admin/support/kb/articles/${draft.body.id}/revisions/${first}/diff`);
    expect(diff.body.diff.some((d: { op: string }) => d.op === "+")).toBe(true);
    await editor.post(`${S}/admin/support/kb/articles/${draft.body.id}/revisions/${first}/restore`);
    expect((await anon.get(`${S}/support/kb/articles/${draft.body.slug}`)).body.html).not.toContain("sign-in page");

    expect((await agent.post(`${S}/admin/support/kb/articles`, { title: "Nope", body: "x" })).status).toBe(403);
  });
});
