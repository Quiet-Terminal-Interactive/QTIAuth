import { sql } from "kysely";
import { ProblemError, uuidv7, inc } from "@qtiauth/common";
import { ageBand, type IdentityClaims, type ParentalControls } from "@qtiauth/auth-context";
import { surfaceUrl } from "@qtiauth/config";
import { EVENTS } from "@qtiauth/bus";
import type { Guardian, User } from "../db/types.ts";
import type { Ctx, Exec } from "./ctx.ts";
import { issueToken } from "./tokens.ts";
import { displayName, getUser, normalizeEmail, requireUser, setState } from "./users.ts";
import { runAssurance, isRequiredFor } from "./age.ts";
import { guardianEmailsFor } from "./guardian-notify.ts";

export function consentUrl(ctx: Ctx, token: string): string {
  return `${surfaceUrl(ctx.surfaces.account, "/family/consent")}?token=${encodeURIComponent(token)}`;
}

export function familyAccessUrl(ctx: Ctx, token: string): string {
  return `${surfaceUrl(ctx.surfaces.account, "/family/access")}?token=${encodeURIComponent(token)}`;
}

export async function startGuardianConsent(ctx: Ctx, db: Exec, child: User, guardianEmail: string, invitedBy: string | null = null): Promise<Guardian> {
  const normalized = normalizeEmail(ctx.config, guardianEmail);
  if (child.email_normalized && normalized === child.email_normalized) throw new ProblemError(422, "GUARDIAN_EMAIL_SAME_AS_CHILD");
  const existing = await db.selectFrom("guardians").selectAll().where("child_user_id", "=", child.id).where("email_normalized", "=", normalized).where("status", "in", ["pending", "active"]).executeTakeFirst();
  const guardian =
    existing ??
    (await db
      .insertInto("guardians")
      .values({ id: uuidv7(), child_user_id: child.id, email: guardianEmail.trim(), email_normalized: normalized, status: "pending", invited_by: invitedBy })
      .returningAll()
      .executeTakeFirstOrThrow());
  if (guardian.status === "active") return guardian;
  await sendConsentEmail(ctx, db, child, guardian);
  await ctx.emit(db, EVENTS.parentalConsentRequested, { child_user_id: child.id, guardian_id: guardian.id }, { subject: { type: "user", id: child.id } });
  return guardian;
}

export async function sendConsentEmail(ctx: Ctx, db: Exec, child: User, guardian: Guardian): Promise<void> {
  await db.updateTable("tokens").set({ used_at: new Date() }).where("kind", "=", "guardian_consent").where("used_at", "is", null).where(sql<boolean>`data @> ${JSON.stringify({ guardian_id: guardian.id })}::jsonb`).execute();
  const { token, expiresAt } = await issueToken(db, "guardian_consent", {
    userId: child.id,
    email: guardian.email,
    data: { guardian_id: guardian.id },
    ttlMs: ctx.config.parental.pending_ttl,
  });
  await ctx.email(db, {
    template: "guardian_consent_request",
    to: { email: guardian.email, guardian_id: guardian.id },
    locale: child.locale,
    vars: {
      child_name: displayName(child),
      child_email: child.email,
      consent_url: consentUrl(ctx, token),
      privacy_summary_url: surfaceUrl(ctx.surfaces.account, "/legal/children-summary"),
      privacy_url: surfaceUrl(ctx.surfaces.account, "/legal/privacy"),
      expires_at: expiresAt.toISOString(),
    },
    sender: "auth",
    priority: "high",
  });
}

