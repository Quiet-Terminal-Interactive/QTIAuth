import type { ManifestRoute, NotificationCategory, ServiceManifest } from "@qtiauth/auth-context";
import { setGauge } from "@qtiauth/common";

export interface Instance {
  id: string;
  service: string;
  baseUrl: string;
  ready: boolean;
  lastSeen: number;
  version: string;
}

export interface CompiledRoute extends ManifestRoute {
  service: string;
  regex: RegExp;
  paramNames: string[];
  score: number;
}

function compile(path: string): { regex: RegExp; paramNames: string[]; score: number } {
  const paramNames: string[] = [];
  let score = 0;
  const parts = path.split("/").filter(Boolean);
  const pattern = parts
    .map((seg) => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        score += 1;
        return "([^/]+)";
      }
      if (seg === "*") return ".*";
      score += 10;
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { regex: new RegExp(`^/${pattern}/?$`), paramNames, score: score * 100 + parts.length };
}

export class Registry {
  private readonly instances = new Map<string, Instance>();
  private readonly manifests = new Map<string, ServiceManifest>();
  private routes: CompiledRoute[] = [];
  private rr = new Map<string, number>();
  private listeners: (() => void)[] = [];
  readonly startedAt = Date.now();

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  upsert(m: ServiceManifest & { stopping?: boolean }): void {
    if (!m?.service || !m.instance_id || m.service === "gateway") return;
    if (m.stopping) {
      this.instances.delete(m.instance_id);
      this.rebuild();
      return;
    }
    const existing = this.instances.get(m.instance_id);
    this.instances.set(m.instance_id, { id: m.instance_id, service: m.service, baseUrl: m.base_url, ready: m.ready, lastSeen: Date.now(), version: m.version });
    const prev = this.manifests.get(m.service);
    const changed = !prev || JSON.stringify(prev.routes) !== JSON.stringify(m.routes) || JSON.stringify(prev.features) !== JSON.stringify(m.features) || !existing || existing.ready !== m.ready;
    this.manifests.set(m.service, m);
    if (changed) this.rebuild();
  }

  expire(maxAgeMs = 45_000): void {
    const cutoff = Date.now() - maxAgeMs;
    let removed = false;
    for (const [id, inst] of this.instances) {
      if (inst.lastSeen < cutoff) {
        this.instances.delete(id);
        removed = true;
      }
    }
    if (removed) this.rebuild();
  }

  private rebuild(): void {
    const live = new Set([...this.instances.values()].filter((i) => i.ready).map((i) => i.service));
    for (const s of [...this.manifests.keys()]) if (![...this.instances.values()].some((i) => i.service === s)) this.manifests.delete(s);
    const routes: CompiledRoute[] = [];
    for (const [service, m] of this.manifests) {
      if (!live.has(service)) continue;
      for (const r of m.routes) routes.push({ ...r, service, ...compile(r.path) });
    }
    routes.sort((a, b) => b.score - a.score);
    this.routes = routes;
    for (const s of ["identity", "notifier", "oidc", "safety", "support", "games", "web"]) {
      setGauge("qtiauth_gateway_service_instances", [...this.instances.values()].filter((i) => i.service === s && i.ready).length, { service: s }, "Ready instances per service");
    }
    for (const fn of this.listeners) fn();
  }

  match(method: string, path: string): { route: CompiledRoute; params: Record<string, string> } | { methodNotAllowed: true } | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (!m) continue;
      if (r.method !== method && !(method === "HEAD" && r.method === "GET")) {
        pathMatched = true;
        continue;
      }
      const params: Record<string, string> = {};
      r.paramNames.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1]!)));
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }

  pick(service: string): Instance | null {
    const list = [...this.instances.values()].filter((i) => i.service === service && i.ready);
    if (!list.length) return null;
    const n = (this.rr.get(service) ?? 0) % list.length;
    this.rr.set(service, n + 1);
    return list[n]!;
  }

  running(): string[] {
    return [...new Set([...this.instances.values()].filter((i) => i.ready).map((i) => i.service))].sort();
  }

  instancesOf(service: string): Instance[] {
    return [...this.instances.values()].filter((i) => i.service === service);
  }

  allInstances(): Instance[] {
    return [...this.instances.values()];
  }

  manifest(service: string): ServiceManifest | undefined {
    return this.manifests.get(service);
  }

  allManifests(): ServiceManifest[] {
    return [...this.manifests.values()];
  }

  permissions(): string[] {
    const out = new Set<string>();
    for (const m of this.manifests.values()) for (const p of m.permissions) out.add(p);
    return [...out].sort();
  }

  notificationCategories(): NotificationCategory[] {
    const out = new Map<string, NotificationCategory>();
    for (const m of this.manifests.values()) for (const c of m.notification_categories) out.set(c.id, c);
    return [...out.values()];
  }

  features(): string[] {
    const out = new Set<string>();
    for (const m of this.manifests.values()) for (const f of m.features) out.add(f);
    return [...out].sort();
  }

  allRoutes(): CompiledRoute[] {
    return this.routes;
  }
}
