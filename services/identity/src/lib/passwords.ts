import { hash, verify } from "@node-rs/argon2";
import { ProblemError, sha1Hex, inc } from "@qtiauth/common";
import type { Config } from "@qtiauth/config";

export function argonOptions(cfg: Config) {
  return {
    algorithm: 2 as const,
    memoryCost: cfg.password.argon2.memory_kib,
    timeCost: cfg.password.argon2.iterations,
    parallelism: cfg.password.argon2.parallelism,
  };
}

export async function hashPassword(cfg: Config, password: string): Promise<string> {
  return hash(password, argonOptions(cfg));
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

let dummyHash: string | null = null;

export async function dummyVerify(cfg: Config, password: string): Promise<void> {
  if (!dummyHash) dummyHash = await hash("qtiauth-timing-equaliser", argonOptions(cfg));
  await verifyPassword(dummyHash, password);
}

export function needsRehash(cfg: Config, stored: string): boolean {
  const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
  if (!m) return true;
  const o = argonOptions(cfg);
  return Number(m[1]) !== o.memoryCost || Number(m[2]) !== o.timeCost || Number(m[3]) !== o.parallelism;
}

export interface PolicyContext {
  email?: string | null;
  username?: string | null;
}

export function checkPasswordPolicy(cfg: Config, password: string, context: PolicyContext): void {
  const p = cfg.password;
  const length = [...password].length;
  if (length < p.min_length) throw new ProblemError(422, "PASSWORD_TOO_SHORT", undefined, { min_length: p.min_length });
  if (length > Math.min(p.max_length, 256)) throw new ProblemError(422, "PASSWORD_TOO_LONG", undefined, { max_length: p.max_length });
  const c = p.composition;
  if (c.require_lower && !/\p{Ll}/u.test(password)) throw new ProblemError(422, "PASSWORD_NEEDS_LOWERCASE");
  if (c.require_upper && !/\p{Lu}/u.test(password)) throw new ProblemError(422, "PASSWORD_NEEDS_UPPERCASE");
  if (c.require_digit && !/\p{Nd}/u.test(password)) throw new ProblemError(422, "PASSWORD_NEEDS_DIGIT");
  if (c.require_symbol && !/[^\p{L}\p{Nd}]/u.test(password)) throw new ProblemError(422, "PASSWORD_NEEDS_SYMBOL");
  const lower = password.toLowerCase();
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 3 && lower.includes(local)) throw new ProblemError(422, "PASSWORD_CONTAINS_EMAIL");
  const username = context.username?.toLowerCase();
  if (username && username.length >= 3 && lower.includes(username)) throw new ProblemError(422, "PASSWORD_CONTAINS_USERNAME");
}

export async function isBreached(cfg: Config, password: string): Promise<boolean> {
  if (!cfg.password.breach_check) return false;
  const digest = sha1Hex(password).toUpperCase();
  const prefix = digest.slice(0, 5);
  const suffix = digest.slice(5);
  try {
    const r = await fetch(`${cfg.password.breach_api_url}${prefix}`, {
      headers: { "Add-Padding": "true", "user-agent": "qtiauth" },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return false;
    const text = await r.text();
    for (const line of text.split("\n")) {
      const [s, count] = line.trim().split(":");
      if (s === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function assertAcceptablePassword(cfg: Config, password: string, context: PolicyContext): Promise<void> {
  checkPasswordPolicy(cfg, password, context);
  if (await isBreached(cfg, password)) {
    inc("qtiauth_auth_breach_rejections_total", {}, 1, "Passwords rejected by the breach check");
    throw new ProblemError(422, "PASSWORD_BREACHED");
  }
}