export async function approveConsent(
  ctx: Ctx,
  db: Exec,
  guardianId: string,
  input: { guardian_dob: string; display_name?: string | null },
): Promise<{ guardian: Guardian; child: User }> {
  const guardian = await db.selectFrom("guardians").selectAll().where("id", "=", guardianId).executeTakeFirst();
  if (!guardian || guardian.status !== "pending") throw new ProblemError(400, "INVALID_OR_EXPIRED_TOKEN");
  const band = ageBand(input.guardian_dob, ctx.config.age.boundaries);
  if (band !== "adult") throw new ProblemError(422, "GUARDIAN_MUST_BE_ADULT");
  const child = await requireUser(db, guardian.child_user_id);
  const active = await db.selectFrom("guardians").select("id").where("child_user_id", "=", child.id).where("status", "=", "active").execute();
  if (active.length >= ctx.config.parental.max_guardians) throw new ProblemError(409, "MAX_GUARDIANS_REACHED");
  const updated = await db
    .updateTable("guardians")
    .set({ status: "active", dob: input.guardian_dob, display_name: input.display_name ?? null, approved_at: new Date() })
    .where("id", "=", guardian.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  let childNow = child;
  if (child.state === "pending_parental_consent") {
    childNow = await setState(ctx, db, child, "active", { type: "guardian", id: guardian.id } as never);
    await ctx.email(db, { template: "parental_consent_granted", to: { user_id: child.id }, locale: child.locale, vars: { name: displayName(child) }, sender: "auth" });
  }
  await ctx.emit(db, EVENTS.parentalConsentGranted, { child_user_id: child.id, guardian_id: guardian.id }, { actor: { type: "guardian", id: guardian.id }, subject: { type: "user", id: child.id } });
  await ctx.audit(db, { actor: { type: "guardian", id: guardian.id }, action: "parental.consent_granted", target: { type: "user", id: child.id } });
  inc("qtiauth_guardian_decisions_total", { decision: "approved" }, 1, "Guardian consent decisions");
  return { guardian: updated, child: childNow };
}

export async function guardianAssurance(ctx: Ctx, db: Exec, child: User, guardianDob: string): Promise<void> {
  if (!isRequiredFor(ctx, "guardian_approval")) return;
  const r = await runAssurance(ctx, db, { id: child.id, dob: guardianDob }, "guardian_approval", surfaceUrl(ctx.surfaces.account, "/family"));
  if (r.status !== "complete" || r.result?.outcome !== "adult") throw new ProblemError(403, "GUARDIAN_AGE_ASSURANCE_FAILED");
}

export async function declineConsent(ctx: Ctx, db: Exec, guardianId: string): Promise<void> {
  const guardian = await db.selectFrom("guardians").selectAll().where("id", "=", guardianId).executeTakeFirst();
  if (!guardian || guardian.status !== "pending") throw new ProblemError(400, "INVALID_OR_EXPIRED_TOKEN");
  await db.updateTable("guardians").set({ status: "declined" }).where("id", "=", guardian.id).execute();
  const child = await getUser(db, guardian.child_user_id);
  inc("qtiauth_guardian_decisions_total", { decision: "declined" }, 1, "Guardian consent decisions");
  if (child && child.state === "pending_parental_consent") {
    const { purgeAccount } = await import("./deletion.ts");
    await purgeAccount(ctx, db, child, "parental_consent_declined");
  }
}

export async function guardianRowsForPrincipal(db: Exec, id: IdentityClaims): Promise<Guardian[]> {
  if (id.principal === "guardian" && id.gid) {
    const g = await db.selectFrom("guardians").select("email_normalized").where("id", "=", id.gid).executeTakeFirst();
    if (!g) return [];
    return db.selectFrom("guardians").selectAll().where("email_normalized", "=", g.email_normalized).where("status", "=", "active").execute();
  }
  if (id.sub) return db.selectFrom("guardians").selectAll().where("user_id", "=", id.sub).where("status", "=", "active").execute();
  return [];
}

export async function requireGuardianOf(db: Exec, id: IdentityClaims, childId: string): Promise<Guardian> {
  const rows = await guardianRowsForPrincipal(db, id);
  const g = rows.find((r) => r.child_user_id === childId);
  if (!g) throw new ProblemError(404, "CHILD_NOT_FOUND");
  return g;
}

export function guardianActor(g: Guardian): { type: "guardian"; id: string } {
  return { type: "guardian", id: g.id };
}

export async function updateControls(ctx: Ctx, db: Exec, child: User, patch: Partial<ParentalControls>, actor: { type: "guardian" | "user" | "staff"; id: string }): Promise<ParentalControls> {
  const current = { ...ctx.config.parental.default_controls, ...(child.parental_controls ?? {}) };
  const next = { ...current, ...patch };
  const extra: Record<string, unknown> = {};
  if (patch.leaderboards !== undefined) extra.leaderboard_visible = patch.leaderboards;
  if (patch.public_profile !== undefined) extra.public_profile = patch.public_profile;
  await db
    .updateTable("users")
    .set({ parental_controls: JSON.stringify(next), ...extra, updated_at: new Date() })
    .where("id", "=", child.id)
    .execute();
  await ctx.emit(db, EVENTS.parentalControlsChanged, { child_user_id: child.id, controls: next }, { actor, subject: { type: "user", id: child.id } });
  await ctx.emit(db, EVENTS.userUpdated, { user_id: child.id, reason: "parental_controls" }, { actor, subject: { type: "user", id: child.id } });
  await ctx.audit(db, { actor, action: "parental.controls_changed", target: { type: "user", id: child.id }, data: { patch } });
  return next;
}

export async function createGuardianRequest(
  ctx: Ctx,
  db: Exec,
  child: User,
  type: "removal" | "app_approval" | "username_change" | "legal_acceptance",
  data: Record<string, unknown>,
  requestedBy: string | null,
): Promise<string> {
  const existing = await db
    .selectFrom("guardian_requests")
    .select(["id", "data"])
    .where("child_user_id", "=", child.id)
    .where("type", "=", type)
    .where("status", "=", "pending")
    .execute();
  const dupe = existing.find((e) => JSON.stringify(e.data) === JSON.stringify(data));
  if (dupe) return dupe.id;
  const id = uuidv7();
  await db.insertInto("guardian_requests").values({ id, child_user_id: child.id, type, status: "pending", data: JSON.stringify(data), requested_by: requestedBy }).execute();
  for (const g of await guardianEmailsFor(db, child.id)) {
    await ctx.email(db, {
      template: `guardian_request_${type}`,
      to: { email: g.email, guardian_id: g.id },
      locale: child.locale,
      vars: { child_name: displayName(child), dashboard_url: surfaceUrl(ctx.surfaces.account, "/family"), ...data },
      sender: "auth",
      priority: "high",
    });
  }
  await ctx.emit(db, EVENTS.parentalRequestCreated, { request_id: id, child_user_id: child.id, type, data }, { subject: { type: "user", id: child.id } });
  if (type === "removal") await ctx.emit(db, EVENTS.parentalRemovalRequested, { request_id: id, child_user_id: child.id }, { subject: { type: "user", id: child.id } });
  return id;
}

export async function decideRequest(ctx: Ctx, db: Exec, guardian: Guardian, requestId: string, approve: boolean): Promise<{ type: string; data: Record<string, unknown> }> {
  const req = await db.selectFrom("guardian_requests").selectAll().where("id", "=", requestId).where("child_user_id", "=", guardian.child_user_id).executeTakeFirst();
  if (!req || req.status !== "pending") throw new ProblemError(404, "REQUEST_NOT_FOUND");
  await db
    .updateTable("guardian_requests")
    .set({ status: approve ? "approved" : "denied", decided_by: guardian.id, decided_at: new Date() })
    .where("id", "=", req.id)
    .execute();
  const child = await requireUser(db, req.child_user_id);
  if (approve && req.type === "removal") await removeGuardianLinks(ctx, db, child, { type: "guardian", id: guardian.id });
  if (approve && req.type === "username_change") {
    const { assertUsernameAvailable, applyUsername } = await import("./usernames.ts");
    const name = String(req.data.username ?? "");
    const canonical = await assertUsernameAvailable(ctx, db, name, child.id);
    await applyUsername(ctx, db, child, name, canonical, "guardian_approved", { type: "guardian", id: guardian.id });
  }
  await ctx.emit(db, EVENTS.parentalRequestDecided, { request_id: req.id, child_user_id: child.id, type: req.type, approved: approve, data: req.data }, { actor: { type: "guardian", id: guardian.id }, subject: { type: "user", id: child.id } });
  await ctx.audit(db, { actor: { type: "guardian", id: guardian.id }, action: `parental.request_${approve ? "approved" : "denied"}`, target: { type: "user", id: child.id }, data: { type: req.type, request_id: req.id } });
  await ctx.email(db, {
    template: "guardian_request_decided",
    to: { user_id: child.id },
    locale: child.locale,
    vars: { name: displayName(child), type: req.type, approved: approve },
    sender: "auth",
  });
  return { type: req.type, data: req.data };
}

export async function removeGuardianLinks(ctx: Ctx, db: Exec, child: User, actor: { type: "guardian" | "user" | "staff" | "system"; id: string }): Promise<void> {
  const guardians = await guardianEmailsFor(db, child.id);
  await db.updateTable("guardians").set({ status: "removed", removed_at: new Date() }).where("child_user_id", "=", child.id).where("status", "in", ["active", "pending"]).execute();
  await db.updateTable("users").set({ parental_controls: null, updated_at: new Date() }).where("id", "=", child.id).execute();
  await db.updateTable("guardian_requests").set({ status: "cancelled" }).where("child_user_id", "=", child.id).where("status", "=", "pending").execute();
  for (const g of guardians) {
    await ctx.email(db, { template: "guardian_link_removed", to: { email: g.email, guardian_id: g.id }, locale: child.locale, vars: { child_name: displayName(child) }, sender: "auth" });
  }
  await ctx.emit(db, EVENTS.parentalConsentRevoked, { child_user_id: child.id }, { actor, subject: { type: "user", id: child.id } });
  await ctx.emit(db, EVENTS.userUpdated, { user_id: child.id, reason: "guardians_removed" }, { actor, subject: { type: "user", id: child.id } });
  await ctx.audit(db, { actor, action: "parental.guardians_removed", target: { type: "user", id: child.id } });
}

export async function activitySummary(ctx: Ctx, db: Exec, childId: string, sinceMs = 7 * 86_400_000) {
  const since = new Date(Date.now() - sinceMs);
  const signIns = await db
    .selectFrom("sessions")
    .select(["created_at", "device", "country", "auth_method"])
    .where("user_id", "=", childId)
    .where("created_at", ">", since)
    .orderBy("created_at", "desc")
    .limit(100)
    .execute();
  const games = await ctx.rpcOptional<{ games: { slug: string; name: string; playtime_minutes: number; last_played_at: string | null }[] } | null>(
    "games.activity_summary",
    { user_id: childId, since: since.toISOString() },
    null,
  );
  const apps = await ctx.rpcOptional<{ apps: { client_id: string; name: string; connected_at: string }[] } | null>("oidc.user_apps", { user_id: childId }, null);
  return {
    since: since.toISOString(),
    sign_ins: signIns.map((s) => ({ at: s.created_at.toISOString(), device: s.device, country: s.country, method: s.auth_method })),
    games: games?.games ?? [],
    apps_connected: apps?.apps ?? [],
  };
}

export async function childOverview(ctx: Ctx, db: Exec, child: User) {
  const guardians = await db.selectFrom("guardians").select(["id", "email", "display_name", "status", "approved_at"]).where("child_user_id", "=", child.id).where("status", "in", ["active", "pending"]).execute();
  const requests = await db.selectFrom("guardian_requests").selectAll().where("child_user_id", "=", child.id).where("status", "=", "pending").orderBy("created_at", "desc").execute();
  return {
    id: child.id,
    username: child.username,
    display_name: displayName(child),
    state: child.state,
    age_band: ageBand(child.dob, ctx.config.age.boundaries),
    controls: { ...ctx.config.parental.default_controls, ...(child.parental_controls ?? {}) },
    controls_optional: Boolean(child.guardian_controls_optional_at && child.guardian_controls_optional_at <= new Date()),
    guardians: guardians.map((g) => ({ id: g.id, email: g.email, display_name: g.display_name, status: g.status, approved_at: g.approved_at?.toISOString() ?? null })),
    pending_requests: requests.map((r) => ({ id: r.id, type: r.type, data: r.data, created_at: r.created_at.toISOString() })),
  };
}
