import { sql } from "kysely";
import { inc, setGauge } from "@qtiauth/common";
import { ageBand } from "@qtiauth/auth-context";
import { surfaceUrl } from "@qtiauth/config";
import { EVENTS, type EventEnvelope } from "@qtiauth/bus";
import type { AuditEntry } from "@qtiauth/service-kit";
import type { Ctx } from "./lib/ctx.ts";
import { storeAudit, pruneAudit } from "./lib/audit.ts";
import { flushLedger, forceStaleErasures, pruneLedger, purgeAccount, purgeDue, recordErasure } from "./lib/deletion.ts";
import { applySafetyAction, expireLocksAndRestrictions, liftSafetyAction, type SafetyActionEvent } from "./lib/enforcement.ts";
import { activitySummary } from "./lib/parental.ts";
import { displayName } from "./lib/users.ts";
import { invalidateLegalCache, legalPendingGauge } from "./lib/legal.ts";
import { activeSessionGauge } from "./lib/sessions.ts";
import { reloadCustomEntries } from "./lib/filter.ts";
import { runExport } from "./lib/exports.ts";

export async function registerConsumers(ctx: Ctx): Promise<void> {
  await ctx.on<AuditEntry & { service: string; occurred_at: string }>("audit-store", [EVENTS.auditRecorded], async (env, trx) => {
    await storeAudit(trx, env as EventEnvelope<AuditEntry & { service: string; occurred_at: string }>);
  });

  await ctx.on<{ user_id: string; service: string }>("erasure-progress", ["qtiauth.*.user.erased.v1"], async (env, trx) => {
    const service = env.data.service ?? env.type.split(".")[1]!;
    await recordErasure(ctx, trx, env.data.user_id, service);
  });

  await ctx.on<SafetyActionEvent & { action_id: string }>("enforcement", [EVENTS.safetyActionApplied, EVENTS.safetyActionLifted], async (env, trx) => {
    if (env.type === EVENTS.safetyActionApplied) await applySafetyAction(ctx, trx, env.data);
    else await liftSafetyAction(ctx, trx, env.data.action_id);
  });

  await ctx.on<{ user_id: string; hold_id: string; reason: string; reference?: string }>("legal-holds", [EVENTS.safetyLegalHoldPlaced, EVENTS.safetyLegalHoldReleased], async (env, trx) => {
    if (env.type === EVENTS.safetyLegalHoldPlaced) {
      await trx
        .insertInto("legal_holds")
        .values({ id: env.data.hold_id, user_id: env.data.user_id, reason: env.data.reason, reference: env.data.reference ?? null, placed_by: "safety" })
        .onConflict((oc) => oc.column("id").doNothing())
        .execute();
    } else {
      await trx.updateTable("legal_holds").set({ released_at: new Date() }).where("id", "=", env.data.hold_id).execute();
    }
  });

  ctx.bus.subscribe("qtiauth.identity.filter.reload", () => reloadCustomEntries(ctx));

  await ctx.bus.consumeQueue<{ export_id: string }>({
    queue: "identity.export",
    durable: "identity-export",
    ackWaitMs: 15 * 60_000,
    maxDeliver: 5,
    concurrency: 2,
    handler: async (p) => {
      await runExport(ctx, p.export_id);
    },
  });
}

