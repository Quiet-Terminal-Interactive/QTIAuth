import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export interface SpanContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }[];
  status: { code: number };
}

const storage = new AsyncLocalStorage<SpanContext>();
let exporter: { endpoint: string; service: string; ratio: number; buffer: FinishedSpan[]; timer: NodeJS.Timeout | null } | null = null;

export function initTracing(service: string, endpoint: string | null, ratio: number): void {
  if (!endpoint) return;
  exporter = { endpoint: endpoint.replace(/\/$/, ""), service, ratio, buffer: [], timer: null };
  exporter.timer = setInterval(() => void flushSpans(), 5000);
  exporter.timer.unref();
}

export function parseTraceparent(header: string | null | undefined): SpanContext | null {
  if (!header) return null;
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header.trim());
  if (!m) return null;
  return { traceId: m[1]!, spanId: m[2]!, sampled: (parseInt(m[3]!, 16) & 1) === 1 };
}

export function formatTraceparent(ctx: SpanContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

export function currentSpan(): SpanContext | undefined {
  return storage.getStore();
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export async function withSpan<T>(name: string, attrs: Record<string, string | number | boolean>, parent: SpanContext | null | undefined, fn: (span: SpanContext) => Promise<T>, kind = 1): Promise<T> {
  const p = parent ?? storage.getStore();
  const span: SpanContext = {
    traceId: p?.traceId ?? newTraceId(),
    spanId: randomBytes(8).toString("hex"),
    sampled: p?.sampled ?? (exporter ? Math.random() < exporter.ratio : false),
  };
  const start = process.hrtime.bigint();
  const startWall = BigInt(Date.now()) * 1_000_000n;
  let ok = true;
  try {
    return await storage.run(span, () => fn(span));
  } catch (err) {
    ok = false;
    throw err;
  } finally {
    if (exporter && span.sampled) {
      const end = startWall + (process.hrtime.bigint() - start);
      exporter.buffer.push({
        traceId: span.traceId,
        spanId: span.spanId,
        ...(p?.spanId ? { parentSpanId: p.spanId } : {}),
        name,
        kind,
        startTimeUnixNano: startWall.toString(),
        endTimeUnixNano: end.toString(),
        attributes: Object.entries(attrs).map(([key, v]) => ({
          key,
          value: typeof v === "number" ? { intValue: String(Math.trunc(v)) } : typeof v === "boolean" ? { boolValue: v } : { stringValue: v },
        })),
        status: { code: ok ? 1 : 2 },
      });
      if (exporter.buffer.length > 512) void flushSpans();
    }
  }
}

export async function flushSpans(): Promise<void> {
  if (!exporter || !exporter.buffer.length) return;
  const spans = exporter.buffer.splice(0, exporter.buffer.length);
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: `qtiauth-${exporter.service}` } }] },
        scopeSpans: [{ scope: { name: "qtiauth" }, spans }],
      },
    ],
  };
  try {
    await fetch(`${exporter.endpoint}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  } catch {
    return;
  }
}
