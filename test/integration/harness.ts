import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inject } from "vitest";
import pg from "pg";
import { parseConfig, type LoadedConfig, type ConfigInput } from "@qtiauth/config";
import { runService, type ServiceContext, type ServiceDefinition } from "@qtiauth/service-kit";
import { createLogger } from "@qtiauth/common";
import { Bus } from "@qtiauth/bus";
import { startGateway, type GatewayHandle } from "../../services/gateway/src/server.ts";
import { AckPolicy, DeliverPolicy } from "@nats-io/jetstream";
import { nanos } from "@nats-io/nats-core";

export const REPO = resolve(import.meta.dirname, "../..");

export function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (typeof a === "object" && a ? res(a.port) : rej(new Error("no port"))));
    });
  });
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k])) out[k] = deepMerge(a[k] as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

export interface CapturedEmail {
  template: string;
  to: { user_id?: string; email?: string; guardian_id?: string };
  vars: Record<string, unknown>;
  sender: string;
}

export interface Stack {
  port: number;
  origin: string;
  config: LoadedConfig;
  gateway: GatewayHandle;
  services: Map<string, { ctx: ServiceContext; stop: () => Promise<void> }>;
  emails: CapturedEmail[];
  bus: Bus;
  db: pg.Pool;
  waitForEmail(pred: (e: CapturedEmail) => boolean, ms?: number): Promise<CapturedEmail>;
  client(): Client;
  stop(): Promise<void>;
}

let stackCounter = 0;

export async function startStack(defs: ServiceDefinition<any>[], overrides: Partial<ConfigInput> & Record<string, unknown> = {}): Promise<Stack> {
  const port = await freePort();
  const internalPort = await freePort();
  const n = `${process.pid}_${++stackCounter}`;
  const dir = mkdtempSync(join(tmpdir(), "qtiauth-stack-"));
  mkdirSync(join(dir, "legal"));
  cpSync(join(REPO, "config/legal"), join(dir, "legal"), { recursive: true });
  const base: Record<string, unknown> = {
    branding: { product_name: "Test Account", company_name: "Test Ltd" },
    surfaces: {
      account: { hosts: [`localhost:${port}`], base_path: "/", scheme: "http" },
      support: { hosts: [`localhost:${port}`], base_path: "/support", scheme: "http" },
      api: { hosts: [`localhost:${port}`], base_path: "/api", scheme: "http" },
    },
    cookies: { secure: false },
    infrastructure: { nats_url: inject("natsUrl"), valkey_url: inject("valkeyUrl"), rpc_timeout: "10s", gateway_url: `http://127.0.0.1:${internalPort}` },
    geoip: { source: "header", header: "x-test-country" },
    password: { breach_check: false, argon2: { memory_kib: 1024, iterations: 1, parallelism: 1 } },
    legal: { directory: join(dir, "legal") },
    text_filter: { lists_directory: join(REPO, "config/lists/username") },
    captcha: { provider: "none" },
    rate_limits: Object.fromEntries(
      ["global", "auth_signup", "auth_password", "auth_general", "auth_verify", "magic_link_email", "magic_link_ip", "magic_link_ip_day", "password_reset", "totp_verify", "account_write", "guest_ticket", "guest_code", "key_redeem", "report_create", "ticket_create", "oauth_token", "oauth_device", "developer", "admin", "intake", "public_read", "kb_feedback", "steam_authenticate"].map((n) => [n, { per: "ip", limit: 100000, window: "1m" }]),
    ),
    email: { provider: "console" },
    backups: { destination: { type: "volume", path: join(dir, "backups") } },
    observability: { log_level: process.env.QTIAUTH_TEST_LOG ?? "silent" },
    secrets: { app_encryption_key: "a".repeat(64), key_encryption_key: "b".repeat(64), backup_encryption_key: "c".repeat(64) },
  };
  const cfgObj = parseConfig(deepMerge(base, overrides as Record<string, unknown>), {});
  const config = Object.assign(cfgObj, { configDir: dir, configPath: join(dir, "qtiauth.yaml") }) as LoadedConfig;
  writeFileSync(config.configPath, "");
  const pgUrl = inject("pgUrl");
  const db = new pg.Pool({ connectionString: pgUrl, max: 3 });
  const services = new Map<string, { ctx: ServiceContext; stop: () => Promise<void> }>();
  for (const def of defs) {
    const svcPort = await freePort();
    const schema = def.schema ? `${def.schema}_${n}` : undefined;
    const env = { ...process.env, DATABASE_URL: pgUrl, PORT: String(svcPort), QTIAUTH_INTERNAL_URL: `http://127.0.0.1:${svcPort}`, LISTEN_HOST: "127.0.0.1" };
    const prev = { PORT: process.env.PORT, QTIAUTH_INTERNAL_URL: process.env.QTIAUTH_INTERNAL_URL, LISTEN_HOST: process.env.LISTEN_HOST };
    Object.assign(process.env, { PORT: env.PORT, QTIAUTH_INTERNAL_URL: env.QTIAUTH_INTERNAL_URL, LISTEN_HOST: "127.0.0.1" });
    const r = await runService({ ...def, schema }, { config, env, log: createLogger(def.name, config.observability.log_level) });
    Object.assign(process.env, prev);
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k];
    services.set(def.name, { ctx: r.ctx, stop: r.stop });
  }
  process.env.LISTEN_HOST = "127.0.0.1";
  const gateway = await startGateway({ config, ports: [port], internalPort });
  const bus = await Bus.connect({ servers: inject("natsUrl"), name: `test-${n}`, log: createLogger("test", "silent") });
  const emails: CapturedEmail[] = [];
  const consumerName = `test_emails_${n}_${Date.now()}`;
  if (!defs.some((d) => d.name === "notifier")) {
    await bus.jsm.consumers.add("QTIAUTH_QUEUE", {
      name: consumerName,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      filter_subject: "qtiauth.queue.email.>",
      inactive_threshold: nanos(120_000),
    });
    void (async () => {
      const c = await bus.js.consumers.get("QTIAUTH_QUEUE", consumerName);
      const msgs = await c.consume();
      for await (const m of msgs) {
        emails.push(m.json<CapturedEmail>());
        m.ack();
      }
    })().catch(() => undefined);
  }
  await waitUntil(() => defs.every((d) => gateway.registry.running().includes(d.name)), 15_000);
  const origin = `http://localhost:${port}`;
  return {
    port,
    origin,
    config,
    gateway,
    services,
    emails,
    bus,
    db,
    async waitForEmail(pred, ms = 10_000) {
      let found: CapturedEmail | undefined;
      await waitUntil(() => Boolean((found = emails.find(pred))), ms);
      return found!;
    },
    client: () => new Client(origin),
    async stop() {
      await bus.jsm.consumers.delete("QTIAUTH_QUEUE", consumerName).catch(() => undefined);
      await gateway.stop();
      for (const s of [...services.values()].reverse()) await s.stop().catch(() => undefined);
      await bus.close().catch(() => undefined);
      await db.end();
    },
  };
}

