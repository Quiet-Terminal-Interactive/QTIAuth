import { z } from "zod";
import { ProblemError, uuidv7 } from "@qtiauth/common";
import { route, type AnyRoute, zSlug, zUuidParam } from "@qtiauth/service-kit";
import { EVENTS } from "@qtiauth/bus";
import type { Achievement, Game, GameSettings, Leaderboard, Stat } from "../db.ts";
import { PUBLIC_STATUSES, findGame, periodFor, requireGame, requiresGameAuthority, validResetPeriod, type Ctx } from "../lib/core.ts";

const tags = ["games"];
const adminTags = ["admin", "games"];
const catalog = (extra: { step_up?: boolean } = {}) => ({ auth: "session" as const, permissions: ["games.catalog.edit"], rate_limit: ["admin"], step_up: extra.step_up ?? false });
const zSlugParam = z.object({ slug: zSlug });
const zSlugId = z.object({ slug: zSlug, id: z.uuid() });
export const RESERVED_SLUGS = new Set(["owned", "devices", "keys", "licensing", "steam", "server", "leaderboards", "entitlements", "key-batches", "admin"]);
const zKey = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const zUrl = z.url().max(2000).nullable().optional();

const zSettings = z
  .object({
    lease_duration: z.string().regex(/^\d+[smhdw]$/).nullable().optional(),
    device_binding: z.boolean().optional(),
    max_devices: z.number().int().min(1).max(100).nullable().optional(),
    cloud_slots: z.number().int().min(0).max(100).nullable().optional(),
    cloud_slot_bytes: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
    require_game_authority: z.boolean().nullable().optional(),
    redirect_uris: z.array(z.string().max(2000)).max(20).optional(),
  })
  .partial();

function parseShortDuration(v: string): number {
  const n = Number(v.slice(0, -1));
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[v.slice(-1)]!;
  return n * unit;
}

function mergeSettings(current: GameSettings, input: z.output<typeof zSettings> | undefined): GameSettings {
  if (!input) return current;
  const { lease_duration, ...rest } = input;
  return { ...current, ...rest, ...(lease_duration !== undefined ? { lease_duration_ms: lease_duration ? parseShortDuration(lease_duration) : null } : {}) };
}

export function gameView(g: Game) {
  return { id: g.id, slug: g.slug, name: g.name, description: g.description, status: g.status, icon_url: g.icon_url, art: g.art };
}

export function achievementView(a: Achievement, opts: { reveal: boolean }) {
  const masked = a.hidden && !opts.reveal;
  return {
    key: a.key,
    name: masked ? "Hidden achievement" : a.name,
    description: masked ? "" : a.description,
    icon_url: masked ? a.locked_icon_url : a.icon_url,
    locked_icon_url: a.locked_icon_url,
    points: a.points,
    hidden: a.hidden,
    progress_target: a.progress_target,
    rarity_percent: a.rarity_percent,
  };
}

export function statView(s: Stat) {
  return { id: s.id, key: s.key, name: s.name, type: s.type, aggregation: s.aggregation, max_delta: s.max_delta, authority: s.authority, default_value: s.default_value };
}

export function leaderboardView(l: Leaderboard, statKey?: string) {
  return { id: l.id, key: l.key, name: l.name, sort: l.sort, reset_period: l.reset_period, current_period: l.current_period, stat_key: statKey };
}

