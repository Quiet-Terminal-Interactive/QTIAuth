import { surfacePairs, externalApiPath, joinPath, issuer, type Config, type ResolvedSurface, type SurfaceName } from "@qtiauth/config";
import type { Bus } from "@qtiauth/bus";
import type { Valkey } from "@qtiauth/service-kit";
import type { Logger } from "@qtiauth/common";
import type { Registry } from "./registry.ts";
import type { Captcha } from "./captcha.ts";
import type { GeoIp } from "./geoip.ts";
import type { MetaRequest } from "./gateway.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const SUBFEATURE_OWNERS: { path: string; service: string; on: (c: Config) => boolean }[] = [
  { path: "features.games.licensing", service: "games", on: (c) => c.features.games.licensing.enabled },
  { path: "features.games.steam", service: "games", on: (c) => c.features.games.steam.enabled },
  { path: "features.games.leaderboards", service: "games", on: (c) => c.features.games.leaderboards.enabled },
  { path: "features.games.playtime", service: "games", on: (c) => c.features.games.playtime.enabled },
  { path: "features.games.cloud_saves", service: "games", on: (c) => c.features.games.cloud_saves.enabled },
  { path: "features.games.keys", service: "games", on: (c) => c.features.games.keys.enabled },
  { path: "features.support.tickets", service: "support", on: (c) => c.features.support.tickets.enabled },
  { path: "features.support.kb", service: "support", on: (c) => c.features.support.kb.enabled },
  { path: "features.support.guest_tickets", service: "support", on: (c) => c.features.support.guest_tickets.enabled },
  { path: "features.support.attachments", service: "support", on: (c) => c.features.support.attachments.enabled },
  { path: "features.oidc.developer_portal", service: "oidc", on: (c) => c.features.oidc.developer_portal.enabled },
  { path: "features.oidc.backchannel_logout", service: "oidc", on: (c) => c.features.oidc.backchannel_logout.enabled },
];

const MODULE_SERVICE: Record<string, string> = { identity: "identity", oidc: "oidc", games: "games", safety: "safety", support: "support", admin: "identity" };

export interface MetaDeps {
  cfg: Config;
  surfaces: Record<SurfaceName, ResolvedSurface>;
  registry: Registry;
  captcha: Captcha;
  geoip: GeoIp;
  bus: Bus;
  valkey: Valkey;
  log: Logger;
}

export class Meta {
  private readonly d: MetaDeps;
  private openapiCache: { at: number; docs: Map<string, Record<string, unknown>> } = { at: 0, docs: new Map() };

  constructor(d: MetaDeps) {
    this.d = d;
    d.registry.onChange(() => {
      this.openapiCache.at = 0;
    });
  }

  consistencyErrors(): { code: string; severity: "error"; message: string }[] {
    if (Date.now() - this.d.registry.startedAt < 60_000) return [];
    const running = new Set(this.d.registry.running());
    return SUBFEATURE_OWNERS.filter((s) => s.on(this.d.cfg) && !running.has(s.service)).map((s) => ({
      code: "SUBFEATURE_SERVICE_MISSING",
      severity: "error" as const,
      message: `${s.path} is enabled but the ${s.service} service is not running (enable the "${s.service}" Compose profile or turn the feature off).`,
    }));
  }

  async handle(req: MetaRequest): Promise<Response | null> {
    switch (req.internalPath) {
      case "/api/v1/meta/features":
        return json(this.features(req.surface), 200, { "cache-control": "public, max-age=30" });
      case "/api/v1/meta/health":
        return json(await this.health(req.claims.perms.includes("system.health.read")));
      case "/api/v1/meta/captcha/challenge":
        return json(await this.d.captcha.challenge(), 200, { "cache-control": "no-store" });
      case "/api/v1/openapi.json":
        return json(await this.openapi(req.surface), 200, { "cache-control": "public, max-age=60" });
      default:
        return null;
    }
  }

