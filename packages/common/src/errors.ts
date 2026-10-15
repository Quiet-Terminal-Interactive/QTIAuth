export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  423: "Locked",
  428: "Precondition Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export class ProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, detail?: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(detail ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }

  toProblem(instance?: string): ProblemDetails {
    return {
      type: `https://qtiauth.qtidocs.dev/problems/${this.code.toLowerCase().replaceAll("_", "-")}`,
      title: TITLES[this.status] ?? "Error",
      status: this.status,
      code: this.code,
      ...(this.message && this.message !== this.code ? { detail: this.message } : {}),
      ...(instance ? { instance } : {}),
      ...this.extra,
    };
  }
}

export const problems = {
  badRequest: (code = "BAD_REQUEST", detail?: string, extra?: Record<string, unknown>) => new ProblemError(400, code, detail, extra),
  validation: (issues: unknown) => new ProblemError(422, "VALIDATION_FAILED", "Request validation failed", { errors: issues }),
  unauthorized: (code = "UNAUTHENTICATED", detail?: string) => new ProblemError(401, code, detail),
  forbidden: (code = "FORBIDDEN", detail?: string, extra?: Record<string, unknown>) => new ProblemError(403, code, detail, extra),
  notFound: (code = "NOT_FOUND", detail?: string) => new ProblemError(404, code, detail),
  conflict: (code = "CONFLICT", detail?: string, extra?: Record<string, unknown>) => new ProblemError(409, code, detail, extra),
  gone: (code = "GONE", detail?: string) => new ProblemError(410, code, detail),
  tooMany: (retryAfterSeconds: number, code = "RATE_LIMITED") =>
    new ProblemError(429, code, undefined, { retry_after: retryAfterSeconds }, { "Retry-After": String(retryAfterSeconds) }),
  unavailable: (code = "SERVICE_UNAVAILABLE", detail?: string) => new ProblemError(503, code, detail),
  badGateway: (code = "UPSTREAM_ERROR", detail?: string) => new ProblemError(502, code, detail),
  internal: (detail?: string) => new ProblemError(500, "INTERNAL_ERROR", detail),
};

export function isProblemError(err: unknown): err is ProblemError {
  return err instanceof ProblemError || (typeof err === "object" && err !== null && (err as { name?: string }).name === "ProblemError");
}

export function fromProblem(p: { status: number; code: string; detail?: string } & Record<string, unknown>): ProblemError {
  const { status, code, detail, type: _type, title: _title, instance: _instance, ...extra } = p;
  return new ProblemError(status, code, detail, extra);
}
