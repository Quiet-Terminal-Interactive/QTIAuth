import { SignJWT, createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { ProblemError, inc, randomToken, sha256 } from "@qtiauth/common";
import { issuer } from "@qtiauth/config";
import { KeyStore } from "@qtiauth/service-kit";
import type { Game } from "../db.ts";
import { activeEntitlements, type Ctx } from "./core.ts";

let store: KeyStore | null = null;

export function licensingKeys(ctx: Ctx): KeyStore {
  if (!store) {
    store = new KeyStore({ db: ctx.db, purpose: "licensing", alg: "EdDSA", kek: ctx.config.secrets.key_encryption_key, rotateEveryMs: ctx.config.keys.rotate_every, overlapMs: Math.max(ctx.config.keys.overlap, ctx.config.games.lease_duration + 86_400_000), log: ctx.log });
  }
  return store;
}

export function resetLicensingKeys(): void {
  store = null;
}

export interface LeaseClaims extends JWTPayload {
  gid: string;
  game: string;
  products: string[];
  dev?: string;
}

export function deviceHash(game: Game, deviceId: string): string {
  return sha256(`device:${game.id}:${deviceId}`);
}

export function leaseDuration(ctx: Ctx, game: Game): number {
  return game.settings.lease_duration_ms ?? ctx.config.games.lease_duration;
}

export async function issueLease(ctx: Ctx, game: Game, userId: string, deviceId: string | null, deviceName: string | null): Promise<{ lease: string; jti: string; expires_at: string; products: string[] }> {
  const owned = await activeEntitlements(ctx.db, userId, game.id);
  if (!owned.length) throw new ProblemError(403, "NOT_OWNED");
  const products = [...new Set(owned.map((e) => e.sku))].sort();
  const binding = game.settings.device_binding ?? false;
  if (binding && !deviceId) throw new ProblemError(422, "DEVICE_ID_REQUIRED");
  const dev = binding && deviceId ? deviceHash(game, deviceId) : null;
  if (dev) {
    const max = game.settings.max_devices ?? ctx.config.features.games.licensing.max_devices;
    const known = await ctx.db.selectFrom("devices").select(["device_hash"]).where("user_id", "=", userId).where("game_id", "=", game.id).where("removed_at", "is", null).execute();
    if (!known.some((d) => d.device_hash === dev) && known.length >= max) throw new ProblemError(409, "DEVICE_LIMIT_REACHED", "Remove a device on your account page to use this one", { max_devices: max });
    await ctx.db
      .insertInto("devices")
      .values({ user_id: userId, game_id: game.id, device_hash: dev, name: deviceName })
      .onConflict((oc) => oc.columns(["user_id", "game_id", "device_hash"]).doUpdateSet({ last_seen_at: new Date(), removed_at: null, ...(deviceName ? { name: deviceName } : {}) }))
      .execute();
  }
  const jti = `lic_${randomToken(16)}`;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.floor(leaseDuration(ctx, game) / 1000);
  const key = await licensingKeys(ctx).current();
  const lease = await new SignJWT({ gid: game.id, game: game.slug, products, ...(dev ? { dev } : {}) })
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: "qtiauth-license+jwt" })
    .setIssuer(issuer(ctx.config))
    .setSubject(userId)
    .setAudience(`game:${game.slug}`)
    .setJti(jti)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(key.privateKey);
  await ctx.db.insertInto("leases").values({ jti, user_id: userId, game_id: game.id, device_hash: dev, products: JSON.stringify(products), expires_at: new Date(exp * 1000) }).execute();
  inc("qtiauth_games_leases_total", { event: "issued" }, 1, "Leases issued and verified");
  return { lease, jti, expires_at: new Date(exp * 1000).toISOString(), products };
}

export async function verifyLease(ctx: Ctx, token: string): Promise<{ valid: boolean; reason?: string; claims?: LeaseClaims }> {
  const set = createLocalJWKSet(await licensingKeys(ctx).jwks());
  let claims: LeaseClaims;
  try {
    const r = await jwtVerify<LeaseClaims>(token, set, { issuer: issuer(ctx.config), typ: "qtiauth-license+jwt" });
    claims = r.payload;
  } catch (err) {
    inc("qtiauth_games_leases_total", { event: "verify_invalid" }, 1, "Leases issued and verified");
    return { valid: false, reason: (err as { code?: string }).code === "ERR_JWT_EXPIRED" ? "expired" : "invalid_signature" };
  }
  const row = await ctx.db.selectFrom("leases").select(["revoked_at"]).where("jti", "=", claims.jti!).executeTakeFirst();
  if (!row) return { valid: false, reason: "unknown" };
  if (row.revoked_at) {
    inc("qtiauth_games_leases_total", { event: "verify_revoked" }, 1, "Leases issued and verified");
    return { valid: false, reason: "revoked", claims };
  }
  inc("qtiauth_games_leases_total", { event: "verified" }, 1, "Leases issued and verified");
  return { valid: true, claims };
}

export async function signedRevocations(ctx: Ctx, since: Date): Promise<string> {
  const rows = await ctx.db
    .selectFrom("leases")
    .innerJoin("games", "games.id", "leases.game_id")
    .select(["leases.jti", "leases.revoked_at", "leases.expires_at", "games.slug"])
    .where("leases.revoked_at", ">", since)
    .where("leases.expires_at", ">", new Date())
    .orderBy("leases.revoked_at")
    .limit(10_000)
    .execute();
  const key = await licensingKeys(ctx).current();
  inc("qtiauth_games_revocation_pulls_total", {}, 1, "Revocation-list pulls");
  return new SignJWT({ revoked: rows.map((r) => ({ jti: r.jti, game: r.slug, revoked_at: Math.floor(r.revoked_at!.getTime() / 1000), exp: Math.floor(r.expires_at.getTime() / 1000) })), since: Math.floor(since.getTime() / 1000) })
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: "qtiauth-revocations+jwt" })
    .setIssuer(issuer(ctx.config))
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key.privateKey);
}

export async function revokeLeases(ctx: Ctx, where: { user_id: string; game_id?: string; device_hash?: string }, reason: string): Promise<number> {
  let q = ctx.db.updateTable("leases").set({ revoked_at: new Date(), revoke_reason: reason }).where("user_id", "=", where.user_id).where("revoked_at", "is", null).where("expires_at", ">", new Date());
  if (where.game_id) q = q.where("game_id", "=", where.game_id);
  if (where.device_hash) q = q.where("device_hash", "=", where.device_hash);
  const r = await q.executeTakeFirst();
  return Number(r.numUpdatedRows);
}
