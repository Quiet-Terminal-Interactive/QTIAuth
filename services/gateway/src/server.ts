import { hostname } from "node:os";
import { serve, type ServerType } from "@hono/node-server";
import type { IncomingMessage } from "node:http";
import { createLogger, renderMetrics, safeEqual, startDefaultMetrics, ulid, inc, type Logger } from "@qtiauth/common";
import { apiResource, issuer, loadConfig, resolveSurfaces, type LoadedConfig } from "@qtiauth/config";
import { Bus, EVENTS, SYS_ANNOUNCE, cronSubject, type EventEnvelope } from "@qtiauth/bus";
import { createValkey, initTracing, type Valkey } from "@qtiauth/service-kit";
import type { ServiceManifest } from "@qtiauth/auth-context";
import { Registry } from "./registry.ts";
import { RateLimiter } from "./ratelimit.ts";
import { Captcha } from "./captcha.ts";
import { GeoIp } from "./geoip.ts";
import { SessionResolver } from "./session.ts";
import { AccessTokenVerifier } from "./tokens.ts";
import { InternalKeys } from "./keys.ts";
import { Gateway } from "./gateway.ts";
import { Meta } from "./meta.ts";

export interface GatewayHandle {
  gateway: Gateway;
  registry: Registry;
  bus: Bus;
  valkey: Valkey;
  config: LoadedConfig;
  log: Logger;
  keys: InternalKeys;
  ports: number[];
  internalPort: number;
  stop(): Promise<void>;
}

export interface GatewayOptions {
  config?: LoadedConfig;
  ports?: number[];
  internalPort?: number;
}

