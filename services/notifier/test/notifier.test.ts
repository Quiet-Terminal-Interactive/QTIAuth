import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, resolveSurfaces, type LoadedConfig } from "@qtiauth/config";
import { parse, render, referencedVars } from "../src/templating.ts";
import { TemplateStore } from "../src/templates.ts";
import { formatBody, minimisePayload, sign } from "../src/webhooks.ts";
import { parseProviderEvents } from "../src/providers/index.ts";

function config(dir = mkdtempSync(join(tmpdir(), "notifier-"))): LoadedConfig {
  const c = parseConfig({
    surfaces: { account: { hosts: ["me.example.com"] }, support: { hosts: ["me.example.com"], base_path: "/support" }, api: { hosts: ["me.example.com"], base_path: "/api" } },
  });
  return Object.assign(c, { configDir: dir, configPath: join(dir, "qtiauth.yaml") });
}

describe("templating", () => {
  it("renders variables, conditionals and loops with HTML escaping", () => {
    const t = parse("Hi {{name}}{{#if vip}} (VIP){{else}} (guest){{/if}}: {{#each games}}{{this.name}}={{this.mins}};{{/each}}");
    expect(render(t, { name: "<b>", vip: false, games: [{ name: "A", mins: 3 }] }, { html: true })).toBe("Hi &lt;b&gt; (guest): A=3;");
    expect(render(t, { name: "<b>", vip: true, games: [] }, { html: false })).toBe("Hi <b> (VIP): ");
  });

  it("lists referenced top-level variables", () => {
    expect([...referencedVars(parse("{{a}} {{#if b}}{{c.d}}{{/if}} {{#each e}}{{this.f}}{{/each}}"))].sort()).toEqual(["a", "b", "c", "e"]);
  });
});

describe("template store", () => {
  it("loads and renders every shipped template", async () => {
    const cfg = config();
    const store = new TemplateStore(cfg, resolveSurfaces(cfg));
    const r = await store.load();
    expect(r.loaded).toBeGreaterThanOrEqual(60);
    const mail = await store.render("verify_email", "en-GB", { name: "Ada", verify_url: "https://me.example.com/verify-email?token=abc" });
    expect(mail.subject).toBe("Confirm your email for Example Account");
    expect(mail.html).toContain("https://me.example.com/verify-email?token=abc");
    expect(mail.html).toContain("#222034");
    expect(mail.text).toContain("Confirm email: https://me.example.com/verify-email?token=abc");
  });

  it("fails at startup when an override uses an undeclared variable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notifier-"));
    mkdirSync(join(dir, "templates/email/en-GB"), { recursive: true });
    writeFileSync(join(dir, "templates/email/en-GB/verify_email.mjml"), "---\nsubject: Hi {{nope}}\nvars: [name, verify_url]\n---\n<mjml><mj-body></mj-body></mjml>");
    const cfg = config(dir);
    await expect(new TemplateStore(cfg, resolveSurfaces(cfg)).load()).rejects.toThrow(/nope/);
  });

  it("uses overrides from the config directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notifier-"));
    mkdirSync(join(dir, "templates/email/en-GB"), { recursive: true });
    writeFileSync(join(dir, "templates/email/en-GB/verify_email.txt"), "Custom {{verify_url}}");
    const cfg = config(dir);
    const store = new TemplateStore(cfg, resolveSurfaces(cfg));
    expect((await store.load()).overrides).toBe(1);
    expect((await store.render("verify_email", "en-GB", { name: "x", verify_url: "U" })).text).toBe("Custom U");
  });
});

describe("webhooks", () => {
  it("signs per the Standard Webhooks test vector", () => {
    expect(sign("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}')).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("strips content and reporter identity from payloads", () => {
    const cfg = config();
    const ctx = { config: cfg, surfaces: resolveSurfaces(cfg) } as never;
    const p = minimisePayload(ctx, {
      event_id: "01J",
      type: "qtiauth.safety.report.created.v1",
      occurred_at: "2026-01-01T00:00:00Z",
      actor: { type: "user", id: "reporter" },
      subject: { type: "report", id: "r1" },
      data: { report_id: "r1", priority: "high", type: "hate", description: "secret text", snapshot: { a: 1 }, reporter_id: "u1" },
    });
    expect(p.data).toEqual({ report_id: "r1", priority: "high", type: "hate" });
    expect(JSON.stringify(p)).not.toContain("secret text");
    expect(JSON.stringify(p)).not.toContain("reporter");
    expect(p.link).toBe("https://me.example.com/admin/safety/reports/r1");
    const discord = JSON.parse(formatBody(ctx, "discord", p));
    expect(discord.embeds[0].title).toBe("Safety report created");
    const slack = JSON.parse(formatBody(ctx, "slack", p));
    expect(slack.blocks[0].type).toBe("header");
  });
});

describe("provider events", () => {
  it("parses hard bounces and complaints", () => {
    expect(parseProviderEvents("postmark", { RecordType: "Bounce", Type: "HardBounce", Email: "a@x.com", MessageID: "m1" })).toEqual([{ email: "a@x.com", kind: "hard_bounce", provider_message_id: "m1" }]);
    expect(parseProviderEvents("resend", { type: "email.complained", data: { to: ["b@x.com"], email_id: "e" } })[0]!.kind).toBe("complaint");
    expect(parseProviderEvents("ses", { Type: "Notification", Message: JSON.stringify({ notificationType: "Bounce", bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "c@x.com" }] }, mail: { messageId: "s" } }) })[0]!.kind).toBe("hard_bounce");
  });
});
