import { hostname } from "node:os";
import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import { sql, type Transaction } from "kysely";
import type { JWK } from "jose";
import { createLogger, inc, renderMetrics, setGauge, startDefaultMetrics, ulid, type Logger, observe } from "@qtiauth/common";
import { loadConfig, resolveSurfaces, type LoadedConfig } from "@qtiauth/config";
import { Bus, EVENTS, SYS_ANNOUNCE, cronSubject, makeEvent, type EventEnvelope } from "@qtiauth/bus";
import { claimOutbox, createDb, insertOutbox, markProcessed, migrateUp, migrationStatus, outboxStats, PendingMigrationsError, ping, type Database } from "@qtiauth/db";
import { InternalKeyRing, type ServiceManifest } from "@qtiauth/auth-context";
import { buildApp, buildOpenApi, manifestRoutes, type AnyRoute } from "./http.ts";
import { Storage } from "./storage.ts";
import { createValkey, valkeyPing } from "./valkey.ts";
import { initTracing, flushSpans } from "./tracing.ts";
import type { ServiceContext, ServiceDefinition, HealthWarning } from "./context.ts";

export const VERSION = process.env.QTIAUTH_VERSION ?? "1.0.0";

export interface BootOptions {
  config?: LoadedConfig;
  env?: NodeJS.ProcessEnv;
  skipMigrations?: boolean;
  log?: Logger;
}

export async function connectDatabase<DB>(def: ServiceDefinition<DB>, env: NodeJS.ProcessEnv): Promise<Database<DB> | null> {
  if (!def.schema) return null;
  const url = env.DATABASE_URL ?? env[`${def.name.toUpperCase()}_DATABASE_URL`];
  if (!url) throw new Error(`DATABASE_URL is not set for ${def.name}`);
  const database = createDb<DB>({ url, schema: def.schema, max: Number(env.DATABASE_POOL_SIZE ?? 10) });
  await ping(database.db);
  return database;
}

export async function applyMigrations<DB>(def: ServiceDefinition<DB>, database: Database<DB>, config: LoadedConfig, log: Logger, env: NodeJS.ProcessEnv): Promise<void> {
  const migrations = def.migrations ?? [];
  const status = await migrationStatus(database.db, def.schema!, migrations);
  if (!status.pending.length) return;
  if (!config.migrations.auto_apply) throw new PendingMigrationsError(def.name, status.pending);
  const started = performance.now();
  const ran = await migrateUp(database.db, def.schema!, migrations, (msg, data) => log.info(data ?? {}, msg), env);
  inc("qtiauth_migrations_applied_total", { service: def.name }, ran.length, "Migrations applied");
  observe("qtiauth_migration_run_seconds", (performance.now() - started) / 1000, { service: def.name }, undefined, "Migration run duration");
}

