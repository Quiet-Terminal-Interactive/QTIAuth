import { EVENTS } from "@qtiauth/bus";
import type { Restriction } from "@qtiauth/auth-context";
import type { User } from "../db/types.ts";
import type { Ctx, Exec } from "./ctx.ts";
import { getUser, setState, activeRestrictions, bandOf } from "./users.ts";
import { revokeAllSessions } from "./sessions.ts";

type Actor = { type: "user" | "staff" | "system" | "service"; id: string };

export async function banUser(ctx: Ctx, db: Exec, user: User, reason: string, actor: Actor, reasonCode?: string): Promise<void> {
  if (user.state === "banned") return;
  await setState(ctx, db, user, "banned", actor, { banned_at: new Date(), ban_reason: reason, locked_until: null });
  await ctx.emit(db, EVENTS.userBanned, { user_id: user.id, reason_code: reasonCode ?? null }, { actor, subject: { type: "user", id: user.id } });
  await notifyGuardiansOfModeration(ctx, db, user, "ban");
}

export async function unbanUser(ctx: Ctx, db: Exec, user: User, actor: Actor): Promise<void> {
  if (user.state !== "banned") return;
  await setState(ctx, db, user, "active", actor, { banned_at: null, ban_reason: null });
  await ctx.emit(db, EVENTS.userUnbanned, { user_id: user.id }, { actor, subject: { type: "user", id: user.id } });
}

export async function lockUser(ctx: Ctx, db: Exec, user: User, until: Date | null, reason: string, actor: Actor): Promise<void> {
  if (user.state === "banned") return;
  await setState(ctx, db, user, "locked", actor, { locked_until: until, lock_reason: reason });
  await ctx.emit(db, EVENTS.userLocked, { user_id: user.id, until: until?.toISOString() ?? null }, { actor, subject: { type: "user", id: user.id } });
  await notifyGuardiansOfModeration(ctx, db, user, "lock");
}

export async function unlockUser(ctx: Ctx, db: Exec, user: User, actor: Actor): Promise<void> {
  if (user.state !== "locked") return;
  await setState(ctx, db, user, "active", actor, { locked_until: null, lock_reason: null });
  await ctx.emit(db, EVENTS.userUnlocked, { user_id: user.id }, { actor, subject: { type: "user", id: user.id } });
}

export async function setRestrictions(ctx: Ctx, db: Exec, user: User, restrictions: Restriction[], actor: Actor): Promise<void> {
  await db.updateTable("users").set({ restrictions: JSON.stringify(restrictions), updated_at: new Date() }).where("id", "=", user.id).execute();
  await ctx.emit(db, EVENTS.userRestricted, { user_id: user.id, restrictions }, { actor, subject: { type: "user", id: user.id } });
  await ctx.emit(db, EVENTS.userUpdated, { user_id: user.id, reason: "restrictions" }, { actor, subject: { type: "user", id: user.id } });
}

async function notifyGuardiansOfModeration(ctx: Ctx, db: Exec, user: User, action: string): Promise<void> {
  if (bandOf(ctx, user) === "adult") return;
  const guardians = await db.selectFrom("guardians").select(["id", "email"]).where("child_user_id", "=", user.id).where("status", "=", "active").execute();
  for (const g of guardians) {
    await ctx.email(db, {
      template: "guardian_moderation_action",
      to: { email: g.email, guardian_id: g.id },
      locale: user.locale,
      vars: { child_name: user.username ?? "your child", action },
      sender: "security",
      priority: "high",
    });
  }
}

export interface SafetyActionEvent {
  action_id: string;
  user_id: string;
  effect: "warn" | "restrict" | "force_username_reset" | "lock" | "ban" | "remove_content" | "proscribed_org_removal";
  restrictions?: string[];
  expires_at?: string | null;
  reason_code?: string | null;
  rule?: string | null;
}

