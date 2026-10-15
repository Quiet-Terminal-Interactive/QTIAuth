import { ulid } from "@qtiauth/common";

export interface Actor {
  type: "user" | "service" | "system" | "guardian" | "staff";
  id: string;
}

export interface EventEnvelope<T = Record<string, unknown>> {
  event_id: string;
  type: string;
  occurred_at: string;
  actor: Actor;
  subject: { type: string; id: string };
  data: T;
  trace_id?: string;
}

export interface MakeEventOptions {
  actor?: Actor;
  subject: { type: string; id: string };
  trace_id?: string;
  occurred_at?: Date;
}

export function makeEvent<T>(type: string, data: T, opts: MakeEventOptions): EventEnvelope<T> {
  return {
    event_id: ulid(),
    type,
    occurred_at: (opts.occurred_at ?? new Date()).toISOString(),
    actor: opts.actor ?? { type: "system", id: "system" },
    subject: opts.subject,
    data,
    ...(opts.trace_id ? { trace_id: opts.trace_id } : {}),
  };
}

export function eventWildcardMatches(pattern: string, type: string): boolean {
  const p = pattern.replace(/^qtiauth\./, "").replace(/\.v\d+$/, "");
  const t = type.replace(/^qtiauth\./, "").replace(/\.v\d+$/, "");
  if (p === "*" || p === ">") return true;
  const pp = p.split(".");
  const tt = t.split(".");
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i]!;
    if (seg === ">" || (seg === "*" && i === pp.length - 1)) return tt.length >= i + 1;
    if (seg === "*") {
      if (tt[i] === undefined) return false;
      continue;
    }
    if (seg !== tt[i]) return false;
  }
  return pp.length === tt.length;
}

export function shortEventType(type: string): string {
  return type.replace(/^qtiauth\./, "").replace(/\.v\d+$/, "");
}