  features(current: ResolvedSurface): Record<string, unknown> {
    const cfg = this.d.cfg;
    const running = new Set(this.d.registry.running());
    const svcFeatures = new Set(this.d.registry.features());
    const surfaces = Object.fromEntries(
      Object.values(this.d.surfaces).map((s) => [
        s.name,
        {
          origin: s.origin,
          origins: s.origins,
          base_path: s.basePath,
          api_path: s.apiPath,
          url: s.url,
          modules: s.modules.filter((m) => running.has(MODULE_SERVICE[m] ?? m)),
        },
      ]),
    );
    const modules = Object.fromEntries(["identity", "oidc", "safety", "support", "games", "notifier"].map((m) => [m, running.has(m)]));
    const g = cfg.features.games;
    const sp = cfg.features.support;
    return {
      product: {
        name: cfg.branding.product_name,
        company: cfg.branding.company_name,
        support_email: cfg.branding.support_email,
        website_url: cfg.branding.website_url ?? null,
        footer_links: cfg.branding.footer_links,
      },
      branding: {
        colors: cfg.branding.colors,
        font_family: cfg.branding.font_family,
        heading_font_family: cfg.branding.heading_font_family ?? cfg.branding.font_family,
        border_radius: cfg.branding.border_radius,
        logo_url: joinPath(this.d.surfaces.account.basePath, "/branding/logo"),
        favicon_url: joinPath(this.d.surfaces.account.basePath, "/branding/favicon"),
      },
      locales: { default: cfg.branding.default_locale, available: cfg.branding.locales },
      current_surface: current.name,
      surfaces,
      same_site: surfacePairs(cfg),
      modules,
      auth: {
        password: cfg.features.auth.password.enabled,
        magic_link: cfg.features.auth.magic_link.enabled,
        passkeys: cfg.features.auth.passkeys.enabled,
        totp: cfg.features.auth.totp.enabled,
        social: [...svcFeatures].filter((f) => f.startsWith("auth.social.")).map((f) => f.slice("auth.social.".length)),
        password_policy: { min_length: cfg.password.min_length, max_length: cfg.password.max_length, composition: cfg.password.composition },
        session_security: cfg.features.session_security.enabled,
      },
      usernames: { min_length: cfg.usernames.min_length, max_length: cfg.usernames.max_length, charset: cfg.usernames.charset },
      age: { consent_age: cfg.parental.consent_age, min_signup_age: cfg.accounts.min_signup_age, boundaries: cfg.age.boundaries },
      captcha: this.d.captcha.info(),
      legal: { public_history: cfg.legal.public_history, required_at_signup: cfg.legal.required_at_signup },
      features: {
        data_export: cfg.features.data_export.enabled,
        developer_portal: running.has("oidc") && cfg.features.oidc.developer_portal.enabled,
        device_flow: running.has("oidc") && cfg.features.oidc.device_flow.enabled,
        games: running.has("games")
          ? { licensing: g.licensing.enabled, steam: g.steam.enabled, leaderboards: g.leaderboards.enabled, playtime: g.playtime.enabled, cloud_saves: g.cloud_saves.enabled, keys: g.keys.enabled }
          : null,
        support: running.has("support") ? { tickets: sp.tickets.enabled, kb: sp.kb.enabled, guest_tickets: sp.guest_tickets.enabled, attachments: sp.attachments.enabled } : null,
        safety: running.has("safety"),
      },
      oidc: running.has("oidc") ? { issuer: issuer(cfg), discovery: `${issuer(cfg)}/.well-known/openid-configuration` } : null,
    };
  }

  async health(detailed: boolean): Promise<Record<string, unknown>> {
    const running = this.d.registry.running();
    const errors = this.consistencyErrors();
    const warnings: { code: string; severity: string; message: string }[] = [...errors];
    if (this.d.geoip.status === "missing") warnings.push({ code: "NO_GEOIP", severity: "warning", message: "GeoIP database not found; country checks are off." });
    if (this.d.geoip.status === "disabled") warnings.push({ code: "GEOIP_DISABLED", severity: "info", message: "GeoIP is disabled; country checks are off." });
    if (this.d.cfg.storage.provider === "none") warnings.push({ code: "NO_STORAGE", severity: "info", message: "No object storage configured: attachments, KB images, cloud saves and large exports are unavailable." });
    for (const p of surfacePairs(this.d.cfg)) {
      if (!p.same_site) warnings.push({ code: "CROSS_SITE_SURFACES", severity: "info", message: `${p.a} and ${p.b} are on different registrable domains; the frontend links between them instead of loading data inline.` });
    }
    let maintenance = false;
    try {
      maintenance = (await this.d.valkey.get("qtiauth:maintenance")) !== null;
    } catch {
      warnings.push({ code: "VALKEY_UNREACHABLE", severity: "error", message: "Valkey is unreachable." });
    }
    const status = maintenance ? "maintenance" : errors.length ? "degraded" : "ok";
    if (!detailed) return { status, services: running };
    const services: Record<string, unknown> = {};
    for (const svc of ["identity", "notifier", "oidc", "safety", "support", "games", "web"]) {
      const instances = this.d.registry.instancesOf(svc);
      if (!instances.length) {
        services[svc] = { running: false };
        continue;
      }
      try {
        const h = await this.d.bus.request<{ ready: boolean; checks: Record<string, boolean>; warnings: { code: string; severity: string; message: string }[] }>(`${svc}.health`, {}, { timeoutMs: 2000 });
        services[svc] = { running: true, instances: instances.length, version: instances[0]!.version, ...h };
        for (const w of h.warnings ?? []) warnings.push({ ...w, code: `${svc.toUpperCase()}_${w.code}` });
      } catch {
        services[svc] = { running: true, instances: instances.length, ready: false, error: "health check failed" };
      }
    }
    let bus: unknown = null;
    try {
      bus = await this.d.bus.consumerLag();
    } catch {
      bus = null;
    }
    return { status, maintenance, services, warnings, bus, geoip: this.d.geoip.status, surfaces: surfacePairs(this.d.cfg) };
  }

