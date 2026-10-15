import { sql } from "kysely";
import { UAParser } from "ua-parser-js";
import { hashToken, ipSubnet, randomToken, uuidv7, inc, setGauge, ProblemError } from "@qtiauth/common";
import { anyPermissionMatches } from "@qtiauth/config";
import { EVENTS } from "@qtiauth/bus";
import { SESSION_CLEAR_HEADER, SESSION_SET_HEADER, type AccountState, type AgeBand, type IdentityClaims, type ParentalControls, type Restriction } from "@qtiauth/auth-context";
import { setJson, takeJson } from "@qtiauth/service-kit";
import type { Session, User } from "../db/types.ts";
import type { Ctx, Exec } from "./ctx.ts";
import { activeRestrictions, bandOf, displayName, getUser, setState } from "./users.ts";
import { securityAlert, securityEvent } from "./security.ts";
import { userGrants } from "./roles.ts";
import { pendingLegalFor } from "./legal.ts";
import { has2fa } from "./mfa.ts";
import { guardianEmailsFor } from "./guardian-notify.ts";

export interface RequestMeta {
  ip: string | null;
  port?: number | null;
  country: string | null;
  ua: string | null;
  tls: string | null;
  signals: Record<string, string>;
  scope: string;
  locale: string | null;
}

export function metaFrom(id: IdentityClaims): RequestMeta {
  return {
    ip: id.ip || null,
    port: id.port ?? null,
    country: id.country ?? null,
    ua: id.ua ?? null,
    tls: null,
    signals: {},
    scope: id.cookie_scope ?? (id.origin ? `host:${new URL(id.origin).host}` : "host:unknown"),
    locale: id.locale ?? null,
  };
}

export function parseDevice(ua: string | null): { label: string; key: string; browser: string; os: string; type: string } {
  if (!ua) return { label: "Unknown device", key: "unknown", browser: "Unknown", os: "Unknown", type: "unknown" };
  const r = new UAParser(ua).getResult();
  const browser = r.browser.name ?? "Unknown browser";
  const os = r.os.name ?? "Unknown OS";
  const type = r.device.type ?? "desktop";
  return { label: `${browser} on ${os}`, key: `${browser}|${os}|${type}`.toLowerCase(), browser, os, type };
}

export interface CreateSessionInput {
  userId?: string | null;
  guardianId?: string | null;
  principal?: "user" | "guardian";
  aal: 1 | 2;
  amr: string[];
  method: string;
  meta: RequestMeta;
  ttlMs?: number;
}

export interface CreatedSession {
  session: Session;
  bindingToken: string;
  headers: Record<string, string>;
}

