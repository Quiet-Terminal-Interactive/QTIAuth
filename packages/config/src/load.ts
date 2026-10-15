import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { configSchema, type Config } from "./schema.ts";

export class ConfigError extends Error {
  readonly issues: { path: string; message: string }[];
  constructor(issues: { path: string; message: string }[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const REF_RE = /\$\{(env|file):([^}]+)\}/g;

export function interpolate(value: unknown, env: NodeJS.ProcessEnv, path: string[] = [], issues: { path: string; message: string }[] = []): unknown {
  if (typeof value === "string") {
    const whole = /^\$\{(env|file):([^}]+)\}$/.exec(value);
    const resolveRef = (kind: string, ref: string): string | undefined => {
      if (kind === "env") {
        const [name, fallback] = ref.split(":-") as [string, string | undefined];
        const v = env[name.trim()];
        if (v === undefined || v === "") return fallback;
        return v;
      }
      const file = ref.trim();
      if (!existsSync(file)) {
        issues.push({ path: path.join("."), message: `Secret file ${file} does not exist` });
        return undefined;
      }
      return readFileSync(file, "utf8").replace(/\r?\n$/, "");
    };
    if (whole) return resolveRef(whole[1]!, whole[2]!);
    return value.replace(REF_RE, (_m, kind: string, ref: string) => resolveRef(kind, ref) ?? "");
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, [...path, String(i)], issues));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = interpolate(v, env, [...path, k], issues);
      if (r !== undefined) out[k] = r;
    }
    return out;
  }
  return value;
}

export interface LoadedConfig extends Config {
  readonly configDir: string;
  readonly configPath: string;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.QTIAUTH_CONFIG ?? resolve(process.cwd(), "config/qtiauth.yaml");
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): Config {
  const issues: { path: string; message: string }[] = [];
  const interpolated = interpolate(raw ?? {}, env, [], issues) as Record<string, unknown>;
  const secrets = (interpolated.secrets ?? {}) as Record<string, unknown>;
  interpolated.secrets = {
    app_encryption_key: env.APP_ENCRYPTION_KEY,
    key_encryption_key: env.KEY_ENCRYPTION_KEY,
    backup_encryption_key: env.BACKUP_ENCRYPTION_KEY,
    ...secrets,
  };
  if (issues.length) throw new ConfigError(issues);
  const result = configSchema.safeParse(interpolated);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => ({
        path: i.path.map(String).join("."),
        message: i.message,
      })),
    );
  }
  return result.data;
}

export function loadConfig(path: string = defaultConfigPath(), env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const configPath = resolve(path);
  if (!existsSync(configPath)) throw new ConfigError([{ path: "", message: `Config file not found at ${configPath}` }]);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new ConfigError([{ path: "", message: `YAML parse error: ${(err as Error).message}` }]);
  }
  const cfg = parseConfig(raw, env);
  return Object.assign(cfg, { configDir: dirname(configPath), configPath });
}

export function configFile(cfg: { configDir: string }, p: string): string {
  return isAbsolute(p) ? p : resolve(cfg.configDir, p);
}

export function configJsonSchema(): unknown {
  return z.toJSONSchema(configSchema, { io: "input", unrepresentable: "any", target: "draft-2020-12" });
}
