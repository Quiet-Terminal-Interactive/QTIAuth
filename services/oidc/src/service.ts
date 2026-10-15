import { ProblemError } from "@qtiauth/common";
import { EVENTS } from "@qtiauth/bus";
import { defineService, KeyStore, type CliCommand } from "@qtiauth/service-kit";
import { migrations, type OidcDB } from "./db.ts";
import {
  deliverBackchannel,
  ensureFirstPartyClients,
  getClient,
  getKeys,
  hashSecret,
  issueTokens,
  newClientSecret,
  purgeExpired,
  queueBackchannel,
  revokeJtis,
  revokeRefresh,
  setKeys,
  startDeviceAuthorization,
  type Ctx,
} from "./lib.ts";
import { protocolRoutes } from "./routes/protocol.ts";
import { accountRoutes } from "./routes/account.ts";

const keysRotate: CliCommand = {
  description: "Rotate the OIDC signing key now",
  async run(_args, cli) {
    const ctx = (await cli.boot()) as Ctx;
    const store = new KeyStore({ db: ctx.db, purpose: "oidc", alg: ctx.config.oidc.id_token_alg, kek: ctx.config.secrets.key_encryption_key, rotateEveryMs: ctx.config.keys.rotate_every, overlapMs: ctx.config.keys.overlap, log: ctx.log });
    cli.print(`New OIDC signing key: ${await store.rotate("cli")}`);
    return 0;
  },
};

