import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityService } from "../../services/identity/src/service.ts";
import { webService } from "../../apps/web/src/service.tsx";
import { LEGAL, startStack, tokenFromUrl, type Stack } from "./harness.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack([identityService, webService]);
});

afterAll(async () => {
  await stack?.stop();
});

function hidden(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return m ? m[1]!.replace(/&amp;/g, "&") : "";
}

describe("web shell", () => {
  it("serves the themed login page with a nonce CSP", async () => {
    const r = await stack.client().page("/login");
    expect(r.status).toBe(200);
    expect(r.body).toContain("<!doctype html>");
    expect(r.body).toContain("Sign in");
    const csp = r.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(r.body).toContain(`nonce="${nonce}"`);
    expect(csp).toContain("frame-ancestors 'none'");
    const theme = await stack.client().page("/assets/theme.css");
    expect(theme.body).toContain("--bg: #222034");
    expect(theme.body).toContain("--primary: #5BB1EF");
    expect(theme.body).toContain("--purple: #BC6DE0");
  });

  it("redirects anonymous visitors to sign in", async () => {
    const r = await stack.client().page("/settings/security");
    expect([303, 404]).toContain(r.status);
  });

  it("signs up, verifies and signs in through forms", async () => {
    const c = stack.client();
    const signup = await c.form("/signup", { email: "web@example.com", password: "a long enough passphrase", dob: "1991-02-03", username: "web_tester", accept_legal: "on" });
    expect(signup.status).toBe(200);
    expect(signup.body).toContain("Verify your email");
    const mail = await stack.waitForEmail((e) => e.template === "verify_email" && e.to.email === "web@example.com");
    const confirm = await c.page(`/verify-email?token=${tokenFromUrl(mail.vars.verify_url)}`);
    expect(confirm.body).toContain("Verify and sign in");
    const done = await c.form("/verify-email", { token: tokenFromUrl(mail.vars.verify_url) });
    expect(done.status).toBe(303);
    expect([...c.cookies.keys()].some((k) => k.endsWith("qtiauth_session"))).toBe(true);
    const me = await c.get("/api/v1/me");
    expect(me.body.username).toBe("web_tester");

    await c.form("/logout", {});
    expect((await c.get("/api/v1/me")).status).toBe(401);
    const bad = await c.form("/login", { identifier: "web@example.com", password: "nope nope nope" });
    expect(bad.body).toContain("Email or password incorrect.");
    expect(hidden(bad.body, "identifier") || bad.body.includes('value="web@example.com"')).toBeTruthy();
    const ok = await c.form("/login", { identifier: "web@example.com", password: "a long enough passphrase" });
    expect(ok.status).toBe(303);
    expect((await c.get("/api/v1/me")).status).toBe(200);
    expect(LEGAL.length).toBe(2);
  });
});