export async function applySafetyAction(ctx: Ctx, db: Exec, e: SafetyActionEvent): Promise<void> {
  const user = await getUser(db, e.user_id);
  if (!user || user.state === "deleted") return;
  const actor: Actor = { type: "service", id: "safety" };
  const expires = e.expires_at ? new Date(e.expires_at) : null;
  await db
    .insertInto("enforcements")
    .values({ action_id: e.action_id, user_id: user.id, effect: e.effect, restrictions: JSON.stringify(e.restrictions ?? []), expires_at: expires })
    .onConflict((oc) => oc.column("action_id").doNothing())
    .execute();
  switch (e.effect) {
    case "restrict": {
      const current = activeRestrictions(user).filter((r) => r.action_id !== e.action_id);
      const added = (e.restrictions ?? []).map((name) => ({ name, until: e.expires_at ?? null, action_id: e.action_id }));
      await setRestrictions(ctx, db, user, [...current, ...added], actor);
      break;
    }
    case "force_username_reset":
      await db.updateTable("users").set({ force_username_reset: true, updated_at: new Date() }).where("id", "=", user.id).execute();
      await ctx.emit(db, EVENTS.userUpdated, { user_id: user.id, reason: "force_username_reset" }, { actor, subject: { type: "user", id: user.id } });
      break;
    case "lock":
      await lockUser(ctx, db, user, expires, e.rule ?? "moderation", actor);
      break;
    case "ban":
    case "proscribed_org_removal":
      await banUser(ctx, db, user, e.rule ?? "moderation", actor, e.reason_code ?? undefined);
      if (e.effect === "proscribed_org_removal") await revokeAllSessions(ctx, db, user.id, "proscribed_org_removal", { type: "system", id: "safety" });
      break;
    default:
      if (e.effect === "warn") await notifyGuardiansOfModeration(ctx, db, user, "warning");
      break;
  }
}

export async function liftSafetyAction(ctx: Ctx, db: Exec, actionId: string): Promise<void> {
  const enf = await db.selectFrom("enforcements").selectAll().where("action_id", "=", actionId).executeTakeFirst();
  if (!enf || enf.lifted_at) return;
  await db.updateTable("enforcements").set({ lifted_at: new Date() }).where("action_id", "=", actionId).execute();
  const user = await getUser(db, enf.user_id);
  if (!user || user.state === "deleted") return;
  const actor: Actor = { type: "service", id: "safety" };
  if (enf.effect === "restrict") {
    await setRestrictions(ctx, db, user, activeRestrictions(user).filter((r) => r.action_id !== actionId), actor);
  } else if (enf.effect === "lock") {
    await unlockUser(ctx, db, user, actor);
  } else if (enf.effect === "ban" || enf.effect === "proscribed_org_removal") {
    const otherBans = await db.selectFrom("enforcements").select("action_id").where("user_id", "=", user.id).where("effect", "in", ["ban", "proscribed_org_removal"]).where("lifted_at", "is", null).executeTakeFirst();
    if (!otherBans) await unbanUser(ctx, db, user, actor);
  } else if (enf.effect === "force_username_reset") {
    await db.updateTable("users").set({ force_username_reset: false }).where("id", "=", user.id).execute();
  }
}

export async function expireLocksAndRestrictions(ctx: Ctx): Promise<number> {
  const now = new Date();
  let n = 0;
  const locked = await ctx.db.selectFrom("users").selectAll().where("state", "=", "locked").where("locked_until", "is not", null).where("locked_until", "<=", now).limit(500).execute();
  for (const u of locked) {
    await ctx.db.transaction().execute(async (trx) => {
      await unlockUser(ctx, trx, u, { type: "system", id: "lock-expiry" });
      await trx.updateTable("enforcements").set({ lifted_at: now }).where("user_id", "=", u.id).where("effect", "=", "lock").where("lifted_at", "is", null).execute();
    });
    n++;
  }
  const restricted = await ctx.db.selectFrom("users").selectAll().where("restrictions", "!=", JSON.stringify([]) as never).limit(1000).execute();
  for (const u of restricted) {
    const active = activeRestrictions(u, now.getTime());
    if (active.length !== u.restrictions.length) {
      await ctx.db.transaction().execute((trx) => setRestrictions(ctx, trx, u, active, { type: "system", id: "restriction-expiry" }));
      n++;
    }
  }
  return n;
}