export async function createSession(ctx: Ctx, db: Exec, input: CreateSessionInput): Promise<CreatedSession> {
  const now = new Date();
  const ttl = input.ttlMs ?? ctx.config.cookies.session_ttl;
  const device = parseDevice(input.meta.ua);
  const id = uuidv7();
  const principal = input.principal ?? "user";
  const baseline = {
    ip: input.meta.ip,
    subnet: input.meta.ip ? ipSubnet(input.meta.ip) : null,
    country: input.meta.country,
    ua: device.key,
    tls: input.meta.tls,
  };
  const session = await db
    .insertInto("sessions")
    .values({
      id,
      user_id: input.userId ?? null,
      guardian_id: input.guardianId ?? null,
      principal,
      last_active_at: now,
      expires_at: new Date(now.getTime() + ttl),
      idle_expires_at: new Date(now.getTime() + Math.min(ctx.config.cookies.idle_timeout, ttl)),
      aal: input.aal,
      amr: JSON.stringify(input.amr),
      auth_method: input.method,
      auth_time: now,
      step_up_at: input.aal >= 2 ? now : null,
      ip: input.meta.ip,
      ip_subnet: baseline.subnet,
      country: input.meta.country,
      user_agent: input.meta.ua?.slice(0, 512) ?? null,
      device: device.label,
      device_key: device.key,
      tls_fingerprint: input.meta.tls,
      client_signals: JSON.stringify(input.meta.signals),
      baseline: JSON.stringify(baseline),
      last_ip: input.meta.ip,
      last_country: input.meta.country,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const bindingToken = randomToken(32);
  await db
    .insertInto("session_bindings")
    .values({ id: uuidv7(), session_id: id, token_hash: hashToken(bindingToken), scope: input.meta.scope, last_used_at: now })
    .execute();
  inc("qtiauth_sessions_created_total", { method: input.method, principal }, 1, "Sessions created");
  inc("qtiauth_session_bindings_created_total", {}, 1, "Session bindings created");

  if (principal === "user" && input.userId) {
    const user = await getUser(db, input.userId);
    if (user) {
      await db.updateTable("users").set({ last_sign_in_at: now, last_sign_in_method: input.method }).where("id", "=", user.id).execute();
      if (user.state === "pending_deletion") {
        await setState(ctx, db, user, (user.previous_state && user.previous_state !== "pending_deletion" ? user.previous_state : "active") as AccountState, { type: "user", id: user.id }, {
          deletion_requested_at: null,
          deletion_due_at: null,
        });
        await ctx.emit(db, EVENTS.userDeletionCancelled, { user_id: user.id }, { actor: { type: "user", id: user.id }, subject: { type: "user", id: user.id } });
        inc("qtiauth_account_deletions_total", { result: "cancelled" }, 1, "Account deletion lifecycle");
        await ctx.email(db, { template: "deletion_cancelled", to: { user_id: user.id }, locale: user.locale, vars: { name: displayName(user) }, sender: "security", priority: "high" });
      }
      await evictOldest(ctx, db, user.id);
      await recordDevice(ctx, db, user, session, device.label, input.meta);
    }
  }
  await securityEvent(db, {
    userId: input.userId ?? null,
    sessionId: id,
    type: "session.created",
    ip: input.meta.ip,
    port: input.meta.port ?? null,
    country: input.meta.country,
    userAgent: input.meta.ua,
    data: { method: input.method, aal: input.aal, principal },
  });
  await ctx.emit(
    db,
    EVENTS.sessionCreated,
    { session_id: id, user_id: input.userId ?? null, guardian_id: input.guardianId ?? null, method: input.method, aal: input.aal, country: input.meta.country, device: device.label },
    { actor: { type: principal === "guardian" ? "guardian" : "user", id: input.userId ?? input.guardianId ?? "unknown" }, subject: { type: "session", id } },
  );
  return { session, bindingToken, headers: { [SESSION_SET_HEADER]: bindingToken } };
}

async function evictOldest(ctx: Ctx, db: Exec, userId: string): Promise<void> {
  const max = ctx.config.sessions.max_per_user;
  const active = await db
    .selectFrom("sessions")
    .select(["id"])
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", new Date())
    .orderBy("created_at", "desc")
    .execute();
  for (const s of active.slice(max)) await revokeSession(ctx, db, s.id, "evicted", { type: "system", id: "session-limit" });
}

async function recordDevice(ctx: Ctx, db: Exec, user: User, session: Session, label: string, meta: RequestMeta): Promise<void> {
  const key = `${session.device_key}|${meta.country ?? "??"}`;
  const existing = await db.selectFrom("known_devices").select("device_key").where("user_id", "=", user.id).where("device_key", "=", key).executeTakeFirst();
  if (existing) {
    await db.updateTable("known_devices").set({ last_seen_at: new Date() }).where("user_id", "=", user.id).where("device_key", "=", key).execute();
    return;
  }
  const anyKnown = await db.selectFrom("known_devices").select("device_key").where("user_id", "=", user.id).executeTakeFirst();
  await db.insertInto("known_devices").values({ user_id: user.id, device_key: key, last_seen_at: new Date() }).execute();
  if (!anyKnown) return;
  const location = await locationLabel(meta.country);
  const vars = { device: label, location, time: new Date().toISOString(), ip: meta.ip };
  if (ctx.config.session_security.new_device_email) {
    await ctx.email(db, { template: "new_device", to: { user_id: user.id }, locale: user.locale, vars: { name: displayName(user), ...vars }, sender: "security", priority: "high" });
    inc("qtiauth_new_device_emails_total", {}, 1, "New-device sign-in emails");
  }
  for (const g of await guardianEmailsFor(db, user.id)) {
    await ctx.email(db, {
      template: "guardian_new_device",
      to: { email: g.email, guardian_id: g.id },
      locale: user.locale,
      vars: { child_name: displayName(user), ...vars },
      sender: "security",
      priority: "high",
    });
  }
}

async function locationLabel(country: string | null): Promise<string> {
  if (!country) return "an unknown location";
  try {
    return new Intl.DisplayNames(["en-GB"], { type: "region" }).of(country) ?? country;
  } catch {
    return country;
  }
}

export async function revokeSession(ctx: Ctx, db: Exec, sessionId: string, reason: string, actor: { type: "user" | "staff" | "system" | "guardian"; id: string }): Promise<boolean> {
  const s = await db
    .updateTable("sessions")
    .set({ revoked_at: new Date(), revoke_reason: reason })
    .where("id", "=", sessionId)
    .where("revoked_at", "is", null)
    .returning(["id", "user_id", "guardian_id"])
    .executeTakeFirst();
  if (!s) return false;
  await db.updateTable("session_bindings").set({ revoked_at: new Date() }).where("session_id", "=", sessionId).where("revoked_at", "is", null).execute();
  await ctx.emit(db, EVENTS.sessionRevoked, { session_id: sessionId, user_id: s.user_id, guardian_id: s.guardian_id, reason }, { actor, subject: { type: "session", id: sessionId } });
  inc("qtiauth_sessions_revoked_total", { reason }, 1, "Sessions revoked");
  return true;
}

export async function revokeAllSessions(ctx: Ctx, db: Exec, userId: string, reason: string, actor: { type: "user" | "staff" | "system" | "guardian"; id: string }, exceptSessionId?: string): Promise<number> {
  let q = db.selectFrom("sessions").select("id").where("user_id", "=", userId).where("revoked_at", "is", null);
  if (exceptSessionId) q = q.where("id", "<>", exceptSessionId);
  const rows = await q.execute();
  for (const r of rows) await revokeSession(ctx, db, r.id, reason, actor);
  return rows.length;
}

export const clearSessionHeaders = { [SESSION_CLEAR_HEADER]: "1" };

export interface SessionContext {
  session_id: string;
  user_id: string | null;
  guardian_id: string | null;
  principal: "user" | "guardian";
  state: AccountState | null;
  grants: string[];
  restrictions: Restriction[];
  age_band: AgeBand | null;
  parental_controls: ParentalControls | null;
  amr: string[];
  aal: 0 | 1 | 2;
  auth_time: number;
  step_up_at: number | null;
  pending_legal: boolean;
  mfa_enrolment_required: boolean;
  force_username_reset: boolean;
  locale: string | null;
  trust_level: string;
  expires_at: string;
  username: string | null;
}

export interface ResolveInput {
  token_hash: string;
  scope: string;
  ip: string | null;
  port?: number | null;
  country: string | null;
  ua: string | null;
  tls?: string | null;
  signals?: Record<string, string>;
}

export async function userContext(ctx: Ctx, db: Exec, user: User): Promise<Omit<SessionContext, "session_id" | "guardian_id" | "principal" | "amr" | "aal" | "auth_time" | "step_up_at" | "trust_level" | "expires_at">> {
  const grants = await userGrants(db, user.id);
  const needs2fa = grants.length > 0 && anyPermissionMatches(grants, ctx.config.security.require_2fa_for_permissions);
  return {
    user_id: user.id,
    state: user.state,
    grants,
    restrictions: activeRestrictions(user),
    age_band: bandOf(ctx, user),
    parental_controls: user.parental_controls ?? null,
    pending_legal: await pendingLegalFor(ctx, db, user),
    mfa_enrolment_required: needs2fa && !(await has2fa(db, user.id)),
    force_username_reset: user.force_username_reset,
    locale: user.locale,
    username: user.username,
  };
}

export async function resolveSession(ctx: Ctx, input: ResolveInput): Promise<SessionContext | null> {
  const db = ctx.db;
  const binding = await db
    .selectFrom("session_bindings")
    .innerJoin("sessions", "sessions.id", "session_bindings.session_id")
    .selectAll("sessions")
    .select(["session_bindings.id as binding_id", "session_bindings.revoked_at as binding_revoked_at", "session_bindings.last_used_at as binding_used_at"])
    .where("session_bindings.token_hash", "=", input.token_hash)
    .executeTakeFirst();
  if (!binding || binding.binding_revoked_at || binding.revoked_at) return null;
  const now = new Date();
  if (binding.expires_at <= now || binding.idle_expires_at <= now) {
    await revokeSession(ctx, db, binding.id, binding.expires_at <= now ? "expired" : "idle_timeout", { type: "system", id: "session-expiry" });
    return null;
  }
  let session: Session = binding;
  if (session.principal === "user" && ctx.config.features.session_security.enabled) {
    const evaluated = await evaluateSessionSecurity(ctx, session, input);
    if (!evaluated) return null;
    session = evaluated;
  }
  const activityInterval = ctx.config.sessions.activity_update_interval;
  if (now.getTime() - session.last_active_at.getTime() > activityInterval) {
    const idleUntil = new Date(Math.min(now.getTime() + ctx.config.cookies.idle_timeout, session.expires_at.getTime()));
    await db.updateTable("sessions").set({ last_active_at: now, idle_expires_at: idleUntil, last_ip: input.ip, last_country: input.country }).where("id", "=", session.id).execute();
    await db.updateTable("session_bindings").set({ last_used_at: now }).where("id", "=", binding.binding_id).execute();
  }
  const base = {
    session_id: session.id,
    guardian_id: session.guardian_id,
    principal: session.principal,
    amr: session.amr,
    aal: Math.max(0, Math.min(2, session.aal)) as 0 | 1 | 2,
    auth_time: Math.floor(session.auth_time.getTime() / 1000),
    step_up_at: session.step_up_at ? Math.floor(session.step_up_at.getTime() / 1000) : null,
    trust_level: session.trust_level,
    expires_at: session.expires_at.toISOString(),
  };
  if (session.principal === "guardian") {
    return {
      ...base,
      user_id: null,
      state: null,
      grants: [],
      restrictions: [],
      age_band: null,
      parental_controls: null,
      pending_legal: false,
      mfa_enrolment_required: false,
      force_username_reset: false,
      locale: null,
      username: null,
    };
  }
  const user = session.user_id ? await getUser(db, session.user_id) : undefined;
  if (!user || user.state === "deleted") return null;
  return { ...base, ...(await userContext(ctx, db, user)) };
}

async function evaluateSessionSecurity(ctx: Ctx, session: Session, input: ResolveInput): Promise<Session | null> {
  const cfg = ctx.config.session_security;
  const baseline = session.baseline ?? {};
  const device = parseDevice(input.ua);
  const current = {
    ip: input.ip,
    subnet: input.ip ? ipSubnet(input.ip) : null,
    country: input.country,
    ua: device.key,
    tls: input.tls ?? null,
  };
  const changes: string[] = [];
  let score = 0;
  if (current.subnet && baseline.subnet && current.subnet !== baseline.subnet) {
    score += cfg.weights.subnet;
    changes.push("subnet");
  } else if (current.ip && baseline.ip && current.ip !== baseline.ip) {
    score += cfg.weights.ip;
    changes.push("ip");
  }
  const countryChanged = Boolean(current.country && baseline.country && current.country !== baseline.country);
  if (countryChanged) {
    score += cfg.weights.country;
    changes.push("country");
  }
  if (current.ua && baseline.ua && current.ua !== baseline.ua) {
    score += cfg.weights.user_agent;
    changes.push("user_agent");
  }
  if (current.tls && baseline.tls && current.tls !== baseline.tls) {
    score += cfg.weights.tls_fingerprint;
    changes.push("tls_fingerprint");
  }
  for (const [k, v] of Object.entries(input.signals ?? {})) {
    const prev = (session.client_signals ?? {})[k];
    if (prev && prev !== v) {
      score += cfg.weights.client_signals;
      changes.push(`signal:${k}`);
    }
  }
  if (!changes.length) return session;

  const t = cfg.thresholds;
  let trust: "full" | "partial" | "challenge" | "blocked" = score >= t.blocked ? "blocked" : score >= t.challenge ? "challenge" : score >= t.partial ? "partial" : "full";
  let alert: string | null = null;
  if (countryChanged) {
    switch (cfg.on_country_change) {
      case "block":
        trust = "blocked";
        alert = "session_blocked_country";
        inc("qtiauth_session_country_changes_total", { action: "block" }, 1, "Country changes detected on sessions");
        break;
      case "challenge":
        if (trust !== "blocked") trust = "challenge";
        inc("qtiauth_session_country_changes_total", { action: "challenge" }, 1, "Country changes detected on sessions");
        break;
      case "notify":
        alert = "session_country_changed";
        if (trust === "challenge") trust = "partial";
        inc("qtiauth_session_country_changes_total", { action: "notify" }, 1, "Country changes detected on sessions");
        break;
      case "ignore":
        if (trust === "challenge") trust = "partial";
        break;
    }
  }
  const lockKey = `ssec:${session.id}:${changes.join(",")}:${current.ip}:${current.country}:${current.ua}`;
  const firstSeen = await ctx.valkey.set(lockKey, "1", "PX", 60_000, "NX").catch(() => "OK");
  if (trust !== session.trust_level) inc("qtiauth_session_trust_transitions_total", { from: session.trust_level, to: trust }, 1, "Session trust level transitions");

  return ctx.db.transaction().execute(async (trx) => {
    if (firstSeen === "OK") {
      await securityEvent(trx, {
        userId: session.user_id,
        sessionId: session.id,
        type: "session.signals_changed",
        ip: input.ip,
        port: input.port ?? null,
        country: input.country,
        userAgent: input.ua,
        data: { changes, score, trust },
      });
    }
    if (trust === "blocked") {
      await revokeSession(ctx, trx, session.id, "security_blocked", { type: "system", id: "session-security" });
      if (session.user_id) await securityAlert(ctx, trx, session.user_id, alert ?? "session_blocked", { country: input.country, device: device.label });
      await ctx.emit(trx, EVENTS.sessionFlagged, { session_id: session.id, user_id: session.user_id, trust, changes }, { subject: { type: "session", id: session.id } });
      return null;
    }
    const patch: Record<string, unknown> = { trust_level: trust };
    if (trust === "challenge") {
      patch.aal = 0;
      await ctx.emit(trx, EVENTS.sessionFlagged, { session_id: session.id, user_id: session.user_id, trust, changes }, { subject: { type: "session", id: session.id } });
    } else {
      patch.baseline = JSON.stringify({ ...current, country: current.country ?? session.baseline?.country ?? null });
      if (input.signals) patch.client_signals = JSON.stringify(input.signals);
      if (trust === "partial" && firstSeen === "OK") {
        await ctx.emit(trx, EVENTS.sessionFlagged, { session_id: session.id, user_id: session.user_id, trust, changes }, { subject: { type: "session", id: session.id } });
      }
    }
    if (alert && session.user_id && firstSeen === "OK") await securityAlert(ctx, trx, session.user_id, alert, { country: input.country, device: device.label });
    return trx.updateTable("sessions").set(patch).where("id", "=", session.id).returningAll().executeTakeFirstOrThrow();
  });
}

export async function markReauthenticated(ctx: Ctx, db: Exec, sessionId: string, aal: 1 | 2, method: string, meta: RequestMeta): Promise<void> {
  const session = await db.selectFrom("sessions").selectAll().where("id", "=", sessionId).executeTakeFirst();
  if (!session) throw new ProblemError(401, "UNAUTHENTICATED");
  const device = parseDevice(meta.ua);
  const newAal = Math.max(session.aal, aal);
  const amr = [...new Set([...session.amr, method])];
  await db
    .updateTable("sessions")
    .set({
      aal: newAal === 0 ? aal : newAal,
      amr: JSON.stringify(amr),
      step_up_at: aal >= 2 || newAal >= 2 ? new Date() : session.step_up_at,
      trust_level: "full",
      baseline: JSON.stringify({ ip: meta.ip, subnet: meta.ip ? ipSubnet(meta.ip) : null, country: meta.country, ua: device.key, tls: meta.tls }),
    })
    .where("id", "=", sessionId)
    .execute();
  await securityEvent(db, { userId: session.user_id, sessionId, type: "session.reauthenticated", ip: meta.ip, port: meta.port ?? null, country: meta.country, userAgent: meta.ua, data: { method, aal } });
  await ctx.emit(db, EVENTS.userUpdated, { user_id: session.user_id, session_id: sessionId, reason: "reauthenticated" }, { subject: { type: "session", id: sessionId } });
}

export async function createBindingCode(ctx: Ctx, input: { token_hash: string; target_origin: string; return_path: string }): Promise<{ code: string } | null> {
  const binding = await ctx.db
    .selectFrom("session_bindings")
    .innerJoin("sessions", "sessions.id", "session_bindings.session_id")
    .select(["sessions.id", "sessions.revoked_at", "sessions.expires_at"])
    .where("session_bindings.token_hash", "=", input.token_hash)
    .where("session_bindings.revoked_at", "is", null)
    .executeTakeFirst();
  if (!binding || binding.revoked_at || binding.expires_at <= new Date()) return null;
  const code = randomToken(24);
  await setJson(ctx.valkey, `bindcode:${hashToken(code)}`, { session_id: binding.id, origin: input.target_origin, return_path: input.return_path }, 60_000);
  return { code };
}

export async function exchangeBindingCode(ctx: Ctx, input: { code: string; origin: string; scope: string }): Promise<{ token: string; return_path: string } | null> {
  const data = await takeJson<{ session_id: string; origin: string; return_path: string }>(ctx.valkey, `bindcode:${hashToken(input.code)}`);
  if (!data || data.origin !== input.origin) return null;
  const session = await ctx.db.selectFrom("sessions").select(["id", "revoked_at", "expires_at"]).where("id", "=", data.session_id).executeTakeFirst();
  if (!session || session.revoked_at || session.expires_at <= new Date()) return null;
  const token = randomToken(32);
  await ctx.db.insertInto("session_bindings").values({ id: uuidv7(), session_id: session.id, token_hash: hashToken(token), scope: input.scope, last_used_at: new Date() }).execute();
  inc("qtiauth_session_bindings_created_total", {}, 1, "Session bindings created");
  return { token, return_path: data.return_path };
}

export async function sessionList(db: Exec, userId: string, currentSessionId?: string) {
  const rows = await db
    .selectFrom("sessions")
    .selectAll()
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", new Date())
    .orderBy("last_active_at", "desc")
    .execute();
  return rows.map((s) => ({
    id: s.id,
    device: s.device,
    country: s.last_country ?? s.country,
    auth_method: s.auth_method,
    created_at: s.created_at.toISOString(),
    last_active_at: s.last_active_at.toISOString(),
    expires_at: s.expires_at.toISOString(),
    aal: s.aal,
    trust_level: s.trust_level,
    current: s.id === currentSessionId,
  }));
}

export async function activeSessionGauge(ctx: Ctx): Promise<void> {
  const r = await sql<{ n: number }>`select count(*)::int as n from sessions where revoked_at is null and expires_at > now()`.execute(ctx.db);
  setGauge("qtiauth_sessions_active", r.rows[0]?.n ?? 0, {}, "Active sessions");
}