export async function bootContext<DB>(def: ServiceDefinition<DB>, opts: BootOptions = {}): Promise<ServiceContext<DB>> {
  const env = opts.env ?? process.env;
  const config = opts.config ?? loadConfig(undefined, env);
  const log = opts.log ?? createLogger(def.name, config.observability.log_level);
  const database = await connectDatabase(def, env);
  if (database && !opts.skipMigrations) await applyMigrations(def, database, config, log, env);
  const bus = await Bus.connect({
    servers: config.infrastructure.nats_url,
    name: `qtiauth-${def.name}`,
    user: config.infrastructure.nats_user,
    pass: config.infrastructure.nats_password,
    log,
  });
  const valkey = createValkey(config.infrastructure.valkey_url);
  const keyring = new InternalKeyRing(async (kid) => {
    try {
      return await bus.request<JWK>(`gateway.key.${kid}`, {}, { timeoutMs: 2000 });
    } catch {
      return null;
    }
  });
  bus.onAnnounce((a) => {
    const m = a as ServiceManifest;
    if (m?.service === "gateway" && m.jwks) for (const k of m.jwks.keys) void keyring.add(k as JWK);
  });
  const timeoutMs = config.infrastructure.rpc_timeout;
  const db = (database?.db ?? null) as ServiceContext<DB>["db"];

  const ctx: ServiceContext<DB> = {
    name: def.name,
    version: def.version ?? VERSION,
    instanceId: `${def.name}-${hostname()}-${ulid().slice(-6)}`,
    config,
    surfaces: resolveSurfaces(config),
    log,
    db,
    database,
    bus,
    valkey,
    storage: Storage.fromConfig(config),
    keyring,
    async emit(exec, type, data, eopts) {
      const env = makeEvent(type, data, eopts);
      await insertOutbox(exec, { event_id: env.event_id, subject: type, payload: env });
      return env;
    },
    async audit(exec, entry) {
      const env = makeEvent(
        EVENTS.auditRecorded,
        { ...entry, service: def.name, occurred_at: new Date().toISOString() },
        { actor: entry.actor, subject: entry.target ?? { type: "system", id: def.name } },
      );
      await insertOutbox(exec, { event_id: env.event_id, subject: EVENTS.auditRecorded, payload: env });
    },
    async email(exec, req) {
      const id = ulid();
      await insertOutbox(exec, { event_id: req.dedupe_key ?? `email-${id}`, subject: `qtiauth.queue.email.${req.priority ?? "normal"}`, payload: { id, ...req } });
    },
    async enqueue(exec, queue, payload, msgId) {
      await insertOutbox(exec, { event_id: msgId ?? `q-${ulid()}`, subject: `qtiauth.queue.${queue}`, payload });
    },
    rpc(method, data, o) {
      return bus.request(method, data, { timeoutMs: o?.timeoutMs ?? timeoutMs });
    },
    rpcOptional(method, data, fallback, o) {
      return bus.requestOptional(method, data, fallback, { timeoutMs: o?.timeoutMs ?? timeoutMs });
    },
    async on(consumer, subjects, handler, o) {
      if (!db) throw new Error("Event consumers with dedupe need a database");
      const durable = `${def.name}-${consumer}`;
      await bus.consume({
        durable,
        subjects,
        deliverNew: o?.deliverNew === true,
        handler: async (env) => {
          await db.transaction().execute(async (trx) => {
            if (!(await markProcessed(trx, durable, env.event_id))) return;
            await handler(env as never, trx as Transaction<DB>);
          });
        },
      });
    },
    async registeredServices() {
      return bus.requestOptional<string[]>("gateway.services", {}, [], { timeoutMs: 2000 });
    },
  };
  return ctx;
}

function startOutboxRelay(ctx: ServiceContext): () => void {
  let stopped = false;
  const tick = async () => {
    let sent = 0;
    do {
      sent = await claimOutbox(ctx.db, 100, async (rows) => {
        const ok: number[] = [];
        const failed: { id: number; error: string }[] = [];
        for (const row of rows) {
          try {
            const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
            if (row.subject.startsWith("qtiauth.queue.")) {
              await ctx.bus.enqueue(row.subject.slice("qtiauth.queue.".length), payload, row.event_id);
            } else {
              await ctx.bus.publishEvent(payload as EventEnvelope<unknown>);
            }
            ok.push(row.id);
          } catch (err) {
            failed.push({ id: row.id, error: (err as Error).message.slice(0, 500) });
          }
        }
        return { sent: ok, failed };
      });
    } while (sent > 0 && !stopped);
  };
  const loop = async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        ctx.log.warn({ err }, "outbox relay error");
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  };
  void loop();
  const statsTimer = setInterval(async () => {
    try {
      const s = await outboxStats(ctx.db);
      setGauge("qtiauth_outbox_backlog", s.backlog, {}, "Unsent outbox rows");
      setGauge("qtiauth_outbox_oldest_age_seconds", s.oldest_age_seconds, {}, "Age of the oldest unsent outbox row");
    } catch {
      return;
    }
  }, 15_000);
  statsTimer.unref();
  return () => {
    stopped = true;
    clearInterval(statsTimer);
  };
}

async function standardRetention(ctx: ServiceContext): Promise<Record<string, number>> {
  if (!ctx.db) return {};
  const r = ctx.config.retention;
  const processed = await sql`delete from processed_events where processed_at < ${new Date(Date.now() - r.processed_events)}`.execute(ctx.db);
  const outbox = await sql`delete from outbox where sent_at is not null and sent_at < ${new Date(Date.now() - r.outbox_sent)}`.execute(ctx.db);
  return { processed_events: Number(processed.numAffectedRows ?? 0), outbox: Number(outbox.numAffectedRows ?? 0) };
}

