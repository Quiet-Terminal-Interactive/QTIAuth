import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityService } from "../../services/identity/src/service.ts";
import { oidcService } from "../../services/oidc/src/service.ts";
import { safetyService } from "../../services/safety/src/service.ts";
import { supportService } from "../../services/support/src/service.ts";
import { gamesService } from "../../services/games/src/service.ts";
import { webService } from "../../apps/web/src/service.tsx";
import { signupAndVerify, staffClient, startStack, type Client, type Stack } from "./harness.ts";

let stack: Stack;
let admin: Client;
let user: Client;

beforeAll(async () => {
  stack = await startStack([identityService, oidcService, safetyService, supportService, gamesService, webService]);
  admin = (await staffClient(stack, "webadmin@example.com", ["admin"], { csea_officer: ["safety.csea.access"] })).client;
  user = await signupAndVerify(stack, "webuser@example.com", { username: "web_player" });
});

afterAll(async () => {
  await stack?.stop();
});

function assertPage(path: string, r: { status: number; body: string }) {
  if (r.status !== 200 || r.body.includes("Something went wrong") || r.body.includes("Page not found")) {
    const msg = /<p class="lede">([^<]*)<\/p>/.exec(r.body)?.[1] ?? r.body.slice(0, 300);
    throw new Error(`${path} → ${r.status}: ${msg}`);
  }
}

describe("every page renders", () => {
  it("renders the account pages for a regular user", async () => {
    for (const path of [
      "/",
      "/settings/profile",
      "/settings/security",
      "/settings/sessions",
      "/settings/notifications",
      "/settings/apps",
      "/settings/privacy",
      "/settings/family",
      "/games",
      "/games/devices",
      "/safety",
      "/developer",
      "/developer/clients/new",
      "/legal",
      "/legal/terms",
      "/device",
    ]) {
      const r = await user.page(path);
      assertPage(path, r);
    }
  });

  it("renders the admin pages", async () => {
    for (const path of [
      "/admin",
      "/admin/users",
      "/admin/roles",
      "/admin/audit",
      "/admin/text-filter",
      "/admin/oidc/clients",
      "/admin/safety",
      "/admin/safety/actions",
      "/admin/safety/appeals",
      "/admin/safety/flags",
      "/admin/safety/csea",
      "/admin/games",
      "/admin/games/entitlements",
    ]) {
      const r = await admin.page(path);
      assertPage(path, r);
    }
    const userId = (await user.get("/api/v1/me")).body.id;
    assertPage("/admin/users/:id", await admin.page(`/admin/users/${userId}`));

    const report = await admin.post("/api/v1/safety/reports", { type: "csea", subtype: "grooming", reported_user_id: userId, snapshot: { message: "test" } });
    const caseId = (await admin.get("/api/v1/admin/safety/csea")).body.items.find((c: { report_id: string }) => c.report_id === report.body.report_id).id;
    const open = await admin.page(`/admin/safety/csea/${caseId}`);
    assertPage("/admin/safety/csea/:id (open)", open);
    expect(open.body).toContain("Set priority");
    expect(open.body).toMatch(/port \d+/);
    await admin.post(`/api/v1/admin/safety/csea/${caseId}/priority`, { level: 3, reason: "Test assessment" });
    await admin.post(`/api/v1/admin/safety/csea/${caseId}/submission`, { nca_reference: "NCA-PAGE-1" });
    await admin.post(`/api/v1/admin/safety/csea/${caseId}/nca-requests`, { summary: "More details please" });
    const submitted = await admin.page(`/admin/safety/csea/${caseId}`);
    assertPage("/admin/safety/csea/:id (submitted)", submitted);
    expect(submitted.body).toContain("NCA-PAGE-1");
    expect(submitted.body).toContain("Add a supplementary report");
  });

  it("renders the support surface", async () => {
    for (const path of ["/support", "/support/search?q=password", "/support/guest", "/support/tickets", "/support/tickets/new"]) {
      assertPage(path, await user.page(path));
    }
    for (const path of ["/support/staff/tickets", "/support/staff/macros", "/support/staff/metrics", "/support/staff/kb", "/support/staff/kb/new"]) {
      assertPage(path, await admin.page(path));
    }
    const anon = await stack.client().page("/support");
    assertPage("/support (anonymous)", anon);
  });

  it("denies admin pages to regular users", async () => {
    const r = await user.page("/admin/users");
    expect(r.status).toBe(403);
  });
});

describe("forms", () => {
  it("starts TOTP setup with a QR code", async () => {
    const r = await user.form("/settings/security", { _action: "totp_setup" });
    expect(r.status).toBe(200);
    expect(r.body).toContain("<svg");
    expect(r.body).toContain('name="_action" value="totp_confirm"');
  });

  it("creates a game, files a report and opens a ticket through the pages", async () => {
    const created = await admin.form("/admin/games", { _action: "create", name: "Web Game", slug: "web-game" });
    expect(created.status).toBe(200);
    expect(created.body).toContain("client_secret");
    assertPage("/admin/games/web-game", await admin.page("/admin/games/web-game"));

    const targetId = (await admin.get("/api/v1/me")).body.id;
    const report = await user.form("/safety", { _action: "report", kind: "harassment:harassment", reported_user_id: targetId, description: "rude" });
    expect(report.body).toContain("Your report reference is R-");

    const ticket = await user.form("/support/tickets/new", { _action: "create", category: "account", subject: "Help with my account", body: "Something is wrong" });
    expect(ticket.status).toBe(303);
    const thread = await user.follow(ticket);
    assertPage("ticket thread", thread);
    expect(thread.body).toContain("Something is wrong");
    const number = /\/tickets\/(\d+)/.exec(ticket.headers.get("location")!)![1];
    assertPage("staff ticket", await admin.page(`/support/staff/tickets/${number}`));
  });

  it("publishes a KB article and shows it on the help centre", async () => {
    const r = await admin.form("/support/staff/kb/new", { _action: "save", title: "Changing your username", body: "Go to **Profile** and pick a new one.", tags: "username, profile", status: "published" });
    expect(r.status).toBe(303);
    const article = await stack.client().page("/support/kb/changing-your-username");
    assertPage("article", article);
    expect(article.body).toContain("<strong>Profile</strong>");
    const search = await stack.client().page("/support/search?q=username");
    expect(search.body).toContain("Changing your username");
  });
});
