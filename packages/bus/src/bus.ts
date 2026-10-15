import { connect } from "@nats-io/transport-node";
import { headers as natsHeaders, nanos, NoRespondersError, RequestError, TimeoutError, type Msg, type NatsConnection, type Subscription } from "@nats-io/nats-core";
import { AckPolicy, DeliverPolicy, RetentionPolicy, StorageType, jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager, type JsMsg } from "@nats-io/jetstream";
import { ProblemError, fromProblem, inc, observe, isProblemError, type Logger } from "@qtiauth/common";
import { STREAMS, rpcSubject, SYS_ANNOUNCE, SYS_DISCOVER } from "./subjects.ts";
import type { EventEnvelope } from "./envelope.ts";

export interface BusOptions {
  servers: string | string[];
  name: string;
  user?: string;
  pass?: string;
  log: Logger;
}

export class ServiceNotRunningError extends ProblemError {
  constructor(method: string) {
    super(503, "SERVICE_NOT_RUNNING", `No service is answering ${method}`);
    this.name = "ServiceNotRunningError";
  }
}

export function isServiceNotRunning(err: unknown): boolean {
  return err instanceof ServiceNotRunningError || (isProblemError(err) && err.code === "SERVICE_NOT_RUNNING");
}

export interface RpcContext {
  trace_id?: string;
  headers: Record<string, string>;
}

type RpcResponse<T> = { ok: true; data: T } | { ok: false; error: { status: number; code: string; detail?: string } & Record<string, unknown> };

export interface ConsumeOptions<T = Record<string, unknown>> {
  stream?: keyof typeof STREAMS;
  durable: string;
  subjects: string[];
  handler: (env: EventEnvelope<T>, msg: JsMsg) => Promise<void>;
  maxDeliver?: number;
  ackWaitMs?: number;
  backoffMs?: number[];
  deliverNew?: boolean;
}