export async function runRetention<DB>(def: ServiceDefinition<DB>, ctx: ServiceContext<DB>): Promise<Record<string, number>> {
  const base = await standardRetention(ctx as ServiceContext);
  const own = def.retention ? await def.retention(ctx) : {};
  const result = { ...base, ...own };
  ctx.log.info({ result }, "retention sweep complete");
  return result;
}

export async function runService<DB>(def: ServiceDefinition<DB>, opts: BootOptions = {}): Promise<{ ctx: ServiceContext<DB>; stop: () => Promise<void>; app: Hono }> {
  const ctx = await bootContext(def, opts);
  startDefaultMetrics(def.name);
  initTracing(def.name, ctx.config.observability.otlp_endpoint, ctx.config.observability.trace_sample_ratio);
  await def.init?.(ctx);

  const routes: AnyRoute[] = def.routes?.(ctx) ?? [];
  const openapi = buildOpenApi(def.name, ctx.version, routes, def.policyDefaults);
  let ready = false;

  const readiness = async (): Promise<Record<string, boolean>> => {
    const checks: Record<string, boolean> = { nats: ctx.bus.connected };
    try {
      await valkeyPing(ctx.valkey);
      checks.valkey = true;
    } catch {
      checks.valkey = false;
    }
    if (ctx.db) {
      try {
        await ping(ctx.db);
        checks.postgres = true;
      } catch {
        checks.postgres = false;
      }
    }
    return checks;
  };

  const app = buildApp({
    service: def.name,
    routes,
    keyring: ctx.keyring,
    log: ctx.log,
    stepUpWindowMs: ctx.config.security.step_up_window,
    policyDefaults: def.policyDefaults,
    extra: (a) => {
      a.get("/healthz", (c) => c.json({ status: "ok", service: def.name }));
      a.get("/readyz", async (c) => {
        const checks = await readiness();
        const ok = ready && Object.values(checks).every(Boolean);
        return c.json({ status: ok ? "ready" : "not_ready", checks }, ok ? 200 : 503);
      });
      a.get("/metrics", async () => {
        const m = await renderMetrics();
        return new Response(m.body, { headers: { "content-type": m.contentType } });
      });
      a.get("/openapi.json", (c) => c.json(openapi));
      def.http?.(a, ctx);
    },
  });

  const port = Number(process.env.PORT ?? ctx.config.infrastructure.internal_port);
  const baseUrl = process.env.QTIAUTH_INTERNAL_URL ?? `http://${hostname()}:${port}`;
  let server: ServerType | null = null;
  if (def.serveHttp !== false) {
    server = serve({ fetch: app.fetch, port, hostname: process.env.LISTEN_HOST ?? "0.0.0.0" });
  }

  const stopRelay = ctx.db ? startOutboxRelay(ctx as ServiceContext) : () => undefined;

  const cronJobs: Record<string, (c: ServiceContext<DB>) => Promise<void>> = { ...(def.cron ?? {}) };
  if (!cronJobs["retention.sweep"]) {
    cronJobs["retention.sweep"] = async (c) => {
      await runRetention(def, c);
    };
  }
  await ctx.bus.consume({
    stream: "cron",
    durable: `cron-${def.name}`,
    subjects: Object.keys(cronJobs).map(cronSubject),
    ackWaitMs: 30 * 60_000,
    maxDeliver: 3,
    handler: async (env) => {
      const job = env.type.replace(/^qtiauth\.sys\.cron\./, "");
      const fn = cronJobs[job];
      if (!fn) return;
      const started = performance.now();
      try {
        await fn(ctx);
        inc("qtiauth_cron_job_runs_total", { service: def.name, job, result: "ok" }, 1, "Cron job runs");
      } catch (err) {
        inc("qtiauth_cron_job_runs_total", { service: def.name, job, result: "error" }, 1, "Cron job runs");
        ctx.log.error({ err, job }, "cron job failed");
        throw err;
      } finally {
        observe("qtiauth_cron_job_seconds", (performance.now() - started) / 1000, { service: def.name, job }, [0.1, 1, 5, 30, 60, 300, 900, 1800], "Cron job duration");
      }
    },
  });

  if (def.exportUser) {
    const exportUser = def.exportUser;
    ctx.bus.handle<{ user_id: string }, unknown>(`${def.name}.export_user`, async (req) => exportUser(ctx, req.user_id));
  }

  ctx.bus.handle<Record<string, never>, { service: string; instance: string; ready: boolean; checks: Record<string, boolean>; warnings: HealthWarning[] }>(
    `${def.name}.health`,
    async () => ({
      service: def.name,
      instance: ctx.instanceId,
      ready,
      checks: await readiness(),
      warnings: def.healthWarnings ? await def.healthWarnings(ctx) : [],
    }),
  );

  if (def.eraseUser && def.name !== "identity") {
    const erase = def.eraseUser;
    await ctx.on<{ user_id: string; legal_hold?: boolean }>("erasure", [EVENTS.userDeleted], async (env, trx) => {
      const userId = env.data.user_id ?? env.subject.id;
      await erase(ctx, userId, { legalHold: Boolean(env.data.legal_hold) });
      await ctx.emit(trx, EVENTS.userErased(def.name), { user_id: userId, service: def.name }, { subject: { type: "user", id: userId } });
    });
  }

  const manifest = (): ServiceManifest => ({
    service: def.name,
    instance_id: ctx.instanceId,
    version: ctx.version,
    base_url: baseUrl,
    started_at: new Date().toISOString(),
    routes: manifestRoutes(routes, def.policyDefaults),
    permissions: def.permissions ?? [],
    notification_categories: def.notificationCategories ?? [],
    features: def.features?.(ctx) ?? [],
    ready,
  });
  const announce = () => ctx.bus.publish(SYS_ANNOUNCE, manifest());
  ctx.bus.onDiscover(announce);
  ctx.bus.handle(`${def.name}.manifest.${ctx.instanceId}`, async () => manifest());

  await def.start?.(ctx);
  ready = true;
  announce();
  const announceTimer = setInterval(announce, 15_000);
  announceTimer.unref();
  const lagTimer = setInterval(async () => {
    try {
      for (const l of await ctx.bus.consumerLag()) {
        if (!l.consumer.startsWith(`${def.name}-`) && l.consumer !== `cron-${def.name}`) continue;
        setGauge("qtiauth_bus_consumer_pending", l.pending, { consumer: l.consumer }, "Messages waiting for a consumer");
        setGauge("qtiauth_bus_consumer_ack_pending", l.ack_pending, { consumer: l.consumer }, "Messages delivered but not yet acknowledged");
      }
    } catch {
      return;
    }
  }, 30_000);
  lagTimer.unref();
  ctx.log.info({ port, baseUrl, routes: routes.length }, `${def.name} started`);

  const stop = async () => {
    ready = false;
    clearInterval(announceTimer);
    clearInterval(lagTimer);
    ctx.bus.publish(SYS_ANNOUNCE, { ...manifest(), ready: false, stopping: true });
    stopRelay();
    await def.shutdown?.(ctx);
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await flushSpans();
    await ctx.bus.close().catch(() => undefined);
    ctx.valkey.disconnect();
    await ctx.database?.close();
  };
  return { ctx, stop, app };
}

export function main<DB>(def: ServiceDefinition<DB>): void {
  runService(def)
    .then(({ ctx, stop }) => {
      let stopping = false;
      const handler = (signal: string) => {
        if (stopping) return;
        stopping = true;
        ctx.log.info({ signal }, "shutting down");
        stop()
          .then(() => process.exit(0))
          .catch(() => process.exit(1));
        setTimeout(() => process.exit(1), 15_000).unref();
      };
      process.on("SIGTERM", () => handler("SIGTERM"));
      process.on("SIGINT", () => handler("SIGINT"));
    })
    .catch((err) => {
      const log = createLogger(def.name);
      if (err instanceof PendingMigrationsError) log.fatal({ pending: err.pending }, err.message);
      else log.fatal({ err }, `${def.name} failed to start`);
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
