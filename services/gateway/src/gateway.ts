import { SignJWT, jwtVerify } from "jose";
import {
  CAPTCHA_STRIKE_HEADER,
  IDENTITY_HEADER,
  PLAYER_TOKEN_HEADER,
  REQUEST_ID_HEADER,
  SESSION_CLEAR_HEADER,
  SESSION_SET_HEADER,
  checkPolicy,
  mintIdentityToken,
  type AuthMode,
  type IdentityClaims,
  type RoutePolicy,
} from "@qtiauth/auth-context";
import { ProblemError, clientIp, clientPort, inc, isProblemError, observe, ulid, type Logger } from "@qtiauth/common";
import { cookieScopeFor, expandPermissions, joinPath, type Config, type ResolvedSurface, type SurfaceName } from "@qtiauth/config";
import { normalizeEmailLike } from "./config-helpers.ts";
import type { Registry, CompiledRoute } from "./registry.ts";
import type { RateLimiter } from "./ratelimit.ts";
import type { Captcha } from "./captcha.ts";
import type { GeoIp } from "./geoip.ts";
import { BIND_FAILED_COOKIE, bindFailedCookie, clearSessionCookie, cookieName, parseCookies, sessionCookie, type SessionContext, type SessionResolver } from "./session.ts";
import type { AccessTokenClaims, AccessTokenVerifier } from "./tokens.ts";
import type { InternalKeys } from "./keys.ts";
import type { Bus } from "@qtiauth/bus";
import type { Valkey } from "@qtiauth/service-kit";
import { parseTraceparent, newTraceId, formatTraceparent } from "@qtiauth/service-kit";
import { hashToken, randomToken } from "@qtiauth/common";

export const DELEGATION_HEADER = "x-qtiauth-delegation";
export const SURFACE_ORIGIN_HEADER = "x-qtiauth-surface-origin";
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const STRIP_RESPONSE = new Set([SESSION_SET_HEADER, SESSION_CLEAR_HEADER, CAPTCHA_STRIKE_HEADER, "connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"]);
const FORWARD_REQUEST = ["content-type", "accept", "accept-language", "user-agent", "if-none-match", "if-match", "if-modified-since", "range"];

export interface GatewayDeps {
  cfg: Config;
  surfaces: Record<SurfaceName, ResolvedSurface>;
  log: Logger;
  bus: Bus;
  valkey: Valkey;
  registry: Registry;
  limiter: RateLimiter;
  captcha: Captcha;
  geoip: GeoIp;
  sessions: SessionResolver;
  tokens: AccessTokenVerifier;
  keys: InternalKeys;
  meta: (req: MetaRequest) => Promise<Response | null>;
}

export interface MetaRequest {
  internalPath: string;
  surface: ResolvedSurface;
  request: Request;
  claims: IdentityClaims;
  session: SessionContext | null;
}

interface Ctx {
  rid: string;
  started: number;
  req: Request;
  url: URL;
  ip: string;
  port: number | null;
  country: string | null;
  ua: string | null;
  locale: string | null;
  origin: string | null;
  surface: ResolvedSurface | null;
  internal: boolean;
  traceId: string;
  responseHeaders: Headers;
  routeLabel: string;
}

interface Match {
  kind: "api" | "root" | "web" | "bind" | "bind_callback";
  surface: ResolvedSurface;
  internalPath: string;
  route?: CompiledRoute;
  params?: Record<string, string>;
}

export class Gateway {
  private readonly d: GatewayDeps;
  private readonly credentialedOrigins: Set<string>;
  private readonly publicOrigins: Set<string>;
  private readonly delegationKey: Uint8Array;

  constructor(deps: GatewayDeps) {
    this.d = deps;
    this.credentialedOrigins = new Set(Object.values(deps.surfaces).flatMap((s) => s.origins));
    this.publicOrigins = new Set(deps.cfg.cors.allowed_origins.map((o) => o.replace(/\/$/, "")));
    const secret = deps.cfg.secrets.key_encryption_key ?? deps.cfg.secrets.app_encryption_key ?? randomToken(32);
    this.delegationKey = new TextEncoder().encode(hashToken(`qtiauth-delegation:${secret}`));
  }

  private surfacesFor(host: string, port: number): ResolvedSurface[] {
    const h = host.toLowerCase();
    const hostname = h.replace(/:\d+$/, "");
    const out: ResolvedSurface[] = [];
    for (const s of Object.values(this.d.surfaces)) {
      if (s.hosts.includes(h) || s.hosts.includes(hostname) || s.ports.includes(port)) out.push(s);
      else if (!s.hosts.length && !s.ports.length && s.origins.some((o) => new URL(o).host === h)) out.push(s);
    }
    return out.sort((a, b) => b.basePath.length - a.basePath.length);
  }

  private mounted(route: CompiledRoute, surface: ResolvedSurface): boolean {
    if (route.module === "core" || route.module === "meta") return true;
    return surface.modules.includes(route.module as never);
  }

