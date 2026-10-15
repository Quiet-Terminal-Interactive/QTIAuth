import { z } from "zod";
import { sql } from "kysely";
import { ProblemError, inc, uuidv7 } from "@qtiauth/common";
import { route, type AnyRoute, zSlug } from "@qtiauth/service-kit";
import type { IdentityClaims } from "@qtiauth/auth-context";
import type { Game } from "../db.ts";
import { playerRead, playerWrite, requireGame, type Ctx } from "../lib/core.ts";

const tags = ["games", "cloud_saves"];
const zSlot = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const zSlugSlot = z.object({ slug: zSlug, slot: zSlot });

export function savesRoutes(ctx: Ctx): AnyRoute[] {
  const cfg = ctx.config.games.cloud_saves;

  function enabled(): void {
    if (!ctx.config.features.games.cloud_saves.enabled || !ctx.storage) throw new ProblemError(404, "CLOUD_SAVES_DISABLED");
  }

  function quota(g: Game) {
    return { slots: g.settings.cloud_slots ?? cfg.default_slots, slot_bytes: g.settings.cloud_slot_bytes ?? cfg.default_slot_bytes };
  }

  function owner(id: IdentityClaims, g: Game): string {
    if (id.auth === "session") return playerRead(id);
    return playerWrite(id, g, { allowGameAuthority: false }).userId;
  }

  async function prune(userId: string, gameId: string, slot: string): Promise<void> {
    const old = await ctx.db
      .selectFrom("cloud_versions")
      .select(["id", "storage_key"])
      .where("user_id", "=", userId)
      .where("game_id", "=", gameId)
      .where("slot", "=", slot)
      .where("status", "=", "committed")
      .orderBy("version", "desc")
      .offset(cfg.versions_kept)
      .limit(1000)
      .execute();
    for (const v of old) await ctx.storage!.delete(v.storage_key).catch(() => undefined);
    if (old.length) await ctx.db.deleteFrom("cloud_versions").where("id", "in", old.map((v) => v.id)).execute();
  }

  const read = { auth: ["session", "oauth"] as ("session" | "oauth")[], scopes: ["game_stats.write"] };
  const write = { auth: "oauth" as const, scopes: ["game_stats.write"], rate_limit: ["game_write"] };

  return [
    route({
      method: "GET",
      path: "/api/v1/games/:slug/saves",
      summary: "My cloud save slots",
      tags,
      ...read,
      params: z.object({ slug: zSlug }),
      async handler({ params, id }) {
        enabled();
        const g = await requireGame(ctx.db, params.slug);
        const userId = owner(id, g);
        const rows = await ctx.db.selectFrom("cloud_slots").selectAll().where("user_id", "=", userId).where("game_id", "=", g.id).orderBy("slot").execute();
        return { quota: quota(g), items: rows.map((s) => ({ slot: s.slot, version: s.current_version, size: s.size, sha256: s.sha256, updated_at: s.updated_at.toISOString() })) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/games/:slug/saves/:slot",
      summary: "Download a save",
      description: "Returns a short-lived presigned URL. Pass version for an older one.",
      tags,
      ...read,
      params: zSlugSlot,
      query: z.object({ version: z.coerce.number().int().min(1).optional() }),
      async handler({ params, query, id }) {
        enabled();
        const g = await requireGame(ctx.db, params.slug);
        const userId = owner(id, g);
        const slot = await ctx.db.selectFrom("cloud_slots").selectAll().where("user_id", "=", userId).where("game_id", "=", g.id).where("slot", "=", params.slot).executeTakeFirst();
        if (!slot) throw new ProblemError(404, "SAVE_NOT_FOUND");
        const version = query.version ?? slot.current_version;
        const v = await ctx.db.selectFrom("cloud_versions").selectAll().where("user_id", "=", userId).where("game_id", "=", g.id).where("slot", "=", params.slot).where("version", "=", version).where("status", "=", "committed").executeTakeFirst();
        if (!v) throw new ProblemError(404, "SAVE_VERSION_NOT_FOUND");
        const url = await ctx.storage!.presignGet(v.storage_key, { filename: `${params.slot}.v${v.version}.sav`, attachment: true, contentType: "application/octet-stream" });
        return { slot: params.slot, version: v.version, size: v.size, sha256: v.sha256, url };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/games/:slug/saves/:slot/versions",
      summary: "Version history for a slot",
      tags,
      ...read,
      params: zSlugSlot,
      async handler({ params, id }) {
        enabled();
        const g = await requireGame(ctx.db, params.slug);
        const userId = owner(id, g);
        const rows = await ctx.db.selectFrom("cloud_versions").select(["version", "size", "sha256", "created_at"]).where("user_id", "=", userId).where("game_id", "=", g.id).where("slot", "=", params.slot).where("status", "=", "committed").orderBy("version", "desc").execute();
        return { items: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/:slug/saves/:slot/uploads",
      summary: "Start uploading a save",
      description: "base_version is the version the client last saw (0 for a new slot). A mismatch returns 409 SAVE_CONFLICT and the client resolves it.",
      tags,
      ...write,
      params: zSlugSlot,
      body: z.object({ size: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), base_version: z.number().int().min(0) }),
      async handler({ params, body, id }) {
        enabled();
        const g = await requireGame(ctx.db, params.slug);
        const userId = owner(id, g);
        const q = quota(g);
        if (body.size > q.slot_bytes) throw new ProblemError(413, "SAVE_TOO_LARGE", undefined, { max_bytes: q.slot_bytes });
        const slot = await ctx.db.selectFrom("cloud_slots").selectAll().where("user_id", "=", userId).where("game_id", "=", g.id).where("slot", "=", params.slot).executeTakeFirst();
        if (!slot) {
          const used = await ctx.db.selectFrom("cloud_slots").select(sql<number>`count(*)::int`.as("n")).where("user_id", "=", userId).where("game_id", "=", g.id).executeTakeFirst();
          if ((used?.n ?? 0) >= q.slots) throw new ProblemError(409, "SAVE_SLOTS_FULL", undefined, { max_slots: q.slots });
        }
        const current = slot?.current_version ?? 0;
        if (body.base_version !== current) {
          inc("qtiauth_games_cloud_save_conflicts_total", {}, 1, "Cloud save conflicts");
          throw new ProblemError(409, "SAVE_CONFLICT", undefined, { current_version: current });
        }
        const uploadId = uuidv7();
        const key = `games/${g.id}/saves/${userId}/${params.slot}/${uploadId}`;
        await ctx.db.insertInto("cloud_versions").values({ id: uploadId, user_id: userId, game_id: g.id, slot: params.slot, version: 0, base_version: body.base_version, storage_key: key, size: body.size, sha256: body.sha256 ?? null, status: "pending" }).execute();
        const upload = await ctx.storage!.presignPut(key, "application/octet-stream", body.size);
        return { upload_id: uploadId, upload };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/:slug/saves/:slot/uploads/:id/commit",
      summary: "Commit an uploaded save",
      tags,
      ...write,
      params: z.object({ slug: zSlug, slot: zSlot, id: z.uuid() }),
      async handler({ params, id }) {
        enabled();
        const g = await requireGame(ctx.db, params.slug);
        const userId = owner(id, g);
        const pending = await ctx.db.selectFrom("cloud_versions").selectAll().where("id", "=", params.id).where("user_id", "=", userId).where("game_id", "=", g.id).where("slot", "=", params.slot).where("status", "=", "pending").executeTakeFirst();
        if (!pending) throw new ProblemError(404, "UPLOAD_NOT_FOUND");
        const head = await ctx.storage!.head(pending.storage_key);
        if (!head) throw new ProblemError(409, "UPLOAD_NOT_FOUND", "Upload the file before committing it");
        if (head.size > quota(g).slot_bytes) {
          await ctx.storage!.delete(pending.storage_key).catch(() => undefined);
          throw new ProblemError(413, "SAVE_TOO_LARGE");
        }
        const version = await ctx.db.transaction().execute(async (trx) => {
          const slot = await trx.selectFrom("cloud_slots").selectAll().where("user_id", "=", userId).where("game_id", "=", g.id).where("slot", "=", params.slot).forUpdate().executeTakeFirst();
          const current = slot?.current_version ?? 0;
          if (current !== pending.base_version) {
            inc("qtiauth_games_cloud_save_conflicts_total", {}, 1, "Cloud save conflicts");
            throw new ProblemError(409, "SAVE_CONFLICT", undefined, { current_version: current });
          }
          const next = current + 1;
          await trx.updateTable("cloud_versions").set({ status: "committed", version: next, size: head.size }).where("id", "=", pending.id).execute();
          await trx
            .insertInto("cloud_slots")
            .values({ user_id: userId, game_id: g.id, slot: params.slot, current_version: next, size: head.size, sha256: pending.sha256 })
            .onConflict((oc) => oc.columns(["user_id", "game_id", "slot"]).doUpdateSet({ current_version: next, size: head.size, sha256: pending.sha256, updated_at: new Date() }))
            .execute();
          return next;
        });
        inc("qtiauth_games_cloud_save_bytes_total", {}, head.size, "Cloud save bytes committed");
        await prune(userId, g.id, params.slot);
        return { slot: params.slot, version, size: head.size };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/games/:slug/saves/:slot",
      summary: "Delete a save slot and its history",
      tags,
      ...write,
      params: zSlugSlot,
      async handler({ params, id }) {
        enabled();
        const g = await requireGame(ctx.db, params.slug);
        const userId = owner(id, g);
        const versions = await ctx.db.selectFrom("cloud_versions").select(["storage_key"]).where("user_id", "=", userId).where("game_id", "=", g.id).where("slot", "=", params.slot).execute();
        for (const v of versions) await ctx.storage!.delete(v.storage_key).catch(() => undefined);
        await ctx.db.deleteFrom("cloud_versions").where("user_id", "=", userId).where("game_id", "=", g.id).where("slot", "=", params.slot).execute();
        await ctx.db.deleteFrom("cloud_slots").where("user_id", "=", userId).where("game_id", "=", g.id).where("slot", "=", params.slot).execute();
      },
    }),
  ];
}
