import { z } from "zod";
import { ProblemError } from "@qtiauth/common";
import { route, type AnyRoute } from "@qtiauth/service-kit";
import type { Game } from "../db.ts";
import { findGame, grantEntitlement, ownsGame, playerWrite, revokeEntitlement, type Ctx } from "../lib/core.ts";
import { SteamApi, type SteamApp, type TicketResult } from "../lib/steam.ts";

const tags = ["games", "steam"];
const DEVICE_SCOPES = ["openid", "profile", "offline_access", "games", "achievements", "game_stats", "achievements.write", "game_stats.write"];

export function steamApi(ctx: Ctx): SteamApi {
  return new SteamApi(ctx.config.features.games.steam);
}

function requireSteam(ctx: Ctx): void {
  if (!ctx.config.features.games.steam.enabled) throw new ProblemError(404, "STEAM_DISABLED");
}

async function gameForApp(ctx: Ctx, app: SteamApp): Promise<Game> {
  const g = await findGame(ctx.db, app.game_slug);
  if (!g) throw new ProblemError(404, "GAME_NOT_FOUND");
  return g;
}

async function recordStatus(ctx: Ctx, t: TicketResult, userId: string | null): Promise<void> {
  await ctx.db
    .insertInto("steam_status")
    .values({ steam_id: t.steam_id, user_id: userId, vac_banned: t.vac_banned, publisher_banned: t.publisher_banned })
    .onConflict((oc) => oc.column("steam_id").doUpdateSet({ user_id: userId, vac_banned: t.vac_banned, publisher_banned: t.publisher_banned, checked_at: new Date() }))
    .execute();
}

export async function syncSteamOwnership(ctx: Ctx, userId: string, steamId: string, onlyApp?: number): Promise<{ granted: number; revoked: number }> {
  const api = steamApi(ctx);
  let granted = 0;
  let revoked = 0;
  for (const app of ctx.config.features.games.steam.apps) {
    if (!app.sync_ownership || (onlyApp && app.app_id !== onlyApp)) continue;
    const game = await findGame(ctx.db, app.game_slug);
    if (!game) continue;
    const base = await ctx.db.selectFrom("products").selectAll().where("game_id", "=", game.id).where("kind", "=", "base").executeTakeFirst();
    if (!base) continue;
    const o = await api.checkOwnership(app.app_id, steamId);
    const ownsOutright = o.owns && (!o.owner_steam_id || o.owner_steam_id === steamId);
    await ctx.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom("entitlements").selectAll().where("user_id", "=", userId).where("product_id", "=", base.id).where("source", "=", "steam").where("revoked_at", "is", null).executeTakeFirst();
      if (ownsOutright && !existing) {
        await grantEntitlement(ctx, trx, { user_id: userId, product: base, source: "steam", source_ref: String(app.app_id) }, { type: "system", id: "steam-sync" });
        granted++;
      } else if (!ownsOutright && existing) {
        await revokeEntitlement(ctx, trx, existing, "steam_ownership_lost", null, { type: "system", id: "steam-sync" });
        revoked++;
      }
    });
  }
  return { granted, revoked };
}

export async function revokeSteamEntitlements(ctx: Ctx, userId: string, reason: string): Promise<void> {
  const ents = await ctx.db.selectFrom("entitlements").selectAll().where("user_id", "=", userId).where("source", "=", "steam").where("revoked_at", "is", null).execute();
  await ctx.db.transaction().execute(async (trx) => {
    for (const e of ents) await revokeEntitlement(ctx, trx, e, reason, null, { type: "system", id: "steam" });
  });
}

export async function nightlySteamSync(ctx: Ctx): Promise<void> {
  if (!ctx.config.features.games.steam.enabled || !ctx.config.features.games.steam.apps.some((a) => a.sync_ownership)) return;
  let cursor: string | null = null;
  do {
    const page: { items: { user_id: string; subject: string }[]; next_cursor: string | null } = await ctx.rpc("identity.users_with_identity", { with_identity: "steam", cursor, limit: 500 }, { timeoutMs: 30_000 });
    for (const u of page.items) {
      await syncSteamOwnership(ctx, u.user_id, u.subject).catch((err) => ctx.log.warn({ err: (err as Error).message }, "steam ownership sync failed for a user"));
    }
    cursor = page.next_cursor;
  } while (cursor);
}

