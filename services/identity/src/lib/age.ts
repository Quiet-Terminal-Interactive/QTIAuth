import { ProblemError, uuidv7 } from "@qtiauth/common";
import type { User } from "../db/types.ts";
import type { Ctx, Exec } from "./ctx.ts";

export type AssuranceStrength = "self_declared" | "estimated" | "verified";

export interface BeginResult {
  status: "complete" | "redirect";
  redirect_url?: string;
  result?: AgeAssuranceResult;
}

export interface AgeAssuranceResult {
  outcome: "adult" | "minor" | "inconclusive" | "failed";
  strength: AssuranceStrength;
  vendor_ref?: string | null;
  estimated_age?: number | null;
  data?: Record<string, unknown>;
}

export interface AssuranceContext {
  trigger: string;
  dob: string | null;
  return_url: string;
  config: Record<string, unknown>;
}

export interface AgeAssuranceProvider {
  id: string;
  strength: AssuranceStrength;
  begin(user: Pick<User, "id" | "dob">, ctx: AssuranceContext): Promise<BeginResult>;
  complete(user: Pick<User, "id" | "dob">, callbackPayload: Record<string, unknown>, ctx: AssuranceContext): Promise<AgeAssuranceResult>;
}

const selfDeclared: AgeAssuranceProvider = {
  id: "self_declared",
  strength: "self_declared",
  async begin(user, ctx) {
    const dob = ctx.dob ?? user.dob;
    if (!dob) return { status: "complete", result: { outcome: "inconclusive", strength: "self_declared" } };
    const d = new Date(`${dob}T00:00:00Z`);
    const now = new Date();
    let age = now.getUTCFullYear() - d.getUTCFullYear();
    if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age--;
    return { status: "complete", result: { outcome: age >= 18 ? "adult" : "minor", strength: "self_declared" } };
  },
  async complete() {
    throw new ProblemError(400, "PROVIDER_HAS_NO_CALLBACK");
  },
};

const providers = new Map<string, AgeAssuranceProvider>([[selfDeclared.id, selfDeclared]]);

export function registerAgeAssuranceProvider(p: AgeAssuranceProvider): void {
  providers.set(p.id, p);
}

export function getProvider(ctx: Ctx, id?: string): AgeAssuranceProvider {
  const p = providers.get(id ?? ctx.config.age.assurance.default_provider);
  if (!p) throw new ProblemError(503, "AGE_ASSURANCE_PROVIDER_UNAVAILABLE");
  return p;
}

export function isRequiredFor(ctx: Ctx, trigger: string): boolean {
  return (ctx.config.age.assurance.required_for as string[]).includes(trigger);
}

export async function recordResult(db: Exec, userId: string, provider: AgeAssuranceProvider, trigger: string, result: AgeAssuranceResult): Promise<void> {
  await db
    .insertInto("age_assurance_results")
    .values({
      id: uuidv7(),
      user_id: userId,
      provider: provider.id,
      strength: result.strength,
      outcome: result.outcome,
      trigger,
      vendor_ref: result.vendor_ref ?? null,
      data: JSON.stringify({ ...(result.estimated_age !== undefined ? { estimated_age: result.estimated_age } : {}) }),
    })
    .execute();
  await db.updateTable("users").set({ age_assurance_strength: result.strength }).where("id", "=", userId).execute();
}

export async function runAssurance(ctx: Ctx, db: Exec, user: Pick<User, "id" | "dob">, trigger: string, returnUrl: string, providerId?: string): Promise<BeginResult> {
  const provider = getProvider(ctx, providerId);
  const actx: AssuranceContext = { trigger, dob: user.dob, return_url: returnUrl, config: ctx.config.age.assurance.providers[provider.id] ?? {} };
  const r = await provider.begin(user, actx);
  if (r.status === "complete" && r.result) await recordResult(db, user.id, provider, trigger, r.result);
  return r;
}

export async function completeAssurance(ctx: Ctx, db: Exec, user: Pick<User, "id" | "dob">, trigger: string, providerId: string, payload: Record<string, unknown>): Promise<AgeAssuranceResult> {
  const provider = getProvider(ctx, providerId);
  const actx: AssuranceContext = { trigger, dob: user.dob, return_url: "", config: ctx.config.age.assurance.providers[provider.id] ?? {} };
  const result = await provider.complete(user, payload, actx);
  await recordResult(db, user.id, provider, trigger, result);
  return result;
}
