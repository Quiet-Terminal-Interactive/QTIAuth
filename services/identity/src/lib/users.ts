import { sql } from "kysely";
import { ProblemError, uuidv7 } from "@qtiauth/common";
import { ageBand, type AccountState, type AgeBand, type ParentalControls, type Restriction } from "@qtiauth/auth-context";
import type { Config } from "@qtiauth/config";
import { EVENTS } from "@qtiauth/bus";
import type { User } from "../db/types.ts";
import type { Ctx, Exec } from "./ctx.ts";

export function normalizeEmail(cfg: Config, email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 1) return trimmed;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  const rule = cfg.accounts.email_normalization[domain];
  if (rule) {
    if (rule.strip_plus) local = local.split("+")[0]!;
    if (rule.strip_dots) local = local.replaceAll(".", "");
    if (rule.canonical_domain) domain = rule.canonical_domain;
  }
  return `${local}@${domain}`;
}

export function bandOf(ctx: Ctx, user: Pick<User, "dob">, on = new Date()): AgeBand | null {
  return ageBand(user.dob, ctx.config.age.boundaries, on);
}

export function ageYears(dob: string, on = new Date()): number {
  const d = new Date(`${dob}T00:00:00Z`);
  let age = on.getUTCFullYear() - d.getUTCFullYear();
  const m = on.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

export function needsParentalConsent(ctx: Ctx, dob: string): boolean {
  return ageYears(dob) < ctx.config.parental.consent_age;
}

export async function getUser(db: Exec, id: string): Promise<User | undefined> {
  return db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
}

export async function requireUser(db: Exec, id: string): Promise<User> {
  const u = await getUser(db, id);
  if (!u || u.state === "deleted") throw new ProblemError(404, "USER_NOT_FOUND");
  return u;
}

export async function usersByEmail(db: Exec, normalized: string): Promise<User[]> {
  return db.selectFrom("users").selectAll().where("email_normalized", "=", normalized).where("state", "<>", "deleted").orderBy("created_at").execute();
}

export async function countAccountsForEmail(db: Exec, normalized: string): Promise<number> {
  const r = await db.selectFrom("users").select(sql<number>`count(*)::int`.as("n")).where("email_normalized", "=", normalized).where("state", "<>", "deleted").executeTakeFirst();
  return r?.n ?? 0;
}

export function defaultControls(ctx: Ctx): ParentalControls {
  return { ...ctx.config.parental.default_controls };
}

export function activeRestrictions(user: Pick<User, "restrictions">, now = Date.now()): Restriction[] {
  return (user.restrictions ?? []).filter((r) => !r.until || new Date(r.until).getTime() > now);
}

export interface CreateUserInput {
  email: string;
  emailVerified: boolean;
  dob: string;
  locale?: string | null;
  state: AccountState;
  username?: string | null;
}

export async function insertUser(ctx: Ctx, db: Exec, input: CreateUserInput): Promise<User> {
  const id = uuidv7();
  const band = ageBand(input.dob, ctx.config.age.boundaries);
  const minor = band !== "adult";
  const row = await db
    .insertInto("users")
    .values({
      id,
      email: input.email.trim(),
      email_normalized: normalizeEmail(ctx.config, input.email),
      email_verified_at: input.emailVerified ? new Date() : null,
      state: input.state,
      dob: input.dob,
      locale: input.locale ?? ctx.config.branding.default_locale,
      public_profile: false,
      leaderboard_visible: !minor,
      parental_controls: needsParentalConsent(ctx, input.dob) ? JSON.stringify(defaultControls(ctx)) : null,
      restrictions: JSON.stringify([]),
      age_band_cached: band,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row;
}

export async function setState(ctx: Ctx, db: Exec, user: User, state: AccountState, actor: { type: "user" | "staff" | "system" | "service" | "guardian"; id: string }, extra: Partial<User> = {}): Promise<User> {
  const updated = await db
    .updateTable("users")
    .set({ ...(extra as object), state, previous_state: user.state, updated_at: new Date() })
    .where("id", "=", user.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await ctx.emit(db, EVENTS.userUpdated, { user_id: user.id, state, previous_state: user.state }, { actor, subject: { type: "user", id: user.id } });
  return updated;
}

export function userSummary(ctx: Ctx, u: User) {
  return {
    id: u.id,
    username: u.username,
    state: u.state,
    age_band: bandOf(ctx, u),
    email_verified: Boolean(u.email_verified_at),
    locale: u.locale,
    created_at: u.created_at.toISOString(),
    public_profile: u.public_profile,
    leaderboard_visible: u.leaderboard_visible,
  };
}

export function displayName(u: Pick<User, "username" | "email">): string {
  return u.username ?? u.email?.split("@")[0] ?? "there";
}

export async function touch(db: Exec, id: string): Promise<void> {
  await db.updateTable("users").set({ updated_at: new Date() }).where("id", "=", id).execute();
}