export function catalogRoutes(ctx: Ctx): AnyRoute[] {
  async function adminGame(slug: string): Promise<Game> {
    const g = await findGame(ctx.db, slug);
    if (!g) throw new ProblemError(404, "GAME_NOT_FOUND");
    return g;
  }

  return [
    route({
      method: "GET",
      path: "/api/v1/games",
      summary: "Published games",
      tags,
      auth: ["none", "oauth"],
      session_optional: true,
      rate_limit: ["public_read"],
      async handler() {
        const rows = await ctx.db.selectFrom("games").selectAll().where("deleted_at", "is", null).where("status", "in", [...PUBLIC_STATUSES]).orderBy("name").execute();
        return { items: rows.map(gameView) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/games/:slug",
      summary: "A game, its products, achievements and leaderboards",
      tags,
      auth: ["none", "oauth"],
      session_optional: true,
      rate_limit: ["public_read"],
      params: zSlugParam,
      async handler({ params }) {
        const g = await requireGame(ctx.db, params.slug);
        const [products, achievements, leaderboards] = await Promise.all([
          ctx.db.selectFrom("products").select(["id", "sku", "name", "kind", "description"]).where("game_id", "=", g.id).where("retired_at", "is", null).orderBy("kind").orderBy("name").execute(),
          ctx.db.selectFrom("achievements").selectAll().where("game_id", "=", g.id).where("deleted_at", "is", null).orderBy("sort_order").orderBy("name").execute(),
          ctx.db
            .selectFrom("leaderboards")
            .innerJoin("stats", "stats.id", "leaderboards.stat_id")
            .selectAll("leaderboards")
            .select("stats.key as stat_key")
            .where("leaderboards.game_id", "=", g.id)
            .where("leaderboards.deleted_at", "is", null)
            .execute(),
        ]);
        return {
          ...gameView(g),
          products,
          achievements: achievements.map((a) => achievementView(a, { reveal: false })),
          achievement_points: achievements.reduce((n, a) => n + a.points, 0),
          leaderboards: ctx.config.features.games.leaderboards.enabled ? leaderboards.map((l) => leaderboardView(l, l.stat_key)) : [],
        };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/games",
      summary: "All games, including drafts",
      tags: adminTags,
      auth: "session",
      permissions: ["games.catalog.edit"],
      rate_limit: ["admin"],
      async handler() {
        const rows = await ctx.db.selectFrom("games").selectAll().where("deleted_at", "is", null).orderBy("name").execute();
        return { items: rows.map((g) => ({ ...gameView(g), settings: g.settings, client_id: g.client_id, server_client_id: g.server_client_id, created_at: g.created_at.toISOString() })) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games",
      summary: "Create a game",
      description: "Creates the base product and, when the OIDC service is running, the game's player client and its confidential server client. The server secret is shown once.",
      tags: adminTags,
      ...catalog(),
      body: z.object({
        slug: zSlug,
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(5000).default(""),
        status: z.enum(["draft", "hidden", "early_access", "released", "archived"]).default("draft"),
        icon_url: zUrl,
        art: z.record(z.string(), z.url().max(2000)).default({}),
        settings: zSettings.optional(),
      }),
      async handler({ body, id }) {
        if (RESERVED_SLUGS.has(body.slug) || (await ctx.db.selectFrom("games").select("id").where("slug", "=", body.slug).executeTakeFirst())) throw new ProblemError(409, "SLUG_TAKEN");
        const gameId = uuidv7();
        const settings = mergeSettings({}, body.settings);
        await ctx.db.transaction().execute(async (trx) => {
          await trx.insertInto("games").values({ id: gameId, slug: body.slug, name: body.name, description: body.description, status: body.status, icon_url: body.icon_url ?? null, art: JSON.stringify(body.art), settings: JSON.stringify(settings) }).execute();
          await trx.insertInto("products").values({ id: uuidv7(), game_id: gameId, sku: body.slug, name: body.name, kind: "base", description: "" }).execute();
          await ctx.emit(trx, EVENTS.gamesGameCreated, { game_id: gameId, slug: body.slug }, { actor: { type: "staff", id: id.sub! }, subject: { type: "game", id: gameId } });
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "games.game_created", target: { type: "game", id: gameId } });
        });
        const clients = await ctx
          .rpcOptional<{ client_id: string; server_client_id: string; server_secret: string | null } | null>("oidc.ensure_game_clients", { game_id: gameId, slug: body.slug, name: body.name, redirect_uris: settings.redirect_uris }, null)
          .catch((err) => {
            ctx.log.warn({ err: (err as Error).message }, "could not create game clients");
            return null;
          });
        if (clients) await ctx.db.updateTable("games").set({ client_id: clients.client_id, server_client_id: clients.server_client_id }).where("id", "=", gameId).execute();
        const g = (await findGame(ctx.db, body.slug))!;
        return { ...gameView(g), settings: g.settings, client_id: g.client_id, server_client_id: g.server_client_id, server_secret: clients?.server_secret ?? null };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/games/:slug",
      summary: "A game with every definition",
      tags: adminTags,
      auth: "session",
      permissions: ["games.catalog.edit"],
      rate_limit: ["admin"],
      params: zSlugParam,
      async handler({ params }) {
        const g = await adminGame(params.slug);
        const [products, achievements, stats, leaderboards] = await Promise.all([
          ctx.db.selectFrom("products").selectAll().where("game_id", "=", g.id).orderBy("created_at").execute(),
          ctx.db.selectFrom("achievements").selectAll().where("game_id", "=", g.id).where("deleted_at", "is", null).orderBy("sort_order").execute(),
          ctx.db.selectFrom("stats").selectAll().where("game_id", "=", g.id).where("deleted_at", "is", null).orderBy("key").execute(),
          ctx.db.selectFrom("leaderboards").selectAll().where("game_id", "=", g.id).where("deleted_at", "is", null).orderBy("key").execute(),
        ]);
        return {
          ...gameView(g),
          settings: g.settings,
          require_game_authority: requiresGameAuthority(ctx, g),
          client_id: g.client_id,
          server_client_id: g.server_client_id,
          products: products.map((p) => ({ ...p, created_at: p.created_at.toISOString(), retired_at: p.retired_at?.toISOString() ?? null })),
          achievements: achievements.map((a) => ({ id: a.id, ...achievementView(a, { reveal: true }), sort_order: a.sort_order })),
          stats: stats.map(statView),
          leaderboards: leaderboards.map((l) => leaderboardView(l, stats.find((s) => s.id === l.stat_id)?.key)),
        };
      },
    }),

    route({
      method: "PATCH",
      path: "/api/v1/admin/games/:slug",
      summary: "Update a game",
      tags: adminTags,
      ...catalog(),
      params: zSlugParam,
      body: z.object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(5000).optional(),
        status: z.enum(["draft", "hidden", "early_access", "released", "archived"]).optional(),
        icon_url: zUrl,
        art: z.record(z.string(), z.url().max(2000)).optional(),
        settings: zSettings.optional(),
      }),
      async handler({ params, body, id }) {
        const g = await adminGame(params.slug);
        const settings = mergeSettings(g.settings, body.settings);
        await ctx.db
          .updateTable("games")
          .set({
            ...(body.name ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(body.status ? { status: body.status } : {}),
            ...(body.icon_url !== undefined ? { icon_url: body.icon_url } : {}),
            ...(body.art ? { art: JSON.stringify(body.art) } : {}),
            settings: JSON.stringify(settings),
            updated_at: new Date(),
          })
          .where("id", "=", g.id)
          .execute();
        if (body.name || body.settings?.redirect_uris) {
          await ctx.rpcOptional("oidc.ensure_game_clients", { game_id: g.id, slug: g.slug, name: body.name ?? g.name, redirect_uris: settings.redirect_uris }, null).catch(() => null);
        }
        await ctx.audit(ctx.db, { actor: { type: "staff", id: id.sub! }, action: "games.game_updated", target: { type: "game", id: g.id }, data: { fields: Object.keys(body) } });
        return gameView((await findGame(ctx.db, g.slug))!);
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games/:slug/server-secret",
      summary: "Rotate the game server's secret",
      description: "The new secret is shown once. Tokens issued with the old secret are revoked.",
      tags: adminTags,
      ...catalog({ step_up: true }),
      params: zSlugParam,
      async handler({ params, id }) {
        const g = await adminGame(params.slug);
        const r = await ctx.rpc<{ server_client_id: string; server_secret: string }>("oidc.rotate_game_server_secret", { slug: g.slug });
        await ctx.audit(ctx.db, { actor: { type: "staff", id: id.sub! }, action: "games.server_secret_rotated", target: { type: "game", id: g.id } });
        return r;
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/admin/games/:slug",
      summary: "Delete a game",
      description: "Only draft games with no entitlements can be deleted. Archive released games instead.",
      tags: adminTags,
      ...catalog({ step_up: true }),
      params: zSlugParam,
      async handler({ params, id }) {
        const g = await adminGame(params.slug);
        if (g.status !== "draft") throw new ProblemError(409, "ARCHIVE_INSTEAD");
        const any = await ctx.db.selectFrom("entitlements").select("id").where("game_id", "=", g.id).executeTakeFirst();
        if (any) throw new ProblemError(409, "GAME_HAS_ENTITLEMENTS");
        await ctx.db.updateTable("games").set({ deleted_at: new Date(), slug: `${g.slug}--deleted-${g.id.slice(0, 8)}` }).where("id", "=", g.id).execute();
        await ctx.audit(ctx.db, { actor: { type: "staff", id: id.sub! }, action: "games.game_deleted", target: { type: "game", id: g.id } });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games/:slug/products",
      summary: "Add a product",
      tags: adminTags,
      ...catalog(),
      params: zSlugParam,
      body: z.object({ sku: zSlug, name: z.string().trim().min(1).max(120), kind: z.enum(["dlc", "edition", "beta_access", "soundtrack", "other"]), description: z.string().trim().max(2000).default("") }),
      async handler({ params, body }) {
        const g = await adminGame(params.slug);
        if (await ctx.db.selectFrom("products").select("id").where("sku", "=", body.sku).executeTakeFirst()) throw new ProblemError(409, "SKU_TAKEN");
        return ctx.db.insertInto("products").values({ id: uuidv7(), game_id: g.id, sku: body.sku, name: body.name, kind: body.kind, description: body.description }).returningAll().executeTakeFirstOrThrow();
      },
    }),

    route({
      method: "PATCH",
      path: "/api/v1/admin/games/:slug/products/:id",
      summary: "Update or retire a product",
      tags: adminTags,
      ...catalog(),
      params: zSlugId,
      body: z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(2000).optional(), retired: z.boolean().optional() }),
      async handler({ params, body }) {
        const g = await adminGame(params.slug);
        const p = await ctx.db.selectFrom("products").selectAll().where("id", "=", params.id).where("game_id", "=", g.id).executeTakeFirst();
        if (!p) throw new ProblemError(404, "PRODUCT_NOT_FOUND");
        if (body.retired && p.kind === "base") throw new ProblemError(409, "CANNOT_RETIRE_BASE");
        return ctx.db
          .updateTable("products")
          .set({ ...(body.name ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}), ...(body.retired !== undefined ? { retired_at: body.retired ? new Date() : null } : {}) })
          .where("id", "=", p.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games/:slug/achievements",
      summary: "Define an achievement",
      tags: adminTags,
      ...catalog(),
      params: zSlugParam,
      body: z.object({
        key: zKey,
        name: z.string().trim().min(1).max(120),
        description: z.string().trim().max(500).default(""),
        icon_url: zUrl,
        locked_icon_url: zUrl,
        points: z.number().int().min(0).max(1000).default(10),
        hidden: z.boolean().default(false),
        progress_target: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
        sort_order: z.number().int().default(0),
      }),
      async handler({ params, body }) {
        const g = await adminGame(params.slug);
        if (await ctx.db.selectFrom("achievements").select("id").where("game_id", "=", g.id).where("key", "=", body.key).where("deleted_at", "is", null).executeTakeFirst()) throw new ProblemError(409, "KEY_TAKEN");
        const a = await ctx.db
          .insertInto("achievements")
          .values({ id: uuidv7(), game_id: g.id, key: body.key, name: body.name, description: body.description, icon_url: body.icon_url ?? null, locked_icon_url: body.locked_icon_url ?? null, points: body.points, hidden: body.hidden, progress_target: body.progress_target ?? null, sort_order: body.sort_order })
          .returningAll()
          .executeTakeFirstOrThrow();
        return { id: a.id, ...achievementView(a, { reveal: true }) };
      },
    }),

    route({
      method: "PATCH",
      path: "/api/v1/admin/games/:slug/achievements/:id",
      summary: "Update an achievement",
      tags: adminTags,
      ...catalog(),
      params: zSlugId,
      body: z.object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().trim().max(500).optional(),
        icon_url: zUrl,
        locked_icon_url: zUrl,
        points: z.number().int().min(0).max(1000).optional(),
        hidden: z.boolean().optional(),
        progress_target: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
        sort_order: z.number().int().optional(),
      }),
      async handler({ params, body }) {
        const g = await adminGame(params.slug);
        const a = await ctx.db
          .updateTable("achievements")
          .set(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)))
          .where("id", "=", params.id)
          .where("game_id", "=", g.id)
          .where("deleted_at", "is", null)
          .returningAll()
          .executeTakeFirst();
        if (!a) throw new ProblemError(404, "ACHIEVEMENT_NOT_FOUND");
        return { id: a.id, ...achievementView(a, { reveal: true }) };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/admin/games/:slug/achievements/:id",
      summary: "Delete an achievement",
      tags: adminTags,
      ...catalog(),
      params: zSlugId,
      async handler({ params }) {
        const g = await adminGame(params.slug);
        await ctx.db.updateTable("achievements").set({ deleted_at: new Date() }).where("id", "=", params.id).where("game_id", "=", g.id).execute();
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games/:slug/stats",
      summary: "Define a stat",
      description: "authority: game stats can only be written by the game's server together with the player's token.",
      tags: adminTags,
      ...catalog(),
      params: zSlugParam,
      body: z.object({
        key: zKey,
        name: z.string().trim().min(1).max(120),
        type: z.enum(["int", "float", "duration"]).default("int"),
        aggregation: z.enum(["sum", "max", "min", "latest"]).default("sum"),
        max_delta: z.number().positive().nullable().optional(),
        authority: z.enum(["player", "game"]).default("player"),
        default_value: z.number().default(0),
      }),
      async handler({ params, body }) {
        const g = await adminGame(params.slug);
        if (await ctx.db.selectFrom("stats").select("id").where("game_id", "=", g.id).where("key", "=", body.key).where("deleted_at", "is", null).executeTakeFirst()) throw new ProblemError(409, "KEY_TAKEN");
        const s = await ctx.db
          .insertInto("stats")
          .values({ id: uuidv7(), game_id: g.id, key: body.key, name: body.name, type: body.type, aggregation: body.aggregation, max_delta: body.max_delta ?? null, authority: body.authority, default_value: body.default_value })
          .returningAll()
          .executeTakeFirstOrThrow();
        return statView(s);
      },
    }),

    route({
      method: "PATCH",
      path: "/api/v1/admin/games/:slug/stats/:id",
      summary: "Update a stat",
      tags: adminTags,
      ...catalog(),
      params: zSlugId,
      body: z.object({ name: z.string().trim().min(1).max(120).optional(), max_delta: z.number().positive().nullable().optional(), authority: z.enum(["player", "game"]).optional() }),
      async handler({ params, body }) {
        const g = await adminGame(params.slug);
        if (body.authority === "player" && requiresGameAuthority(ctx, g)) {
          const lb = await ctx.db.selectFrom("leaderboards").select("id").where("stat_id", "=", params.id).where("deleted_at", "is", null).executeTakeFirst();
          if (lb) throw new ProblemError(409, "LEADERBOARD_NEEDS_GAME_AUTHORITY", "A leaderboard uses this stat and this game requires game authority");
        }
        const s = await ctx.db
          .updateTable("stats")
          .set(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)))
          .where("id", "=", params.id)
          .where("game_id", "=", g.id)
          .returningAll()
          .executeTakeFirst();
        if (!s) throw new ProblemError(404, "STAT_NOT_FOUND");
        return statView(s);
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/admin/games/:slug/stats/:id",
      summary: "Delete a stat",
      tags: adminTags,
      ...catalog(),
      params: zSlugId,
      async handler({ params }) {
        const g = await adminGame(params.slug);
        const lb = await ctx.db.selectFrom("leaderboards").select("id").where("stat_id", "=", params.id).where("deleted_at", "is", null).executeTakeFirst();
        if (lb) throw new ProblemError(409, "STAT_IN_USE");
        await ctx.db.updateTable("stats").set({ deleted_at: new Date() }).where("id", "=", params.id).where("game_id", "=", g.id).execute();
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games/:slug/leaderboards",
      summary: "Define a leaderboard",
      description: "When the game requires game authority (the default), the stat must have authority: game.",
      tags: adminTags,
      ...catalog(),
      params: zSlugParam,
      body: z.object({ key: zKey, name: z.string().trim().min(1).max(120), stat_key: zKey, sort: z.enum(["desc", "asc"]).default("desc"), reset_period: z.string().max(50).default("never") }),
      async handler({ params, body }) {
        if (!ctx.config.features.games.leaderboards.enabled) throw new ProblemError(404, "LEADERBOARDS_DISABLED");
        const g = await adminGame(params.slug);
        if (!validResetPeriod(body.reset_period)) throw new ProblemError(422, "INVALID_RESET_PERIOD");
        const stat = await ctx.db.selectFrom("stats").selectAll().where("game_id", "=", g.id).where("key", "=", body.stat_key).where("deleted_at", "is", null).executeTakeFirst();
        if (!stat) throw new ProblemError(404, "STAT_NOT_FOUND");
        if (stat.authority !== "game" && requiresGameAuthority(ctx, g)) throw new ProblemError(422, "LEADERBOARD_NEEDS_GAME_AUTHORITY", "Leaderboards need a stat with authority: game");
        if (await ctx.db.selectFrom("leaderboards").select("id").where("game_id", "=", g.id).where("key", "=", body.key).where("deleted_at", "is", null).executeTakeFirst()) throw new ProblemError(409, "KEY_TAKEN");
        const l = await ctx.db
          .insertInto("leaderboards")
          .values({ id: uuidv7(), game_id: g.id, key: body.key, name: body.name, stat_id: stat.id, sort: body.sort, reset_period: body.reset_period, current_period: periodFor(body.reset_period) })
          .returningAll()
          .executeTakeFirstOrThrow();
        return leaderboardView(l, stat.key);
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/admin/games/:slug/leaderboards/:id",
      summary: "Delete a leaderboard",
      tags: adminTags,
      ...catalog(),
      params: zSlugId,
      async handler({ params }) {
        const g = await adminGame(params.slug);
        await ctx.db.updateTable("leaderboards").set({ deleted_at: new Date() }).where("id", "=", params.id).where("game_id", "=", g.id).execute();
      },
    }),
  ];
}

export { zSlugParam, zKey, zUuidParam };
