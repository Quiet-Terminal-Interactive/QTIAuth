import client from "prom-client";

export const registry = new client.Registry();

let defaultsStarted = false;

export function startDefaultMetrics(service: string): void {
  if (defaultsStarted) return;
  defaultsStarted = true;
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });
}

const counters = new Map<string, client.Counter<string>>();
const gauges = new Map<string, client.Gauge<string>>();
const histograms = new Map<string, client.Histogram<string>>();

export function counter(name: string, help: string, labelNames: string[] = []): client.Counter<string> {
  let c = counters.get(name);
  if (!c) {
    c = new client.Counter({ name, help, labelNames, registers: [registry] });
    counters.set(name, c);
  }
  return c;
}

export function gauge(name: string, help: string, labelNames: string[] = [], collect?: (this: client.Gauge<string>) => Promise<void> | void): client.Gauge<string> {
  let g = gauges.get(name);
  if (!g) {
    g = new client.Gauge({ name, help, labelNames, registers: [registry], ...(collect ? { collect } : {}) });
    gauges.set(name, g);
  }
  return g;
}

export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
export const DURATION_BUCKETS = [1, 5, 15, 30, 60, 300, 900, 1800, 3600, 7200, 14400, 43200, 86400, 172800, 604800];
export const SIZE_BUCKETS = [100, 1000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000];

export function histogram(name: string, help: string, labelNames: string[] = [], buckets = LATENCY_BUCKETS): client.Histogram<string> {
  let h = histograms.get(name);
  if (!h) {
    h = new client.Histogram({ name, help, labelNames, buckets, registers: [registry] });
    histograms.set(name, h);
  }
  return h;
}

export async function renderMetrics(): Promise<{ body: string; contentType: string }> {
  return { body: await registry.metrics(), contentType: registry.contentType };
}

export function inc(name: string, labels: Record<string, string | number | boolean> = {}, value = 1, help?: string): void {
  const labelNames = Object.keys(labels);
  counter(name, help ?? name, labelNames).inc(stringify(labels), value);
}

export function observe(name: string, value: number, labels: Record<string, string | number | boolean> = {}, buckets = LATENCY_BUCKETS, help?: string): void {
  histogram(name, help ?? name, Object.keys(labels), buckets).observe(stringify(labels), value);
}

export function setGauge(name: string, value: number, labels: Record<string, string | number | boolean> = {}, help?: string): void {
  gauge(name, help ?? name, Object.keys(labels)).set(stringify(labels), value);
}

function stringify(labels: Record<string, string | number | boolean>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) out[k] = String(v);
  return out;
}
