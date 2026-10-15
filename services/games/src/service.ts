import { sql } from "kysely";
import { isUuid, uuidv7 } from "@qtiauth/common";
import { EVENTS } from "@qtiauth/bus";
import { defineService, type CliCommand } from "@qtiauth/service-kit";
import type { ParentalControls, AgeBand } from "@qtiauth/auth-context";
import { migrations, type GamesDB } from "./db.ts";
import { periodFor, type Ctx } from "./lib/core.ts";
import { licensingKeys } from "./lib/licensing.ts";
import { catalogRoutes } from "./routes/catalog.ts";
import { playerRoutes } from "./routes/player.ts";
import { applyPrefsFromUser, ownershipRoutes, userEntitlementsSummary } from "./routes/ownership.ts";
import { licensingRoutes } from "./routes/licensing.ts";
import { savesRoutes } from "./routes/saves.ts";
import { nightlySteamSync, revokeSteamEntitlements, steamRoutes, syncSteamOwnership } from "./routes/steam.ts";

async function recomputeRarity(ctx: Ctx): Promise<void> {
  const games = await ctx.db.selectFrom("games").select("id").where("deleted_at", "is", null).execute();
  for (const g of games) {
    const players = await sql<{ n: number }>`
      select count(*)::int as n from (
        select user_id from entitlements where game_id = ${g.id} and revoked_at is null
        union select user_id from achievement_unlocks where game_id = ${g.id}
        union select user_id from playtime_daily where game_id = ${g.id}
      ) p`.execute(ctx.db);
    const total = players.rows[0]?.n ?? 0;
    await sql`
      update achievements a set rarity_computed_at = now(), rarity_percent = case when ${total}::int = 0 then null else round((
        select count(*) from achievement_unlocks u where u.achievement_id = a.id and u.unlocked_at is not null and u.revoked_at is null
      ) * 1000.0 / ${total}::int) / 10.0 end
      where a.game_id = ${g.id} and a.deleted_at is null`.execute(ctx.db);
  }
}

async function resetLeaderboards(ctx: Ctx): Promise<void> {
  const boards = await ctx.db.selectFrom("leaderboards").selectAll().where("deleted_at", "is", null).execute();
  for (const lb of boards) {
    const next = periodFor(lb.reset_period);
    if (next !== lb.current_period) await ctx.db.updateTable("leaderboards").set({ current_period: next, period_started_at: new Date() }).where("id", "=", lb.id).execute();
  }
}

async function closeStalePlaytime(ctx: Ctx): Promise<number> {
  const r = await ctx.db.updateTable("playtime_sessions").set({ ended_at: sql`last_heartbeat_at` }).where("ended_at", "is", null).where("last_heartbeat_at", "<", new Date(Date.now() - 2 * ctx.config.games.playtime_heartbeat_max_gap)).executeTakeFirst();
  return Number(r.numUpdatedRows);
}

async function refreshUser(ctx: Ctx, userId: string): Promise<void> {
  const u = await ctx.rpcOptional<{ age_band?: AgeBand | null; parental_controls?: ParentalControls | null } | null>("identity.resolve_user", { user_id: userId }, null);
  if (u) await applyPrefsFromUser(ctx, userId, u);
}

const keysRotate: CliCommand = {
  description: "Rotate the game licensing key now",
  async run(_args, cli) {
    const ctx = (await cli.boot()) as Ctx;
    cli.print(`New licensing key: ${await licensingKeys(ctx).rotate("cli")}`);
    return 0;
  },
};

const steamSync: CliCommand = {
  description: "Run the Steam ownership sync now",
  async run(_args, cli) {
    const ctx = (await cli.boot()) as Ctx;
    await nightlySteamSync(ctx);
    cli.print("Steam ownership sync complete");
    return 0;
  },
};

