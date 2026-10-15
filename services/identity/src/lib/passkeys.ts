import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { ProblemError, randomToken, uuidv7, inc } from "@qtiauth/common";
import { setJson, takeJson } from "@qtiauth/service-kit";
import type { Ctx, Exec } from "./ctx.ts";

interface ChallengeState {
  challenge: string;
  purpose: "register" | "authenticate";
  user_id: string | null;
  data?: Record<string, unknown>;
}

export function rpId(ctx: Ctx): string {
  return ctx.config.security.webauthn_rp_id ?? new URL(ctx.surfaces.account.origin).hostname;
}

export function expectedOrigins(ctx: Ctx): string[] {
  const id = rpId(ctx);
  const all = new Set<string>();
  for (const s of Object.values(ctx.surfaces)) {
    for (const o of s.origins) {
      const h = new URL(o).hostname;
      if (h === id || h.endsWith(`.${id}`)) all.add(o);
    }
  }
  return [...all];
}

async function saveChallenge(ctx: Ctx, state: ChallengeState): Promise<string> {
  const id = randomToken(18);
  await setJson(ctx.valkey, `webauthn:${id}`, state, 5 * 60_000);
  return id;
}

async function takeChallenge(ctx: Ctx, id: string, purpose: ChallengeState["purpose"]): Promise<ChallengeState> {
  const state = await takeJson<ChallengeState>(ctx.valkey, `webauthn:${id}`);
  if (!state || state.purpose !== purpose) throw new ProblemError(400, "WEBAUTHN_CHALLENGE_EXPIRED");
  return state;
}

export async function registrationOptions(ctx: Ctx, db: Exec, user: { id: string; username: string | null; email: string | null }) {
  const existing = await db.selectFrom("passkeys").select(["credential_id", "transports"]).where("user_id", "=", user.id).execute();
  const name = user.username ?? user.email ?? user.id;
  const options = await generateRegistrationOptions({
    rpName: ctx.config.security.webauthn_rp_name ?? ctx.config.branding.product_name,
    rpID: rpId(ctx),
    userName: name,
    userDisplayName: name,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports as AuthenticatorTransportFuture[] })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  const challenge_id = await saveChallenge(ctx, { challenge: options.challenge, purpose: "register", user_id: user.id });
  return { challenge_id, options };
}

export async function completeRegistration(ctx: Ctx, db: Exec, userId: string, challengeId: string, response: RegistrationResponseJSON, name: string) {
  const state = await takeChallenge(ctx, challengeId, "register");
  if (state.user_id !== userId) throw new ProblemError(400, "WEBAUTHN_CHALLENGE_EXPIRED");
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: state.challenge,
      expectedOrigin: expectedOrigins(ctx),
      expectedRPID: rpId(ctx),
      requireUserVerification: false,
    });
  } catch {
    throw new ProblemError(400, "WEBAUTHN_VERIFICATION_FAILED");
  }
  if (!verification.verified || !verification.registrationInfo) throw new ProblemError(400, "WEBAUTHN_VERIFICATION_FAILED");
  const info = verification.registrationInfo;
  const id = uuidv7();
  await db
    .insertInto("passkeys")
    .values({
      id,
      user_id: userId,
      credential_id: info.credential.id,
      public_key: Buffer.from(info.credential.publicKey).toString("base64url"),
      counter: info.credential.counter,
      transports: JSON.stringify(info.credential.transports ?? response.response.transports ?? []),
      name: name.slice(0, 64) || "Passkey",
      aaguid: info.aaguid ?? null,
      backed_up: info.credentialBackedUp,
      device_type: info.credentialDeviceType,
    })
    .execute();
  inc("qtiauth_passkey_registrations_total", {}, 1, "Passkeys registered");
  return id;
}

export async function authenticationOptions(ctx: Ctx, db: Exec, userId: string | null, data?: Record<string, unknown>) {
  const allow = userId ? await db.selectFrom("passkeys").select(["credential_id", "transports"]).where("user_id", "=", userId).execute() : [];
  if (userId && !allow.length) throw new ProblemError(400, "NO_PASSKEYS");
  const options = await generateAuthenticationOptions({
    rpID: rpId(ctx),
    userVerification: "preferred",
    allowCredentials: allow.map((c) => ({ id: c.credential_id, transports: c.transports as AuthenticatorTransportFuture[] })),
  });
  const challenge_id = await saveChallenge(ctx, { challenge: options.challenge, purpose: "authenticate", user_id: userId, data });
  return { challenge_id, options };
}

export async function verifyAuthentication(ctx: Ctx, db: Exec, challengeId: string, response: AuthenticationResponseJSON): Promise<{ userId: string; passkeyId: string; data?: Record<string, unknown> }> {
  const state = await takeChallenge(ctx, challengeId, "authenticate");
  const pk = await db.selectFrom("passkeys").selectAll().where("credential_id", "=", response.id).executeTakeFirst();
  if (!pk || (state.user_id && pk.user_id !== state.user_id)) {
    inc("qtiauth_auth_2fa_challenges_total", { factor: "passkey", result: "failure" }, 1, "Second-factor challenges");
    throw new ProblemError(401, "PASSKEY_NOT_RECOGNISED");
  }
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: state.challenge,
      expectedOrigin: expectedOrigins(ctx),
      expectedRPID: rpId(ctx),
      credential: {
        id: pk.credential_id,
        publicKey: new Uint8Array(Buffer.from(pk.public_key, "base64url")),
        counter: Number(pk.counter),
        transports: pk.transports as AuthenticatorTransportFuture[],
      },
      requireUserVerification: false,
    });
  } catch {
    verification = { verified: false } as const;
  }
  inc("qtiauth_auth_2fa_challenges_total", { factor: "passkey", result: verification.verified ? "success" : "failure" }, 1, "Second-factor challenges");
  if (!verification.verified) throw new ProblemError(401, "PASSKEY_VERIFICATION_FAILED");
  await db
    .updateTable("passkeys")
    .set({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date() })
    .where("id", "=", pk.id)
    .execute();
  return { userId: pk.user_id, passkeyId: pk.id, data: state.data };
}
