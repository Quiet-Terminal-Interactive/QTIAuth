import { hostname } from "node:os";
import { serve, type ServerType } from "@hono/node-server";
import { defineService } from "@qtiauth/service-kit";
import { createWebApp } from "./app.tsx";
import { accountRoutes, supportRoutes, apiSurfaceRoutes } from "./routes.ts";

let server: ServerType | null = null;

export const webService = defineService({
  name: "web",
  serveHttp: false,
  async start(ctx) {
    const app = createWebApp({
      cfg: ctx.config,
      surfaces: ctx.surfaces,
      keyring: ctx.keyring,
      log: ctx.log,
      gatewayUrl: process.env.QTIAUTH_GATEWAY_INTERNAL_URL ?? ctx.config.infrastructure.gateway_url,
      routes: { account: accountRoutes, support: supportRoutes, api: apiSurfaceRoutes },
    });
    const port = Number(process.env.PORT ?? ctx.config.infrastructure.internal_port);
    server = serve({ fetch: app.fetch, port, hostname: process.env.LISTEN_HOST ?? "0.0.0.0" });
    ctx.log.info({ port, host: hostname() }, "web listening");
  },
  async shutdown() {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  },
});
