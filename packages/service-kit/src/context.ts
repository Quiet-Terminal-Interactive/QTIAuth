import type { Kysely, Transaction } from "kysely";
import type { Hono } from "hono";
import type { Logger } from "@qtiauth/common";
import type { LoadedConfig, ResolvedSurface, ServiceName, SurfaceName } from "@qtiauth/config";
import type { Bus, EventEnvelope, Actor } from "@qtiauth/bus";
import type { Database, Migration } from "@qtiauth/db";
import type { InternalKeyRing, NotificationCategory, PolicyInput } from "@qtiauth/auth-context";
import type { AnyRoute } from "./http.ts";
import type { Storage } from "./storage.ts";
import type { Valkey } from "./valkey.ts";

export type Exec<DB = any> = Kysely<DB> | Transaction<DB>;

export interface AuditEntry {
  actor: Actor;
  action: string;
  target?: { type: string; id: string };
  reason?: string | null;
  data?: Record<string, unknown>;
  ip?: string | null;
}

export interface EmailRequest {
  template: string;
  to: { user_id?: string; email?: string; guardian_id?: string; name?: string };
  locale?: string | null;
  vars: Record<string, unknown>;
  sender: "auth" | "security" | "support";
  priority?: "high" | "normal";
  notification_category?: string;
  bypass_suppression?: boolean;
  attachments?: { filename: string; content_base64: string; content_type: string }[];
  dedupe_key?: string;
}

export interface HealthWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export interface EmitOptions {
  actor?: Actor;
  subject: { type: string; id: string };
  trace_id?: string;
}

export interface ServiceContext<DB = any> {
  name: ServiceName;
  version: string;
  instanceId: string;
  config: LoadedConfig;
  surfaces: Record<SurfaceName, ResolvedSurface>;
  log: Logger;
  db: Kysely<DB>;
  database: Database<DB> | null;
  bus: Bus;
  valkey: Valkey;
  storage: Storage | null;
  keyring: InternalKeyRing;
  emit<T>(exec: Exec<DB>, type: string, data: T, opts: EmitOptions): Promise<EventEnvelope<T>>;
  audit(exec: Exec<DB>, entry: AuditEntry): Promise<void>;
  email(exec: Exec<DB>, req: EmailRequest): Promise<void>;
  enqueue(exec: Exec<DB>, queue: string, payload: unknown, msgId?: string): Promise<void>;
  rpc<Res, Req = unknown>(method: string, data: Req, opts?: { timeoutMs?: number }): Promise<Res>;
  rpcOptional<Res, Req = unknown>(method: string, data: Req, fallback: Res, opts?: { timeoutMs?: number }): Promise<Res>;
  on<T = Record<string, unknown>>(consumer: string, subjects: string[], handler: (env: EventEnvelope<T>, trx: Transaction<DB>) => Promise<void>, opts?: { deliverNew?: boolean }): Promise<void>;
  registeredServices(): Promise<string[]>;
}

export interface CliCommand {
  description: string;
  usage?: string;
  run(args: string[], ctx: CliContext): Promise<number | void>;
}

export interface CliContext {
  config: LoadedConfig;
  log: Logger;
  service: ServiceName;
  boot(): Promise<ServiceContext>;
  print(line: string): void;
}

export interface ServiceDefinition<DB = any> {
  name: ServiceName;
  version?: string;
  schema?: string;
  migrations?: Migration[];
  permissions?: string[];
  notificationCategories?: NotificationCategory[];
  policyDefaults?: Partial<PolicyInput>;
  routes?(ctx: ServiceContext<DB>): AnyRoute[];
  features?(ctx: ServiceContext<DB>): string[];
  init?(ctx: ServiceContext<DB>): Promise<void>;
  start?(ctx: ServiceContext<DB>): Promise<void>;
  cron?: Record<string, (ctx: ServiceContext<DB>) => Promise<void>>;
  exportUser?(ctx: ServiceContext<DB>, userId: string): Promise<unknown>;
  eraseUser?(ctx: ServiceContext<DB>, userId: string, opts: { legalHold: boolean }): Promise<void>;
  retention?(ctx: ServiceContext<DB>): Promise<Record<string, number>>;
  healthWarnings?(ctx: ServiceContext<DB>): Promise<HealthWarning[]>;
  http?(app: Hono, ctx: ServiceContext<DB>): void;
  shutdown?(ctx: ServiceContext<DB>): Promise<void>;
  cli?: Record<string, CliCommand>;
  needsDb?: boolean;
  serveHttp?: boolean;
}

export function defineService<DB>(def: ServiceDefinition<DB>): ServiceDefinition<DB> {
  return def;
}
