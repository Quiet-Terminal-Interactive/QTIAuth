import type { Valkey } from "@qtiauth/service-kit";
import type { RatePolicy } from "@qtiauth/config";
import { inc } from "@qtiauth/common";

const SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local cur_start = now - (now % window)
local prev_start = cur_start - window
local cur_key = KEYS[1] .. ":" .. cur_start
local prev_key = KEYS[1] .. ":" .. prev_start
local cur = tonumber(redis.call("GET", cur_key) or "0")
local prev = tonumber(redis.call("GET", prev_key) or "0")
local elapsed = now - cur_start
local estimate = prev * ((window - elapsed) / window) + cur
if estimate + cost > limit then
  return {0, math.floor(estimate), window - elapsed}
end
if cost > 0 then
  redis.call("INCRBY", cur_key, cost)
  redis.call("PEXPIRE", cur_key, window * 2)
end
return {1, math.floor(estimate + cost), window - elapsed}
`;

export interface RateResult {
  allowed: boolean;
  policy: string;
  limit: number;
  remaining: number;
  resetMs: number;
  count: number;
}

const AUTH_PREFIXES = ["auth", "magic_link", "password", "totp", "guest", "key_redeem", "oauth", "steam"];

export function failMode(name: string, p: RatePolicy): "open" | "closed" {
  if (p.fail) return p.fail;
  return AUTH_PREFIXES.some((x) => name.startsWith(x)) ? "closed" : "open";
}

export class RateLimiter {
  private readonly v: Valkey;
  private sha: string | null = null;

  constructor(v: Valkey) {
    this.v = v;
  }

  private async eval(key: string, windowMs: number, limit: number, cost: number): Promise<[number, number, number]> {
    const args = [String(Date.now()), String(windowMs), String(limit), String(cost)];
    if (!this.sha) this.sha = (await this.v.script("LOAD", SCRIPT)) as string;
    try {
      return (await this.v.evalsha(this.sha, 1, key, ...args)) as [number, number, number];
    } catch (err) {
      if (String((err as Error).message).includes("NOSCRIPT")) {
        this.sha = null;
        return (await this.v.eval(SCRIPT, 1, key, ...args)) as [number, number, number];
      }
      throw err;
    }
  }

  async check(name: string, policy: RatePolicy, subject: string, cost = 1): Promise<RateResult> {
    const key = `rl:${name}:${subject}`;
    try {
      const [ok, count, reset] = await this.eval(key, policy.window, policy.limit, cost);
      inc("qtiauth_rate_limit_checks_total", { policy: name, result: ok ? "allowed" : "rejected" }, 1, "Rate limit checks");
      return { allowed: ok === 1, policy: name, limit: policy.limit, remaining: Math.max(0, policy.limit - count), resetMs: reset, count };
    } catch {
      const mode = failMode(name, policy);
      inc("qtiauth_rate_limit_valkey_failures_total", { policy: name, mode }, 1, "Rate limit checks when Valkey was unreachable");
      return { allowed: mode === "open", policy: name, limit: policy.limit, remaining: 0, resetMs: policy.window, count: 0 };
    }
  }

  async peek(name: string, policy: RatePolicy, subject: string): Promise<number> {
    try {
      const [, count] = await this.eval(`rl:${name}:${subject}`, policy.window, Number.MAX_SAFE_INTEGER, 0);
      return count;
    } catch {
      return 0;
    }
  }
}