  private async loadDocs(): Promise<Map<string, Record<string, unknown>>> {
    if (Date.now() - this.openapiCache.at < 60_000 && this.openapiCache.docs.size) return this.openapiCache.docs;
    const docs = new Map<string, Record<string, unknown>>();
    for (const svc of this.d.registry.running()) {
      const inst = this.d.registry.pick(svc);
      if (!inst || svc === "web") continue;
      try {
        const r = await fetch(`${inst.baseUrl}/openapi.json`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) docs.set(svc, (await r.json()) as Record<string, unknown>);
      } catch {
        continue;
      }
    }
    this.openapiCache = { at: Date.now(), docs };
    return docs;
  }

  async openapi(surface: ResolvedSurface): Promise<Record<string, unknown>> {
    const docs = await this.loadDocs();
    const routes = this.d.registry.allRoutes();
    const paths: Record<string, unknown> = {};
    const schemas: Record<string, unknown> = {};
    for (const [svc, doc] of docs) {
      for (const [p, ops] of Object.entries((doc.paths ?? {}) as Record<string, Record<string, unknown>>)) {
        const hono = p.replace(/\{([^}]+)\}/g, ":$1");
        for (const [method, op] of Object.entries(ops)) {
          const r = routes.find((x) => x.service === svc && x.path === hono && x.method.toLowerCase() === method);
          if (!r) continue;
          const mounted = r.module === "core" || r.module === "meta" || surface.modules.includes(r.module as never);
          if (!mounted) continue;
          let ext: string;
          if (r.mount === "root") {
            if (surface.name !== "api") continue;
            ext = surface.basePath === "/" ? p : surface.basePath + p;
          } else {
            ext = externalApiPath(surface, p);
          }
          paths[ext] = { ...((paths[ext] as Record<string, unknown>) ?? {}), [method]: op };
        }
      }
      Object.assign(schemas, ((doc.components as Record<string, unknown>)?.schemas as Record<string, unknown>) ?? {});
    }
    const metaBase = externalApiPath(surface, "/api/v1/meta");
    paths[`${metaBase}/features`] = { get: { operationId: "get_meta_features", summary: "Enabled modules, auth methods, surfaces and branding", tags: ["meta"], responses: { "200": { description: "Feature discovery" } } } };
    paths[`${metaBase}/health`] = { get: { operationId: "get_meta_health", summary: "Aggregate health (details need system.health.read)", tags: ["meta"], responses: { "200": { description: "Health" } } } };
    paths[`${metaBase}/captcha/challenge`] = { get: { operationId: "get_meta_captcha_challenge", summary: "A CAPTCHA challenge", tags: ["meta"], responses: { "200": { description: "Challenge" } } } };
    const anyDoc = [...docs.values()][0] as { components?: { securitySchemes?: unknown } } | undefined;
    return {
      openapi: "3.1.0",
      info: { title: `${this.d.cfg.branding.product_name} API`, version: "v1", description: "Generated by QTIAuth from the enabled services." },
      servers: [{ url: surface.origin }],
      paths,
      components: { schemas, securitySchemes: anyDoc?.components?.securitySchemes ?? {} },
    };
  }
}
