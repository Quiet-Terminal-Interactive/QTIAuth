import { z } from "zod";
import { sql } from "kysely";
import { ProblemError, inc, uuidv7 } from "@qtiauth/common";
import { route, type AnyRoute, zSlug } from "@qtiauth/service-kit";
import { EVENTS } from "@qtiauth/bus";
import type { IdentityClaims } from "@qtiauth/auth-context";
import type { Game, Stat } from "../db.ts";
import { leaderboardVisible, playerRead, playerWrite, refreshVisibility, requireGame, requiresGameAuthority, syncPlayerPrefs, today, type Ctx, type Exec, type Player } from "../lib/core.ts";
import { achievementView, statView } from "./catalog.ts";

const tags = ["games", "player"];
const zSlugParam = z.object({ slug: zSlug });
const zSlugKey = z.object({ slug: zSlug, key: z.string().max(64) });
const zSlugSession = z.object({ slug: zSlug, id: z.uuid() });
const write = { auth: ["oauth", "game_authoritative"] as ("oauth" | "game_authoritative")[], rate_limit: ["game_write"], allow_account_states: ["active" as const] };

function requireScope(id: IdentityClaims, oauthScope: string): void {
  const scopes = new Set(id.scopes ?? []);
  if (id.auth === "game_authoritative") {
    if (!scopes.has("games.server")) throw new ProblemError(403, "INSUFFICIENT_SCOPE", undefined, { scope: "games.server" });
    return;
  }
  if (!scopes.has(oauthScope)) throw new ProblemError(403, "INSUFFICIENT_SCOPE", undefined, { scope: oauthScope });
}

function aggregate(agg: Stat["aggregation"], current: number | null, value: number): number {
  if (current === null) return value;
  switch (agg) {
    case "sum":
      return current + value;
    case "max":
      return Math.max(current, value);
    case "min":
      return Math.min(current, value);
    default:
      return value;
  }
}

export async function unlockAchievement(ctx: Ctx, trx: Exec, game: Game, key: string, p: Player, progress: number | null): Promise<{ status: string; progress: number; unlocked_at: string | null }> {
  const a = await trx.selectFrom("achievements").selectAll().where("game_id", "=", game.id).where("key", "=", key).where("deleted_at", "is", null).executeTakeFirst();
  if (!a) throw new ProblemError(404, "ACHIEVEMENT_NOT_FOUND");
  const row = await trx.selectFrom("achievement_unlocks").selectAll().where("user_id", "=", p.userId).where("achievement_id", "=", a.id).forUpdate().executeTakeFirst();
  if (row?.revoked_at) return { status: "revoked", progress: row.progress, unlocked_at: null };
  if (row?.unlocked_at) return { status: "already_unlocked", progress: row.progress, unlocked_at: row.unlocked_at.toISOString() };
  if (progress !== null && !a.progress_target) throw new ProblemError(422, "NOT_A_PROGRESS_ACHIEVEMENT");
  const nextProgress = progress === null ? (a.progress_target ?? 1) : Math.max(row?.progress ?? 0, Math.min(progress, a.progress_target!));
  const unlock = progress === null || nextProgress >= a.progress_target!;
  const now = new Date();
  await trx
    .insertInto("achievement_unlocks")
    .values({ user_id: p.userId, achievement_id: a.id, game_id: game.id, progress: nextProgress, unlocked_at: unlock ? now : null, trust: p.trust })
    .onConflict((oc) => oc.columns(["user_id", "achievement_id"]).doUpdateSet({ progress: nextProgress, unlocked_at: unlock ? now : null, trust: p.trust, updated_at: now }))
    .execute();
  if (unlock) {
    await ctx.emit(trx, EVENTS.gamesAchievementUnlocked, { user_id: p.userId, game_id: game.id, achievement_key: a.key, trust: p.trust }, { actor: { type: "user", id: p.userId }, subject: { type: "user", id: p.userId } });
    inc("qtiauth_games_achievements_total", { event: "unlocked", trust: p.trust }, 1, "Achievement unlocks and progress updates");
  } else {
    inc("qtiauth_games_achievements_total", { event: "progress", trust: p.trust }, 1, "Achievement unlocks and progress updates");
  }
  return { status: unlock ? "unlocked" : "progress", progress: nextProgress, unlocked_at: unlock ? now.toISOString() : null };
}

