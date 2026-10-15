import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  IDENTITY_HEADER,
  checkPolicy,
  normalizePolicy,
  type IdentityClaims,
  type InternalKeyRing,
  type ManifestRoute,
  type PolicyInput,
  type RoutePolicy,
} from "@qtiauth/auth-context";
import { ProblemError, isProblemError, observe, inc, type Logger } from "@qtiauth/common";

type Out<T> = T extends z.ZodType ? z.output<T> : undefined;

export interface HandlerContext<B = unknown, Q = unknown, P = unknown> {
  body: B;
  query: Q;
  params: P;
  id: IdentityClaims;
  c: Context;
  raw: Uint8Array | null;
  userId(): string;
  ip: string;
}

export class Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  constructor(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export function reply(status: number, body?: unknown, headers: Record<string, string> = {}): Reply {
  return new Reply(status, body, headers);
}

export interface RouteDef<B = unknown, Q = unknown, P = unknown> extends PolicyInput {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  description?: string;
  tags?: string[];
  body?: B;
  query?: Q;
  params?: P;
  response?: z.ZodType;
  responseDescription?: string;
  produces?: string;
  handler: (ctx: HandlerContext<Out<B>, Out<Q>, Out<P>>) => Promise<unknown>;
}

export type AnyRoute = RouteDef<any, any, any>;

export function route<B extends z.ZodType | undefined = undefined, Q extends z.ZodType | undefined = undefined, P extends z.ZodType | undefined = undefined>(def: RouteDef<B, Q, P>): AnyRoute {
  return def as unknown as AnyRoute;
}

export function operationId(r: { method: string; path: string }): string {
  const parts = r.path
    .replace(/^\/(api\/v1\/)?/, "")
    .split("/")
    .filter(Boolean)
    .map((p) => (p.startsWith(":") ? `by_${p.slice(1)}` : p.replace(/[^A-Za-z0-9]+/g, "_")));
  return `${r.method.toLowerCase()}_${parts.join("_")}`;
}

export function manifestRoutes(routes: AnyRoute[], defaults: Partial<PolicyInput> = {}): ManifestRoute[] {
  return routes.map((r) => {
    const policy = normalizePolicy({ ...defaults, ...pickPolicy(r) });
    return { ...policy, method: r.method, path: r.path, operation_id: operationId(r) };
  });
}

function pickPolicy(r: AnyRoute): PolicyInput {
  const {
    method: _m,
    path: _p,
    summary: _s,
    description: _d,
    tags: _t,
    body: _b,
    query: _q,
    params: _pa,
    response: _r,
    responseDescription: _rd,
    produces: _pr,
    handler: _h,
    ...policy
  } = r;
  return policy;
}

function queryObject(c: Context): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const url = new URL(c.req.url);
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length > 1 ? all : all[0]!;
  }
  return out;
}

function zodIssues(err: z.ZodError): { path: string; message: string; code: string }[] {
  return err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message, code: i.code }));
}

export function problemResponse(c: Context, err: ProblemError): Response {
  const body = err.toProblem(c.req.path);
  return new Response(JSON.stringify(body), {
    status: err.status,
    headers: { "content-type": "application/problem+json", ...err.headers },
  });
}

export interface BuildAppOptions {
  service: string;
  routes: AnyRoute[];
  keyring: InternalKeyRing;
  log: Logger;
  stepUpWindowMs: number;
  policyDefaults?: Partial<PolicyInput>;
  extra?: (app: Hono) => void;
}

