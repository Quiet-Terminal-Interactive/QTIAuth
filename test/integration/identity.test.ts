import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { identityService } from "../../services/identity/src/service.ts";
import { LEGAL, signupAndVerify, startStack, tokenFromUrl, type Stack } from "./harness.ts";
import { totpAt, totpStep } from "../../services/identity/src/lib/totp.ts";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack([identityService]);
});

afterAll(async () => {
  await stack?.stop();
});

describe("meta", () => {
  it("serves feature discovery", async () => {
    const r = await stack.client().get("/api/v1/meta/features");
    expect(r.status).toBe(200);
    expect(r.body.product.name).toBe("Test Account");
    expect(r.body.branding.colors.background).toBe("#222034");
    expect(r.body.modules.identity).toBe(true);
    expect(r.body.surfaces.support.api_path).toBe("/support/api");
  });

  it("serves a merged OpenAPI document for the surface", async () => {
    const r = await stack.client().get("/api/v1/openapi.json");
    expect(r.status).toBe(200);
    expect(r.body.paths["/api/v1/me"]).toBeDefined();
    const support = await stack.client().get("/support/api/v1/openapi.json");
    expect(support.body.paths["/support/api/v1/me"]).toBeDefined();
    expect(support.body.paths["/support/api/v1/admin/users"]).toBeUndefined();
  });

  it("returns problem details for unknown routes", async () => {
    const r = await stack.client().get("/api/v1/nope");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("ROUTE_NOT_FOUND");
    expect(r.headers.get("content-type")).toContain("application/problem+json");
  });
});

