import { registrableDomain } from "@qtiauth/common";
import type { Config, ModuleName, SurfaceName } from "./schema.ts";
import { SURFACE_NAMES } from "./schema.ts";

const DEFAULT_MODULES: Record<SurfaceName, ModuleName[]> = {
  account: ["identity", "oidc", "games", "safety", "admin"],
  support: ["support"],
  api: ["identity", "oidc", "games", "safety", "admin", "support"],
};

export interface ResolvedSurface {
  name: SurfaceName;
  hosts: string[];
  ports: number[];
  basePath: string;
  apiPath: string;
  origins: string[];
  origin: string;
  url: string;
  modules: ModuleName[];
  scheme: "http" | "https";
}

export function joinPath(...parts: string[]): string {
  const joined = parts
    .filter((p) => p !== undefined && p !== "")
    .join("/")
    .replace(/\/{2,}/g, "/");
  const withLead = joined.startsWith("/") ? joined : `/${joined}`;
  return withLead.length > 1 ? withLead.replace(/\/$/, "") : withLead;
}

export function resolveSurfaces(cfg: Config): Record<SurfaceName, ResolvedSurface> {
  const out = {} as Record<SurfaceName, ResolvedSurface>;
  for (const name of SURFACE_NAMES) {
    const s = cfg.surfaces[name];
    const origins: string[] = [];
    if (s.public_origin) origins.push(new URL(s.public_origin).origin);
    for (const h of s.hosts) origins.push(`${s.scheme}://${h.toLowerCase()}`);
    for (const p of s.ports) {
      const defaultPort = (s.scheme === "https" && p === 443) || (s.scheme === "http" && p === 80);
      origins.push(`${s.scheme}://localhost${defaultPort ? "" : `:${p}`}`);
    }
    const unique = [...new Set(origins)];
    const origin = unique[0] ?? `${s.scheme}://localhost`;
    const apiPath = name === "api" ? (s.base_path === "/" ? "/api" : s.base_path) : joinPath(s.base_path, "api");
    out[name] = {
      name,
      hosts: s.hosts.map((h) => h.toLowerCase()),
      ports: s.ports,
      basePath: s.base_path,
      apiPath,
      origins: unique,
      origin,
      url: s.base_path === "/" ? origin : origin + s.base_path,
      modules: s.modules ?? DEFAULT_MODULES[name],
      scheme: s.scheme,
    };
  }
  return out;
}

export function externalApiPath(surface: ResolvedSurface, internalPath: string): string {
  return joinPath(surface.apiPath, internalPath.replace(/^\/api(?=\/|$)/, ""));
}

export function surfaceUrl(surface: ResolvedSurface, path: string): string {
  return surface.origin + joinPath(surface.basePath, path);
}

export function sameSite(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  if (ua.protocol !== ub.protocol) return false;
  return registrableDomain(ua.hostname) === registrableDomain(ub.hostname);
}

export function surfacePairs(cfg: Config): { a: SurfaceName; b: SurfaceName; same_site: boolean; same_origin: boolean }[] {
  const s = resolveSurfaces(cfg);
  const pairs: { a: SurfaceName; b: SurfaceName; same_site: boolean; same_origin: boolean }[] = [];
  for (let i = 0; i < SURFACE_NAMES.length; i++) {
    for (let j = i + 1; j < SURFACE_NAMES.length; j++) {
      const a = s[SURFACE_NAMES[i]!];
      const b = s[SURFACE_NAMES[j]!];
      pairs.push({ a: a.name, b: b.name, same_site: sameSite(a.origin, b.origin), same_origin: a.origin === b.origin });
    }
  }
  return pairs;
}

export function issuer(cfg: Config): string {
  if (cfg.oidc.issuer) return cfg.oidc.issuer.replace(/\/$/, "");
  const api = resolveSurfaces(cfg).api;
  return api.basePath === "/" ? api.origin : api.origin + api.basePath;
}

export function apiResource(cfg: Config): string {
  return cfg.oidc.resource ?? issuer(cfg);
}

export function cookieScopeFor(cfg: Config, host: string): string {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  const domain = cfg.cookies.domain?.replace(/^\./, "").toLowerCase();
  if (domain && (h === domain || h.endsWith(`.${domain}`))) return `domain:${domain}`;
  return `host:${host.toLowerCase()}`;
}

export function moduleOwner(cfg: Config, module: ModuleName): SurfaceName | null {
  const s = resolveSurfaces(cfg);
  for (const name of ["account", "support"] as const) if (s[name].modules.includes(module)) return name;
  return s.api.modules.includes(module) ? "api" : null;
}
