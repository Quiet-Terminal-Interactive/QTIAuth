import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { JSX } from "hono/jsx/jsx-runtime";
import { IDENTITY_HEADER, type IdentityClaims, type InternalKeyRing } from "@qtiauth/auth-context";
import { configFile, type LoadedConfig, type ResolvedSurface, type SurfaceName } from "@qtiauth/config";
import { inc, observe, renderMetrics, type Logger } from "@qtiauth/common";
import { Api, DELEGATION_HEADER, SURFACE_ORIGIN_HEADER, type ApiResult, type Problem } from "./api.ts";
import { translator, errorMessage } from "./i18n/index.ts";
import { buildTheme } from "./theme.ts";
import { BASE_CSS } from "./assets/styles.ts";
import { CLIENT_JS } from "./assets/client.ts";
import { ProblemSignal, RedirectSignal, currentUrl, href, loginLocation, surfaceHref, type Features, type Me, type RequestContext } from "./context.ts";
import { AuthLayout, LinkButton } from "./ui.tsx";

export type PageResult = Response | JSX.Element | Promise<JSX.Element>;
export type Handler = (rc: RequestContext, params: Record<string, string>) => Promise<PageResult> | PageResult;

export interface PageRoute {
  method: "GET" | "POST";
  path: string;
  handler: Handler;
}

interface CompiledRoute extends PageRoute {
  regex: RegExp;
  keys: string[];
}

export function page(path: string, handler: Handler): PageRoute {
  return { method: "GET", path, handler };
}

export function action(path: string, handler: Handler): PageRoute {
  return { method: "POST", path, handler };
}

export function actions(path: string, handlers: Record<string, Handler>): PageRoute {
  return action(path, (rc, params) => {
    const h = handlers[rc.form._action ?? ""];
    if (!h) throw new ProblemSignal({ status: 400, code: "UNKNOWN_ACTION" });
    return h(rc, params);
  });
}