async function recomputeBands(ctx: Ctx): Promise<void> {
  const today = new Date();
  const m = today.getUTCMonth() + 1;
  const d = today.getUTCDate();
  const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const leapCatch = m === 3 && d === 1 && !isLeap(today.getUTCFullYear());
  const rows = await sql<{ id: string; dob: string; age_band_cached: string | null; locale: string | null; username: string | null; email: string | null; parental_controls: unknown; graduated_at: Date | null }>`
    select id, dob::text as dob, age_band_cached, locale, username, email, parental_controls, graduated_at from users
    where dob is not null and state <> 'deleted'
      and ((extract(month from dob) = ${m} and extract(day from dob) = ${d})
        ${leapCatch ? sql`or (extract(month from dob) = 2 and extract(day from dob) = 29)` : sql``}
        or age_band_cached is null)`.execute(ctx.db);
  for (const u of rows.rows) {
    const band = ageBand(u.dob, ctx.config.age.boundaries, today);
    const age = today.getUTCFullYear() - new Date(`${u.dob}T00:00:00Z`).getUTCFullYear();
    await ctx.db.transaction().execute(async (trx) => {
      if (band !== u.age_band_cached) {
        await trx.updateTable("users").set({ age_band_cached: band, updated_at: new Date() }).where("id", "=", u.id).execute();
        if (u.age_band_cached) {
          await ctx.emit(trx, EVENTS.userAgeBandChanged, { user_id: u.id, from: u.age_band_cached, to: band }, { subject: { type: "user", id: u.id } });
          await ctx.emit(trx, EVENTS.userUpdated, { user_id: u.id, reason: "age_band" }, { subject: { type: "user", id: u.id } });
        }
      }
      if (u.parental_controls && !u.graduated_at && age >= ctx.config.parental.consent_age) {
        const optionalAt = new Date(Date.now() + ctx.config.parental.graduation_grace);
        await trx.updateTable("users").set({ graduated_at: new Date(), guardian_controls_optional_at: optionalAt }).where("id", "=", u.id).execute();
        const vars = { name: u.username ?? "there", optional_at: optionalAt.toISOString(), settings_url: surfaceUrl(ctx.surfaces.account, "/settings/family") };
        await ctx.email(trx, { template: "graduation_child", to: { user_id: u.id }, locale: u.locale, vars, sender: "auth" });
        const guardians = await trx.selectFrom("guardians").select(["id", "email"]).where("child_user_id", "=", u.id).where("status", "=", "active").execute();
        for (const g of guardians) {
          await ctx.email(trx, { template: "graduation_guardian", to: { email: g.email, guardian_id: g.id }, locale: u.locale, vars: { child_name: u.username ?? "your child", optional_at: optionalAt.toISOString() }, sender: "auth" });
        }
        await ctx.emit(trx, EVENTS.parentalGraduated, { user_id: u.id, controls_optional_at: optionalAt.toISOString() }, { subject: { type: "user", id: u.id } });
      }
    });
  }
}

async function expirePendingConsent(ctx: Ctx): Promise<void> {
  const cutoff = new Date(Date.now() - ctx.config.parental.pending_ttl);
  const rows = await ctx.db.selectFrom("users").selectAll().where("state", "=", "pending_parental_consent").where("created_at", "<", cutoff).limit(500).execute();
  for (const u of rows) {
    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable("guardians").set({ status: "declined" }).where("child_user_id", "=", u.id).where("status", "=", "pending").execute();
      await purgeAccount(ctx, trx, u, "parental_consent_expired");
    });
    inc("qtiauth_guardian_decisions_total", { decision: "expired" }, 1, "Guardian consent decisions");
  }
}

