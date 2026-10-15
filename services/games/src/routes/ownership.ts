import { z } from "zod";
import { sql } from "kysely";
import { ProblemError, decodeKey, decrypt, deriveSubkey, encrypt, humanCode, inc, sha256, uuidv7 } from "@qtiauth/common";
import { reply, route, type AnyRoute, zCaptcha, zReason, zSlug } from "@qtiauth/service-kit";
import type { IdentityClaims } from "@qtiauth/auth-context";
import { CAPTCHA_STRIKE_HEADER } from "@qtiauth/auth-context";
import type { Product } from "../db.ts";
import { activeEntitlements, entitlementView, findGame, gameActor, grantEntitlement, playerRead, refreshVisibility, requireGame, revokeEntitlement, type Ctx } from "../lib/core.ts";
import { revokeLeases } from "../lib/licensing.ts";
import { gameView } from "./catalog.ts";

const tags = ["games"];
const adminTags = ["admin", "games"];
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const staff = (permissions: string[], extra: { step_up?: boolean } = {}) => ({ auth: "session" as const, permissions, rate_limit: ["admin"], step_up: extra.step_up ?? false });

export function normalizeKey(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function keyHash(code: string): string {
  return sha256(`key:${normalizeKey(code)}`);
}

export function generateKey(format: string): string {
  return format.replace(/X/g, () => humanCode(1, 0, KEY_ALPHABET));
}

function keyCipher(ctx: Ctx): Buffer {
  const m = ctx.config.secrets.app_encryption_key;
  if (!m) throw new ProblemError(503, "ENCRYPTION_KEY_MISSING");
  return deriveSubkey(decodeKey(m), "game-keys");
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function ownershipRoutes(ctx: Ctx): AnyRoute[] {
  const keysEnabled = ctx.config.features.games.keys.enabled;

  async function productBySku(sku: string): Promise<Product> {
    const p = await ctx.db.selectFrom("products").selectAll().where("sku", "=", sku).executeTakeFirst();
    if (!p) throw new ProblemError(404, "PRODUCT_NOT_FOUND");
    return p;
  }

  async function requireUser(userId: string): Promise<void> {
    const u = await ctx.rpc<unknown | null>("identity.get_user_summary", { user_id: userId });
    if (!u) throw new ProblemError(404, "USER_NOT_FOUND");
  }

  async function ownedByGame(userId: string) {
    const ents = await activeEntitlements(ctx.db, userId);
    const gameIds = [...new Set(ents.map((e) => e.game_id))];
    const games = gameIds.length ? await ctx.db.selectFrom("games").selectAll().where("id", "in", gameIds).execute() : [];
    return games.map((g) => ({ ...gameView(g), entitlements: ents.filter((e) => e.game_id === g.id).map(entitlementView) }));
  }

  return [
    route({
      method: "GET",
      path: "/api/v1/games/owned",
      summary: "Games and content I own",
      tags,
      auth: ["session", "oauth"],
      scopes: ["games"],
      async handler({ id }) {
        return { items: await ownedByGame(playerRead(id)) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/games/:slug/owned",
      summary: "Whether I own a game, and which products",
      tags,
      auth: ["session", "oauth"],
      scopes: ["games"],
      params: z.object({ slug: zSlug }),
      async handler({ params, id }) {
        const g = await requireGame(ctx.db, params.slug);
        const ents = await activeEntitlements(ctx.db, playerRead(id), g.id);
        const products = [...new Set(ents.map((e) => e.sku))].sort();
        return { owned: ents.length > 0, base: ents.some((e) => e.kind === "base"), products, entitlements: ents.map(entitlementView) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/keys/redeem",
      summary: "Redeem a product key",
      description: "Failed attempts are tracked, and a CAPTCHA is required after repeated failures.",
      tags,
      auth: ["session", "oauth"],
      scopes: ["games"],
      captcha: true,
      rate_limit: ["key_redeem"],
      body: z.object({ code: z.string().trim().min(5).max(64), captcha: zCaptcha }),
      async handler({ body, id }) {
        if (!keysEnabled) throw new ProblemError(404, "KEYS_DISABLED");
        const userId = playerRead(id);
        const fail = (code: string) => {
          inc("qtiauth_games_key_redemptions_total", { result: code.toLowerCase() }, 1, "Key redemptions and failures");
          return new ProblemError(code === "KEY_ALREADY_REDEEMED" ? 409 : 400, code, undefined, {}, { [CAPTCHA_STRIKE_HEADER]: "1" });
        };
        return ctx.db.transaction().execute(async (trx) => {
          const key = await trx
            .selectFrom("keys")
            .innerJoin("key_batches", "key_batches.id", "keys.batch_id")
            .select(["keys.id", "keys.redeemed_by", "keys.revoked_at", "key_batches.revoked_at as batch_revoked_at", "key_batches.expires_at", "key_batches.product_id", "key_batches.label"])
            .where("keys.code_hash", "=", keyHash(body.code))
            .forUpdate("keys")
            .executeTakeFirst();
          if (!key) throw fail("KEY_INVALID");
          if (key.revoked_at || key.batch_revoked_at) throw fail("KEY_REVOKED");
          if (key.expires_at && key.expires_at < new Date()) throw fail("KEY_EXPIRED");
          if (key.redeemed_by) throw fail(key.redeemed_by === userId ? "KEY_ALREADY_REDEEMED" : "KEY_INVALID");
          const product = await trx.selectFrom("products").selectAll().where("id", "=", key.product_id).executeTakeFirstOrThrow();
          const { entitlement } = await grantEntitlement(ctx, trx, { user_id: userId, product, source: "key_redemption", source_ref: key.id }, gameActor(id));
          await trx.updateTable("keys").set({ redeemed_by: userId, redeemed_at: new Date(), entitlement_id: entitlement.id }).where("id", "=", key.id).execute();
          inc("qtiauth_games_key_redemptions_total", { result: "ok" }, 1, "Key redemptions and failures");
          const game = await trx.selectFrom("games").selectAll().where("id", "=", product.game_id).executeTakeFirstOrThrow();
          return { status: "redeemed", game: gameView(game), product: { sku: product.sku, name: product.name, kind: product.kind }, entitlement: entitlementView(entitlement) };
        });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/entitlements",
      summary: "Grant an entitlement from an external system",
      description: "For payment systems, storefronts or membership integrations. Needs a client-credentials token with games.entitlements.write. Repeating the same grant is a no-op.",
      tags: ["games", "integrations"],
      auth: "service",
      scopes: ["games.entitlements.write"],
      rate_limit: ["game_service"],
      body: z.object({ user_id: z.uuid(), sku: z.string().max(80), external_ref: z.string().max(200).optional(), expires_at: z.iso.datetime().nullable().optional() }),
      async handler({ body, id }) {
        await requireUser(body.user_id);
        const product = await productBySku(body.sku);
        const r = await ctx.db.transaction().execute((trx) =>
          grantEntitlement(ctx, trx, { user_id: body.user_id, product, source: "api", source_ref: body.external_ref ?? null, granted_by: `client:${id.client_id}`, expires_at: body.expires_at ? new Date(body.expires_at) : body.expires_at === null ? null : undefined }, { type: "service", id: id.client_id ?? "api" }),
        );
        return { ...entitlementView(r.entitlement), created: r.created };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/entitlements/revoke",
      summary: "Revoke an entitlement granted through the external API",
      description: "Only revokes the api-sourced grant. Grants from other sources (keys, Steam, staff) stay.",
      tags: ["games", "integrations"],
      auth: "service",
      scopes: ["games.entitlements.write"],
      rate_limit: ["game_service"],
      body: z.object({ user_id: z.uuid(), sku: z.string().max(80), reason: z.string().trim().min(1).max(500) }),
      async handler({ body, id }) {
        const product = await productBySku(body.sku);
        const ent = await ctx.db.selectFrom("entitlements").selectAll().where("user_id", "=", body.user_id).where("product_id", "=", product.id).where("source", "=", "api").where("revoked_at", "is", null).executeTakeFirst();
        if (!ent) throw new ProblemError(404, "ENTITLEMENT_NOT_FOUND");
        await ctx.db.transaction().execute((trx) => revokeEntitlement(ctx, trx, ent, body.reason, `client:${id.client_id}`, { type: "service", id: id.client_id ?? "api" }));
        return { status: "revoked" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/games/devices",
      summary: "Devices registered for offline play",
      tags,
      auth: "session",
      async handler({ id }) {
        const rows = await ctx.db
          .selectFrom("devices")
          .innerJoin("games", "games.id", "devices.game_id")
          .select(["devices.device_hash", "devices.name", "devices.first_seen_at", "devices.last_seen_at", "games.slug", "games.name as game_name"])
          .where("devices.user_id", "=", id.sub!)
          .where("devices.removed_at", "is", null)
          .orderBy("devices.last_seen_at", "desc")
          .execute();
        return { items: rows.map((d) => ({ ...d, first_seen_at: d.first_seen_at.toISOString(), last_seen_at: d.last_seen_at.toISOString() })) };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/games/devices/:slug/:hash",
      summary: "Remove a device",
      description: "Revokes the leases issued to that device.",
      tags,
      auth: "session",
      rate_limit: ["account_write"],
      params: z.object({ slug: zSlug, hash: z.string().regex(/^[0-9a-f]{64}$/) }),
      async handler({ params, id }) {
        const g = await findGame(ctx.db, params.slug);
        if (!g) throw new ProblemError(404, "GAME_NOT_FOUND");
        await ctx.db.updateTable("devices").set({ removed_at: new Date() }).where("user_id", "=", id.sub!).where("game_id", "=", g.id).where("device_hash", "=", params.hash).execute();
        await revokeLeases(ctx, { user_id: id.sub!, game_id: g.id, device_hash: params.hash }, "device_removed");
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/games/server/removal-requests",
      summary: "Content removal requests for this game",
      description: "Moderation asks the game to remove content. Poll with the game server credential and acknowledge once removed.",
      tags: ["games", "server"],
      auth: "service",
      scopes: ["games.server"],
      rate_limit: ["game_service"],
      async handler({ id }) {
        if (!id.game_id) throw new ProblemError(403, "GAME_SERVER_CREDENTIAL_REQUIRED");
        const rows = await ctx.db.selectFrom("removal_requests").selectAll().where("game_id", "=", id.game_id).where("acknowledged_at", "is", null).orderBy("created_at").limit(500).execute();
        return { items: rows.map((r) => ({ id: r.id, action_id: r.action_id, user_id: r.user_id, content: r.content, created_at: r.created_at.toISOString() })) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/server/removal-requests/:id/ack",
      summary: "Acknowledge a content removal",
      tags: ["games", "server"],
      auth: "service",
      scopes: ["games.server"],
      rate_limit: ["game_service"],
      params: z.object({ id: z.uuid() }),
      async handler({ params, id }) {
        if (!id.game_id) throw new ProblemError(403, "GAME_SERVER_CREDENTIAL_REQUIRED");
        const r = await ctx.db.updateTable("removal_requests").set({ acknowledged_at: new Date() }).where("id", "=", params.id).where("game_id", "=", id.game_id).executeTakeFirst();
        if (!Number(r.numUpdatedRows)) throw new ProblemError(404, "REMOVAL_REQUEST_NOT_FOUND");
        return { status: "acknowledged" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/games/entitlements",
      summary: "A user's entitlements, including revoked ones",
      tags: adminTags,
      ...staff(["games.entitlements.grant"]),
      query: z.object({ user_id: z.uuid() }),
      async handler({ query }) {
        const rows = await ctx.db
          .selectFrom("entitlements")
          .innerJoin("products", "products.id", "entitlements.product_id")
          .innerJoin("games", "games.id", "entitlements.game_id")
          .selectAll("entitlements")
          .select(["products.sku", "products.name as product_name", "products.kind", "games.slug as game_slug", "games.name as game_name"])
          .where("entitlements.user_id", "=", query.user_id)
          .orderBy("entitlements.granted_at", "desc")
          .execute();
        return { items: rows.map((r) => ({ ...entitlementView(r), game_slug: r.game_slug, game_name: r.game_name, source_ref: r.source_ref, granted_by: r.granted_by })) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games/entitlements",
      summary: "Grant an entitlement",
      tags: adminTags,
      ...staff(["games.entitlements.grant"], { step_up: true }),
      body: z.object({ user_id: z.uuid(), sku: z.string().max(80), expires_at: z.iso.datetime().nullable().optional(), reason: zReason }),
      async handler({ body, id }) {
        await requireUser(body.user_id);
        const product = await productBySku(body.sku);
        const r = await ctx.db.transaction().execute(async (trx) => {
          const res = await grantEntitlement(ctx, trx, { user_id: body.user_id, product, source: "admin_grant", granted_by: id.sub!, expires_at: body.expires_at ? new Date(body.expires_at) : null }, { type: "staff", id: id.sub! });
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "games.entitlement_granted", target: { type: "user", id: body.user_id }, reason: body.reason, data: { sku: body.sku, entitlement_id: res.entitlement.id } });
          return res;
        });
        return { ...entitlementView(r.entitlement), created: r.created };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games/entitlements/:id/revoke",
      summary: "Revoke an entitlement",
      tags: adminTags,
      ...staff(["games.entitlements.grant"], { step_up: true }),
      params: z.object({ id: z.uuid() }),
      body: z.object({ reason: zReason }),
      async handler({ params, body, id }) {
        const ent = await ctx.db.selectFrom("entitlements").selectAll().where("id", "=", params.id).executeTakeFirst();
        if (!ent) throw new ProblemError(404, "ENTITLEMENT_NOT_FOUND");
        await ctx.db.transaction().execute(async (trx) => {
          await revokeEntitlement(ctx, trx, ent, body.reason, id.sub!, { type: "staff", id: id.sub! });
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "games.entitlement_revoked", target: { type: "user", id: ent.user_id }, reason: body.reason, data: { entitlement_id: ent.id } });
        });
        return { status: "revoked" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/games/:slug/key-batches",
      summary: "Key batches for a game",
      tags: adminTags,
      ...staff(["games.keys.manage"]),
      params: z.object({ slug: zSlug }),
      async handler({ params }) {
        const g = await requireGame(ctx.db, params.slug, { staff: true });
        const rows = await ctx.db
          .selectFrom("key_batches")
          .innerJoin("products", "products.id", "key_batches.product_id")
          .selectAll("key_batches")
          .select(["products.sku", sql<number>`(select count(*)::int from keys where keys.batch_id = key_batches.id and keys.redeemed_by is not null)`.as("redeemed")])
          .where("key_batches.game_id", "=", g.id)
          .orderBy("key_batches.created_at", "desc")
          .execute();
        return { items: rows.map((b) => ({ id: b.id, label: b.label, sku: b.sku, count: b.count, redeemed: b.redeemed, format: b.format, expires_at: b.expires_at?.toISOString() ?? null, created_at: b.created_at.toISOString(), exported_at: b.exported_at?.toISOString() ?? null, revoked_at: b.revoked_at?.toISOString() ?? null })) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games/:slug/key-batches",
      summary: "Generate a key batch",
      tags: adminTags,
      ...staff(["games.keys.manage"]),
      params: z.object({ slug: zSlug }),
      body: z.object({ sku: z.string().max(80), count: z.number().int().min(1), label: z.string().trim().min(1).max(100), format: z.string().regex(/^[X-]{5,64}$/).optional(), expires_at: z.iso.datetime().nullable().optional() }),
      async handler({ params, body, id }) {
        if (!keysEnabled) throw new ProblemError(404, "KEYS_DISABLED");
        const g = await requireGame(ctx.db, params.slug, { staff: true });
        const product = await productBySku(body.sku);
        if (product.game_id !== g.id) throw new ProblemError(422, "PRODUCT_NOT_IN_GAME");
        if (body.count > ctx.config.games.keys.max_batch) throw new ProblemError(422, "BATCH_TOO_LARGE", undefined, { max: ctx.config.games.keys.max_batch });
        const format = body.format ?? ctx.config.games.keys.format;
        if ((format.match(/X/g) ?? []).length < 12) throw new ProblemError(422, "KEY_FORMAT_TOO_SHORT", "Key formats need at least 12 random characters");
        const cipher = keyCipher(ctx);
        const batchId = uuidv7();
        await ctx.db.transaction().execute(async (trx) => {
          await trx.insertInto("key_batches").values({ id: batchId, game_id: g.id, product_id: product.id, label: body.label, count: body.count, format, expires_at: body.expires_at ? new Date(body.expires_at) : null, created_by: id.sub! }).execute();
          const seen = new Set<string>();
          for (let made = 0; made < body.count; ) {
            const chunk: { id: string; batch_id: string; code_hash: string; code_enc: string }[] = [];
            while (chunk.length < 1000 && made + chunk.length < body.count) {
              const code = generateKey(format);
              const h = keyHash(code);
              if (seen.has(h)) continue;
              seen.add(h);
              chunk.push({ id: uuidv7(), batch_id: batchId, code_hash: h, code_enc: encrypt(cipher, code, `key:${batchId}`) });
            }
            await trx.insertInto("keys").values(chunk).onConflict((oc) => oc.column("code_hash").doNothing()).execute();
            made += chunk.length;
          }
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "games.key_batch_created", target: { type: "game", id: g.id }, data: { batch_id: batchId, count: body.count, sku: body.sku, label: body.label } });
          await ctx.email(trx, { template: "key_batch_ready", to: { user_id: id.sub! }, vars: { label: body.label, count: body.count }, sender: "support" });
        });
        return { id: batchId, label: body.label, count: body.count, sku: body.sku };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/games/key-batches/:id/export",
      summary: "Export a key batch as CSV",
      description: "Requires step-up. Every export is audited.",
      tags: adminTags,
      ...staff(["games.keys.manage"], { step_up: true }),
      produces: "text/csv; charset=utf-8",
      params: z.object({ id: z.uuid() }),
      async handler({ params, id }) {
        const batch = await ctx.db.selectFrom("key_batches").selectAll().where("id", "=", params.id).executeTakeFirst();
        if (!batch) throw new ProblemError(404, "BATCH_NOT_FOUND");
        const cipher = keyCipher(ctx);
        const keys = await ctx.db.selectFrom("keys").select(["code_enc", "redeemed_at", "revoked_at"]).where("batch_id", "=", batch.id).execute();
        const lines = ["code,redeemed,revoked", ...keys.map((k) => [decrypt(cipher, k.code_enc, `key:${batch.id}`).toString(), k.redeemed_at ? "yes" : "no", k.revoked_at ? "yes" : "no"].map(csvCell).join(","))];
        await ctx.db.updateTable("key_batches").set({ exported_at: new Date() }).where("id", "=", batch.id).execute();
        await ctx.audit(ctx.db, { actor: { type: "staff", id: id.sub! }, action: "games.key_batch_exported", target: { type: "key_batch", id: batch.id }, ip: id.ip });
        const name = `${batch.label.replace(/[^A-Za-z0-9_-]+/g, "_")}-${batch.id.slice(0, 8)}.csv`;
        return reply(200, `${lines.join("\n")}\n`, { "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games/key-batches/:id/revoke",
      summary: "Revoke a key batch",
      description: "Unredeemed keys stop working. Optionally also revokes entitlements already granted from the batch.",
      tags: adminTags,
      ...staff(["games.keys.manage"], { step_up: true }),
      params: z.object({ id: z.uuid() }),
      body: z.object({ revoke_entitlements: z.boolean().default(false), reason: zReason }),
      async handler({ params, body, id }) {
        const batch = await ctx.db.selectFrom("key_batches").selectAll().where("id", "=", params.id).executeTakeFirst();
        if (!batch) throw new ProblemError(404, "BATCH_NOT_FOUND");
        let revoked = 0;
        await ctx.db.transaction().execute(async (trx) => {
          await trx.updateTable("key_batches").set({ revoked_at: new Date() }).where("id", "=", batch.id).execute();
          await trx.updateTable("keys").set({ revoked_at: new Date() }).where("batch_id", "=", batch.id).where("revoked_at", "is", null).execute();
          if (body.revoke_entitlements) {
            const ents = await trx
              .selectFrom("entitlements")
              .selectAll()
              .where("source", "=", "key_redemption")
              .where("revoked_at", "is", null)
              .where("id", "in", trx.selectFrom("keys").select("entitlement_id").where("batch_id", "=", batch.id).where("entitlement_id", "is not", null) as never)
              .execute();
            for (const e of ents) await revokeEntitlement(ctx, trx, e, `key batch revoked: ${body.reason}`, id.sub!, { type: "staff", id: id.sub! });
            revoked = ents.length;
          }
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "games.key_batch_revoked", target: { type: "key_batch", id: batch.id }, reason: body.reason, data: { revoke_entitlements: body.revoke_entitlements, entitlements_revoked: revoked } });
        });
        return { status: "revoked", entitlements_revoked: revoked };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games/:slug/achievements/:key/revoke",
      summary: "Revoke an achievement unlock",
      tags: adminTags,
      ...staff(["games.achievements.moderate"]),
      params: z.object({ slug: zSlug, key: z.string().max(64) }),
      body: z.object({ user_id: z.uuid(), reason: zReason }),
      async handler({ params, body, id }) {
        const g = await requireGame(ctx.db, params.slug, { staff: true });
        const a = await ctx.db.selectFrom("achievements").select("id").where("game_id", "=", g.id).where("key", "=", params.key).where("deleted_at", "is", null).executeTakeFirst();
        if (!a) throw new ProblemError(404, "ACHIEVEMENT_NOT_FOUND");
        await ctx.db.transaction().execute(async (trx) => {
          const r = await trx.updateTable("achievement_unlocks").set({ revoked_at: new Date(), revoked_by: id.sub!, revoke_reason: body.reason }).where("user_id", "=", body.user_id).where("achievement_id", "=", a.id).executeTakeFirst();
          if (!Number(r.numUpdatedRows)) throw new ProblemError(404, "UNLOCK_NOT_FOUND");
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "games.achievement_revoked", target: { type: "user", id: body.user_id }, reason: body.reason, data: { game: g.slug, achievement: params.key } });
        });
        return { status: "revoked" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games/:slug/leaderboards/:key/remove",
      summary: "Remove a leaderboard entry",
      tags: adminTags,
      ...staff(["games.leaderboards.moderate"]),
      params: z.object({ slug: zSlug, key: z.string().max(64) }),
      body: z.object({ user_id: z.uuid(), period: z.string().max(60).optional(), reason: zReason }),
      async handler({ params, body, id }) {
        const g = await requireGame(ctx.db, params.slug, { staff: true });
        const lb = await ctx.db.selectFrom("leaderboards").selectAll().where("game_id", "=", g.id).where("key", "=", params.key).where("deleted_at", "is", null).executeTakeFirst();
        if (!lb) throw new ProblemError(404, "LEADERBOARD_NOT_FOUND");
        const period = body.period ?? lb.current_period;
        await ctx.db.transaction().execute(async (trx) => {
          const r = await trx
            .updateTable("leaderboard_entries")
            .set({ removed_at: new Date(), removed_by: id.sub!, removed_reason: body.reason })
            .where("leaderboard_id", "=", lb.id)
            .where("period", "=", period)
            .where("user_id", "=", body.user_id)
            .executeTakeFirst();
          if (!Number(r.numUpdatedRows)) throw new ProblemError(404, "ENTRY_NOT_FOUND");
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "games.leaderboard_entry_removed", target: { type: "user", id: body.user_id }, reason: body.reason, data: { game: g.slug, leaderboard: lb.key, period } });
        });
        return { status: "removed" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/games/licensing/revoke",
      summary: "Revoke a user's licence leases",
      tags: adminTags,
      ...staff(["games.licensing.manage"]),
      body: z.object({ user_id: z.uuid(), slug: zSlug.optional(), reason: zReason }),
      async handler({ body, id }) {
        const g = body.slug ? await requireGame(ctx.db, body.slug, { staff: true }) : null;
        const n = await revokeLeases(ctx, { user_id: body.user_id, ...(g ? { game_id: g.id } : {}) }, body.reason);
        await ctx.audit(ctx.db, { actor: { type: "staff", id: id.sub! }, action: "games.leases_revoked", target: { type: "user", id: body.user_id }, reason: body.reason, data: { game: g?.slug ?? null, count: n } });
        return { status: "revoked", count: n };
      },
    }),
  ];
}

export async function userEntitlementsSummary(ctx: Ctx, userId: string) {
  const rows = await ctx.db
    .selectFrom("entitlements")
    .innerJoin("products", "products.id", "entitlements.product_id")
    .innerJoin("games", "games.id", "entitlements.game_id")
    .selectAll("entitlements")
    .select(["products.sku", "products.name as product_name", "products.kind", "games.slug as game_slug", "games.name as game_name"])
    .where("entitlements.user_id", "=", userId)
    .orderBy("entitlements.granted_at", "desc")
    .execute();
  return { items: rows.map((r) => ({ ...entitlementView(r), game_slug: r.game_slug, game_name: r.game_name })) };
}

export async function applyPrefsFromUser(ctx: Ctx, userId: string, claims: Pick<IdentityClaims, "age_band" | "parental_controls">): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    const guardian = claims.parental_controls ? Boolean(claims.parental_controls.leaderboards) : null;
    const existing = await trx.selectFrom("player_prefs").select("user_id").where("user_id", "=", userId).executeTakeFirst();
    if (!existing) return;
    await trx.updateTable("player_prefs").set({ age_band: claims.age_band ?? null, guardian_leaderboards: guardian, updated_at: new Date() }).where("user_id", "=", userId).execute();
    await refreshVisibility(trx, userId);
  });
}
