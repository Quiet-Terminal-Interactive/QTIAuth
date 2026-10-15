import { sql } from "kysely";
import { inc, ProblemError } from "@qtiauth/common";
import { EVENTS } from "@qtiauth/bus";
import { ledgerStore } from "@qtiauth/service-kit";
import type { User } from "../db/types.ts";
import type { Ctx, Exec } from "./ctx.ts";
import { displayName, setState } from "./users.ts";
import { revokeAllSessions } from "./sessions.ts";
import { releaseUsername } from "./usernames.ts";

export const ERASING_SERVICES = ["oidc", "safety", "support", "games", "notifier"];

export async function requestDeletion(ctx: Ctx, db: Exec, user: User, actor: { type: "user" | "guardian" | "staff"; id: string }): Promise<Date> {
  if (user.state === "pending_deletion" && user.deletion_due_at) return user.deletion_due_at;
  if (user.state === "deleted") throw new ProblemError(404, "USER_NOT_FOUND");
  const due = new Date(Date.now() + ctx.config.accounts.deletion_grace);
  await setState(ctx, db, user, "pending_deletion", actor as never, { deletion_requested_at: new Date(), deletion_due_at: due });
  await revokeAllSessions(ctx, db, user.id, "account_deletion", actor);
  await ctx.emit(db, EVENTS.userDeletionRequested, { user_id: user.id, due_at: due.toISOString() }, { actor, subject: { type: "user", id: user.id } });
  await ctx.audit(db, { actor, action: "account.deletion_requested", target: { type: "user", id: user.id } });
  await ctx.email(db, {
    template: "deletion_scheduled",
    to: { user_id: user.id },
    locale: user.locale,
    vars: { name: displayName(user), due_at: due.toISOString() },
    sender: "security",
    priority: "high",
  });
  inc("qtiauth_account_deletions_total", { result: "requested" }, 1, "Account deletion lifecycle");
  return due;
}