function compile(r: PageRoute): CompiledRoute {
  const keys: string[] = [];
  const pattern = r.path
    .split("/")
    .map((seg) => {
      if (seg.startsWith(":")) {
        keys.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { ...r, regex: new RegExp(`^${pattern || "/"}/?$`), keys };
}

export interface WebDeps {
  cfg: LoadedConfig;
  surfaces: Record<SurfaceName, ResolvedSurface>;
  keyring: InternalKeyRing;
  log: Logger;
  gatewayUrl: string;
  routes: Record<SurfaceName, PageRoute[]>;
}

const GATE_CODES: Record<string, string> = {
  LEGAL_ACCEPTANCE_REQUIRED: "/legal/accept",
  PARENTAL_CONSENT_PENDING: "/waiting",
  REAUTHENTICATION_REQUIRED: "/auth/reauth",
  MFA_ENROLMENT_REQUIRED: "/settings/security?enrol=1",
  USERNAME_RESET_REQUIRED: "/welcome/username",
  ACCOUNT_LOCKED: "/standing",
  ACCOUNT_BANNED: "/standing",
  STEP_UP_REQUIRED: "/auth/step-up",
};

export function gateRedirect(rc: RequestContext, p: Problem): string | null {
  if (p.code === "UNAUTHENTICATED") return loginLocation(rc);
  const target = GATE_CODES[p.code];
  if (!target) return null;
  const [path, q] = target.split("?");
  const query: Record<string, string> = Object.fromEntries(new URLSearchParams(q ?? ""));
  if (p.code !== "ACCOUNT_LOCKED" && p.code !== "ACCOUNT_BANNED" && p.code !== "PARENTAL_CONSENT_PENDING") query.return = rc.method === "GET" ? currentUrl(rc) : rc.fullPath;
  return surfaceHref(rc, "account", path!, query);
}

export function unwrap<T>(rc: RequestContext, r: ApiResult<T>): T {
  if (r.ok) return r.data;
  const loc = gateRedirect(rc, r.problem);
  if (loc) throw new RedirectSignal(loc);
  throw new ProblemSignal(r.problem);
}

export function attempt<T>(rc: RequestContext, r: ApiResult<T>): { ok: true; data: T } | { ok: false; problem: Problem } {
  if (r.ok) return { ok: true, data: r.data };
  const loc = gateRedirect(rc, r.problem);
  if (loc) throw new RedirectSignal(loc);
  return { ok: false, problem: r.problem };
}

export function redirect(rc: RequestContext, location: string): Response {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const [k, v] of rc.api.sessionHeaders) h.set(k, v);
  return new Response(null, { status: 303, headers: h });
}

export function back(rc: RequestContext, path: string, query?: Record<string, string | undefined>): Response {
  return redirect(rc, href(rc, path, query));
}

function csp(rc: RequestContext): string {
  const origins = [...new Set(Object.values(rc.surfaces).flatMap((s) => s.origins))].join(" ");
  const extra = [...new Set(rc.cspHosts)].join(" ");
  return [
    "default-src 'self'",
    `script-src 'nonce-${rc.nonce}' 'strict-dynamic'`,
    "style-src 'self' https://fonts.googleapis.com",
    "img-src 'self' data: https:",
    "font-src 'self' data: https:",
    `connect-src 'self' ${extra}`.trim(),
    `frame-src ${extra || "'none'"}`,
    `form-action 'self' ${origins} ${extra}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

export async function render(rc: RequestContext, node: JSX.Element | Promise<JSX.Element>, status = 200): Promise<Response> {
  const html = String(await (await node).toString());
  const h = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store, private", "content-security-policy": csp(rc), vary: "Cookie" });
  for (const [k, v] of rc.api.sessionHeaders) h.set(k, v);
  return new Response(html, { status, headers: h });
}

function ErrorPage({ rc, problem }: { rc: RequestContext; problem: Problem }) {
  const notFound = problem.status === 404;
  return (
    <AuthLayout rc={rc} title={notFound ? rc.t("error.not_found_title") : rc.t("error.title")}>
      <p class="lede">{notFound ? rc.t("error.not_found") : errorMessage(rc.t, problem.code, typeof problem.detail === "string" ? problem.detail : undefined)}</p>
      <LinkButton href={href(rc, "/")} block>
        {rc.t("error.home")}
      </LinkButton>
    </AuthLayout>
  );
}

function fallbackLogo(cfg: LoadedConfig): string {
  const c = cfg.branding.colors;
  const letter = (cfg.branding.product_name.trim()[0] ?? "Q").toUpperCase().replace(/[<&>]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c.primary}"/><stop offset="1" stop-color="${c.accent}"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><text x="32" y="43" font-family="system-ui,sans-serif" font-size="32" font-weight="700" text-anchor="middle" fill="${c.primary_text}">${letter}</text></svg>`;
}

const MIME: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".gif": "image/gif" };

function loadBrandAsset(cfg: LoadedConfig, path: string): { body: Uint8Array; type: string } | null {
  const file = configFile(cfg, path);
  if (!existsSync(file)) return null;
  const body = readFileSync(file);
  if (!body.length) return null;
  return { body, type: MIME[extname(file).toLowerCase()] ?? "application/octet-stream" };
}

const featureCache = new Map<string, { at: number; value: Features }>();

export function createWebApp(deps: WebDeps): Hono {
  const app = new Hono();
  const theme = buildTheme(deps.cfg, BASE_CSS);
  const logo = loadBrandAsset(deps.cfg, deps.cfg.branding.logo) ?? { body: new TextEncoder().encode(fallbackLogo(deps.cfg)), type: "image/svg+xml" };
  const favicon = loadBrandAsset(deps.cfg, deps.cfg.branding.favicon) ?? logo;
  const compiled = Object.fromEntries(Object.entries(deps.routes).map(([k, v]) => [k, v.map(compile)])) as Record<SurfaceName, CompiledRoute[]>;
  const staticHeaders = (type: string) => ({ "content-type": type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" });

  app.all("*", async (c) => {
    const started = performance.now();
    const url = new URL(c.req.url);
    const token = c.req.header(IDENTITY_HEADER);
    if (!token) {
      if (url.pathname === "/healthz") return c.json({ status: "ok", service: "web" });
      if (url.pathname === "/metrics") {
        const m = await renderMetrics();
        return new Response(m.body, { headers: { "content-type": m.contentType } });
      }
      return c.text("Requests must come through the gateway", 401);
    }
    let claims: IdentityClaims;
    try {
      claims = await deps.keyring.verify(token, { method: c.req.method === "HEAD" ? "GET" : c.req.method, path: url.pathname });
    } catch (err) {
      deps.log.warn({ err: (err as Error).message }, "rejected identity token on web request");
      return c.text("Invalid identity", 401);
    }
    const surfaceName = (c.req.header("x-qtiauth-surface") as SurfaceName) ?? (claims.surface as SurfaceName) ?? "account";
    const surface = deps.surfaces[surfaceName] ?? deps.surfaces.account;
    const rel = surface.basePath === "/" ? url.pathname : url.pathname.slice(surface.basePath.length) || "/";

    if (c.req.method === "GET" || c.req.method === "HEAD") {
      if (rel === "/assets/theme.css") return new Response(theme.css, { headers: staticHeaders("text/css; charset=utf-8") });
      if (rel === "/assets/app.js") return new Response(CLIENT_JS, { headers: staticHeaders("text/javascript; charset=utf-8") });
      if (rel === "/branding/logo" || rel === "/branding/logo.png" || rel === "/branding/logo.svg") return new Response(logo.body as BodyInit, { headers: staticHeaders(logo.type) });
      if (rel === "/branding/favicon" || rel === "/favicon.ico") return new Response(favicon.body as BodyInit, { headers: staticHeaders(favicon.type) });
      if (rel === "/robots.txt") return new Response(surface.name === "support" ? "User-agent: *\nAllow: /\nDisallow: /staff\nDisallow: /tickets\n" : "User-agent: *\nDisallow: /\n", { headers: staticHeaders("text/plain") });
    }

    const origin = c.req.header(SURFACE_ORIGIN_HEADER) ?? surface.origin;
    const locale = claims.locale ?? deps.cfg.branding.default_locale;
    const api = new Api({ gatewayUrl: deps.gatewayUrl, surface, origin, delegation: c.req.header(DELEGATION_HEADER) ?? null, incoming: c.req.raw.headers });
    let form: Record<string, string> = {};
    const formAll: Record<string, string[]> = {};
    if (c.req.method === "POST") {
      const ct = c.req.header("content-type") ?? "";
      if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        const fd = await c.req.formData();
        for (const [k, v] of fd.entries()) {
          if (typeof v !== "string") continue;
          (formAll[k] ??= []).push(v);
        }
        form = Object.fromEntries(Object.entries(formAll).map(([k, v]) => [k, v[v.length - 1]!]));
      }
    }
    let meCache: Promise<Me | null> | null = null;
    const rc: RequestContext = {
      cfg: deps.cfg,
      surface,
      surfaces: deps.surfaces,
      origin,
      claims,
      api,
      t: translator(locale, deps.cfg.branding.default_locale, { product: deps.cfg.branding.product_name, company: deps.cfg.branding.company_name }),
      locale,
      nonce: randomBytes(16).toString("base64"),
      themeVersion: theme.version,
      path: rel,
      fullPath: url.pathname,
      query: url.searchParams,
      method: c.req.method === "HEAD" ? "GET" : c.req.method,
      form,
      formAll,
      cspHosts: [],
      async features() {
        const hit = featureCache.get(surface.name);
        if (hit && Date.now() - hit.at < 30_000) return hit.value;
        const r = await api.get<Features>("/api/v1/meta/features");
        if (!r.ok) throw new ProblemSignal(r.problem);
        featureCache.set(surface.name, { at: Date.now(), value: r.data });
        return r.data;
      },
      me() {
        if (!claims.sub) return Promise.resolve(null);
        meCache ??= api.get<Me>("/api/v1/me").then((r) => (r.ok ? r.data : null));
        return meCache;
      },
    };

    let status = 500;
    try {
      const routes = compiled[surface.name] ?? [];
      let matched: { route: CompiledRoute; params: Record<string, string> } | null = null;
      let pathMatched = false;
      for (const r of routes) {
        const m = r.regex.exec(rel);
        if (!m) continue;
        if (r.method !== rc.method) {
          pathMatched = true;
          continue;
        }
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
        matched = { route: r, params };
        break;
      }
      if (!matched) throw new ProblemSignal({ status: pathMatched ? 405 : 404, code: pathMatched ? "METHOD_NOT_ALLOWED" : "NOT_FOUND" });
      const result = await matched.route.handler(rc, matched.params);
      const res = result instanceof Response ? result : await render(rc, result);
      status = res.status;
      return res;
    } catch (err) {
      if (err instanceof RedirectSignal) {
        status = 303;
        return redirect(rc, err.location);
      }
      const problem: Problem = err instanceof ProblemSignal ? err.problem : { status: 500, code: "INTERNAL_ERROR" };
      if (!(err instanceof ProblemSignal)) deps.log.error({ err, path: rel }, "web page error");
      const loc = err instanceof ProblemSignal ? gateRedirect(rc, problem) : null;
      if (loc) {
        status = 303;
        return redirect(rc, loc);
      }
      status = problem.status >= 400 && problem.status < 600 ? problem.status : 500;
      return render(rc, <ErrorPage rc={rc} problem={problem} />, status);
    } finally {
      inc("qtiauth_web_requests_total", { surface: surface.name, method: rc.method, status }, 1, "Web page requests");
      observe("qtiauth_web_render_seconds", (performance.now() - started) / 1000, { surface: surface.name }, undefined, "Web page render time");
    }
  });
  return app;
}