export async function startGateway(opts: GatewayOptions = {}): Promise<GatewayHandle> {
  const config = opts.config ?? loadConfig();
  const log = createLogger("gateway", config.observability.log_level);
  startDefaultMetrics("gateway");
  initTracing("gateway", config.observability.otlp_endpoint, config.observability.trace_sample_ratio);
  const surfaces = resolveSurfaces(config);
  const bus = await Bus.connect({ servers: config.infrastructure.nats_url, name: "qtiauth-gateway", user: config.infrastructure.nats_user, pass: config.infrastructure.nats_password, log });
  const valkey = createValkey(config.infrastructure.valkey_url);
  const registry = new Registry();
  const keys = new InternalKeys(config.keys.rotate_every, log);
  await keys.init();
  const geoip = new GeoIp(config, log);
  await geoip.init();
  const captcha = new Captcha(config, valkey);
  const sessions = new SessionResolver(bus, valkey);
  const tokens = new AccessTokenVerifier(bus, valkey, issuer(config), apiResource(config));
  const meta = new Meta({ cfg: config, surfaces, registry, captcha, geoip, bus, valkey, log });
  const gateway = new Gateway({ cfg: config, surfaces, log, bus, valkey, registry, limiter: new RateLimiter(valkey), captcha, geoip, sessions, tokens, keys, meta: (r) => meta.handle(r) });
  const instanceId = `gateway-${hostname()}-${ulid().slice(-6)}`;

  bus.onAnnounce((m) => registry.upsert(m as ServiceManifest & { stopping?: boolean }));
  const expiry = setInterval(() => registry.expire(), 10_000);
  expiry.unref();

  const announce = () =>
    bus.publish(SYS_ANNOUNCE, {
      service: "gateway",
      instance_id: instanceId,
      version: process.env.QTIAUTH_VERSION ?? "1.0.0",
      base_url: "",
      started_at: new Date().toISOString(),
      routes: [],
      permissions: [],
      notification_categories: [],
      features: [],
      jwks: { keys: keys.publicKeys() },
      ready: true,
    });
  keys.listen(announce);
  bus.onDiscover(announce);
  const announceTimer = setInterval(announce, 15_000);
  announceTimer.unref();

  bus.nc.subscribe("qtiauth.rpc.gateway.key.*", {
    callback: (err, msg) => {
      if (err) return;
      const kid = msg.subject.split(".").pop()!;
      const jwk = keys.find(kid);
      if (jwk) msg.respond(new TextEncoder().encode(JSON.stringify({ ok: true, data: jwk })));
    },
  });
  bus.handle("gateway.services", async () => registry.running());
  bus.handle("gateway.permissions", async () => registry.permissions());
  bus.handle("gateway.notification_categories", async () => registry.notificationCategories());
  bus.handle("gateway.consistency", async () => meta.consistencyErrors());

  await bus.consume<Record<string, unknown>>({
    durable: "gateway-cache",
    subjects: [
      EVENTS.sessionRevoked,
      EVENTS.sessionFlagged,
      "qtiauth.identity.user.>",
      EVENTS.rolesChanged,
      EVENTS.parentalControlsChanged,
      EVENTS.parentalConsentGranted,
      EVENTS.parentalConsentRevoked,
      EVENTS.oidcTokenRevoked,
      EVENTS.oidcClientSuspended,
    ],
    handler: async (env: EventEnvelope<Record<string, unknown>>) => {
      const d = env.data;
      if (env.type === EVENTS.sessionRevoked || env.type === EVENTS.sessionFlagged) {
        if (typeof d.session_id === "string") {
          await sessions.bustSession(d.session_id);
          if (env.type === EVENTS.sessionRevoked) await valkey.set(`gw:revoked:sid:${d.session_id}`, "1", "PX", config.oidc.access_token_ttl).catch(() => undefined);
        }
        if (typeof d.user_id === "string") await sessions.bustUser(d.user_id);
        return;
      }
      if (env.type === EVENTS.oidcTokenRevoked) {
        for (const jti of (d.jtis as string[] | undefined) ?? (typeof d.jti === "string" ? [d.jti] : [])) {
          await valkey.set(`gw:revoked:jti:${jti}`, "1", "PX", config.oidc.access_token_ttl + 60_000).catch(() => undefined);
        }
        return;
      }
      if (env.type === EVENTS.oidcClientSuspended) {
        if (typeof d.client_id === "string") {
          if (d.suspended === false) await valkey.del(`gw:client_suspended:${d.client_id}`).catch(() => undefined);
          else await valkey.set(`gw:client_suspended:${d.client_id}`, "1").catch(() => undefined);
        }
        return;
      }
      const userId = (typeof d.user_id === "string" ? d.user_id : null) ?? (typeof d.child_user_id === "string" ? d.child_user_id : null) ?? (env.subject.type === "user" ? env.subject.id : null);
      if (userId) await sessions.bustUser(userId);
    },
  });

  await bus.consume({
    stream: "cron",
    durable: "cron-gateway",
    subjects: [cronSubject("keys.rotate")],
    handler: async () => {
      await keys.rotateIfDue();
    },
  });

  const ports = opts.ports ?? [...new Set([...(config.network.listen.length ? config.network.listen : [Number(process.env.PORT ?? 8080)]), ...Object.values(surfaces).flatMap((s) => s.ports)])];
  const internalPort = opts.internalPort ?? Number(process.env.GATEWAY_INTERNAL_PORT ?? 8081);
  const servers: ServerType[] = [];
  const host = process.env.LISTEN_HOST ?? "0.0.0.0";
  for (const port of ports) {
    servers.push(
      serve({
        port,
        hostname: host,
        fetch: (req: Request, env: { incoming: IncomingMessage }) => gateway.handle(req, env.incoming.socket.remoteAddress, port, false, env.incoming.socket.remotePort),
      } as never),
    );
  }
  servers.push(
    serve({
      port: internalPort,
      hostname: host,
      fetch: async (req: Request, env: { incoming: IncomingMessage }) => {
        const path = new URL(req.url).pathname;
        if (path === "/metrics") {
          const token = config.network.metrics_token;
          const auth = req.headers.get("authorization") ?? "";
          const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
          if (!token || !provided || !safeEqual(provided, token)) return new Response(null, { status: 404 });
          const m = await renderMetrics();
          return new Response(m.body, { headers: { "content-type": m.contentType } });
        }
        return gateway.handle(req, env.incoming.socket.remoteAddress, internalPort, true);
      },
    } as never),
  );

  bus.discover();
  announce();
  inc("qtiauth_gateway_starts_total", {}, 1, "Gateway starts");
  log.info({ ports, internalPort, surfaces: Object.fromEntries(Object.values(surfaces).map((s) => [s.name, s.origins])) }, "gateway started");

  return {
    gateway,
    registry,
    bus,
    valkey,
    config,
    log,
    keys,
    ports,
    internalPort,
    async stop() {
      clearInterval(expiry);
      clearInterval(announceTimer);
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await bus.close().catch(() => undefined);
      valkey.disconnect();
    },
  };
}