export function steamRoutes(ctx: Ctx): AnyRoute[] {
  return [
    route({
      method: "POST",
      path: "/api/v1/games/steam/authenticate",
      summary: "Authenticate a Steam session ticket",
      description:
        "Send the hex ticket from ISteamUser::GetAuthTicketForWebApi(identity). Works with the game server credential or without credentials (rate-limited per app). " +
        "If the Steam account isn't linked, the response carries a device-flow code so the player can link now. With issue_tokens, a linked player gets an OIDC token set without a browser.",
      tags,
      auth: ["service", "none"],
      rate_limit: ["steam_authenticate"],
      rate_limit_keys: { app: "app_id" },
      body: z.object({ app_id: z.number().int().positive(), ticket: z.string().regex(/^[0-9A-Fa-f]{16,4096}$/), issue_tokens: z.boolean().default(false) }),
      async handler({ body, id }) {
        requireSteam(ctx);
        const api = steamApi(ctx);
        const app = api.app(body.app_id);
        const game = await gameForApp(ctx, app);
        if (id.auth === "service" && id.game_id && id.game_id !== game.id) throw new ProblemError(403, "WRONG_GAME");
        const t = await api.authenticateTicket(app, body.ticket);
        const familyShared = t.owner_steam_id !== t.steam_id;
        if (familyShared && app.family_sharing === "deny") throw new ProblemError(403, "FAMILY_SHARING_DENIED");
        const link = await ctx.rpcOptional<{ user_id: string } | null>("identity.find_by_identity", { type: "steam", subject: t.steam_id }, null);
        await recordStatus(ctx, t, link?.user_id ?? null);
        const steamEntitled = !familyShared || app.family_sharing === "allow";
        const entitled = steamEntitled || (link ? await ownsGame(ctx.db, link.user_id, game.id) : false);
        let tokens: unknown = null;
        let deviceCode: unknown = null;
        if (link && body.issue_tokens) {
          if (!app.allow_token_issue || !game.client_id) throw new ProblemError(403, "TOKEN_ISSUE_NOT_ALLOWED");
          const user = await ctx.rpc<{ state?: string } | null>("identity.resolve_user", { user_id: link.user_id });
          if (!user || user.state !== "active") throw new ProblemError(403, "ACCOUNT_UNAVAILABLE");
          tokens = await ctx.rpc("oidc.issue_tokens_for", { user_id: link.user_id, client_id: game.client_id, scopes: DEVICE_SCOPES });
        } else if (!link && game.client_id) {
          deviceCode = await ctx.rpcOptional("oidc.device_authorize", { client_id: game.client_id, scopes: DEVICE_SCOPES }, null).catch(() => null);
        }
        return {
          valid: true,
          steam_id: t.steam_id,
          owner_steam_id: t.owner_steam_id,
          family_shared: familyShared,
          vac_banned: t.vac_banned,
          publisher_banned: t.publisher_banned,
          user_id: link?.user_id ?? null,
          entitled,
          device_code: deviceCode,
          ...(tokens ? { tokens } : {}),
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/steam/link",
      summary: "Link the player's Steam account from inside the game",
      description: "After a device-flow sign-in, the game sends a fresh ticket with the player's token to link Steam. One Steam account links to one account.",
      tags,
      auth: "oauth",
      rate_limit: ["steam_authenticate"],
      rate_limit_keys: { app: "app_id" },
      body: z.object({ app_id: z.number().int().positive(), ticket: z.string().regex(/^[0-9A-Fa-f]{16,4096}$/) }),
      async handler({ body, id }) {
        requireSteam(ctx);
        const api = steamApi(ctx);
        const app = api.app(body.app_id);
        const game = await gameForApp(ctx, app);
        const p = playerWrite(id, game, { allowGameAuthority: false });
        const t = await api.authenticateTicket(app, body.ticket);
        const r = await ctx.rpc<{ status: string }>("identity.link_steam", { user_id: p.userId, steam_id: t.steam_id, ip: id.ip });
        await recordStatus(ctx, t, p.userId);
        const sync = await syncSteamOwnership(ctx, p.userId, t.steam_id).catch(() => ({ granted: 0, revoked: 0 }));
        return { status: r.status, steam_id: t.steam_id, ownership: sync };
      },
    }),
  ];
}
