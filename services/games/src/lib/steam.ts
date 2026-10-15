import { ProblemError, inc, observe } from "@qtiauth/common";
import type { Config } from "@qtiauth/config";

export interface TicketResult {
  steam_id: string;
  owner_steam_id: string;
  vac_banned: boolean;
  publisher_banned: boolean;
}

export interface OwnershipResult {
  owns: boolean;
  owner_steam_id: string | null;
}

export type SteamApp = Config["features"]["games"]["steam"]["apps"][number];

export class SteamApi {
  private readonly cfg: Config["features"]["games"]["steam"];

  constructor(cfg: Config["features"]["games"]["steam"]) {
    this.cfg = cfg;
  }

  private base(): string {
    const h = this.cfg.web_api_host;
    return h.includes("://") ? h.replace(/\/$/, "") : `https://${h}`;
  }

  app(appId: number): SteamApp {
    const app = this.cfg.apps.find((a) => a.app_id === appId);
    if (!app) throw new ProblemError(404, "STEAM_APP_NOT_CONFIGURED");
    return app;
  }

  private async call<T>(method: string, path: string, params: Record<string, string>): Promise<T> {
    if (!this.cfg.publisher_key) throw new ProblemError(503, "STEAM_NOT_CONFIGURED");
    const url = new URL(`${this.base()}${path}`);
    url.searchParams.set("key", this.cfg.publisher_key);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    } catch {
      inc("qtiauth_games_steam_api_errors_total", { method, reason: "network" }, 1, "Steam Web API errors");
      throw new ProblemError(502, "STEAM_UNAVAILABLE");
    } finally {
      observe("qtiauth_games_steam_api_seconds", (performance.now() - started) / 1000, { method }, undefined, "Steam Web API latency");
    }
    if (res.status === 403 || res.status === 401) {
      inc("qtiauth_games_steam_api_errors_total", { method, reason: "auth" }, 1, "Steam Web API errors");
      throw new ProblemError(502, "STEAM_PUBLISHER_KEY_REJECTED");
    }
    if (!res.ok) {
      inc("qtiauth_games_steam_api_errors_total", { method, reason: `http_${res.status}` }, 1, "Steam Web API errors");
      throw new ProblemError(502, "STEAM_API_ERROR", undefined, { upstream_status: res.status });
    }
    return (await res.json()) as T;
  }

  async authenticateTicket(app: SteamApp, ticket: string): Promise<TicketResult> {
    const r = await this.call<{ response?: { params?: { result: string; steamid: string; ownersteamid: string; vacbanned: boolean; publisherbanned: boolean }; error?: { errorcode: number; errordesc: string } } }>(
      "AuthenticateUserTicket",
      "/ISteamUserAuth/AuthenticateUserTicket/v1/",
      { appid: String(app.app_id), ticket, identity: app.ticket_identity },
    );
    const p = r.response?.params;
    if (!p || p.result !== "OK") throw new ProblemError(401, "STEAM_TICKET_INVALID", undefined, { steam_error: r.response?.error?.errorcode ?? null });
    return { steam_id: p.steamid, owner_steam_id: p.ownersteamid, vac_banned: Boolean(p.vacbanned), publisher_banned: Boolean(p.publisherbanned) };
  }

  async checkOwnership(appId: number, steamId: string): Promise<OwnershipResult> {
    const r = await this.call<{ appownership?: { ownsapp: boolean; ownersteamid?: string; result?: string } }>("CheckAppOwnership", "/ISteamUser/CheckAppOwnership/v4/", { steamid: steamId, appid: String(appId) });
    const o = r.appownership;
    if (!o) throw new ProblemError(502, "STEAM_API_ERROR");
    return { owns: Boolean(o.ownsapp), owner_steam_id: o.ownersteamid ?? null };
  }
}