async function guardianReminders(ctx: Ctx): Promise<void> {
  const cutoff = new Date(Date.now() - ctx.config.parental.reminder_interval);
  const rows = await ctx.db
    .selectFrom("guardian_requests")
    .selectAll()
    .where("status", "=", "pending")
    .where("created_at", "<", cutoff)
    .where((eb) => eb.or([eb("last_reminded_at", "is", null), eb("last_reminded_at", "<", cutoff)]))
    .limit(500)
    .execute();
  for (const r of rows) {
    await ctx.db.transaction().execute(async (trx) => {
      const child = await trx.selectFrom("users").selectAll().where("id", "=", r.child_user_id).executeTakeFirst();
      if (!child) return;
      const guardians = await trx.selectFrom("guardians").select(["id", "email"]).where("child_user_id", "=", r.child_user_id).where("status", "=", "active").execute();
      for (const g of guardians) {
        await ctx.email(trx, {
          template: `guardian_request_reminder`,
          to: { email: g.email, guardian_id: g.id },
          locale: child.locale,
          vars: { child_name: displayName(child), type: r.type, dashboard_url: surfaceUrl(ctx.surfaces.account, "/family") },
          sender: "auth",
        });
      }
      await trx.updateTable("guardian_requests").set({ last_reminded_at: new Date() }).where("id", "=", r.id).execute();
    });
  }
  const pendingGuardians = await ctx.db
    .selectFrom("guardians")
    .innerJoin("users", "users.id", "guardians.child_user_id")
    .selectAll("guardians")
    .where("guardians.status", "=", "pending")
    .where("users.state", "=", "pending_parental_consent")
    .where("guardians.created_at", "<", cutoff)
    .where((eb) => eb.or([eb("guardians.last_reminded_at", "is", null), eb("guardians.last_reminded_at", "<", cutoff)]))
    .limit(500)
    .execute();
  const { sendConsentEmail } = await import("./lib/parental.ts");
  for (const g of pendingGuardians) {
    await ctx.db.transaction().execute(async (trx) => {
      const child = await trx.selectFrom("users").selectAll().where("id", "=", g.child_user_id).executeTakeFirstOrThrow();
      await sendConsentEmail(ctx, trx, child, g);
      await trx.updateTable("guardians").set({ last_reminded_at: new Date() }).where("id", "=", g.id).execute();
    });
  }
}

async function weeklyActivity(ctx: Ctx): Promise<void> {
  const guardians = await ctx.db.selectFrom("guardians").selectAll().where("status", "=", "active").execute();
  for (const g of guardians) {
    const child = await ctx.db.selectFrom("users").selectAll().where("id", "=", g.child_user_id).executeTakeFirst();
    if (!child || child.state === "deleted") continue;
    const summary = await activitySummary(ctx, ctx.db, child.id);
    await ctx.db.transaction().execute((trx) =>
      ctx.email(trx, {
        template: "guardian_activity_summary",
        to: { email: g.email, guardian_id: g.id },
        locale: child.locale,
        vars: {
          child_name: displayName(child),
          sign_in_count: summary.sign_ins.length,
          games: summary.games,
          apps: summary.apps_connected,
          total_playtime_minutes: summary.games.reduce((a, x) => a + (x.playtime_minutes ?? 0), 0),
          dashboard_url: surfaceUrl(ctx.surfaces.account, "/family"),
        },
        sender: "auth",
        dedupe_key: `activity-${g.id}-${new Date().toISOString().slice(0, 10)}`,
      }),
    );
  }
}

async function activateLegalVersions(ctx: Ctx): Promise<void> {
  const due = await ctx.db.selectFrom("legal_documents").selectAll().where("effective_at", "<=", new Date()).where("effective_notified_at", "is", null).execute();
  for (const d of due) {
    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable("legal_documents").set({ effective_notified_at: new Date() }).where("id", "=", d.id).where("version", "=", d.version).execute();
      const earlier = await trx.selectFrom("legal_documents").select("version").where("id", "=", d.id).where("effective_at", "<", d.effective_at).executeTakeFirst();
      if (!earlier || !d.requires_acceptance) return;
      await ctx.emit(
        trx,
        EVENTS.legalVersionEffective,
        { document_id: d.id, version: d.version, title: d.title, material: d.material, summary: d.summary, url: surfaceUrl(ctx.surfaces.account, `/legal/${d.id}`) },
        { subject: { type: "legal_document", id: d.id } },
      );
    });
  }
  if (due.length) invalidateLegalCache();
}