  private resolve(method: string, path: string, candidates: ResolvedSurface[]): Match | { methodNotAllowed: true } | null {
    let methodNotAllowed = false;
    for (const s of candidates) {
      const inApi = path === s.apiPath || path.startsWith(`${s.apiPath}/`);
      if (inApi) {
        const internalPath = `/api${path.slice(s.apiPath.length)}` || "/api";
        if (internalPath.startsWith("/api/v1/meta/") || internalPath === "/api/v1/openapi.json") return { kind: "api", surface: s, internalPath };
        const m = this.d.registry.match(method, internalPath);
        if (m && "route" in m && m.route.mount === "api" && this.mounted(m.route, s)) return { kind: "api", surface: s, internalPath, route: m.route, params: m.params };
        if (m && "methodNotAllowed" in m) methodNotAllowed = true;
      }
    }
    for (const s of candidates) {
      if (s.name !== "api") continue;
      const rel = s.basePath === "/" ? path : path.startsWith(`${s.basePath}/`) ? path.slice(s.basePath.length) : null;
      if (!rel || !(rel.startsWith("/oauth/") || rel.startsWith("/.well-known/"))) continue;
      const m = this.d.registry.match(method, rel);
      if (m && "route" in m && m.route.mount === "root") return { kind: "root", surface: s, internalPath: rel, route: m.route, params: m.params };
      if (m && "methodNotAllowed" in m) methodNotAllowed = true;
    }
    for (const s of candidates) {
      if (s.name === "api") continue;
      const within = s.basePath === "/" || path === s.basePath || path.startsWith(`${s.basePath}/`);
      if (!within) continue;
      const rel = s.basePath === "/" ? path : path.slice(s.basePath.length) || "/";
      if (rel === "/auth/bind" && method === "GET") return { kind: "bind", surface: s, internalPath: rel };
      if (rel === "/auth/bind/callback" && method === "GET") return { kind: "bind_callback", surface: s, internalPath: rel };
      if (rel.startsWith("/api/") || rel === "/api") continue;
      return { kind: "web", surface: s, internalPath: path };
    }
    return methodNotAllowed ? { methodNotAllowed: true } : null;
  }

