import { hashToken, inc } from "@qtiauth/common";
import type { Config } from "@qtiauth/config";
import type { Bus } from "@qtiauth/bus";
import type { Valkey } from "@qtiauth/service-kit";
import type { AccountState, AgeBand, ParentalControls, Restriction } from "@qtiauth/auth-context";

export interface SessionContext {
  session_id: string;
  user_id: string | null;
  guardian_id: string | null;
  principal: "user" | "guardian";
  state: AccountState | null;
  grants: string[];
  restrictions: Restriction[];
  age_band: AgeBand | null;
  parental_controls: ParentalControls | null;
  amr: string[];
  aal: 0 | 1 | 2;
  auth_time: number;
  step_up_at: number | null;
  pending_legal: boolean;
  mfa_enrolment_required: boolean;
  force_username_reset: boolean;
  locale: string | null;
  trust_level: string;
  expires_at: string;
  username: string | null;
}

export type UserContext = Omit<SessionContext, "session_id" | "guardian_id" | "principal" | "amr" | "aal" | "auth_time" | "step_up_at" | "trust_level" | "expires_at">;

export function cookieName(cfg: Config): string {
  return cfg.cookies.domain || !cfg.cookies.secure ? cfg.cookies.name : `__Host-${cfg.cookies.name}`;
}

export const BIND_FAILED_COOKIE = "qtiauth_bind_failed";

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function sessionCookie(cfg: Config, value: string, maxAgeSeconds: number): string {
  const parts = [`${cookieName(cfg)}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (cfg.cookies.secure) parts.push("Secure");
  if (cfg.cookies.domain) parts.push(`Domain=${cfg.cookies.domain}`);
  return parts.join("; ");
}

export function clearSessionCookie(cfg: Config): string {
  return sessionCookie(cfg, "", 0);
}

export function bindFailedCookie(cfg: Config, set: boolean): string {
  return [`${BIND_FAILED_COOKIE}=${set ? "1" : ""}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${set ? 60 : 0}`, ...(cfg.cookies.secure ? ["Secure"] : [])].join("; ");
}

interface CacheEntry {
  ctx: SessionContext;
  signals: { ip: string | null; country: string | null; ua: string | null };
}

export class SessionResolver {
  private readonly bus: Bus;
  private readonly v: Valkey;
  private readonly ttlMs = 30_000;

  constructor(bus: Bus, v: Valkey) {
    this.bus = bus;
    this.v = v;
  }

  async resolve(token: string, scope: string, signals: { ip: string | null; port?: number | null; country: string | null; ua: string | null; tls: string | null; client: Record<string, string> }): Promise<SessionContext | null> {
    if (!token || token.length > 128) return null;
    const hash = hashToken(token);
    const key = `gw:s:${hash}`;
    try {
      const raw = await this.v.get(key);
      if (raw) {
        const hit = JSON.parse(raw) as CacheEntry;
        if (hit.signals.ip === signals.ip && hit.signals.country === signals.country && hit.signals.ua === signals.ua) {
          inc("qtiauth_gateway_session_cache_total", { result: "hit" }, 1, "Session cache lookups");
          return hit.ctx;
        }
      }
    } catch {
      inc("qtiauth_gateway_session_cache_total", { result: "error" }, 1, "Session cache lookups");
    }
    inc("qtiauth_gateway_session_cache_total", { result: "miss" }, 1, "Session cache lookups");
    const ctx = await this.bus.request<SessionContext | null>(
      "identity.resolve_session",
      { token_hash: hash, scope, ip: signals.ip, port: signals.port ?? null, country: signals.country, ua: signals.ua, tls: signals.tls, signals: signals.client },
      { timeoutMs: 5000 },
    );
    if (!ctx) {
      await this.v.del(key).catch(() => undefined);
      return null;
    }
    try {
      const entry: CacheEntry = { ctx, signals: { ip: signals.ip, country: signals.country, ua: signals.ua } };
      const ttl = this.ttlMs;
      await this.v
        .multi()
        .set(key, JSON.stringify(entry), "PX", ttl)
        .sadd(`gw:sidx:${ctx.session_id}`, hash)
        .pexpire(`gw:sidx:${ctx.session_id}`, ttl * 2)
        .sadd(`gw:uidx:${ctx.user_id ?? ctx.guardian_id ?? "none"}`, hash)
        .pexpire(`gw:uidx:${ctx.user_id ?? ctx.guardian_id ?? "none"}`, ttl * 2)
        .exec();
    } catch {
      return ctx;
    }
    return ctx;
  }

  async bustSession(sessionId: string): Promise<void> {
    try {
      const hashes = await this.v.smembers(`gw:sidx:${sessionId}`);
      if (hashes.length) await this.v.del(...hashes.map((h) => `gw:s:${h}`));
      await this.v.del(`gw:sidx:${sessionId}`);
    } catch {
      return;
    }
  }

  async bustUser(userId: string): Promise<void> {
    try {
      const hashes = await this.v.smembers(`gw:uidx:${userId}`);
      if (hashes.length) await this.v.del(...hashes.map((h) => `gw:s:${h}`));
      await this.v.del(`gw:uidx:${userId}`, `gw:u:${userId}`);
    } catch {
      return;
    }
  }

  async userContext(userId: string): Promise<UserContext | null> {
    const key = `gw:u:${userId}`;
    try {
      const raw = await this.v.get(key);
      if (raw) return JSON.parse(raw) as UserContext;
    } catch {
      inc("qtiauth_gateway_session_cache_total", { result: "error" }, 1, "Session cache lookups");
    }
    const ctx = await this.bus.request<UserContext | null>("identity.resolve_user", { user_id: userId }, { timeoutMs: 5000 });
    if (ctx) await this.v.set(key, JSON.stringify(ctx), "PX", this.ttlMs).catch(() => undefined);
    return ctx;
  }
}