export const gamesService = defineService<GamesDB>({
  name: "games",
  schema: "games",
  migrations,
  permissions: ["games.catalog.edit", "games.entitlements.grant", "games.keys.manage", "games.achievements.moderate", "games.leaderboards.moderate", "games.licensing.manage"],
  policyDefaults: { module: "games" },
  features: (ctx) => {
    const f = ctx.config.features.games;
    return [
      "games.catalog",
      "games.entitlements",
      ...(f.keys.enabled ? ["games.keys"] : []),
      ...(f.achievements.enabled ? ["games.achievements"] : []),
      ...(f.stats.enabled ? ["games.stats"] : []),
      ...(f.leaderboards.enabled ? ["games.leaderboards"] : []),
      ...(f.playtime.enabled ? ["games.playtime"] : []),
      ...(f.cloud_saves.enabled && ctx.storage ? ["games.cloud_saves"] : []),
      ...(f.licensing.enabled ? ["games.licensing"] : []),
      ...(f.steam.enabled ? ["games.steam"] : []),
    ];
  },
  async init(ctx) {
    if (ctx.config.features.games.licensing.enabled) await licensingKeys(ctx as Ctx).current();
    if (ctx.storage) await ctx.storage.ensureBucket().catch((err) => ctx.log.warn({ err }, "could not ensure storage bucket"));
  },
  routes: (ctx) => {
    const c = ctx as Ctx;
    return [...ownershipRoutes(c), ...licensingRoutes(c), ...steamRoutes(c), ...savesRoutes(c), ...playerRoutes(c), ...catalogRoutes(c)];
  },
  async start(ctx) {
    const c = ctx as Ctx;
    c.bus.handle<{ user_id: string }, unknown>("games.user_entitlements", async (req) => (isUuid(req.user_id) ? userEntitlementsSummary(c, req.user_id) : { items: [] }));

    c.bus.handle<{ user_id: string; since: string }, unknown>("games.activity_summary", async (req) => {
      if (!isUuid(req.user_id)) return { games: [] };
      const since = new Date(req.since).toISOString().slice(0, 10);
      const rows = await c.db
        .selectFrom("playtime_daily")
        .innerJoin("games", "games.id", "playtime_daily.game_id")
        .select(["games.slug", "games.name", sql<number>`sum(playtime_daily.seconds)::int`.as("seconds"), sql<string>`max(playtime_daily.day)::text`.as("last_day")])
        .where("playtime_daily.user_id", "=", req.user_id)
        .where("playtime_daily.day", ">=", since)
        .groupBy(["games.slug", "games.name"])
        .execute();
      return { games: rows.map((r) => ({ slug: r.slug, name: r.name, playtime_minutes: Math.round(r.seconds / 60), last_played_at: r.last_day })) };
    });

    await c.on<{ user_id?: string; reason?: string; steam_id?: string }>("user-changes", [EVENTS.userUpdated, EVENTS.userAgeBandChanged, EVENTS.parentalControlsChanged, EVENTS.parentalGraduated], async (env) => {
      const userId = env.data.user_id ?? (env.data as { child_user_id?: string }).child_user_id ?? (env.subject.type === "user" ? env.subject.id : null);
      if (!userId) return;
      if (env.data.reason === "steam_linked" && env.data.steam_id && c.config.features.games.steam.enabled) {
        await syncSteamOwnership(c, userId, env.data.steam_id).catch((err) => c.log.warn({ err: (err as Error).message }, "steam sync on link failed"));
        return;
      }
      if (env.data.reason === "steam_unlinked") {
        await revokeSteamEntitlements(c, userId, "steam_unlinked");
        return;
      }
      await refreshUser(c, userId);
    });

    await c.on<{ action_id: string; game_id: string | null; user_id: string | null; content: Record<string, unknown> | null }>("content-removal", [EVENTS.safetyContentRemovalRequested], async (env, trx) => {
      const gameId = env.data.game_id;
      if (!gameId || !isUuid(gameId)) return;
      const game = await trx.selectFrom("games").select("id").where("id", "=", gameId).executeTakeFirst();
      if (!game) return;
      await trx
        .insertInto("removal_requests")
        .values({ id: uuidv7(), game_id: game.id, action_id: env.data.action_id, user_id: env.data.user_id, content: JSON.stringify(env.data.content ?? {}) })
        .onConflict((oc) => oc.column("action_id").doNothing())
        .execute();
    });
  },
  cron: {
    "keys.rotate": async (ctx) => {
      if (!ctx.config.features.games.licensing.enabled) return;
      await licensingKeys(ctx as Ctx).rotateIfDue();
      await licensingKeys(ctx as Ctx).prune();
    },
    "achievements.recompute_rarity": (ctx) => recomputeRarity(ctx as Ctx),
    "leaderboards.reset_periodic": (ctx) => resetLeaderboards(ctx as Ctx),
    "steam.ownership_sync": (ctx) => nightlySteamSync(ctx as Ctx),
  },
  async retention(ctx) {
    const c = ctx as Ctx;
    const stale = await closeStalePlaytime(c);
    const abandoned = await c.db.selectFrom("cloud_versions").select(["id", "storage_key"]).where("status", "=", "pending").where("created_at", "<", new Date(Date.now() - 86_400_000)).limit(1000).execute();
    for (const v of abandoned) await c.storage?.delete(v.storage_key).catch(() => undefined);
    if (abandoned.length) await c.db.deleteFrom("cloud_versions").where("id", "in", abandoned.map((v) => v.id)).execute();
    const leases = await c.db.deleteFrom("leases").where("expires_at", "<", new Date(Date.now() - 30 * 86_400_000)).executeTakeFirst();
    return { stale_playtime_sessions: stale, abandoned_uploads: abandoned.length, expired_leases: Number(leases.numDeletedRows) };
  },
  async exportUser(ctx, userId) {
    const c = ctx as Ctx;
    const [ents, unlocks, stats, data, playtime, saves, devices] = await Promise.all([
      userEntitlementsSummary(c, userId),
      c.db.selectFrom("achievement_unlocks").innerJoin("achievements", "achievements.id", "achievement_unlocks.achievement_id").select(["achievements.key", "achievement_unlocks.game_id", "achievement_unlocks.progress", "achievement_unlocks.unlocked_at"]).where("achievement_unlocks.user_id", "=", userId).execute(),
      c.db.selectFrom("user_stats").innerJoin("stats", "stats.id", "user_stats.stat_id").select(["stats.key", "user_stats.game_id", "user_stats.value", "user_stats.updated_at"]).where("user_stats.user_id", "=", userId).execute(),
      c.db.selectFrom("custom_data").select(["game_id", "data", "updated_at"]).where("user_id", "=", userId).execute(),
      c.db.selectFrom("playtime_daily").selectAll().where("user_id", "=", userId).execute(),
      c.db.selectFrom("cloud_slots").select(["game_id", "slot", "current_version", "size", "updated_at"]).where("user_id", "=", userId).execute(),
      c.db.selectFrom("devices").select(["game_id", "name", "first_seen_at", "last_seen_at"]).where("user_id", "=", userId).execute(),
    ]);
    return { entitlements: ents.items, achievements: unlocks, stats, custom_data: data, playtime_daily: playtime, cloud_saves: saves, devices };
  },
  async eraseUser(ctx, userId) {
    const c = ctx as Ctx;
    if (c.storage) {
      const games = await c.db.selectFrom("cloud_slots").select("game_id").distinct().where("user_id", "=", userId).execute();
      for (const g of games) await c.storage.deletePrefix(`games/${g.game_id}/saves/${userId}/`).catch(() => undefined);
    }
    await c.db.transaction().execute(async (trx) => {
      for (const table of ["cloud_versions", "cloud_slots", "custom_data", "user_stats", "achievement_unlocks", "leaderboard_entries", "playtime_sessions", "playtime_daily", "devices", "leases", "player_prefs"] as const) {
        await trx.deleteFrom(table).where("user_id", "=", userId).execute();
      }
      await trx.updateTable("steam_status").set({ user_id: null }).where("user_id", "=", userId).execute();
      await trx.updateTable("keys").set({ redeemed_by: null }).where("redeemed_by", "=", userId).execute();
      await trx.deleteFrom("entitlements").where("user_id", "=", userId).execute();
      await trx.updateTable("removal_requests").set({ user_id: null }).where("user_id", "=", userId).execute();
    });
  },
  async healthWarnings(ctx) {
    const w = [];
    if (ctx.config.features.games.cloud_saves.enabled && !ctx.storage) w.push({ code: "CLOUD_SAVES_NEED_STORAGE", severity: "error" as const, message: "Cloud saves are enabled but no object storage is configured." });
    if (!ctx.config.secrets.app_encryption_key) w.push({ code: "KEYS_NEED_ENCRYPTION_KEY", severity: "warning" as const, message: "APP_ENCRYPTION_KEY is not set, so product key batches cannot be generated or exported." });
    const unlinkedApps = [];
    for (const app of ctx.config.features.games.steam.enabled ? ctx.config.features.games.steam.apps : []) {
      const g = await ctx.db.selectFrom("games").select("id").where("slug", "=", app.game_slug).where("deleted_at", "is", null).executeTakeFirst();
      if (!g) unlinkedApps.push(app.app_id);
    }
    if (unlinkedApps.length) w.push({ code: "STEAM_APP_GAME_MISSING", severity: "warning" as const, message: `Steam app(s) ${unlinkedApps.join(", ")} point at games that don't exist.` });
    return w;
  },
  cli: { "steam sync": steamSync, "keys rotate": keysRotate },
});