export interface QueueConsumeOptions<T> {
  queue: string;
  durable: string;
  handler: (payload: T, msg: JsMsg) => Promise<void | { retryInMs: number }>;
  maxDeliver?: number;
  ackWaitMs?: number;
  concurrency?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Bus {
  readonly nc: NatsConnection;
  readonly js: JetStreamClient;
  readonly jsm: JetStreamManager;
  readonly log: Logger;
  readonly name: string;
  private readonly subs: Subscription[] = [];
  private readonly loops: Promise<void>[] = [];
  private stopping = false;
  private readonly stopFns: (() => void)[] = [];

  private constructor(nc: NatsConnection, js: JetStreamClient, jsm: JetStreamManager, log: Logger, name: string) {
    this.nc = nc;
    this.js = js;
    this.jsm = jsm;
    this.log = log;
    this.name = name;
  }

  static async connect(opts: BusOptions): Promise<Bus> {
    const nc = await connect({
      servers: opts.servers,
      name: opts.name,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1000,
      ...(opts.user ? { user: opts.user, pass: opts.pass } : {}),
    });
    const jsm = await jetstreamManager(nc);
    const js = jetstream(nc);
    const bus = new Bus(nc, js, jsm, opts.log, opts.name);
    await bus.ensureStreams();
    (async () => {
      for await (const s of nc.status()) {
        if (s.type === "disconnect" || s.type === "reconnect") opts.log.warn({ status: s.type }, "nats connection status");
        inc("qtiauth_nats_connection_events_total", { type: s.type }, 1, "NATS connection status events");
      }
    })().catch(() => undefined);
    return bus;
  }

  async ensureStreams(): Promise<void> {
    for (const s of Object.values(STREAMS)) {
      const config = {
        name: s.name,
        subjects: s.subjects,
        retention: s.retention === "workqueue" ? RetentionPolicy.Workqueue : RetentionPolicy.Limits,
        max_age: nanos(s.maxAgeMs),
        storage: StorageType.File,
        duplicate_window: nanos(120_000),
        num_replicas: 1,
      };
      try {
        await this.jsm.streams.info(s.name);
        await this.jsm.streams.update(s.name, { subjects: config.subjects, max_age: config.max_age, duplicate_window: config.duplicate_window });
      } catch {
        try {
          await this.jsm.streams.add(config);
        } catch (err) {
          if (!/already in use|exists/i.test((err as Error).message)) throw err;
        }
      }
    }
  }

  get connected(): boolean {
    return !this.nc.isClosed();
  }

  async publishEvent(env: EventEnvelope<unknown>, extraHeaders: Record<string, string> = {}): Promise<void> {
    const h = natsHeaders();
    for (const [k, v] of Object.entries(extraHeaders)) h.set(k, v);
    if (env.trace_id) h.set("trace-id", env.trace_id);
    await this.js.publish(env.type, enc.encode(JSON.stringify(env)), { msgID: env.event_id, headers: h });
    inc("qtiauth_bus_published_total", { subject: env.type }, 1, "Events published to JetStream");
  }

  async enqueue(queue: string, payload: unknown, msgId?: string): Promise<void> {
    await this.js.publish(`qtiauth.queue.${queue}`, enc.encode(JSON.stringify(payload)), msgId ? { msgID: msgId } : undefined);
    inc("qtiauth_bus_published_total", { subject: `qtiauth.queue.${queue}` }, 1, "Events published to JetStream");
  }

  publish(subject: string, data: unknown): void {
    this.nc.publish(subject, enc.encode(JSON.stringify(data)));
  }

  subscribe<T>(subject: string, handler: (data: T, msg: Msg) => void | Promise<void>, queue?: string): void {
    const sub = this.nc.subscribe(subject, {
      ...(queue ? { queue } : {}),
      callback: (err, msg) => {
        if (err) return;
        let data: T;
        try {
          data = msg.data.length ? (JSON.parse(dec.decode(msg.data)) as T) : (undefined as T);
        } catch {
          return;
        }
        Promise.resolve(handler(data, msg)).catch((e) => this.log.error({ err: e, subject }, "subscription handler failed"));
      },
    });
    this.subs.push(sub);
  }

  handle<Req, Res>(method: string, handler: (req: Req, ctx: RpcContext) => Promise<Res>, queue?: string): void {
    const subject = rpcSubject(method);
    const sub = this.nc.subscribe(subject, {
      queue: queue ?? method.split(".")[0]!,
      callback: (err, msg) => {
        if (err) return;
        const started = performance.now();
        const ctx: RpcContext = { headers: {} };
        if (msg.headers) {
          for (const [k, v] of msg.headers) ctx.headers[k] = v[0] ?? "";
          ctx.trace_id = msg.headers.get("trace-id") || undefined;
        }
        (async () => {
          let resp: RpcResponse<Res>;
          try {
            const req = msg.data.length ? (JSON.parse(dec.decode(msg.data)) as Req) : ({} as Req);
            resp = { ok: true, data: await handler(req, ctx) };
          } catch (e) {
            if (isProblemError(e)) {
              resp = { ok: false, error: { status: e.status, code: e.code, detail: e.message, ...e.extra } };
            } else {
              this.log.error({ err: e, method }, "rpc handler failed");
              resp = { ok: false, error: { status: 500, code: "INTERNAL_ERROR" } };
            }
          }
          msg.respond(enc.encode(JSON.stringify(resp)));
          observe("qtiauth_rpc_handle_seconds", (performance.now() - started) / 1000, { method, ok: resp.ok }, undefined, "RPC handler latency");
        })().catch(() => undefined);
      },
    });
    this.subs.push(sub);
  }

  async request<Res, Req = unknown>(method: string, data: Req, opts: { timeoutMs?: number; trace_id?: string } = {}): Promise<Res> {
    const started = performance.now();
    const h = natsHeaders();
    if (opts.trace_id) h.set("trace-id", opts.trace_id);
    try {
      const msg = await this.nc.request(rpcSubject(method), enc.encode(JSON.stringify(data ?? {})), { timeout: opts.timeoutMs ?? 5000, headers: h });
      const resp = JSON.parse(dec.decode(msg.data)) as RpcResponse<Res>;
      observe("qtiauth_rpc_request_seconds", (performance.now() - started) / 1000, { method }, undefined, "RPC client latency");
      if (resp.ok) return resp.data;
      throw fromProblem(resp.error);
    } catch (err) {
      if (err instanceof NoRespondersError || (err instanceof RequestError && err.isNoResponders())) {
        inc("qtiauth_rpc_no_responders_total", { method }, 1, "RPC requests with no responders");
        throw new ServiceNotRunningError(method);
      }
      if (err instanceof TimeoutError || (err as Error)?.name === "TimeoutError") {
        inc("qtiauth_rpc_timeouts_total", { method }, 1, "RPC request timeouts");
        throw new ProblemError(504, "SERVICE_TIMEOUT", `${method} timed out`);
      }
      throw err;
    }
  }

  async requestOptional<Res, Req = unknown>(method: string, data: Req, fallback: Res, opts: { timeoutMs?: number; trace_id?: string } = {}): Promise<Res> {
    try {
      return await this.request<Res, Req>(method, data, opts);
    } catch (err) {
      if (isServiceNotRunning(err)) return fallback;
      throw err;
    }
  }

  async consume<T = Record<string, unknown>>(opts: ConsumeOptions<T>): Promise<void> {
    const stream = STREAMS[opts.stream ?? "events"].name;
    const durable = opts.durable.replace(/[^A-Za-z0-9_-]/g, "_");
    const config = {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: opts.deliverNew === false ? DeliverPolicy.All : DeliverPolicy.New,
      filter_subjects: opts.subjects,
      max_deliver: opts.maxDeliver ?? 20,
      ack_wait: nanos(opts.ackWaitMs ?? 60_000),
      ...(opts.backoffMs ? { backoff: opts.backoffMs.map((ms) => nanos(ms)) } : {}),
    };
    try {
      const info = await this.jsm.consumers.info(stream, durable);
      const same = JSON.stringify([...(info.config.filter_subjects ?? [info.config.filter_subject])].sort()) === JSON.stringify([...opts.subjects].sort());
      if (!same) await this.jsm.consumers.update(stream, durable, { filter_subjects: opts.subjects, max_deliver: config.max_deliver, ack_wait: config.ack_wait });
    } catch {
      await this.jsm.consumers.add(stream, config);
    }
    const consumer = await this.js.consumers.get(stream, durable);
    const loop = (async () => {
      while (!this.stopping) {
        try {
          const messages = await consumer.consume({ max_messages: 16 });
          this.stopFns.push(() => messages.stop());
          for await (const m of messages) {
            const started = performance.now();
            let env: EventEnvelope<T>;
            try {
              env = m.json<EventEnvelope<T>>();
            } catch {
              m.term("invalid json");
              continue;
            }
            if (m.info.deliveryCount > 1) inc("qtiauth_bus_redeliveries_total", { consumer: durable }, 1, "Redelivered messages");
            try {
              await opts.handler(env, m);
              m.ack();
              inc("qtiauth_bus_consumed_total", { subject: m.subject, consumer: durable, result: "ok" }, 1, "Events consumed");
            } catch (err) {
              const delay = Math.min(60_000, 1000 * 2 ** Math.min(m.info.deliveryCount, 6));
              this.log.warn({ err, consumer: durable, subject: m.subject, event_id: env.event_id, attempt: m.info.deliveryCount }, "event handler failed");
              m.nak(delay);
              inc("qtiauth_bus_consumed_total", { subject: m.subject, consumer: durable, result: "error" }, 1, "Events consumed");
            }
            observe("qtiauth_bus_consume_seconds", (performance.now() - started) / 1000, { consumer: durable }, undefined, "Event handling latency");
            if (this.stopping) break;
          }
        } catch (err) {
          if (this.stopping) break;
          this.log.warn({ err, consumer: durable }, "consumer loop error; restarting");
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
    this.loops.push(loop);
  }

  async consumeQueue<T>(opts: QueueConsumeOptions<T>): Promise<void> {
    const stream = STREAMS.queue.name;
    const durable = opts.durable.replace(/[^A-Za-z0-9_-]/g, "_");
    const subject = `qtiauth.queue.${opts.queue}`;
    try {
      await this.jsm.consumers.info(stream, durable);
    } catch {
      await this.jsm.consumers.add(stream, {
        durable_name: durable,
        ack_policy: AckPolicy.Explicit,
        filter_subject: subject,
        max_deliver: opts.maxDeliver ?? 50,
        ack_wait: nanos(opts.ackWaitMs ?? 120_000),
      });
    }
    const consumer = await this.js.consumers.get(stream, durable);
    const loop = (async () => {
      while (!this.stopping) {
        try {
          const messages = await consumer.consume({ max_messages: opts.concurrency ?? 8 });
          this.stopFns.push(() => messages.stop());
          for await (const m of messages) {
            let payload: T;
            try {
              payload = m.json<T>();
            } catch {
              m.term("invalid json");
              continue;
            }
            try {
              const r = await opts.handler(payload, m);
              if (r && "retryInMs" in r) m.nak(r.retryInMs);
              else m.ack();
            } catch (err) {
              this.log.warn({ err, queue: opts.queue, attempt: m.info.deliveryCount }, "queue handler failed");
              m.nak(Math.min(300_000, 1000 * 2 ** Math.min(m.info.deliveryCount, 8)));
            }
            if (this.stopping) break;
          }
        } catch (err) {
          if (this.stopping) break;
          this.log.warn({ err, queue: opts.queue }, "queue loop error; restarting");
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
    this.loops.push(loop);
  }

  async consumerLag(): Promise<{ stream: string; consumer: string; pending: number; ack_pending: number; redelivered: number }[]> {
    const out: { stream: string; consumer: string; pending: number; ack_pending: number; redelivered: number }[] = [];
    for (const s of Object.values(STREAMS)) {
      try {
        for await (const c of this.jsm.consumers.list(s.name)) {
          out.push({ stream: s.name, consumer: c.name, pending: c.num_pending, ack_pending: c.num_ack_pending, redelivered: c.num_redelivered });
        }
      } catch {
        continue;
      }
    }
    return out;
  }

  onAnnounce(handler: (a: unknown) => void): void {
    this.subscribe(SYS_ANNOUNCE, handler);
  }

  onDiscover(handler: () => void): void {
    this.subscribe(SYS_DISCOVER, handler);
  }

  discover(): void {
    this.publish(SYS_DISCOVER, {});
  }

  async close(): Promise<void> {
    this.stopping = true;
    for (const f of this.stopFns) {
      try {
        f();
      } catch {
        continue;
      }
    }
    for (const s of this.subs) s.unsubscribe();
    try {
      await this.nc.drain();
    } catch {
      await this.nc.close();
    }
  }
}
