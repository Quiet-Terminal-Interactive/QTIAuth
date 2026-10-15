import { SESSION_CLEAR_HEADER, SESSION_SET_HEADER } from "@qtiauth/auth-context";
import { externalApiPath, type ResolvedSurface } from "@qtiauth/config";

export const DELEGATION_HEADER = "x-qtiauth-delegation";
export const SURFACE_ORIGIN_HEADER = "x-qtiauth-surface-origin";
const FORWARD = ["accept-language", "user-agent", "x-qtiauth-tz", "x-qtiauth-screen"];

export interface Problem {
  status: number;
  code: string;
  detail?: string;
  errors?: { path: string; message: string; code: string }[];
  [key: string]: unknown;
}

export type ApiResult<T> = { ok: true; status: number; data: T; headers: Headers } | { ok: false; status: number; problem: Problem; headers: Headers };

export interface ApiOptions {
  gatewayUrl: string;
  surface: ResolvedSurface;
  origin: string;
  delegation: string | null;
  incoming: Headers;
}

export class Api {
  readonly sessionHeaders = new Headers();
  private readonly o: ApiOptions;

  constructor(o: ApiOptions) {
    this.o = o;
  }

  async request<T = any>(method: string, path: string, body?: unknown, extra: { query?: Record<string, string | number | undefined | null>; raw?: boolean } = {}): Promise<ApiResult<T>> {
    const external = externalApiPath(this.o.surface, path);
    const url = new URL(this.o.gatewayUrl.replace(/\/$/, "") + external);
    for (const [k, v] of Object.entries(extra.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const headers = new Headers({ accept: "application/json", [SURFACE_ORIGIN_HEADER]: this.o.origin });
    if (this.o.delegation) headers.set(DELEGATION_HEADER, this.o.delegation);
    for (const h of FORWARD) {
      const v = this.o.incoming.get(h);
      if (v) headers.set(h, v);
    }
    let payload: string | undefined;
    if (body !== undefined && method !== "GET") {
      headers.set("content-type", "application/json");
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: payload, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    } catch {
      return { ok: false, status: 502, problem: { status: 502, code: "UPSTREAM_ERROR" }, headers: new Headers() };
    }
    const set = res.headers.get(SESSION_SET_HEADER);
    const clear = res.headers.get(SESSION_CLEAR_HEADER);
    if (set) {
      this.sessionHeaders.set(SESSION_SET_HEADER, set);
      this.sessionHeaders.delete(SESSION_CLEAR_HEADER);
    } else if (clear) {
      this.sessionHeaders.set(SESSION_CLEAR_HEADER, clear);
      this.sessionHeaders.delete(SESSION_SET_HEADER);
    }
    if (res.status === 204) return { ok: true, status: 204, data: undefined as T, headers: res.headers };
    if (extra.raw && res.ok) return { ok: true, status: res.status, data: (await res.text()) as T, headers: res.headers };
    if (res.status >= 300 && res.status < 400) return { ok: true, status: res.status, data: { location: res.headers.get("location") } as T, headers: res.headers };
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (res.ok) return { ok: true, status: res.status, data: parsed as T, headers: res.headers };
    const p = (parsed && typeof parsed === "object" ? parsed : {}) as Problem;
    return { ok: false, status: res.status, problem: { ...p, status: res.status, code: p.code ?? (res.status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR") }, headers: res.headers };
  }

  get<T = any>(path: string, query?: Record<string, string | number | undefined | null>) {
    return this.request<T>("GET", path, undefined, { query });
  }
  post<T = any>(path: string, body: unknown = {}) {
    return this.request<T>("POST", path, body);
  }
  put<T = any>(path: string, body: unknown = {}) {
    return this.request<T>("PUT", path, body);
  }
  patch<T = any>(path: string, body: unknown = {}) {
    return this.request<T>("PATCH", path, body);
  }
  delete<T = any>(path: string, body?: unknown) {
    return this.request<T>("DELETE", path, body);
  }
}

export function fieldErrors(p: Problem | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of p?.errors ?? []) {
    const key = e.path.split(".")[0] ?? "";
    if (key && !out[key]) out[key] = e.message;
  }
  return out;
}
