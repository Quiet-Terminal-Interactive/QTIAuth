import { ProblemError, inc, uuidv7 } from "@qtiauth/common";
import { EVENTS, type Actor } from "@qtiauth/bus";
import type { IdentityClaims } from "@qtiauth/auth-context";
import type { ServiceContext, Exec as KitExec } from "@qtiauth/service-kit";
import type { Authority, Entitlement, EntitlementSource, Game, GamesDB, Product } from "../db.ts";

export type Ctx = ServiceContext<GamesDB>;
export type Exec = KitExec<GamesDB>;

export const PUBLIC_STATUSES = ["early_access", "released", "archived"] as const;

export async function findGame(db: Exec, slug: string): Promise<Game | undefined> {
  return db.selectFrom("games").selectAll().where("slug", "=", slug).where("deleted_at", "is", null).executeTakeFirst();
}

export async function requireGame(db: Exec, slug: string, opts: { staff?: boolean } = {}): Promise<Game> {
  const g = await findGame(db, slug);
  if (!g || (!opts.staff && !(PUBLIC_STATUSES as readonly string[]).includes(g.status))) throw new ProblemError(404, "GAME_NOT_FOUND");
  return g;
}

export function isStaffViewer(id: IdentityClaims): boolean {
  return id.perms.some((p) => p.startsWith("games."));
}

export interface Player {
  userId: string;
  trust: Authority;
}

export function playerRead(id: IdentityClaims): string {
  if (!id.sub) throw new ProblemError(401, "UNAUTHENTICATED");
  return id.sub;
}

export function playerWrite(id: IdentityClaims, game: Game, opts: { allowGameAuthority?: boolean } = {}): Player {
  if (!id.sub) throw new ProblemError(401, "UNAUTHENTICATED");
  if (id.auth === "game_authoritative") {
    if (opts.allowGameAuthority === false) throw new ProblemError(403, "WRONG_CREDENTIAL_TYPE");
    if (id.game_id !== game.id) throw new ProblemError(403, "WRONG_GAME", "The credentials belong to a different game");
    return { userId: id.sub, trust: "game" };
  }
  if (id.auth === "oauth") {
    if (id.game_id !== game.id) throw new ProblemError(403, "WRONG_GAME", "Only this game's own client can write its player data");
    return { userId: id.sub, trust: "player" };
  }
  throw new ProblemError(403, "WRONG_CREDENTIAL_TYPE");
}

export function requiresGameAuthority(ctx: Ctx, game: Game): boolean {
  return game.settings.require_game_authority ?? ctx.config.features.games.leaderboards.require_game_authority;
}

export function gameActor(id: IdentityClaims): Actor {
  if (id.sub) return { type: "user", id: id.sub };
  return { type: "service", id: id.client_id ?? "games" };
}

export async function activeEntitlements(db: Exec, userId: string, gameId?: string): Promise<(Entitlement & { sku: string; product_name: string; kind: string })[]> {
  let q = db
    .selectFrom("entitlements")
    .innerJoin("products", "products.id", "entitlements.product_id")
    .selectAll("entitlements")
    .select(["products.sku", "products.name as product_name", "products.kind"])
    .where("entitlements.user_id", "=", userId)
    .where("entitlements.revoked_at", "is", null)
    .where((eb) => eb.or([eb("entitlements.expires_at", "is", null), eb("entitlements.expires_at", ">", new Date())]));
  if (gameId) q = q.where("entitlements.game_id", "=", gameId);
  return q.orderBy("entitlements.granted_at").execute();
}

export async function ownsGame(db: Exec, userId: string, gameId: string): Promise<boolean> {
  return (await activeEntitlements(db, userId, gameId)).length > 0;
}

export interface GrantInput {
  user_id: string;
  product: Product;
  source: EntitlementSource;
  source_ref?: string | null;
  granted_by?: string | null;
  expires_at?: Date | null;
}

