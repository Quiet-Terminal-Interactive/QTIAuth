import { sql } from "kysely";
import { ProblemError, uuidv7 } from "@qtiauth/common";
import { EVENTS } from "@qtiauth/bus";
import type { User } from "../db/types.ts";
import type { Ctx, Exec } from "./ctx.ts";
import { checkText } from "./filter.ts";

export function canonicalUsername(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}

export function validateUsernameShape(ctx: Ctx, name: string): void {
  const u = ctx.config.usernames;
  const re = new RegExp(`^${u.charset}+$`);
  const len = [...name].length;
  if (len < u.min_length || len > u.max_length || !re.test(name)) {
    throw new ProblemError(422, "USERNAME_INVALID", undefined, { min_length: u.min_length, max_length: u.max_length });
  }
}

function notAvailable(): ProblemError {
  return new ProblemError(409, "USERNAME_NOT_AVAILABLE", "Username not available");
}

export async function assertUsernameAvailable(ctx: Ctx, db: Exec, name: string, forUserId: string | null): Promise<string> {
  validateUsernameShape(ctx, name);
  const canonical = canonicalUsername(name);
  const u = ctx.config.usernames;
  if (u.reserved.some((r) => canonicalUsername(r) === canonical)) throw notAvailable();
  if (u.reserved_prefixes.some((p) => canonical.startsWith(canonicalUsername(p)))) throw notAvailable();
  const taken = await db.selectFrom("users").select("id").where("username_canonical", "=", canonical).executeTakeFirst();
  if (taken && taken.id !== forUserId) throw notAvailable();
  const hold = await db
    .selectFrom("username_history")
    .select(["user_id", "hold_until"])
    .where("canonical", "=", canonical)
    .where("hold_until", ">", new Date())
    .orderBy("released_at", "desc")
    .executeTakeFirst();
  if (hold && hold.user_id !== forUserId) throw notAvailable();
  const decision = await checkText(ctx, db, name, "username");
  if (decision.action === "block") throw notAvailable();
  return canonical;
}

export async function assertCanChange(ctx: Ctx, db: Exec, user: User): Promise<void> {
  if (!user.username || user.force_username_reset) return;
  const u = ctx.config.usernames;
  if ((user.restrictions ?? []).some((r) => r.name === "username_change" && (!r.until || new Date(r.until) > new Date()))) {
    throw new ProblemError(403, "USERNAME_CHANGE_RESTRICTED");
  }
  if (user.username_changed_at && Date.now() - user.username_changed_at.getTime() < u.change_cooldown) {
    throw new ProblemError(429, "USERNAME_COOLDOWN", undefined, { available_at: new Date(user.username_changed_at.getTime() + u.change_cooldown).toISOString() });
  }
  const yearAgo = new Date(Date.now() - 365 * 86_400_000);
  const r = await db
    .selectFrom("username_history")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("user_id", "=", user.id)
    .where("claimed_at", ">", yearAgo)
    .where("reason", "<>", "initial")
    .executeTakeFirst();
  if ((r?.n ?? 0) >= u.yearly_limit) throw new ProblemError(429, "USERNAME_YEARLY_LIMIT", undefined, { limit: u.yearly_limit });
}

export async function applyUsername(ctx: Ctx, db: Exec, user: User, name: string, canonical: string, reason: string, actor: { type: "user" | "staff" | "guardian" | "system"; id: string }): Promise<void> {
  const now = new Date();
  if (user.username && user.username_canonical) {
    await db
      .updateTable("username_history")
      .set({ released_at: now, hold_until: new Date(now.getTime() + ctx.config.usernames.release_hold) })
      .where("user_id", "=", user.id)
      .where("canonical", "=", user.username_canonical)
      .where("released_at", "is", null)
      .execute();
  }
  await db
    .updateTable("users")
    .set({ username: name, username_canonical: canonical, username_changed_at: user.username ? now : null, force_username_reset: false, updated_at: now })
    .where("id", "=", user.id)
    .execute();
  await db
    .updateTable("username_history")
    .set({ hold_until: null })
    .where("canonical", "=", canonical)
    .where("user_id", "=", user.id)
    .where("hold_until", "is not", null)
    .execute();
  await db
    .insertInto("username_history")
    .values({ id: uuidv7(), user_id: user.id, username: name, canonical, claimed_at: now, reason: user.username ? reason : "initial" })
    .execute();
  await ctx.emit(db, EVENTS.userUsernameChanged, { user_id: user.id, username: name, previous: user.username }, { actor, subject: { type: "user", id: user.id } });
  await ctx.emit(db, EVENTS.userUpdated, { user_id: user.id, reason: "username" }, { actor, subject: { type: "user", id: user.id } });
}

export async function releaseUsername(ctx: Ctx, db: Exec, user: User, holdMs = ctx.config.usernames.release_hold): Promise<void> {
  if (!user.username_canonical) return;
  const now = new Date();
  await db
    .updateTable("username_history")
    .set({ released_at: now, hold_until: new Date(now.getTime() + holdMs) })
    .where("user_id", "=", user.id)
    .where("canonical", "=", user.username_canonical)
    .where("released_at", "is", null)
    .execute();
}

export async function usernameHistory(db: Exec, userId: string) {
  const rows = await db.selectFrom("username_history").selectAll().where("user_id", "=", userId).orderBy("claimed_at", "desc").execute();
  return rows.map((r) => ({
    username: r.username,
    claimed_at: r.claimed_at.toISOString(),
    released_at: r.released_at?.toISOString() ?? null,
    hold_until: r.hold_until?.toISOString() ?? null,
    reason: r.reason,
  }));
}