export async function waitUntil(fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("waitUntil timed out");
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  readonly origin: string;
  readonly cookies = new Map<string, string>();
  headers: Record<string, string> = {};

  constructor(origin: string) {
    this.origin = origin;
  }

  private storeCookies(h: Headers): void {
    for (const c of h.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const i = pair!.indexOf("=");
      const name = pair!.slice(0, i).trim();
      const value = pair!.slice(i + 1).trim();
      const maxAge = attrs.find((a) => a.trim().toLowerCase().startsWith("max-age="));
      if (!value || (maxAge && Number(maxAge.split("=")[1]) <= 0)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...this.headers, ...extra };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET" && !("origin" in headers)) headers.origin = this.origin;
    const r = await fetch(this.origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    this.storeCookies(r.headers);
    const text = await r.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: r.status, body: parsed as T, headers: r.headers };
  }

  get<T = any>(path: string, extra?: Record<string, string>) {
    return this.request<T>("GET", path, undefined, extra);
  }
  post<T = any>(path: string, body?: unknown, extra?: Record<string, string>) {
    return this.request<T>("POST", path, body ?? {}, extra);
  }
  put<T = any>(path: string, body?: unknown, extra?: Record<string, string>) {
    return this.request<T>("PUT", path, body ?? {}, extra);
  }
  patch<T = any>(path: string, body?: unknown, extra?: Record<string, string>) {
    return this.request<T>("PATCH", path, body ?? {}, extra);
  }
  delete<T = any>(path: string, body?: unknown, extra?: Record<string, string>) {
    return this.request<T>("DELETE", path, body, extra);
  }

  async page(path: string, extra: Record<string, string> = {}): Promise<ApiResponse<string>> {
    const headers: Record<string, string> = { accept: "text/html", ...this.headers, ...extra };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await fetch(this.origin + path, { headers, redirect: "manual" });
    this.storeCookies(r.headers);
    return { status: r.status, body: await r.text(), headers: r.headers };
  }

  async form(path: string, fields: Record<string, string>, extra: Record<string, string> = {}): Promise<ApiResponse<string>> {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", origin: this.origin, ...this.headers, ...extra };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await fetch(this.origin + path, { method: "POST", headers, body: new URLSearchParams(fields), redirect: "manual" });
    this.storeCookies(r.headers);
    return { status: r.status, body: await r.text(), headers: r.headers };
  }

  async follow(r: ApiResponse<string>, max = 5): Promise<ApiResponse<string>> {
    let cur = r;
    for (let i = 0; i < max && cur.status >= 300 && cur.status < 400; i++) {
      const loc = cur.headers.get("location")!;
      cur = await this.page(loc.startsWith("http") ? new URL(loc).pathname + new URL(loc).search : loc);
    }
    return cur;
  }
}

export function tokenFromUrl(url: unknown): string {
  return new URL(String(url)).searchParams.get("token") ?? "";
}

export const LEGAL = [
  { id: "terms", version: "2026-01-01" },
  { id: "privacy", version: "2026-01-01" },
];

export async function signupAndVerify(stack: Stack, email: string, opts: { dob?: string; password?: string; username?: string } = {}): Promise<Client> {
  const c = stack.client();
  const password = opts.password ?? "correct horse battery staple";
  const r = await c.post("/api/v1/auth/signup", { email, password, dob: opts.dob ?? "1990-05-05", username: opts.username, accept_legal: LEGAL });
  if (r.status !== 200) throw new Error(`signup failed ${r.status} ${JSON.stringify(r.body)}`);
  const mail = await stack.waitForEmail((e) => e.template === "verify_email" && e.to.email === email);
  const v = await c.post("/api/v1/auth/verify-email", { token: tokenFromUrl(mail.vars.verify_url) });
  if (v.status !== 200) throw new Error(`verify failed ${v.status} ${JSON.stringify(v.body)}`);
  return c;
}

export async function grantRoles(stack: Stack, userId: string, roles: string[], customPermissions: Record<string, string[]> = {}): Promise<void> {
  const db = stack.services.get("identity")!.ctx.db;
  for (const [name, permissions] of Object.entries(customPermissions)) {
    await db
      .insertInto("roles")
      .values({ name, description: "test", permissions: JSON.stringify(permissions), builtin: false })
      .onConflict((oc: any) => oc.column("name").doUpdateSet({ permissions: JSON.stringify(permissions) }))
      .execute();
  }
  for (const role of [...roles, ...Object.keys(customPermissions)]) {
    await db.insertInto("user_roles").values({ user_id: userId, role }).onConflict((oc: any) => oc.doNothing()).execute();
  }
}

export async function staffClient(stack: Stack, email: string, roles: string[], customPermissions: Record<string, string[]> = {}): Promise<{ client: Client; userId: string }> {
  const { totpAt, totpStep } = await import("../../services/identity/src/lib/totp.ts");
  const c = await signupAndVerify(stack, email);
  const me = await c.get("/api/v1/me");
  const setup = await c.post("/api/v1/me/totp/setup");
  await c.post("/api/v1/me/totp/confirm", { code: totpAt(setup.body.secret, totpStep()) });
  await grantRoles(stack, me.body.id, roles, customPermissions);
  const fresh = stack.client();
  const login = await fresh.post("/api/v1/auth/login", { identifier: email, password: "correct horse battery staple" });
  if (login.body.status !== "mfa_required") throw new Error(`staff login failed ${JSON.stringify(login.body)}`);
  let verified = await fresh.post("/api/v1/auth/mfa/verify", { mfa_token: login.body.mfa_token, method: "totp", code: totpAt(setup.body.secret, totpStep()) });
  if (verified.status !== 200) verified = await fresh.post("/api/v1/auth/mfa/verify", { mfa_token: login.body.mfa_token, method: "totp", code: totpAt(setup.body.secret, totpStep() + 1) });
  if (verified.status !== 200) throw new Error(`staff mfa failed ${JSON.stringify(verified.body)}`);
  return { client: fresh, userId: me.body.id };
}