export async function grantEntitlement(ctx: Ctx, trx: Exec, input: GrantInput, actor: Actor): Promise<{ entitlement: Entitlement; created: boolean }> {
  if (input.product.retired_at) throw new ProblemError(409, "PRODUCT_RETIRED");
  const existing = await trx
    .selectFrom("entitlements")
    .selectAll()
    .where("user_id", "=", input.user_id)
    .where("product_id", "=", input.product.id)
    .where("source", "=", input.source)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (existing) {
    if (input.expires_at !== undefined && String(existing.expires_at) !== String(input.expires_at)) {
      const updated = await trx.updateTable("entitlements").set({ expires_at: input.expires_at }).where("id", "=", existing.id).returningAll().executeTakeFirstOrThrow();
      return { entitlement: updated, created: false };
    }
    return { entitlement: existing, created: false };
  }
  const ent = await trx
    .insertInto("entitlements")
    .values({
      id: uuidv7(),
      user_id: input.user_id,
      product_id: input.product.id,
      game_id: input.product.game_id,
      source: input.source,
      source_ref: input.source_ref ?? null,
      granted_by: input.granted_by ?? null,
      expires_at: input.expires_at ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await ctx.emit(
    trx,
    EVENTS.gamesEntitlementGranted,
    { entitlement_id: ent.id, user_id: ent.user_id, product_id: ent.product_id, game_id: ent.game_id, source: ent.source, expires_at: ent.expires_at?.toISOString() ?? null, trust: "game" },
    { actor, subject: { type: "user", id: ent.user_id } },
  );
  inc("qtiauth_games_entitlements_total", { event: "granted", source: ent.source }, 1, "Entitlements granted and revoked");
  return { entitlement: ent, created: true };
}

export async function revokeEntitlement(ctx: Ctx, trx: Exec, ent: Entitlement, reason: string, by: string | null, actor: Actor): Promise<void> {
  if (ent.revoked_at) return;
  await trx.updateTable("entitlements").set({ revoked_at: new Date(), revoke_reason: reason, revoked_by: by }).where("id", "=", ent.id).execute();
  await ctx.emit(
    trx,
    EVENTS.gamesEntitlementRevoked,
    { entitlement_id: ent.id, user_id: ent.user_id, product_id: ent.product_id, game_id: ent.game_id, source: ent.source, revoked_at: new Date().toISOString(), trust: "game" },
    { actor, subject: { type: "user", id: ent.user_id } },
  );
  inc("qtiauth_games_entitlements_total", { event: "revoked", source: ent.source }, 1, "Entitlements granted and revoked");
}

export function entitlementView(e: Entitlement & { sku?: string; product_name?: string; kind?: string }) {
  return {
    id: e.id,
    product_id: e.product_id,
    sku: e.sku,
    product_name: e.product_name,
    kind: e.kind,
    game_id: e.game_id,
    source: e.source,
    granted_at: e.granted_at.toISOString(),
    expires_at: e.expires_at?.toISOString() ?? null,
    revoked_at: e.revoked_at?.toISOString() ?? null,
    revoke_reason: e.revoke_reason,
  };
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function periodFor(resetPeriod: string, now = new Date()): string {
  if (resetPeriod === "never") return "all";
  if (resetPeriod === "daily") return now.toISOString().slice(0, 10);
  if (resetPeriod === "weekly") return isoWeek(now);
  if (resetPeriod === "monthly") return now.toISOString().slice(0, 7);
  if (resetPeriod.startsWith("season:")) return resetPeriod;
  throw new ProblemError(422, "INVALID_RESET_PERIOD");
}

export function validResetPeriod(p: string): boolean {
  return ["never", "daily", "weekly", "monthly"].includes(p) || /^season:[a-z0-9_-]{1,40}$/.test(p);
}

export interface VisibilityInput {
  pref: boolean | null;
  age_band: string | null;
  guardian_leaderboards: boolean | null;
}

export function leaderboardVisible(v: VisibilityInput): boolean {
  if (v.pref === false) return false;
  if (v.guardian_leaderboards !== null) return v.guardian_leaderboards;
  return v.age_band === "adult" || v.pref === true;
}

export async function syncPlayerPrefs(trx: Exec, id: IdentityClaims): Promise<VisibilityInput> {
  const userId = id.sub!;
  const guardian = id.parental_controls ? Boolean(id.parental_controls.leaderboards) : null;
  const band = id.age_band ?? null;
  const row = await trx
    .insertInto("player_prefs")
    .values({ user_id: userId, leaderboard_visible: null, age_band: band, guardian_leaderboards: guardian })
    .onConflict((oc) => oc.column("user_id").doUpdateSet({ age_band: band, guardian_leaderboards: guardian }))
    .returningAll()
    .executeTakeFirstOrThrow();
  return { pref: row.leaderboard_visible, age_band: row.age_band, guardian_leaderboards: row.guardian_leaderboards };
}

export async function refreshVisibility(trx: Exec, userId: string): Promise<void> {
  const p = await trx.selectFrom("player_prefs").selectAll().where("user_id", "=", userId).executeTakeFirst();
  if (!p) return;
  const visible = leaderboardVisible({ pref: p.leaderboard_visible, age_band: p.age_band, guardian_leaderboards: p.guardian_leaderboards });
  await trx.updateTable("leaderboard_entries").set({ visible }).where("user_id", "=", userId).where("visible", "!=", visible).execute();
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