describe("password signup and login", () => {
  it("requires verification, then signs in and exposes /me on every surface", async () => {
    const c = await signupAndVerify(stack, "alice@example.com", { username: "alice_test" });
    const me = await c.get("/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.email).toBe("alice@example.com");
    expect(me.body.username).toBe("alice_test");
    expect(me.body.state).toBe("active");
    const viaSupport = await c.get("/support/api/v1/me");
    expect(viaSupport.status).toBe(200);
    expect(viaSupport.body.id).toBe(me.body.id);
  });

  it("gives the same response for existing and new emails at the limit", async () => {
    const c = stack.client();
    const body = (email: string) => ({ email, password: "another long passphrase", dob: "1991-01-01", accept_legal: LEGAL });
    await c.post("/api/v1/auth/signup", body("limit@example.com"));
    await c.post("/api/v1/auth/signup", body("limit@example.com"));
    const third = await c.post("/api/v1/auth/signup", body("limit@example.com"));
    expect(third.status).toBe(200);
    expect(third.body.status).toBe("verification_sent");
    await stack.waitForEmail((e) => e.template === "signup_limit_reached" && e.to.email === "limit@example.com");
  });

  it("rejects wrong passwords generically and accepts the right one", async () => {
    await signupAndVerify(stack, "bob@example.com");
    const c = stack.client();
    const bad = await c.post("/api/v1/auth/login", { identifier: "bob@example.com", password: "wrong password!!" });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe("INVALID_CREDENTIALS");
    const missing = await c.post("/api/v1/auth/login", { identifier: "nobody@example.com", password: "wrong password!!" });
    expect(missing.body.code).toBe("INVALID_CREDENTIALS");
    const ok = await c.post("/api/v1/auth/login", { identifier: "bob@example.com", password: "correct horse battery staple" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("signed_in");
    expect(ok.headers.getSetCookie().some((h) => h.startsWith("qtiauth_session=") && h.includes("HttpOnly") && h.includes("SameSite=Lax"))).toBe(true);
  });

  it("enforces password policy", async () => {
    const r = await stack.client().post("/api/v1/auth/signup", { email: "short@example.com", password: "short", dob: "1990-01-01", accept_legal: LEGAL });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("PASSWORD_TOO_SHORT");
  });

  it("requires legal acceptance at signup", async () => {
    const r = await stack.client().post("/api/v1/auth/signup", { email: "nolegal@example.com", password: "long enough password", dob: "1990-01-01" });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });
});

describe("CSRF and credential separation", () => {
  it("rejects state-changing requests with a foreign Origin", async () => {
    const c = await signupAndVerify(stack, "csrf@example.com");
    const r = await c.post("/api/v1/me/sessions/revoke-others", {}, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("CSRF_ORIGIN_MISMATCH");
  });

  it("does not accept a bearer token on session routes", async () => {
    const r = await stack.client().get("/api/v1/me", { authorization: "Bearer abc.def.ghi" });
    expect(r.status).toBe(401);
  });

  it("rejects requests to services that skip the gateway", async () => {
    const identity = stack.services.get("identity")!;
    const url = process.env.QTIAUTH_INTERNAL_URL;
    void url;
    const base = (identity.ctx as unknown as { config: unknown }) && stack.gateway.registry.pick("identity")!.baseUrl;
    const r = await fetch(`${base}/api/v1/me`);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { code: string }).code).toBe("MISSING_INTERNAL_IDENTITY");
  });
});

describe("magic link", () => {
  it("signs up a new email after the link is clicked", async () => {
    const c = stack.client();
    const start = await c.post("/api/v1/auth/magic-link/start", { email: "magic@example.com" });
    expect(start.body.status).toBe("sent_if_exists");
    const mail = await stack.waitForEmail((e) => e.template === "magic_link_signup" && e.to.email === "magic@example.com");
    const v = await c.post("/api/v1/auth/magic-link/verify", { token: tokenFromUrl(mail.vars.link_url) });
    expect(v.body.status).toBe("signup_required");
    const done = await c.post("/api/v1/auth/signup/complete", { signup_token: v.body.signup_token, dob: "1995-02-02", accept_legal: LEGAL });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("signed_in");
    const me = await c.get("/api/v1/me");
    expect(me.body.email_verified).toBe(true);
  });

  it("cannot be reused", async () => {
    const c = stack.client();
    await c.post("/api/v1/auth/magic-link/start", { email: "alice@example.com" });
    const mail = await stack.waitForEmail((e) => e.template === "magic_link" && e.to.email === "alice@example.com");
    const token = tokenFromUrl(mail.vars.link_url);
    expect((await c.post("/api/v1/auth/magic-link/verify", { token })).body.status).toBe("signed_in");
    const again = await stack.client().post("/api/v1/auth/magic-link/verify", { token });
    expect(again.status).toBe(400);
  });
});

describe("sessions", () => {
  it("lists, revokes and logs out everywhere", async () => {
    const a = await signupAndVerify(stack, "sessions@example.com");
    const b = stack.client();
    await b.post("/api/v1/auth/login", { identifier: "sessions@example.com", password: "correct horse battery staple" });
    const list = await a.get("/api/v1/me/sessions");
    expect(list.body.items.length).toBe(2);
    expect(list.body.items.filter((s: { current: boolean }) => s.current).length).toBe(1);
    const other = list.body.items.find((s: { current: boolean }) => !s.current);
    expect((await a.delete(`/api/v1/me/sessions/${other.id}`)).status).toBe(200);
    expect((await b.get("/api/v1/me")).status).toBe(401);
    const out = await a.post("/api/v1/auth/logout");
    expect(out.status).toBe(200);
    expect((await a.get("/api/v1/me")).status).toBe(401);
  });

  it("drops to aal0 on a country change and recovers with re-authentication", async () => {
    const c = await signupAndVerify(stack, "travel@example.com");
    c.headers["x-test-country"] = "GB";
    await c.post("/api/v1/auth/logout");
    await c.post("/api/v1/auth/login", { identifier: "travel@example.com", password: "correct horse battery staple" });
    expect((await c.get("/api/v1/me")).status).toBe(200);
    c.headers["x-test-country"] = "FR";
    const blocked = await c.get("/api/v1/me/username/history");
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("REAUTHENTICATION_REQUIRED");
    const reauth = await c.post("/api/v1/auth/step-up/verify", { method: "password", password: "correct horse battery staple" });
    expect(reauth.status).toBe(200);
    expect((await c.get("/api/v1/me/username/history")).status).toBe(200);
  });
});

describe("two-factor", () => {
  it("enrols TOTP, requires it at login and satisfies step-up", async () => {
    const c = await signupAndVerify(stack, "totp@example.com");
    const setup = await c.post("/api/v1/me/totp/setup");
    expect(setup.status).toBe(200);
    const confirm = await c.post("/api/v1/me/totp/confirm", { code: totpAt(setup.body.secret, totpStep()) });
    expect(confirm.status).toBe(200);
    expect(confirm.body.recovery_codes).toHaveLength(10);
    const fresh = stack.client();
    const login = await fresh.post("/api/v1/auth/login", { identifier: "totp@example.com", password: "correct horse battery staple" });
    expect(login.body.status).toBe("mfa_required");
    const bad = await fresh.post("/api/v1/auth/mfa/verify", { mfa_token: login.body.mfa_token, method: "totp", code: "000000" });
    expect(bad.status).toBe(401);
    const rc = await fresh.post("/api/v1/auth/mfa/verify", { mfa_token: login.body.mfa_token, method: "recovery_code", code: confirm.body.recovery_codes[0] });
    expect(rc.status).toBe(200);
    expect(rc.body.aal).toBe(2);
    const del = await fresh.post("/api/v1/me/delete");
    expect(del.status).toBe(200);
    expect(del.body.status).toBe("pending_deletion");
  });
});

describe("usernames and text filter", () => {
  it("blocks offensive usernames and allows Scunthorpe", async () => {
    const c = await signupAndVerify(stack, "names@example.com");
    expect((await c.get("/api/v1/me/username/check?username=Scunthorpe")).body.available).toBe(true);
    const bad = await c.put("/api/v1/me/username", { username: "xxx_cunt_xx" });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe("USERNAME_NOT_AVAILABLE");
    const ok = await c.put("/api/v1/me/username", { username: "Scunthorpe" });
    expect(ok.status).toBe(200);
    const taken = await (await signupAndVerify(stack, "names2@example.com")).put("/api/v1/me/username", { username: "scunthorpe" });
    expect(taken.body.code).toBe("USERNAME_NOT_AVAILABLE");
  });
});

describe("parental consent", () => {
  it("holds a child account until a guardian approves", async () => {
    const dob = `${new Date().getUTCFullYear() - 10}-03-03`;
    const c = stack.client();
    const r = await c.post("/api/v1/auth/signup", { email: "kid@example.com", password: "a long enough passphrase", dob, guardian_email: "parent@example.com", accept_legal: [] });
    expect(r.status).toBe(200);
    const mail = await stack.waitForEmail((e) => e.template === "verify_email" && e.to.email === "kid@example.com");
    await c.post("/api/v1/auth/verify-email", { token: tokenFromUrl(mail.vars.verify_url) });
    const me = await c.get("/api/v1/me");
    expect(me.body.state).toBe("pending_parental_consent");
    const gated = await c.get("/api/v1/me/username/history");
    expect(gated.status).toBe(403);
    expect(gated.body.code).toBe("PARENTAL_CONSENT_PENDING");
    const consent = await stack.waitForEmail((e) => e.template === "guardian_consent_request" && e.to.email === "parent@example.com");
    const parent = stack.client();
    const token = tokenFromUrl(consent.vars.consent_url);
    const lookup = await parent.post("/api/v1/family/consent/lookup", { token });
    expect(lookup.status).toBe(200);
    const tooYoung = await parent.post("/api/v1/family/consent/approve", { token, guardian_dob: `${new Date().getUTCFullYear() - 15}-01-01`, accept_legal: LEGAL });
    expect(tooYoung.body.code).toBe("GUARDIAN_MUST_BE_ADULT");
    const approve = await parent.post("/api/v1/family/consent/approve", { token, guardian_dob: "1980-01-01", accept_legal: LEGAL });
    expect(approve.status).toBe(200);
    expect((await c.get("/api/v1/me")).body.state).toBe("active");
    const children = await parent.get("/api/v1/family/children");
    expect(children.status).toBe(200);
    expect(children.body.items).toHaveLength(1);
    expect(children.body.items[0].controls.approve_third_party_apps).toBe(true);
    const childId = children.body.items[0].id;
    const upd = await parent.patch(`/api/v1/family/children/${childId}/controls`, { daily_playtime_minutes: 60 });
    expect(upd.body.controls.daily_playtime_minutes).toBe(60);
  });
});