async function retention(ctx: Ctx): Promise<Record<string, number>> {
  const r = ctx.config.retention;
  const now = Date.now();
  const del = async (q: Promise<{ numDeletedRows: bigint }>) => Number((await q).numDeletedRows);
  const out: Record<string, number> = {};
  out.session_bindings = Number(
    (await sql`delete from session_bindings where session_id in (select id from sessions where coalesce(revoked_at, expires_at) < ${new Date(now - r.sessions)})`.execute(ctx.db)).numAffectedRows ?? 0,
  );
  out.sessions = await del(
    ctx.db
      .deleteFrom("sessions")
      .where((eb) => eb.or([eb("revoked_at", "<", new Date(now - r.sessions)), eb("expires_at", "<", new Date(now - r.sessions))]))
      .executeTakeFirst(),
  );
  out.security_events = await del(
    ctx.db
      .deleteFrom("security_events")
      .where("created_at", "<", new Date(now - r.security_events))
      .where((eb) => eb.or([eb("user_id", "is", null), eb("user_id", "not in", eb.selectFrom("legal_holds").select("user_id").where("released_at", "is", null))]))
      .executeTakeFirst(),
  );
  out.tokens = await del(ctx.db.deleteFrom("tokens").where("expires_at", "<", new Date(now - r.tokens_after_expiry)).executeTakeFirst());
  out.filter_raw_input = Number(
    (await ctx.db.updateTable("filter_decisions").set({ raw_input: null }).where("raw_input", "is not", null).where("created_at", "<", new Date(now - r.filter_raw_input)).executeTakeFirst()).numUpdatedRows,
  );
  out.filter_decisions = await del(ctx.db.deleteFrom("filter_decisions").where("created_at", "<", new Date(now - Math.max(r.filter_raw_input, 90 * 86_400_000))).executeTakeFirst());
  out.audit_log = await pruneAudit(ctx);
  const expiredExports = await ctx.db.selectFrom("data_exports").select(["id", "object_key"]).where("expires_at", "<", new Date()).where("status", "=", "ready").execute();
  for (const e of expiredExports) {
    if (e.object_key && ctx.storage) await ctx.storage.delete(e.object_key).catch(() => undefined);
    await ctx.db.updateTable("data_exports").set({ status: "expired", object_key: null }).where("id", "=", e.id).execute();
  }
  out.data_exports = expiredExports.length;
  out.erasures = await del(ctx.db.deleteFrom("erasures").where("completed_at", "<", new Date(now - 90 * 86_400_000)).executeTakeFirst());
  out.username_holds = Number((await ctx.db.updateTable("username_history").set({ hold_until: null }).where("hold_until", "<", new Date()).executeTakeFirst()).numUpdatedRows);
  return out;
}

export function cronJobs(): Record<string, (ctx: Ctx) => Promise<void>> {
  return {
    "parental.expire_pending": expirePendingConsent,
    "parental.reminders": guardianReminders,
    "parental.activity_summary": weeklyActivity,
    "accounts.purge_deleted": async (ctx) => {
      await purgeDue(ctx);
      await forceStaleErasures(ctx);
    },
    "age.recompute_bands": recomputeBands,
    "deletion_ledger.flush": async (ctx) => {
      await flushLedger(ctx);
    },
    "deletion_ledger.prune": async (ctx) => {
      await pruneLedger(ctx);
    },
    "identity.expire_locks": async (ctx) => {
      await expireLocksAndRestrictions(ctx);
    },
    "legal.activate_versions": activateLegalVersions,
  };
}

export { retention };

export function startGauges(ctx: Ctx): () => void {
  const fast = setInterval(async () => {
    try {
      const rows = await ctx.db.selectFrom("users").select(["state", ctx.db.fn.countAll<number>().as("n")]).groupBy("state").execute();
      for (const r of rows) setGauge("qtiauth_accounts", Number(r.n), { state: r.state }, "Accounts by state");
      await activeSessionGauge(ctx);
    } catch {
      return;
    }
  }, 60_000);
  const slow = setInterval(() => void legalPendingGauge(ctx).catch(() => undefined), 10 * 60_000);
  fast.unref();
  slow.unref();
  return () => {
    clearInterval(fast);
    clearInterval(slow);
  };
}