export function buildApp(opts: BuildAppOptions): Hono {
  const app = new Hono();
  opts.extra?.(app);
  for (const r of opts.routes) {
    const policy: RoutePolicy = normalizePolicy({ ...opts.policyDefaults, ...pickPolicy(r) });
    const handler = async (c: Context): Promise<Response> => {
      const started = performance.now();
      let status = 500;
      try {
        const token = c.req.header(IDENTITY_HEADER);
        if (!token) throw new ProblemError(401, "MISSING_INTERNAL_IDENTITY");
        let claims: IdentityClaims;
        try {
          claims = await opts.keyring.verify(token, { method: c.req.method, path: c.req.path });
        } catch (e) {
          opts.log.warn({ err: (e as Error).message, path: c.req.path }, "rejected internal identity token");
          throw new ProblemError(401, "INVALID_INTERNAL_IDENTITY");
        }
        checkPolicy(policy, claims, { stepUpWindowMs: opts.stepUpWindowMs });
        const params = r.params ? parseOrThrow(r.params, c.req.param()) : c.req.param();
        const query = r.query ? parseOrThrow(r.query, queryObject(c)) : queryObject(c);
        let raw: Uint8Array | null = null;
        let body: unknown = undefined;
        if (r.method !== "GET" && r.method !== "DELETE") {
          if (policy.raw_body) {
            raw = new Uint8Array(await c.req.arrayBuffer());
          } else if (r.body) {
            const ct = c.req.header("content-type") ?? "";
            let input: unknown = {};
            if (ct.includes("application/json")) {
              const text = await c.req.text();
              if (text.length) {
                try {
                  input = JSON.parse(text);
                } catch {
                  throw new ProblemError(400, "INVALID_JSON");
                }
              }
            } else if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
              input = Object.fromEntries((await c.req.formData()).entries());
            }
            body = parseOrThrow(r.body, input);
          }
        }
        const ctx: HandlerContext = {
          body,
          query,
          params,
          id: claims,
          c,
          raw,
          ip: claims.ip,
          userId() {
            if (!claims.sub) throw new ProblemError(401, "UNAUTHENTICATED");
            return claims.sub;
          },
        };
        const result = await r.handler(ctx as never);
        if (result instanceof Response) {
          status = result.status;
          return result;
        }
        if (result instanceof Reply) {
          status = result.status;
          if (result.body === undefined || result.status === 204) return new Response(null, { status: result.status, headers: result.headers });
          if (typeof result.body === "string" || result.body instanceof Uint8Array) {
            return new Response(result.body as BodyInit, { status: result.status, headers: { "content-type": r.produces ?? "text/plain; charset=utf-8", ...result.headers } });
          }
          return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json", ...result.headers } });
        }
        status = result === undefined ? 204 : 200;
        if (result === undefined) return new Response(null, { status: 204 });
        return c.json(result as object, 200);
      } catch (err) {
        if (isProblemError(err)) {
          status = err.status;
          return problemResponse(c, err);
        }
        status = 500;
        opts.log.error({ err, path: r.path, method: r.method }, "unhandled route error");
        return problemResponse(c, new ProblemError(500, "INTERNAL_ERROR"));
      } finally {
        observe("qtiauth_service_http_seconds", (performance.now() - started) / 1000, { service: opts.service, route: r.path, method: r.method, status }, undefined, "Service HTTP latency");
        inc("qtiauth_service_http_requests_total", { service: opts.service, route: r.path, method: r.method, status }, 1, "Service HTTP requests");
      }
    };
    app.on(r.method, r.path, handler);
  }
  app.notFound((c) => problemResponse(c, new ProblemError(404, "ROUTE_NOT_FOUND")));
  app.onError((err, c) => {
    opts.log.error({ err }, "unhandled error");
    return problemResponse(c, new ProblemError(500, "INTERNAL_ERROR"));
  });
  return app;
}

export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new ProblemError(422, "VALIDATION_FAILED", "Request validation failed", { errors: zodIssues(r.error) });
  return r.data;
}

function jsonSchema(s: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  try {
    const js = z.toJSONSchema(s, { io, unrepresentable: "any", target: "openapi-3.0" }) as Record<string, unknown>;
    delete js.$schema;
    return js;
  } catch {
    return {};
  }
}

const SECURITY: Record<string, Record<string, string[]>> = {
  session: { session: [] },
  oauth: { oauth: [] },
  service: { service: [] },
  game_authoritative: { service: [], playerToken: [] },
};

export function buildOpenApi(service: string, version: string, routes: AnyRoute[], policyDefaults: Partial<PolicyInput> = {}): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const policy = normalizePolicy({ ...policyDefaults, ...pickPolicy(r) });
    const p = r.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const parameters: Record<string, unknown>[] = [];
    for (const m of r.path.matchAll(/:([A-Za-z0-9_]+)/g)) parameters.push({ name: m[1], in: "path", required: true, schema: { type: "string" } });
    if (r.query && r.query instanceof z.ZodObject) {
      const shape = (r.query as z.ZodObject).shape as Record<string, z.ZodType>;
      for (const [name, s] of Object.entries(shape)) {
        parameters.push({ name, in: "query", required: !s.safeParse(undefined).success, schema: jsonSchema(s, "input") });
      }
    }
    const op: Record<string, unknown> = {
      operationId: operationId(r),
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      tags: r.tags ?? [service],
      parameters,
      responses: {
        "200": {
          description: r.responseDescription ?? "Success",
          ...(r.response ? { content: { "application/json": { schema: jsonSchema(r.response, "output") } } } : {}),
        },
        default: { description: "Problem", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
      },
      security: policy.auth.includes("none") ? [{}] : policy.auth.map((a) => SECURITY[a] ?? {}),
      "x-qtiauth-policy": {
        auth: policy.auth,
        permissions: policy.permissions,
        scopes: policy.scopes,
        step_up: policy.step_up,
        rate_limit: policy.rate_limit,
        allow_account_states: policy.allow_account_states,
        allow_pending_legal: policy.allow_pending_legal,
      },
    };
    if (r.body) op.requestBody = { required: true, content: { "application/json": { schema: jsonSchema(r.body, "input") } } };
    paths[p] = { ...(paths[p] ?? {}), [r.method.toLowerCase()]: op };
  }
  return {
    openapi: "3.1.0",
    info: { title: `QTIAuth ${service}`, version },
    paths,
    components: {
      schemas: {
        Problem: {
          type: "object",
          required: ["type", "title", "status", "code"],
          properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "integer" }, code: { type: "string" }, detail: { type: "string" }, instance: { type: "string" } },
        },
      },
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "__Host-qtiauth_session" },
        oauth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        service: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        playerToken: { type: "apiKey", in: "header", name: "X-QTIAuth-Player-Token" },
      },
    },
  };
}
