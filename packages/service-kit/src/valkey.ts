import { Redis } from "iovalkey";
import { observe } from "@qtiauth/common";

export type Valkey = Redis;

export function createValkey(url: string): Redis {
  const client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  client.on("error", () => undefined);
  return client;
}

export async function valkeyPing(v: Redis): Promise<number> {
  const started = performance.now();
  await v.ping();
  const s = (performance.now() - started) / 1000;
  observe("qtiauth_valkey_latency_seconds", s, {}, undefined, "Valkey round-trip latency");
  return s;
}

export async function throttle(v: Redis, key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; count: number; retryAfterMs: number }> {
  const k = `thr:${key}`;
  const count = await v.incr(k);
  if (count === 1) await v.pexpire(k, windowMs);
  if (count > limit) {
    const ttl = await v.pttl(k);
    return { allowed: false, count, retryAfterMs: ttl > 0 ? ttl : windowMs };
  }
  return { allowed: true, count, retryAfterMs: 0 };
}

export async function onceKey(v: Redis, key: string, ttlMs: number): Promise<boolean> {
  const r = await v.set(`once:${key}`, "1", "PX", ttlMs, "NX");
  return r === "OK";
}

export async function getJson<T>(v: Redis, key: string): Promise<T | null> {
  const raw = await v.get(key);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function setJson(v: Redis, key: string, value: unknown, ttlMs: number): Promise<void> {
  await v.set(key, JSON.stringify(value), "PX", ttlMs);
}

export async function takeJson<T>(v: Redis, key: string): Promise<T | null> {
  const raw = await v.getdel(key);
  return raw ? (JSON.parse(raw) as T) : null;
}
