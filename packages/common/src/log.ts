import { pino, type Logger } from "pino";
import { sha256 } from "./crypto.ts";

export type { Logger };

const REDACT = [
  "password",
  "*.password",
  "new_password",
  "*.new_password",
  "current_password",
  "*.current_password",
  "token",
  "*.token",
  "access_token",
  "*.access_token",
  "refresh_token",
  "*.refresh_token",
  "id_token",
  "*.id_token",
  "code",
  "*.code",
  "totp",
  "*.totp",
  "recovery_code",
  "*.recovery_code",
  "ticket",
  "*.ticket",
  "secret",
  "*.secret",
  "client_secret",
  "*.client_secret",
  "authorization",
  "*.authorization",
  "cookie",
  "*.cookie",
  "headers.cookie",
  "headers.authorization",
  "body",
  "*.body",
  "content",
  "*.content",
  "snapshot",
  "*.snapshot",
];

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    level,
    base: { service },
    messageKey: "msg",
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT, censor: "[redacted]" },
    formatters: { level: (label) => ({ level: label }) },
  });
}

export function hashUserId(userId: string | null | undefined): string | undefined {
  if (!userId) return undefined;
  return sha256(`qtiauth-log:${userId}`).slice(0, 16);
}
