import { z } from "zod";
import { surfaceUrl } from "@qtiauth/config";
import type { Ctx } from "../lib/ctx.ts";

export const zLegalAcceptance = z.array(z.object({ id: z.string().max(64), version: z.string().max(64) })).max(20).default([]);
export const zDob = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").refine((d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t < new Date() && t.getUTCFullYear() > 1900;
}, "Invalid date of birth");
export const zEmailIn = z.email().max(254);
export const zPassword = z.string().min(1).max(1024);
export const zToken = z.string().min(10).max(200);

export function accountUrl(ctx: Ctx, path: string, params: Record<string, string> = {}): string {
  const u = new URL(surfaceUrl(ctx.surfaces.account, path));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

export const ALL_STATES = ["pending_email_verification", "pending_parental_consent", "active", "locked", "banned", "pending_deletion"] as const;
export const RESTRICTED_STATES = ["active", "locked", "banned"] as const;

export const openSession = {
  auth: "session" as const,
  allow_account_states: [...RESTRICTED_STATES],
  allow_pending_legal: true,
  allow_pending_parental_consent: true,
  allow_pending_mfa_enrolment: true,
  allow_aal0: true,
};