export const oidcService = defineService<OidcDB>({
  name: "oidc",
  schema: "oidc",
  migrations,
  permissions: ["oidc.clients.read", "oidc.clients.suspend", "oidc.clients.verify"],
  notificationCategories: [],
  policyDefaults: { module: "oidc" },
  features: (ctx) => [
    "oidc.provider",
    ...(ctx.config.features.oidc.developer_portal.enabled ? ["oidc.developer_portal"] : []),
    ...(ctx.config.features.oidc.device_flow.enabled ? ["oidc.device_flow"] : []),
    ...(ctx.config.features.oidc.backchannel_logout.enabled ? ["oidc.backchannel_logout"] : []),
  ],
  async init(ctx) {
    setKeys(new KeyStore({ db: ctx.db, purpose: "oidc", alg: ctx.config.oidc.id_token_alg, kek: ctx.config.secrets.key_encryption_key, rotateEveryMs: ctx.config.keys.rotate_every, overlapMs: ctx.config.keys.overlap, log: ctx.log }));
    await getKeys().current();
    await ensureFirstPartyClients(ctx as Ctx);
  },
  routes: (ctx) => [...protocolRoutes(ctx as Ctx), ...accountRoutes(ctx as Ctx)],
  async start(ctx) {
    const c = ctx as Ctx;
    c.bus.handle("oidc.jwks", async () => getKeys().jwks());

    c.bus.handle<{ game_id: string; slug: string; name: string; redirect_uris?: string[] }, unknown>("oidc.ensure_game_clients", async (req) => {
      const playerId = `game:${req.slug}`;
      const serverId = `game:${req.slug}:server`;
      let serverSecret: string | null = null;
      await c.db.transaction().execute(async (trx) => {
        const player = await getClient(trx, playerId);
        if (!player) {
          await trx
            .insertInto("clients")
            .values({
              id: playerId,
              name: req.name,
              description: "",
              type: "public",
              kind: "game",
              game_id: req.game_id,
              verified: true,
              redirect_uris: JSON.stringify(req.redirect_uris ?? ["http://127.0.0.1/callback"]),
              post_logout_redirect_uris: "[]",
              grant_types: JSON.stringify(["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"]),
              scopes: JSON.stringify(["openid", "profile", "offline_access", "age", "parental_controls", "restrictions", "games", "achievements", "game_stats", "achievements.write", "game_stats.write"]),
            })
            .execute();
        } else {
          await trx
            .updateTable("clients")
            .set({ name: req.name, game_id: req.game_id, ...(req.redirect_uris ? { redirect_uris: JSON.stringify(req.redirect_uris) } : {}), updated_at: new Date() })
            .where("id", "=", playerId)
            .execute();
        }
        const server = await getClient(trx, serverId);
        if (!server) {
          serverSecret = newClientSecret();
          await trx
            .insertInto("clients")
            .values({
              id: serverId,
              name: `${req.name} server`,
              description: "",
              type: "confidential",
              kind: "game_server",
              game_id: req.game_id,
              verified: true,
              secret_hash: hashSecret(serverSecret),
              redirect_uris: "[]",
              post_logout_redirect_uris: "[]",
              grant_types: JSON.stringify(["client_credentials"]),
              scopes: JSON.stringify(["games.server", "safety.intake"]),
            })
            .execute();
        }
      });
      return { client_id: playerId, server_client_id: serverId, server_secret: serverSecret };
    });

    c.bus.handle<{ slug: string }, unknown>("oidc.rotate_game_server_secret", async (req) => {
      const serverId = `game:${req.slug}:server`;
      const secret = newClientSecret();
      const r = await c.db.updateTable("clients").set({ secret_hash: hashSecret(secret), updated_at: new Date() }).where("id", "=", serverId).executeTakeFirst();
      if (!Number(r.numUpdatedRows)) throw new ProblemError(404, "CLIENT_NOT_FOUND");
      await c.db.transaction().execute((trx) => revokeJtis(c, trx, { client_id: serverId }, "secret_rotated"));
      return { server_client_id: serverId, server_secret: secret };
    });

    c.bus.handle<{ user_id: string; client_id: string; scopes: string[] }, unknown>("oidc.issue_tokens_for", async (req) => {
      const client = await getClient(c.db, req.client_id);
      if (!client || client.suspended_at) throw new ProblemError(404, "CLIENT_NOT_FOUND");
      const allowed = req.scopes.filter((s) => client.scopes.includes(s));
      return c.db.transaction().execute((trx) => issueTokens(c, trx, { client, userId: req.user_id, sessionId: null, scopes: allowed, grant: "steam_ticket", withRefresh: true, acr: "aal1", amr: ["steam"], authTime: Math.floor(Date.now() / 1000) }));
    });

    c.bus.handle<{ client_id: string; scopes: string[] }, unknown>("oidc.device_authorize", async (req) => {
      const client = await getClient(c.db, req.client_id);
      if (!client || client.suspended_at) throw new ProblemError(404, "CLIENT_NOT_FOUND");
      return startDeviceAuthorization(c, client, req.scopes.filter((s) => client.scopes.includes(s)));
    });

    c.bus.handle<{ user_id: string }, unknown>("oidc.user_apps", async (req) => {
      const rows = await c.db
        .selectFrom("consents")
        .innerJoin("clients", "clients.id", "consents.client_id")
        .select(["clients.id", "clients.name", "consents.granted_at"])
        .where("consents.user_id", "=", req.user_id)
        .execute();
      return { apps: rows.map((r) => ({ client_id: r.id, name: r.name, connected_at: r.granted_at.toISOString() })) };
    });

    c.bus.handle<{ client_id: string }, unknown>("oidc.client_info", async (req) => {
      const cl = await getClient(c.db, req.client_id);
      return cl ? { client_id: cl.id, name: cl.name, kind: cl.kind, game_id: cl.game_id, verified: cl.verified, suspended: Boolean(cl.suspended_at) } : null;
    });

    await c.on<{ session_id: string; user_id: string | null; reason: string }>("session-ended", [EVENTS.sessionRevoked], async (env, trx) => {
      if (!env.data.user_id) return;
      await revokeRefresh(trx, { session_id: env.data.session_id }, "session_ended");
      await revokeJtis(c, trx, { session_id: env.data.session_id }, "session_ended");
      await queueBackchannel(c, trx, env.data.user_id, env.data.session_id, env.data.reason);
    });

    await c.on<{ user_id: string }>("account-blocked", [EVENTS.userLocked, EVENTS.userBanned, EVENTS.userDeleted], async (env, trx) => {
      const userId = env.data.user_id ?? env.subject.id;
      await revokeRefresh(trx, { user_id: userId, include_offline: true }, env.type.split(".")[3] ?? "blocked");
      await revokeJtis(c, trx, { user_id: userId }, "account_blocked");
      await queueBackchannel(c, trx, userId, null, "account_blocked");
    });

    await c.on<{ request_id: string; child_user_id: string; type: string; approved: boolean; data: { client_id?: string; scopes?: string } }>("guardian-decisions", [EVENTS.parentalRequestDecided], async (env, trx) => {
      if (env.data.type !== "app_approval" || !env.data.data.client_id) return;
      const scopes = (env.data.data.scopes ?? "").split(" ").filter(Boolean);
      if (env.data.approved) {
        await trx
          .insertInto("consents")
          .values({ user_id: env.data.child_user_id, client_id: env.data.data.client_id, scopes: JSON.stringify(scopes), guardian_approved: true })
          .onConflict((oc) => oc.columns(["user_id", "client_id"]).doUpdateSet({ scopes: JSON.stringify(scopes), guardian_approved: true, updated_at: new Date() }))
          .execute();
        await trx.updateTable("authorization_requests").set({ status: "pending" }).where("guardian_request_id", "=", env.data.request_id).where("status", "=", "awaiting_guardian").execute();
      } else {
        await trx.updateTable("authorization_requests").set({ status: "denied" }).where("guardian_request_id", "=", env.data.request_id).execute();
      }
    });
  },
  cron: {
    "keys.rotate": async () => {
      await getKeys().rotateIfDue();
      await getKeys().prune();
    },
    "oidc.backchannel_retry": async (ctx) => {
      await deliverBackchannel(ctx as Ctx);
    },
  },
  retention: (ctx) => purgeExpired(ctx as Ctx),
  async exportUser(ctx, userId) {
    const consents = await ctx.db.selectFrom("consents").innerJoin("clients", "clients.id", "consents.client_id").select(["clients.name", "consents.client_id", "consents.scopes", "consents.granted_at", "consents.last_used_at"]).where("consents.user_id", "=", userId).execute();
    const clients = await ctx.db.selectFrom("clients").select(["id", "name", "description", "redirect_uris", "created_at"]).where("owner_user_id", "=", userId).execute();
    const tokens = await ctx.db.selectFrom("refresh_tokens").select(["client_id", "created_at", "expires_at", "revoked_at", "offline"]).where("user_id", "=", userId).execute();
    return { authorized_apps: consents, developer_clients: clients, refresh_tokens: tokens };
  },
  async eraseUser(ctx, userId) {
    await ctx.db.deleteFrom("consents").where("user_id", "=", userId).execute();
    await ctx.db.deleteFrom("refresh_tokens").where("user_id", "=", userId).execute();
    await ctx.db.deleteFrom("auth_codes").where("user_id", "=", userId).execute();
    await ctx.db.deleteFrom("device_codes").where("user_id", "=", userId).execute();
    await ctx.db.deleteFrom("session_clients").where("user_id", "=", userId).execute();
    await ctx.db.updateTable("authorization_requests").set({ user_id: null }).where("user_id", "=", userId).execute();
    await ctx.db.updateTable("issued_tokens").set({ user_id: null }).where("user_id", "=", userId).execute();
    await ctx.db.updateTable("clients").set({ deleted_at: new Date(), secret_hash: null, owner_user_id: null }).where("owner_user_id", "=", userId).execute();
  },
  async healthWarnings(ctx) {
    const w = [];
    const failing = await ctx.db.selectFrom("backchannel_deliveries").select(ctx.db.fn.countAll<number>().as("n")).where("status", "=", "failed").where("created_at", ">", new Date(Date.now() - 86_400_000)).executeTakeFirst();
    if (Number(failing?.n ?? 0) > 0) w.push({ code: "BACKCHANNEL_FAILURES", severity: "warning" as const, message: `${failing!.n} back-channel logout deliveries failed in the last 24 hours.` });
    return w;
  },
  cli: { "keys rotate": keysRotate },
});