export async function purgeAccount(ctx: Ctx, db: Exec, user: User, reason: string): Promise<void> {
  const holds = await db.selectFrom("legal_holds").select("id").where("user_id", "=", user.id).where("released_at", "is", null).execute();
  const legalHold = holds.length > 0;
  await revokeAllSessions(ctx, db, user.id, "account_deleted", { type: "system", id: "deletion" });
  await releaseUsername(ctx, db, user);
  const exports = await db.selectFrom("data_exports").select(["object_key"]).where("user_id", "=", user.id).execute();
  if (ctx.storage) {
    for (const e of exports) if (e.object_key) await ctx.storage.delete(e.object_key).catch(() => undefined);
    await ctx.storage.deletePrefix(`exports/${user.id}/`).catch(() => undefined);
  }
  for (const table of ["identities", "passkeys", "totp", "recovery_codes", "known_devices", "notification_prefs", "legal_acceptances", "age_assurance_results", "user_roles", "guardian_requests", "enforcements"] as const) {
    await db.deleteFrom(table).where(table === "guardian_requests" ? "child_user_id" : "user_id", "=", user.id).execute();
  }
  await db.deleteFrom("guardians").where("child_user_id", "=", user.id).execute();
  await db.updateTable("guardians").set({ user_id: null }).where("user_id", "=", user.id).execute();
  await db.deleteFrom("tokens").where("user_id", "=", user.id).execute();
  if (!legalHold) await db.deleteFrom("security_events").where("user_id", "=", user.id).execute();
  await db.deleteFrom("data_exports").where("user_id", "=", user.id).execute();
  await sql`delete from session_bindings where session_id in (select id from sessions where user_id = ${user.id})`.execute(db);
  await db.deleteFrom("sessions").where("user_id", "=", user.id).execute();
  await db.updateTable("username_history").set({ username: "[deleted]" }).where("user_id", "=", user.id).where("hold_until", "is", null).execute();
  await db
    .updateTable("users")
    .set({
      state: "deleted",
      previous_state: user.state,
      email: null,
      email_normalized: null,
      email_verified_at: null,
      dob: null,
      username: null,
      username_canonical: null,
      locale: null,
      parental_controls: null,
      restrictions: JSON.stringify([]),
      lock_reason: null,
      ban_reason: null,
      last_sign_in_method: null,
      deleted_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", user.id)
    .execute();
  const expected = (await expectedErasers(ctx)).filter((s) => s !== "identity");
  await db
    .insertInto("erasures")
    .values({ user_id: user.id, expected: JSON.stringify(expected), completed: JSON.stringify(["identity"]), legal_hold: legalHold })
    .onConflict((oc) => oc.column("user_id").doNothing())
    .execute();
  await ctx.emit(db, EVENTS.userDeleted, { user_id: user.id, legal_hold: legalHold, reason }, { subject: { type: "user", id: user.id } });
  await ctx.audit(db, { actor: { type: "system", id: "deletion" }, action: "account.deleted", target: { type: "user", id: user.id }, data: { reason, legal_hold: legalHold } });
  inc("qtiauth_account_deletions_total", { result: "completed" }, 1, "Account deletion lifecycle");
  if (!expected.length) await completeErasure(db, user.id);
}

async function expectedErasers(ctx: Ctx): Promise<string[]> {
  const registered = await ctx.registeredServices().catch(() => [] as string[]);
  if (registered.length) return registered.filter((s) => ERASING_SERVICES.includes(s));
  return ["notifier"];
}

export async function recordErasure(ctx: Ctx, db: Exec, userId: string, service: string): Promise<void> {
  const row = await db.selectFrom("erasures").selectAll().where("user_id", "=", userId).executeTakeFirst();
  if (!row || row.completed_at) return;
  const completed = [...new Set([...row.completed, service])];
  await db.updateTable("erasures").set({ completed: JSON.stringify(completed) }).where("user_id", "=", userId).execute();
  if (row.expected.every((s) => completed.includes(s))) await completeErasure(db, userId);
  ctx.log.debug({ service, done: completed.length, expected: row.expected.length }, "erasure progress");
}

export async function completeErasure(db: Exec, userId: string): Promise<void> {
  const now = new Date();
  await db.updateTable("erasures").set({ completed_at: now }).where("user_id", "=", userId).where("completed_at", "is", null).execute();
  await db
    .insertInto("deletion_ledger_outbox")
    .values({ user_id: userId, deleted_at: now })
    .onConflict((oc) => oc.column("user_id").doNothing())
    .execute();
}

export async function forceStaleErasures(ctx: Ctx): Promise<number> {
  const stale = await ctx.db.selectFrom("erasures").select(["user_id", "expected", "completed"]).where("completed_at", "is", null).where("started_at", "<", new Date(Date.now() - 86_400_000)).execute();
  for (const s of stale) {
    ctx.log.warn({ missing: s.expected.filter((e) => !s.completed.includes(e)) }, "erasure confirmations missing after 24h; writing ledger entry anyway");
    await completeErasure(ctx.db, s.user_id);
  }
  return stale.length;
}

export async function flushLedger(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.selectFrom("deletion_ledger_outbox").selectAll().where("written_at", "is", null).limit(500).execute();
  if (!rows.length) return 0;
  const store = ledgerStore(ctx.config);
  let written = 0;
  for (const r of rows) {
    try {
      await store.write({ user_id: r.user_id, deleted_at: r.deleted_at.toISOString() });
      await ctx.db.updateTable("deletion_ledger_outbox").set({ written_at: new Date(), last_error: null }).where("user_id", "=", r.user_id).execute();
      written++;
    } catch (err) {
      await ctx.db
        .updateTable("deletion_ledger_outbox")
        .set({ attempts: sql`attempts + 1`, last_error: (err as Error).message.slice(0, 500) })
        .where("user_id", "=", r.user_id)
        .execute();
    }
  }
  return written;
}

export async function pruneLedger(ctx: Ctx): Promise<number> {
  const cutoff = Date.now() - (ctx.config.backups.retention + ctx.config.deletion_ledger.extra_retention);
  const store = ledgerStore(ctx.config);
  let removed = 0;
  for (const e of await store.list()) {
    if (new Date(e.deleted_at).getTime() < cutoff) {
      await store.remove(e.user_id);
      removed++;
    }
  }
  await ctx.db.deleteFrom("deletion_ledger_outbox").where("written_at", "<", new Date(cutoff)).execute();
  return removed;
}

export async function purgeDue(ctx: Ctx): Promise<number> {
  const due = await ctx.db.selectFrom("users").selectAll().where("state", "=", "pending_deletion").where("deletion_due_at", "<=", new Date()).limit(200).execute();
  for (const u of due) {
    await ctx.db.transaction().execute((trx) => purgeAccount(ctx, trx, u, "grace_period_ended"));
  }
  return due.length;
}

export async function replayDeletionLedger(ctx: Ctx, entries: { user_id: string; deleted_at: string }[]): Promise<string[]> {
  const ids = [...new Set(entries.map((e) => e.user_id))];
  const replayed: string[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const users = await ctx.db.selectFrom("users").selectAll().where("id", "in", chunk).execute();
    for (const user of users) {
      await ctx.db.transaction().execute(async (trx) => {
        await trx.deleteFrom("erasures").where("user_id", "=", user.id).execute();
        await purgeAccount(ctx, trx, user, "backup_restore");
      });
      replayed.push(user.id);
    }
  }
  return replayed;
}

export async function revokeRestoredSessions(ctx: Ctx): Promise<number> {
  const now = new Date();
  await ctx.db.updateTable("session_bindings").set({ revoked_at: now }).where("revoked_at", "is", null).execute();
  const r = await ctx.db.updateTable("sessions").set({ revoked_at: now, revoke_reason: "backup_restore" }).where("revoked_at", "is", null).executeTakeFirst();
  return Number(r.numUpdatedRows);
}