  async handle(req: Request, peer: string | undefined, port: number, internal: boolean, peerPort?: number): Promise<Response> {
    const url = new URL(req.url);
    const ctx: Ctx = {
      rid: ulid(),
      started: performance.now(),
      req,
      url,
      ip: "0.0.0.0",
      port: null,
      country: null,
      ua: req.headers.get("user-agent"),
      locale: pickLocale(req.headers.get("accept-language"), this.d.cfg.branding.locales, this.d.cfg.branding.default_locale),
      origin: null,
      surface: null,
      internal,
      traceId: parseTraceparent(req.headers.get("traceparent"))?.traceId ?? newTraceId(),
      responseHeaders: new Headers(),
      routeLabel: "unmatched",
    };
    let status = 500;
    try {
      if (url.pathname === "/healthz") return new Response('{"status":"ok"}', { headers: { "content-type": "application/json" } });
      if (url.pathname === "/readyz") return this.readyz();
      if (await this.inMaintenance()) {
        if (!url.pathname.endsWith("/meta/health")) throw new ProblemError(503, "MAINTENANCE", undefined, {}, { "Retry-After": "60" });
      }
      let delegation: DelegationClaims | null = null;
      if (internal) {
        delegation = await this.readDelegation(req);
        ctx.ip = delegation?.ip ?? clientIp(peer, undefined, []);
        ctx.port = delegation ? (delegation.port ?? null) : null;
        ctx.ua = delegation?.ua ?? ctx.ua;
      } else {
        ctx.ip = clientIp(peer, req.headers.get("x-forwarded-for") ?? undefined, this.d.cfg.network.trusted_proxies);
        const portHeader = this.d.cfg.network.client_port_header;
        ctx.port = clientPort(peer, peerPort, portHeader ? req.headers.get(portHeader) : null, this.d.cfg.network.trusted_proxies);
      }
      ctx.country = delegation?.country ?? this.d.geoip.country(ctx.ip, req.headers);
      const host = internal && req.headers.get(SURFACE_ORIGIN_HEADER) ? new URL(req.headers.get(SURFACE_ORIGIN_HEADER)!).host : (req.headers.get("host") ?? url.host);
      const listenPort = internal && req.headers.get(SURFACE_ORIGIN_HEADER) ? Number(new URL(req.headers.get(SURFACE_ORIGIN_HEADER)!).port || 0) : port;
      const candidates = this.surfacesFor(host, listenPort);
      if (!candidates.length) throw new ProblemError(404, "UNKNOWN_SURFACE");
      const origin = req.headers.get("origin");
      if (req.method === "OPTIONS" && origin) return this.preflight(origin, req);
      const match = this.resolve(req.method === "HEAD" ? "GET" : req.method, url.pathname, candidates);
      if (!match) throw new ProblemError(404, "ROUTE_NOT_FOUND");
      if ("methodNotAllowed" in match) throw new ProblemError(405, "METHOD_NOT_ALLOWED");
      ctx.surface = match.surface;
      ctx.origin = match.surface.origins.includes(`${match.surface.scheme}://${host}`) ? `${match.surface.scheme}://${host}` : match.surface.origin;
      ctx.routeLabel = match.route?.path ?? (match.kind === "web" ? "web" : match.internalPath);
      const res = await this.dispatch(ctx, match, delegation);
      status = res.status;
      return this.finish(ctx, res);
    } catch (err) {
      const problem = isProblemError(err) ? err : new ProblemError(500, "INTERNAL_ERROR");
      if (!isProblemError(err)) this.d.log.error({ err, rid: ctx.rid }, "gateway error");
      status = problem.status;
      const body = problem.toProblem(url.pathname);
      const res = new Response(JSON.stringify(body), { status: problem.status, headers: { "content-type": "application/problem+json", ...problem.headers } });
      return this.finish(ctx, res);
    } finally {
      const labels = { surface: ctx.surface?.name ?? "none", route: ctx.routeLabel, method: req.method, status };
      inc("qtiauth_gateway_requests_total", labels, 1, "Gateway requests");
      observe("qtiauth_gateway_request_seconds", (performance.now() - ctx.started) / 1000, { surface: labels.surface, route: labels.route, method: labels.method }, undefined, "Gateway request latency");
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len) observe("qtiauth_gateway_request_bytes", len, { surface: labels.surface }, [100, 1000, 10_000, 100_000, 1_000_000, 10_000_000], "Request body sizes");
    }
  }

  private async readyz(): Promise<Response> {
    const checks: Record<string, boolean> = { nats: this.d.bus.connected };
    try {
      await this.d.valkey.ping();
      checks.valkey = true;
    } catch {
      checks.valkey = false;
    }
    const ok = Object.values(checks).every(Boolean);
    return new Response(JSON.stringify({ status: ok ? "ready" : "not_ready", checks }), { status: ok ? 200 : 503, headers: { "content-type": "application/json" } });
  }

  private async inMaintenance(): Promise<boolean> {
    try {
      return (await this.d.valkey.get("qtiauth:maintenance")) !== null;
    } catch {
      return false;
    }
  }

  private preflight(origin: string, req: Request): Response {
    const h = new Headers();
    const allowCred = this.credentialedOrigins.has(origin);
    if (allowCred || this.publicOrigins.has(origin) || this.publicOrigins.has("*")) {
      h.set("access-control-allow-origin", allowCred || !this.publicOrigins.has("*") ? origin : "*");
      if (allowCred) h.set("access-control-allow-credentials", "true");
      h.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      h.set("access-control-allow-headers", req.headers.get("access-control-request-headers") ?? "content-type, authorization, x-qtiauth-player-token, x-qtiauth-captcha, x-request-id");
      h.set("access-control-max-age", "600");
      h.set("vary", "Origin");
    }
    return new Response(null, { status: 204, headers: h });
  }

  private corsHeaders(ctx: Ctx, h: Headers): void {
    const origin = ctx.req.headers.get("origin");
    if (!origin) return;
    if (this.credentialedOrigins.has(origin)) {
      h.set("access-control-allow-origin", origin);
      h.set("access-control-allow-credentials", "true");
    } else if (this.publicOrigins.has(origin)) {
      h.set("access-control-allow-origin", origin);
    } else if (this.publicOrigins.has("*")) {
      h.set("access-control-allow-origin", "*");
    }
    h.append("vary", "Origin");
    h.set("access-control-expose-headers", "ratelimit-limit, ratelimit-remaining, ratelimit-reset, retry-after, x-request-id, location");
  }

  private securityHeaders(ctx: Ctx, h: Headers, kind: "api" | "web"): void {
    h.set("x-content-type-options", "nosniff");
    h.set("referrer-policy", "strict-origin-when-cross-origin");
    h.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=(), browsing-topics=()");
    h.set("x-frame-options", "DENY");
    h.set("cross-origin-opener-policy", "same-origin");
    if (ctx.surface?.scheme === "https") h.set("strict-transport-security", "max-age=63072000; includeSubDomains");
    if (kind === "api") {
      h.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      if (!h.has("cache-control")) h.set("cache-control", "no-store");
    } else {
      const csp = h.get("content-security-policy");
      if (!csp) h.set("content-security-policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
      else if (!/frame-ancestors/.test(csp)) h.set("content-security-policy", `${csp}; frame-ancestors 'none'`);
    }
  }

  private finish(ctx: Ctx, res: Response): Response {
    const h = new Headers(res.headers);
    for (const [k, v] of ctx.responseHeaders) {
      if (k === "set-cookie") h.append(k, v);
      else h.set(k, v);
    }
    h.set(REQUEST_ID_HEADER, ctx.rid);
    this.corsHeaders(ctx, h);
    const isWeb = (h.get("content-type") ?? "").startsWith("text/html") || h.has("x-qtiauth-web");
    h.delete("x-qtiauth-web");
    this.securityHeaders(ctx, h, isWeb ? "web" : "api");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }

  private sessionToken(ctx: Ctx): string | null {
    if (ctx.internal) return null;
    return parseCookies(ctx.req.headers.get("cookie"))[cookieName(this.d.cfg)] || null;
  }

  private cookieScope(ctx: Ctx): string {
    return cookieScopeFor(this.d.cfg, new URL(ctx.origin ?? ctx.url.origin).host);
  }

  private async resolveSession(ctx: Ctx, delegation: DelegationClaims | null): Promise<{ session: SessionContext | null; clear: boolean }> {
    if (delegation) {
      if (!delegation.bh) return { session: null, clear: false };
      return { session: await this.resolveByHash(ctx, delegation.bh), clear: false };
    }
    const token = this.sessionToken(ctx);
    if (!token) return { session: null, clear: false };
    const session = await this.d.sessions
      .resolve(token, this.cookieScope(ctx), {
        ip: ctx.ip,
        port: ctx.port,
        country: ctx.country,
        ua: ctx.ua,
        tls: this.d.cfg.session_security.tls_fingerprint.header ? ctx.req.headers.get(this.d.cfg.session_security.tls_fingerprint.header) : null,
        client: clientSignals(ctx.req.headers, this.d.cfg.session_security.client_signal_headers),
      })
      .catch((err) => {
        if (isProblemError(err) && err.code === "SERVICE_NOT_RUNNING") throw new ProblemError(503, "IDENTITY_UNAVAILABLE");
        throw err;
      });
    return { session, clear: !session };
  }

  private async resolveByHash(ctx: Ctx, bindingHash: string): Promise<SessionContext | null> {
    return this.d.bus.request<SessionContext | null>(
      "identity.resolve_session",
      { token_hash: bindingHash, scope: this.cookieScope(ctx), ip: ctx.ip, port: ctx.port, country: ctx.country, ua: ctx.ua, tls: null, signals: {} },
      { timeoutMs: 5000 },
    );
  }

  private baseClaims(ctx: Ctx, htm: string, htu: string): IdentityClaims {
    const cookies = parseCookies(ctx.req.headers.get("cookie"));
    return {
      rid: ctx.rid,
      htm,
      htu,
      auth: "none",
      surface: ctx.surface?.name ?? null,
      origin: ctx.origin,
      ip: ctx.ip,
      port: ctx.port,
      country: ctx.country,
      ua: ctx.ua,
      locale: ctx.locale,
      perms: [],
      restrictions: [],
      amr: [],
      aal: 0,
      cookie_scope: ctx.surface ? this.cookieScope(ctx) : null,
      bind_attempted: cookies[BIND_FAILED_COOKIE] === "1",
      trace_id: ctx.traceId,
    };
  }

  private applySession(claims: IdentityClaims, s: SessionContext): void {
    claims.auth = "session";
    claims.sid = s.session_id;
    claims.principal = s.principal;
    if (s.user_id) claims.sub = s.user_id;
    if (s.guardian_id) claims.gid = s.guardian_id;
    if (s.state) claims.state = s.state;
    claims.perms = expandPermissions(s.grants, this.d.registry.permissions());
    claims.restrictions = s.restrictions;
    claims.age_band = s.age_band;
    claims.parental_controls = s.parental_controls;
    claims.amr = s.amr;
    claims.aal = s.aal;
    claims.auth_time = s.auth_time;
    if (s.step_up_at) claims.step_up_at = s.step_up_at;
    claims.pending_legal = s.pending_legal;
    claims.mfa_enrolment_required = s.mfa_enrolment_required;
    claims.force_username_reset = s.force_username_reset;
    claims.trust_level = s.trust_level as IdentityClaims["trust_level"];
    if (s.locale) claims.locale = s.locale;
  }

  private async applyUser(claims: IdentityClaims, userId: string): Promise<void> {
    const u = await this.d.sessions.userContext(userId).catch((err) => {
      if (isProblemError(err) && err.code === "SERVICE_NOT_RUNNING") throw new ProblemError(503, "IDENTITY_UNAVAILABLE");
      throw err;
    });
    if (!u || u.state === "deleted") throw new ProblemError(401, "INVALID_TOKEN");
    claims.sub = userId;
    claims.principal = "user";
    if (u.state) claims.state = u.state;
    claims.restrictions = u.restrictions;
    claims.age_band = u.age_band;
    claims.parental_controls = u.parental_controls;
    claims.pending_legal = u.pending_legal;
    if (u.locale) claims.locale = u.locale;
  }

  private credentialKind(ctx: Ctx, policy: RoutePolicy): { kind: AuthMode; bearer: string | null; player: string | null } {
    const authz = ctx.req.headers.get("authorization");
    const bearer = authz && /^bearer\s+/i.test(authz) ? authz.replace(/^bearer\s+/i, "").trim() : null;
    const player = ctx.req.headers.get(PLAYER_TOKEN_HEADER);
    if (player && bearer && policy.auth.includes("game_authoritative")) return { kind: "game_authoritative", bearer, player };
    if (bearer) {
      const claims = this.d.tokens.peek(bearer);
      return { kind: claims?.gty === "client_credentials" ? "service" : "oauth", bearer, player: null };
    }
    return { kind: "session", bearer: null, player: null };
  }

  private async authenticate(ctx: Ctx, match: Match, delegation: DelegationClaims | null): Promise<{ claims: IdentityClaims; clearCookie: boolean; session: SessionContext | null }> {
    const route = match.route!;
    const claims = this.baseClaims(ctx, ctx.req.method === "HEAD" ? "GET" : ctx.req.method, match.internalPath);
    const cred = this.credentialKind(ctx, route);
    const accepts = (m: AuthMode) => route.auth.includes(m);
    if (cred.kind === "game_authoritative") {
      const server = await this.d.tokens.verify(cred.bearer!, "service");
      const player = await this.d.tokens.verify(cred.player!, "player");
      if (server.gty !== "client_credentials" || server.ckd !== "game_server" || !server.gid) {
        inc("qtiauth_game_authority_rejections_total", { reason: "not_game_server" }, 1, "Game-authoritative rejections");
        throw new ProblemError(401, "GAME_SERVER_CREDENTIAL_REQUIRED");
      }
      if (player.gty === "client_credentials" || player.gid !== server.gid || player.ckd === "game_server" || !player.sub) {
        inc("qtiauth_game_authority_rejections_total", { reason: "game_mismatch" }, 1, "Game-authoritative rejections");
        throw new ProblemError(401, "PLAYER_TOKEN_GAME_MISMATCH");
      }
      claims.auth = "game_authoritative";
      claims.client_id = player.client_id;
      claims.server_client_id = server.client_id;
      claims.game_id = server.gid;
      claims.scopes = [...new Set([...(server.scope ?? "").split(" "), ...(player.scope ?? "").split(" ")].filter(Boolean))];
      claims.token_jti = player.jti;
      claims.amr = player.amr ?? [];
      claims.aal = 1;
      await this.applyUser(claims, player.sub);
      return { claims, clearCookie: false, session: null };
    }
    if (cred.kind === "oauth" || cred.kind === "service") {
      if (!accepts(cred.kind)) {
        if (accepts("none") && !accepts("session")) return { claims, clearCookie: false, session: null };
        throw new ProblemError(401, "WRONG_CREDENTIAL_TYPE", `This route does not accept ${cred.kind} credentials`);
      }
      const t: AccessTokenClaims = await this.d.tokens.verify(cred.bearer!, cred.kind);
      claims.auth = cred.kind;
      claims.client_id = t.client_id;
      claims.scopes = (t.scope ?? "").split(" ").filter(Boolean);
      claims.token_jti = t.jti;
      if (t.gid) claims.game_id = t.gid;
      if (cred.kind === "oauth") {
        if (!t.sub || t.gty === "client_credentials") throw new ProblemError(401, "INVALID_TOKEN");
        claims.amr = t.amr ?? [];
        claims.aal = (t.acr === "aal2" ? 2 : 1) as 1 | 2;
        if (t.auth_time) claims.auth_time = t.auth_time;
        await this.applyUser(claims, t.sub);
      }
      return { claims, clearCookie: false, session: null };
    }
    if (!accepts("session") && !route.session_optional) return { claims, clearCookie: false, session: null };
    const { session, clear } = await this.resolveSession(ctx, delegation);
    if (session) this.applySession(claims, session);
    return { claims, clearCookie: clear, session };
  }

  private checkOrigin(ctx: Ctx, usesSession: boolean, hasCookie: boolean): void {
    if (ctx.internal || !UNSAFE.has(ctx.req.method) || !usesSession) return;
    const origin = ctx.req.headers.get("origin") ?? refererOrigin(ctx.req.headers.get("referer"));
    if (origin) {
      if (!this.credentialedOrigins.has(origin)) throw new ProblemError(403, "CSRF_ORIGIN_MISMATCH");
      return;
    }
    if (hasCookie) throw new ProblemError(403, "CSRF_ORIGIN_MISSING");
  }

  private rateSubject(dim: string, ctx: Ctx, claims: IdentityClaims, route: CompiledRoute, body: Record<string, unknown> | null, params: Record<string, string>): string {
    const keys = route.rate_limit_keys ?? {};
    const field = (name: string | undefined) => (name && body && typeof body[name] === "string" ? String(body[name]).trim().toLowerCase().slice(0, 254) : null);
    switch (dim) {
      case "ip":
        return `ip:${ctx.ip}`;
      case "account": {
        const v = field(keys.account) ?? field(keys.email);
        return v ? `acct:${normalizeEmailLike(this.d.cfg, v)}` : `ip:${ctx.ip}`;
      }
      case "email": {
        const v = field(keys.email);
        return v ? `email:${normalizeEmailLike(this.d.cfg, v)}` : `ip:${ctx.ip}`;
      }
      case "user":
        return claims.sub ? `user:${claims.sub}` : `ip:${ctx.ip}`;
      case "client":
        return claims.client_id ? `client:${claims.client_id}` : field("client_id") ? `client:${field("client_id")}` : `ip:${ctx.ip}`;
      case "session":
        return claims.sid ? `sid:${claims.sid}` : `ip:${ctx.ip}`;
      case "game":
        return claims.game_id ? `game:${claims.game_id}` : params.slug ? `game:${params.slug}` : `ip:${ctx.ip}`;
      case "app": {
        const v = keys.app && body ? String(body[keys.app] ?? "") : "";
        return v ? `app:${v}` : `ip:${ctx.ip}`;
      }
      default:
        return `ip:${ctx.ip}`;
    }
  }

  private async rateLimit(ctx: Ctx, claims: IdentityClaims, route: CompiledRoute | null, body: Record<string, unknown> | null, params: Record<string, string>): Promise<{ captchaNeeded: boolean }> {
    const cfg = this.d.cfg.rate_limits;
    const checks: { name: string; subject: string }[] = [];
    if (cfg.global) checks.push({ name: "global", subject: `ip:${ctx.ip}` });
    for (const name of route?.rate_limit ?? []) {
      const p = cfg[name];
      if (!p) continue;
      const dims = Array.isArray(p.per) ? p.per : [p.per];
      for (const dim of dims) checks.push({ name, subject: route ? this.rateSubject(dim, ctx, claims, route, body, params) : `ip:${ctx.ip}` });
    }
    let captchaNeeded = false;
    let tightest: { limit: number; remaining: number; resetMs: number } | null = null;
    for (const c of checks) {
      const policy = cfg[c.name]!;
      const r = await this.d.limiter.check(c.name, policy, c.subject);
      if (!tightest || r.remaining < tightest.remaining) tightest = { limit: r.limit, remaining: r.remaining, resetMs: r.resetMs };
      if (!r.allowed) {
        const retry = Math.max(1, Math.ceil(r.resetMs / 1000));
        ctx.responseHeaders.set("ratelimit-limit", String(r.limit));
        ctx.responseHeaders.set("ratelimit-remaining", "0");
        ctx.responseHeaders.set("ratelimit-reset", String(retry));
        ctx.responseHeaders.set("ratelimit-policy", `${r.limit};w=${Math.round(policy.window / 1000)}`);
        throw new ProblemError(429, "RATE_LIMITED", undefined, { policy: c.name, retry_after: retry }, { "Retry-After": String(retry) });
      }
      if (policy.captcha_after && r.count > policy.captcha_after) captchaNeeded = true;
    }
    if (tightest) {
      ctx.responseHeaders.set("ratelimit-limit", String(tightest.limit));
      ctx.responseHeaders.set("ratelimit-remaining", String(tightest.remaining));
      ctx.responseHeaders.set("ratelimit-reset", String(Math.max(1, Math.ceil(tightest.resetMs / 1000))));
    }
    return { captchaNeeded };
  }

  private strikeKeys(ctx: Ctx, route: CompiledRoute, body: Record<string, unknown> | null): string[] {
    const keys = [`gw:strike:${route.operation_id}:ip:${ctx.ip}`];
    const acct = route.rate_limit_keys?.account ?? route.rate_limit_keys?.email;
    if (acct && body && typeof body[acct] === "string") keys.push(`gw:strike:${route.operation_id}:acct:${normalizeEmailLike(this.d.cfg, String(body[acct]))}`);
    return keys;
  }

  private strikeThreshold(route: CompiledRoute): number {
    let t = 3;
    for (const name of route.rate_limit) {
      const p = this.d.cfg.rate_limits[name];
      if (p?.captcha_after) t = Math.min(t, p.captcha_after);
    }
    return t;
  }

  private async strikesExceeded(ctx: Ctx, route: CompiledRoute, body: Record<string, unknown> | null): Promise<boolean> {
    try {
      const values = await this.d.valkey.mget(...this.strikeKeys(ctx, route, body));
      return values.some((v) => Number(v ?? 0) >= this.strikeThreshold(route));
    } catch {
      return false;
    }
  }

  private async recordStrike(ctx: Ctx, route: CompiledRoute, body: Record<string, unknown> | null): Promise<void> {
    try {
      const m = this.d.valkey.multi();
      for (const k of this.strikeKeys(ctx, route, body)) m.incr(k).pexpire(k, 15 * 60_000);
      await m.exec();
    } catch {
      return;
    }
  }

  private async dispatch(ctx: Ctx, match: Match, delegation: DelegationClaims | null): Promise<Response> {
    if (match.kind === "bind") return this.bindStart(ctx, match);
    if (match.kind === "bind_callback") return this.bindCallback(ctx, match);
    if (match.kind === "web") return this.webProxy(ctx, match, delegation);
    if (!match.route) {
      const claims = this.baseClaims(ctx, ctx.req.method, match.internalPath);
      await this.rateLimit(ctx, claims, null, null, {});
      const { session } = await this.resolveSession(ctx, delegation).catch(() => ({ session: null, clear: false }));
      if (session) this.applySession(claims, session);
      const res = await this.d.meta({ internalPath: match.internalPath, surface: match.surface, request: ctx.req, claims, session });
      if (!res) throw new ProblemError(404, "ROUTE_NOT_FOUND");
      return res;
    }
    const route = match.route;
    const hasCookie = Boolean(this.sessionToken(ctx));
    const usesSession = route.auth.includes("session") || route.session_optional;
    this.checkOrigin(ctx, usesSession, hasCookie);

    let raw: ArrayBuffer | null = null;
    let body: Record<string, unknown> | null = null;
    if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") {
      const len = Number(ctx.req.headers.get("content-length") ?? 0);
      if (len > route.body_limit) throw new ProblemError(413, "PAYLOAD_TOO_LARGE");
      raw = await ctx.req.arrayBuffer();
      if (raw.byteLength > route.body_limit) throw new ProblemError(413, "PAYLOAD_TOO_LARGE");
      if (!route.raw_body && (ctx.req.headers.get("content-type") ?? "").includes("application/json") && raw.byteLength) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
        } catch {
          throw new ProblemError(400, "INVALID_JSON");
        }
      } else if ((ctx.req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded") && raw.byteLength) {
        body = Object.fromEntries(new URLSearchParams(new TextDecoder().decode(raw)));
      }
    }

    const { claims, clearCookie } = await this.authenticate(ctx, match, delegation);
    if (clearCookie) ctx.responseHeaders.append("set-cookie", clearSessionCookie(this.d.cfg));
    const { captchaNeeded } = await this.rateLimit(ctx, claims, route, body, match.params ?? {});

    if (route.captcha && this.d.captcha.enabled && (captchaNeeded || (await this.strikesExceeded(ctx, route, body)))) {
      const solution = ctx.req.headers.get("x-qtiauth-captcha") ?? (typeof body?.captcha === "string" ? body.captcha : null);
      inc("qtiauth_captcha_total", { provider: this.d.captcha.info().provider, result: "shown" }, 1, "CAPTCHA verifications");
      if (!(await this.d.captcha.verify(solution, ctx.ip))) {
        throw new ProblemError(403, solution ? "CAPTCHA_FAILED" : "CAPTCHA_REQUIRED", undefined, { captcha: this.d.captcha.info(), challenge: await this.d.captcha.challenge() });
      }
    }

    checkPolicy(route, claims, { stepUpWindowMs: this.d.cfg.security.step_up_window });
    if (route.step_up) inc("qtiauth_step_up_prompts_total", { method: "required", result: "passed" }, 1, "Step-up attempts");

    const instance = this.d.registry.pick(route.service);
    if (!instance) throw new ProblemError(503, "SERVICE_UNAVAILABLE", `${route.service} is not running`);
    const token = await mintIdentityToken(this.d.keys.signing(), claims);
    const headers = new Headers();
    for (const h of FORWARD_REQUEST) {
      const v = ctx.req.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set(IDENTITY_HEADER, token);
    headers.set(REQUEST_ID_HEADER, ctx.rid);
    headers.set("traceparent", formatTraceparent({ traceId: ctx.traceId, spanId: ctx.rid.slice(-16).toLowerCase().replace(/[^0-9a-f]/g, "0").padStart(16, "0"), sampled: true }));
    const upstreamUrl = `${instance.baseUrl}${match.internalPath}${ctx.url.search}`;
    const started = performance.now();
    let upstream: Response;
    try {
      upstream = await fetch(upstreamUrl, {
        method: ctx.req.method,
        headers,
        body: raw && raw.byteLength ? raw : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(route.raw_body ? 120_000 : 30_000),
      });
    } catch (err) {
      inc("qtiauth_gateway_upstream_errors_total", { service: route.service }, 1, "Upstream errors per service");
      this.d.log.warn({ err: (err as Error).message, service: route.service }, "upstream request failed");
      throw new ProblemError(502, "UPSTREAM_ERROR");
    }
    observe("qtiauth_gateway_upstream_seconds", (performance.now() - started) / 1000, { service: route.service }, undefined, "Upstream latency");
    if (upstream.status >= 500) inc("qtiauth_gateway_upstream_errors_total", { service: route.service }, 1, "Upstream errors per service");
    if (upstream.headers.get(CAPTCHA_STRIKE_HEADER)) await this.recordStrike(ctx, route, body);
    if (route.service === "identity" && UNSAFE.has(ctx.req.method) && upstream.status < 400) {
      if (claims.sid) await this.d.sessions.bustSession(claims.sid);
      if (claims.sub) await this.d.sessions.bustUser(claims.sub);
    }
    return this.transformResponse(ctx, upstream);
  }

  private transformResponse(ctx: Ctx, upstream: Response): Response {
    const h = new Headers();
    for (const [k, v] of upstream.headers) {
      if (STRIP_RESPONSE.has(k)) continue;
      if (k === "set-cookie") continue;
      h.append(k, v);
    }
    const set = upstream.headers.get(SESSION_SET_HEADER);
    const clear = upstream.headers.get(SESSION_CLEAR_HEADER);
    if (ctx.internal) {
      if (set) h.set(SESSION_SET_HEADER, set);
      if (clear) h.set(SESSION_CLEAR_HEADER, clear);
    } else {
      if (set) {
        h.append("set-cookie", sessionCookie(this.d.cfg, set, Math.floor(this.d.cfg.cookies.session_ttl / 1000)));
        h.append("set-cookie", bindFailedCookie(this.d.cfg, false));
      } else if (clear) {
        h.append("set-cookie", clearSessionCookie(this.d.cfg));
      }
    }
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: h });
  }

  private async webProxy(ctx: Ctx, match: Match, delegation: DelegationClaims | null): Promise<Response> {
    const instance = this.d.registry.pick("web");
    if (!instance) throw new ProblemError(503, "WEB_UNAVAILABLE");
    const hasCookie = Boolean(this.sessionToken(ctx));
    if (UNSAFE.has(ctx.req.method)) this.checkOrigin(ctx, true, hasCookie);
    const claims = this.baseClaims(ctx, ctx.req.method === "HEAD" ? "GET" : ctx.req.method, match.internalPath);
    const rel = match.surface.basePath === "/" ? match.internalPath : match.internalPath.slice(match.surface.basePath.length);
    const isAsset = ctx.req.method === "GET" && (rel.startsWith("/assets/") || rel.startsWith("/branding/") || rel === "/favicon.ico" || rel === "/robots.txt");
    if (!isAsset) await this.rateLimit(ctx, claims, null, null, {});
    let session: SessionContext | null = null;
    try {
      const r = await this.resolveSession(ctx, delegation);
      session = r.session;
      if (r.clear) ctx.responseHeaders.append("set-cookie", clearSessionCookie(this.d.cfg));
    } catch (err) {
      this.d.log.warn({ err: (err as Error).message }, "session resolution failed for web request");
    }
    if (session) this.applySession(claims, session);
    const token = await mintIdentityToken(this.d.keys.signing(), claims);
    const headers = new Headers();
    for (const h of [...FORWARD_REQUEST, "content-type"]) {
      const v = ctx.req.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set(IDENTITY_HEADER, token);
    headers.set(REQUEST_ID_HEADER, ctx.rid);
    headers.set("x-qtiauth-surface", match.surface.name);
    headers.set(SURFACE_ORIGIN_HEADER, ctx.origin ?? match.surface.origin);
    const token2 = this.sessionToken(ctx);
    headers.set(DELEGATION_HEADER, await this.mintDelegation(ctx, token2 ? hashToken(token2) : null));
    let raw: ArrayBuffer | undefined;
    if (ctx.req.method !== "GET" && ctx.req.method !== "HEAD") {
      raw = await ctx.req.arrayBuffer();
      if (raw.byteLength > 1_000_000) throw new ProblemError(413, "PAYLOAD_TOO_LARGE");
    }
    let upstream: Response;
    try {
      upstream = await fetch(`${instance.baseUrl}${match.internalPath}${ctx.url.search}`, { method: ctx.req.method, headers, body: raw, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    } catch {
      inc("qtiauth_gateway_upstream_errors_total", { service: "web" }, 1, "Upstream errors per service");
      throw new ProblemError(502, "UPSTREAM_ERROR");
    }
    const res = this.transformResponse(ctx, upstream);
    const h = new Headers(res.headers);
    h.set("x-qtiauth-web", "1");
    return new Response(res.body, { status: res.status, headers: h });
  }

  private async mintDelegation(ctx: Ctx, bindingHash: string | null): Promise<string> {
    return new SignJWT({ bh: bindingHash, ip: ctx.ip, port: ctx.port, ua: ctx.ua, country: ctx.country, origin: ctx.origin })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("60s")
      .setAudience("qtiauth-delegation")
      .sign(this.delegationKey);
  }

  private async readDelegation(req: Request): Promise<DelegationClaims | null> {
    const t = req.headers.get(DELEGATION_HEADER);
    if (!t) return null;
    try {
      const { payload } = await jwtVerify(t, this.delegationKey, { audience: "qtiauth-delegation", algorithms: ["HS256"] });
      return payload as unknown as DelegationClaims;
    } catch {
      throw new ProblemError(401, "INVALID_DELEGATION");
    }
  }

  private async bindStart(ctx: Ctx, match: Match): Promise<Response> {
    const account = this.d.surfaces.account;
    if (match.surface.name !== "account") return redirect(`${account.url}/auth/bind${ctx.url.search}`);
    const target = ctx.url.searchParams.get("target") as SurfaceName | null;
    const returnPath = safePath(ctx.url.searchParams.get("return"));
    const targetSurface = target ? this.d.surfaces[target] : null;
    if (!targetSurface) throw new ProblemError(400, "UNKNOWN_SURFACE");
    const targetOrigin = ctx.url.searchParams.get("origin") && targetSurface.origins.includes(ctx.url.searchParams.get("origin")!) ? ctx.url.searchParams.get("origin")! : targetSurface.origin;
    await this.rateLimit(ctx, this.baseClaims(ctx, "GET", "/auth/bind"), null, null, {});
    const token = this.sessionToken(ctx);
    const loginUrl = `${joinPath(account.basePath, "/login")}?return=${encodeURIComponent(`${ctx.url.pathname}${ctx.url.search}`)}`;
    if (!token) return redirect(loginUrl);
    const r = await this.d.bus.request<{ code: string } | null>("identity.create_binding_code", { token_hash: hashToken(token), target_origin: targetOrigin, return_path: returnPath }, { timeoutMs: 5000 });
    if (!r) return redirect(loginUrl);
    const callbackBase = targetOrigin + (targetSurface.basePath === "/" ? "" : targetSurface.basePath);
    return redirect(`${callbackBase}/auth/bind/callback?code=${encodeURIComponent(r.code)}`);
  }

  private async bindCallback(ctx: Ctx, match: Match): Promise<Response> {
    const code = ctx.url.searchParams.get("code") ?? "";
    await this.rateLimit(ctx, this.baseClaims(ctx, "GET", "/auth/bind/callback"), null, null, {});
    const origin = ctx.origin ?? match.surface.origin;
    const r = code ? await this.d.bus.request<{ token: string; return_path: string } | null>("identity.exchange_binding_code", { code, origin, scope: this.cookieScope(ctx) }, { timeoutMs: 5000 }) : null;
    const base = match.surface.basePath === "/" ? "" : match.surface.basePath;
    if (!r) {
      const res = redirect(`${base}/`);
      res.headers.append("set-cookie", bindFailedCookie(this.d.cfg, true));
      return res;
    }
    const res = redirect(safePath(r.return_path) === "/" ? `${base}/` : safePath(r.return_path));
    res.headers.append("set-cookie", sessionCookie(this.d.cfg, r.token, Math.floor(this.d.cfg.cookies.session_ttl / 1000)));
    res.headers.append("set-cookie", bindFailedCookie(this.d.cfg, false));
    return res;
  }
}

interface DelegationClaims {
  bh: string | null;
  ip: string;
  port?: number | null;
  ua: string | null;
  country: string | null;
  origin: string | null;
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

function safePath(p: string | null): string {
  if (!p || !p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return "/";
  return p.slice(0, 1024);
}

function refererOrigin(ref: string | null): string | null {
  if (!ref) return null;
  try {
    return new URL(ref).origin;
  } catch {
    return null;
  }
}

function clientSignals(h: Headers, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = h.get(n);
    if (v) out[n] = v.slice(0, 128);
  }
  return out;
}

export function pickLocale(header: string | null, supported: string[], fallback: string): string {
  if (!header) return fallback;
  const prefs = header
    .split(",")
    .map((p) => {
      const [tag, q] = p.trim().split(";q=");
      return { tag: tag!.trim(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const p of prefs) {
    const exact = supported.find((s) => s.toLowerCase() === p.tag.toLowerCase());
    if (exact) return exact;
    const lang = supported.find((s) => s.split("-")[0]!.toLowerCase() === p.tag.split("-")[0]!.toLowerCase());
    if (lang) return lang;
  }
  return fallback;
}