export function playerRoutes(ctx: Ctx): AnyRoute[] {
  const features = ctx.config.features.games;

  async function accrue(trx: Exec, session: { id: string; user_id: string; game_id: string; last_heartbeat_at: Date }, now: Date): Promise<number> {
    const gap = Math.max(0, Math.min(now.getTime() - session.last_heartbeat_at.getTime(), ctx.config.games.playtime_heartbeat_max_gap));
    const seconds = Math.floor(gap / 1000);
    await trx.updateTable("playtime_sessions").set({ last_heartbeat_at: now, seconds: sql`seconds + ${seconds}` }).where("id", "=", session.id).execute();
    if (seconds > 0) {
      await trx
        .insertInto("playtime_daily")
        .values({ user_id: session.user_id, game_id: session.game_id, day: today(), seconds })
        .onConflict((oc) => oc.columns(["user_id", "game_id", "day"]).doUpdateSet({ seconds: sql`playtime_daily.seconds + ${seconds}` }))
        .execute();
    }
    inc("qtiauth_games_playtime_heartbeats_total", {}, 1, "Playtime heartbeats");
    return seconds;
  }

  async function playedToday(userId: string, gameId: string): Promise<number> {
    const r = await ctx.db.selectFrom("playtime_daily").select("seconds").where("user_id", "=", userId).where("game_id", "=", gameId).where("day", "=", today()).executeTakeFirst();
    return r?.seconds ?? 0;
  }

  return [
    route({
      method: "GET",
      path: "/api/v1/games/:slug/achievements",
      summary: "Achievements with my progress",
      description: "Hidden achievements keep their name and description hidden until unlocked.",
      tags,
      auth: ["session", "oauth"],
      scopes: ["achievements"],
      params: zSlugParam,
      async handler({ params, id }) {
        const g = await requireGame(ctx.db, params.slug);
        const userId = playerRead(id);
        const defs = await ctx.db.selectFrom("achievements").selectAll().where("game_id", "=", g.id).where("deleted_at", "is", null).orderBy("sort_order").orderBy("name").execute();
        const mine = await ctx.db.selectFrom("achievement_unlocks").selectAll().where("user_id", "=", userId).where("game_id", "=", g.id).execute();
        const items = defs.map((a) => {
          const u = mine.find((m) => m.achievement_id === a.id && !m.revoked_at);
          return { ...achievementView(a, { reveal: Boolean(u?.unlocked_at) }), unlocked: Boolean(u?.unlocked_at), unlocked_at: u?.unlocked_at?.toISOString() ?? null, progress: u?.progress ?? 0 };
        });
        const unlocked = items.filter((i) => i.unlocked);
        return {
          items,
          completion_percent: defs.length ? Math.round((unlocked.length / defs.length) * 1000) / 10 : 0,
          points: unlocked.reduce((n, i) => n + i.points, 0),
          total_points: defs.reduce((n, a) => n + a.points, 0),
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/:slug/achievements/:key/unlock",
      summary: "Unlock an achievement",
      description: "Trust-based: uses the player's own token for this game's client (scope achievements.write). Never grants anything of value.",
      tags,
      ...write,
      params: zSlugKey,
      async handler({ params, id }) {
        if (!features.achievements.enabled) throw new ProblemError(404, "ACHIEVEMENTS_DISABLED");
        const g = await requireGame(ctx.db, params.slug);
        requireScope(id, "achievements.write");
        const p = playerWrite(id, g);
        return ctx.db.transaction().execute((trx) => unlockAchievement(ctx, trx, g, params.key, p, null));
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/:slug/achievements/:key/progress",
      summary: "Record progress on a progress achievement",
      description: "Progress only moves forward. The achievement unlocks when it reaches progress_target.",
      tags,
      ...write,
      params: zSlugKey,
      body: z.object({ progress: z.number().int().min(0).max(1_000_000_000) }),
      async handler({ params, body, id }) {
        if (!features.achievements.enabled) throw new ProblemError(404, "ACHIEVEMENTS_DISABLED");
        const g = await requireGame(ctx.db, params.slug);
        requireScope(id, "achievements.write");
        const p = playerWrite(id, g);
        return ctx.db.transaction().execute((trx) => unlockAchievement(ctx, trx, g, params.key, p, body.progress));
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/games/:slug/stats/me",
      summary: "My stats",
      tags,
      auth: ["session", "oauth"],
      scopes: ["game_stats"],
      params: zSlugParam,
      async handler({ params, id }) {
        const g = await requireGame(ctx.db, params.slug);
        const userId = playerRead(id);
        const defs = await ctx.db.selectFrom("stats").selectAll().where("game_id", "=", g.id).where("deleted_at", "is", null).orderBy("key").execute();
        const values = await ctx.db.selectFrom("user_stats").selectAll().where("user_id", "=", userId).where("game_id", "=", g.id).execute();
        return { items: defs.map((s) => ({ ...statView(s), value: values.find((v) => v.stat_id === s.id)?.value ?? s.default_value })) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/:slug/stats",
      summary: "Update stats",
      description:
        "authority: player stats take the player's own token (scope game_stats.write). authority: game stats need the game server's credential in Authorization and the player's token in X-QTIAuth-Player-Token. " +
        "Game authority proves the score came through the game's server; it doesn't prove the score is legitimate, which is the game server's job.",
      tags,
      ...write,
      params: zSlugParam,
      body: z.object({ updates: z.array(z.object({ key: z.string().max(64), value: z.number().finite() })).min(1).max(50) }),
      async handler({ params, body, id }) {
        if (!features.stats.enabled) throw new ProblemError(404, "STATS_DISABLED");
        const g = await requireGame(ctx.db, params.slug);
        requireScope(id, "game_stats.write");
        const p = playerWrite(id, g);
        const authorityRequired = requiresGameAuthority(ctx, g);
        return ctx.db.transaction().execute(async (trx) => {
          const prefs = await syncPlayerPrefs(trx, id);
          const visible = leaderboardVisible(prefs);
          const results: { key: string; value: number }[] = [];
          for (const u of body.updates) {
            const stat = await trx.selectFrom("stats").selectAll().where("game_id", "=", g.id).where("key", "=", u.key).where("deleted_at", "is", null).executeTakeFirst();
            if (!stat) throw new ProblemError(404, "STAT_NOT_FOUND", undefined, { key: u.key });
            if (stat.authority === "game" && p.trust !== "game") {
              inc("qtiauth_game_authority_rejections_total", { reason: "player_wrote_game_stat" }, 1, "Game-authoritative rejections");
              throw new ProblemError(403, "STAT_REQUIRES_GAME_AUTHORITY", undefined, { key: u.key });
            }
            if (stat.type === "int" && !Number.isInteger(u.value)) throw new ProblemError(422, "STAT_NOT_INTEGER", undefined, { key: u.key });
            const current = await trx.selectFrom("user_stats").select("value").where("user_id", "=", p.userId).where("stat_id", "=", stat.id).forUpdate().executeTakeFirst();
            const base = current?.value ?? stat.default_value;
            if (stat.max_delta !== null) {
              const delta = stat.aggregation === "sum" ? Math.abs(u.value) : Math.abs(u.value - base);
              if (delta > stat.max_delta) throw new ProblemError(422, "STAT_DELTA_TOO_LARGE", undefined, { key: u.key, max_delta: stat.max_delta });
            }
            const next = aggregate(stat.aggregation, current ? current.value : stat.aggregation === "sum" ? stat.default_value : null, u.value);
            await trx
              .insertInto("user_stats")
              .values({ user_id: p.userId, stat_id: stat.id, game_id: g.id, value: next, trust: p.trust })
              .onConflict((oc) => oc.columns(["user_id", "stat_id"]).doUpdateSet({ value: next, trust: p.trust, updated_at: new Date() }))
              .execute();
            results.push({ key: stat.key, value: next });
            await ctx.emit(trx, EVENTS.gamesStatUpdated, { user_id: p.userId, game_id: g.id, stat_key: stat.key, trust: p.trust }, { actor: { type: "user", id: p.userId }, subject: { type: "user", id: p.userId } });
            if (!features.leaderboards.enabled) continue;
            const boards = await trx.selectFrom("leaderboards").selectAll().where("stat_id", "=", stat.id).where("deleted_at", "is", null).execute();
            for (const lb of boards) {
              if (authorityRequired && p.trust !== "game") continue;
              const entry = await trx.selectFrom("leaderboard_entries").select(["score", "removed_at"]).where("leaderboard_id", "=", lb.id).where("period", "=", lb.current_period).where("user_id", "=", p.userId).forUpdate().executeTakeFirst();
              if (entry?.removed_at) continue;
              const score = aggregate(stat.aggregation, entry ? entry.score : null, u.value);
              await trx
                .insertInto("leaderboard_entries")
                .values({ leaderboard_id: lb.id, period: lb.current_period, user_id: p.userId, score, visible, trust: p.trust })
                .onConflict((oc) => oc.columns(["leaderboard_id", "period", "user_id"]).doUpdateSet({ score, visible, trust: p.trust, updated_at: new Date() }))
                .execute();
              await ctx.emit(trx, EVENTS.gamesLeaderboardEntry, { leaderboard_id: lb.id, game_id: g.id, user_id: p.userId, trust: p.trust }, { actor: { type: "user", id: p.userId }, subject: { type: "user", id: p.userId } });
              inc("qtiauth_games_leaderboard_writes_total", { trust: p.trust }, 1, "Leaderboard writes");
            }
          }
          return { items: results };
        });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/games/:slug/data",
      summary: "My custom game data",
      tags,
      auth: "oauth",
      scopes: ["game_stats.write"],
      params: zSlugParam,
      async handler({ params, id }) {
        const g = await requireGame(ctx.db, params.slug);
        const p = playerWrite(id, g, { allowGameAuthority: false });
        const r = await ctx.db.selectFrom("custom_data").select(["data", "updated_at"]).where("user_id", "=", p.userId).where("game_id", "=", g.id).executeTakeFirst();
        return { data: r?.data ?? {}, updated_at: r?.updated_at.toISOString() ?? null };
      },
    }),

    route({
      method: "PUT",
      path: "/api/v1/games/:slug/data",
      summary: "Replace my custom game data",
      description: "Free-form JSON up to 64 KB, written with the player's token.",
      tags,
      auth: "oauth",
      scopes: ["game_stats.write"],
      rate_limit: ["game_write"],
      params: zSlugParam,
      body: z.object({ data: z.record(z.string(), z.unknown()).refine((d) => JSON.stringify(d).length <= 65_536, "data must be at most 64 KB") }),
      async handler({ params, body, id }) {
        const g = await requireGame(ctx.db, params.slug);
        const p = playerWrite(id, g, { allowGameAuthority: false });
        await ctx.db
          .insertInto("custom_data")
          .values({ user_id: p.userId, game_id: g.id, data: JSON.stringify(body.data) })
          .onConflict((oc) => oc.columns(["user_id", "game_id"]).doUpdateSet({ data: JSON.stringify(body.data), updated_at: new Date() }))
          .execute();
        return { status: "saved" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/games/:slug/leaderboards/:key",
      summary: "A leaderboard",
      description: "Hidden players still count in the ranking and show as \"Hidden player\".",
      tags,
      auth: ["none", "session", "oauth"],
      session_optional: true,
      rate_limit: ["public_read"],
      params: zSlugKey,
      query: z.object({ period: z.string().max(60).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(100_000).default(0) }),
      async handler({ params, query, id }) {
        if (!features.leaderboards.enabled) throw new ProblemError(404, "LEADERBOARDS_DISABLED");
        const g = await requireGame(ctx.db, params.slug);
        const lb = await ctx.db.selectFrom("leaderboards").selectAll().where("game_id", "=", g.id).where("key", "=", params.key).where("deleted_at", "is", null).executeTakeFirst();
        if (!lb) throw new ProblemError(404, "LEADERBOARD_NOT_FOUND");
        const period = query.period ?? lb.current_period;
        const order = lb.sort === "desc" ? sql`score desc` : sql`score asc`;
        const ranked = sql<{ user_id: string; score: number; visible: boolean; rank: number; updated_at: Date }>`
          select user_id, score, visible, updated_at, rank() over (order by ${order}) as rank
          from leaderboard_entries where leaderboard_id = ${lb.id} and period = ${period} and removed_at is null`;
        const rows = (await sql<{ user_id: string; score: number; visible: boolean; rank: number; updated_at: Date }>`select * from (${ranked}) r order by rank, updated_at limit ${query.limit} offset ${query.offset}`.execute(ctx.db)).rows;
        const total = await ctx.db.selectFrom("leaderboard_entries").select(sql<number>`count(*)::int`.as("n")).where("leaderboard_id", "=", lb.id).where("period", "=", period).where("removed_at", "is", null).executeTakeFirst();
        const me = id.sub ? (await sql<{ user_id: string; score: number; visible: boolean; rank: number; updated_at: Date }>`select * from (${ranked}) r where user_id = ${id.sub}`.execute(ctx.db)).rows[0] : undefined;
        const names = await ctx.rpcOptional<Record<string, { username?: string | null }>>("identity.get_users", { ids: [...rows.filter((r) => r.visible || r.user_id === id.sub).map((r) => r.user_id), ...(me ? [me.user_id] : [])] }, {});
        const view = (r: { user_id: string; score: number; visible: boolean; rank: number }) => {
          const self = r.user_id === id.sub;
          const show = r.visible || self;
          return { rank: Number(r.rank), score: r.score, hidden: !r.visible, user_id: show ? r.user_id : null, username: show ? (names[r.user_id]?.username ?? null) : "Hidden player", is_me: self };
        };
        return {
          leaderboard: { key: lb.key, name: lb.name, sort: lb.sort, reset_period: lb.reset_period, period, current_period: lb.current_period },
          total: total?.n ?? 0,
          items: rows.map(view),
          me: me ? view(me) : null,
        };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/games/leaderboards/visibility",
      summary: "Whether I appear on leaderboards",
      tags,
      auth: "session",
      async handler({ id }) {
        const prefs = await ctx.db.transaction().execute((trx) => syncPlayerPrefs(trx, id));
        return { preference: prefs.pref, visible: leaderboardVisible(prefs), age_band: prefs.age_band, guardian_controlled: prefs.guardian_leaderboards !== null };
      },
    }),

    route({
      method: "PUT",
      path: "/api/v1/games/leaderboards/visibility",
      summary: "Show or hide me on leaderboards",
      description: "Accounts under 18 are hidden by default and can opt in. For child accounts the guardian's leaderboard control also applies.",
      tags,
      auth: "session",
      rate_limit: ["account_write"],
      body: z.object({ visible: z.boolean().nullable() }),
      async handler({ body, id }) {
        return ctx.db.transaction().execute(async (trx) => {
          await syncPlayerPrefs(trx, id);
          await trx.updateTable("player_prefs").set({ leaderboard_visible: body.visible, updated_at: new Date() }).where("user_id", "=", id.sub!).execute();
          await refreshVisibility(trx, id.sub!);
          const p = await trx.selectFrom("player_prefs").selectAll().where("user_id", "=", id.sub!).executeTakeFirstOrThrow();
          return { preference: p.leaderboard_visible, visible: leaderboardVisible({ pref: p.leaderboard_visible, age_band: p.age_band, guardian_leaderboards: p.guardian_leaderboards }) };
        });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/:slug/playtime/sessions",
      summary: "Start a play session",
      tags,
      auth: "oauth",
      scopes: ["game_stats.write"],
      rate_limit: ["game_write"],
      params: zSlugParam,
      async handler({ params, id }) {
        if (!features.playtime.enabled) throw new ProblemError(404, "PLAYTIME_DISABLED");
        const g = await requireGame(ctx.db, params.slug);
        const p = playerWrite(id, g, { allowGameAuthority: false });
        const now = new Date();
        await ctx.db.updateTable("playtime_sessions").set({ ended_at: now }).where("user_id", "=", p.userId).where("game_id", "=", g.id).where("ended_at", "is", null).execute();
        const sessionId = uuidv7();
        await ctx.db.insertInto("playtime_sessions").values({ id: sessionId, user_id: p.userId, game_id: g.id, client_id: id.client_id ?? null }).execute();
        const limit = id.parental_controls?.daily_playtime_minutes ?? null;
        const played = await playedToday(p.userId, g.id);
        return { session_id: sessionId, heartbeat_interval_s: Math.max(30, Math.floor(ctx.config.games.playtime_heartbeat_max_gap / 2000)), remaining_minutes: limit === null ? null : Math.max(0, limit - Math.floor(played / 60)) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/:slug/playtime/sessions/:id/heartbeat",
      summary: "Play session heartbeat",
      tags,
      auth: "oauth",
      scopes: ["game_stats.write"],
      rate_limit: ["game_write"],
      params: zSlugSession,
      async handler({ params, id }) {
        const g = await requireGame(ctx.db, params.slug);
        const p = playerWrite(id, g, { allowGameAuthority: false });
        return ctx.db.transaction().execute(async (trx) => {
          const s = await trx.selectFrom("playtime_sessions").selectAll().where("id", "=", params.id).where("user_id", "=", p.userId).where("game_id", "=", g.id).forUpdate().executeTakeFirst();
          if (!s || s.ended_at) throw new ProblemError(404, "SESSION_NOT_FOUND");
          await accrue(trx, s, new Date());
          const limit = id.parental_controls?.daily_playtime_minutes ?? null;
          const played = (await trx.selectFrom("playtime_daily").select("seconds").where("user_id", "=", p.userId).where("game_id", "=", g.id).where("day", "=", today()).executeTakeFirst())?.seconds ?? 0;
          return { status: "ok", played_today_minutes: Math.floor(played / 60), remaining_minutes: limit === null ? null : Math.max(0, limit - Math.floor(played / 60)) };
        });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/:slug/playtime/sessions/:id/end",
      summary: "End a play session",
      tags,
      auth: "oauth",
      scopes: ["game_stats.write"],
      rate_limit: ["game_write"],
      params: zSlugSession,
      async handler({ params, id }) {
        const g = await requireGame(ctx.db, params.slug);
        const p = playerWrite(id, g, { allowGameAuthority: false });
        return ctx.db.transaction().execute(async (trx) => {
          const s = await trx.selectFrom("playtime_sessions").selectAll().where("id", "=", params.id).where("user_id", "=", p.userId).where("game_id", "=", g.id).forUpdate().executeTakeFirst();
          if (!s || s.ended_at) throw new ProblemError(404, "SESSION_NOT_FOUND");
          const now = new Date();
          await accrue(trx, s, now);
          const done = await trx.updateTable("playtime_sessions").set({ ended_at: now }).where("id", "=", s.id).returning("seconds").executeTakeFirstOrThrow();
          await ctx.emit(trx, EVENTS.gamesPlaytimeRecorded, { user_id: p.userId, game_id: g.id, seconds: done.seconds, trust: "player" }, { actor: { type: "user", id: p.userId }, subject: { type: "user", id: p.userId } });
          return { status: "ended", seconds: done.seconds };
        });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/games/:slug/playtime/remaining",
      summary: "Remaining playtime today",
      description: "For enforcing the daily_playtime_minutes parental control. remaining_minutes is null when there is no limit.",
      tags,
      auth: "oauth",
      params: zSlugParam,
      async handler({ params, id }) {
        const g = await requireGame(ctx.db, params.slug);
        const userId = playerRead(id);
        const limit = id.parental_controls?.daily_playtime_minutes ?? null;
        const played = Math.floor((await playedToday(userId, g.id)) / 60);
        return { limit_minutes: limit, played_today_minutes: played, remaining_minutes: limit === null ? null : Math.max(0, limit - played), online_play: id.parental_controls?.online_play ?? true };
      },
    }),
  ];
}
