import { SignJWT, jwtVerify, generateKeyPair, exportJWK, importJWK, decodeProtectedHeader, type JWK, type CryptoKey as JoseKey } from "jose";
import { randomToken } from "@qtiauth/common";
import type { IdentityClaims } from "./types.ts";

export const INTERNAL_ISSUER = "qtiauth-gateway";
export const INTERNAL_AUDIENCE = "qtiauth-internal";
export const INTERNAL_TTL_SECONDS = 60;

export interface SigningKey {
  kid: string;
  privateKey: JoseKey;
  publicJwk: JWK;
  createdAt: number;
}

export async function generateSigningKey(alg: "EdDSA" | "ES256" | "RS256" = "EdDSA", kidPrefix = "k"): Promise<SigningKey & { privateJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair(alg, alg === "EdDSA" ? { crv: "Ed25519", extractable: true } : { extractable: true });
  const kid = `${kidPrefix}_${randomToken(9)}`;
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg };
  return { kid, privateKey, publicJwk, privateJwk, createdAt: Date.now() };
}

export async function importSigningKey(privateJwk: JWK, publicJwk: JWK, createdAt = Date.now()): Promise<SigningKey> {
  const privateKey = (await importJWK(privateJwk, privateJwk.alg)) as JoseKey;
  return { kid: publicJwk.kid!, privateKey, publicJwk, createdAt };
}

export async function mintIdentityToken(key: SigningKey, claims: IdentityClaims): Promise<string> {
  return new SignJWT({ ...claims } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: "qtiauth-identity+jwt" })
    .setIssuer(INTERNAL_ISSUER)
    .setAudience(INTERNAL_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${INTERNAL_TTL_SECONDS}s`)
    .sign(key.privateKey);
}

export class InternalKeyRing {
  private readonly keys = new Map<string, { key: JoseKey; seenAt: number }>();
  private readonly fetchKey: (kid: string) => Promise<JWK | null>;

  constructor(fetchKey: (kid: string) => Promise<JWK | null>) {
    this.fetchKey = fetchKey;
  }

  async add(jwk: JWK): Promise<void> {
    if (!jwk.kid) return;
    const existing = this.keys.get(jwk.kid);
    if (existing) {
      existing.seenAt = Date.now();
      return;
    }
    const key = (await importJWK(jwk, jwk.alg ?? "EdDSA")) as JoseKey;
    this.keys.set(jwk.kid, { key, seenAt: Date.now() });
  }

  prune(maxAgeMs = 15 * 60_000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [kid, v] of this.keys) if (v.seenAt < cutoff) this.keys.delete(kid);
  }

  async get(kid: string): Promise<JoseKey | null> {
    const hit = this.keys.get(kid);
    if (hit) return hit.key;
    const jwk = await this.fetchKey(kid).catch(() => null);
    if (!jwk) return null;
    await this.add(jwk);
    return this.keys.get(kid)?.key ?? null;
  }

  async verify(token: string, expect: { method: string; path: string }): Promise<IdentityClaims> {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "EdDSA" || !header.kid) throw new Error("Unexpected identity token header");
    const key = await this.get(header.kid);
    if (!key) throw new Error("Unknown identity token key");
    const { payload } = await jwtVerify(token, key, { issuer: INTERNAL_ISSUER, audience: INTERNAL_AUDIENCE, algorithms: ["EdDSA"], maxTokenAge: `${INTERNAL_TTL_SECONDS + 5}s` });
    const claims = payload as unknown as IdentityClaims;
    if (claims.htm !== expect.method.toUpperCase() || claims.htu !== expect.path) throw new Error("Identity token is bound to a different request");
    return claims;
  }
}
