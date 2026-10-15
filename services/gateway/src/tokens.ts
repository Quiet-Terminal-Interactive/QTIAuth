import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, type JWK, type JWTPayload } from "jose";
import { ProblemError, inc } from "@qtiauth/common";
import type { Bus } from "@qtiauth/bus";
import type { Valkey } from "@qtiauth/service-kit";

export interface AccessTokenClaims extends JWTPayload {
  client_id: string;
  scope?: string;
  sid?: string;
  gid?: string;
  ckd?: "first_party" | "third_party" | "game" | "game_server";
  gty?: string;
  acr?: string;
  amr?: string[];
  auth_time?: number;
}

export class AccessTokenVerifier {
  private readonly bus: Bus;
  private readonly v: Valkey;
  private jwks: ReturnType<typeof createLocalJWKSet> | null = null;
  private kids = new Set<string>();
  private fetchedAt = 0;
  private issuer: string;
  private audience: string;

  constructor(bus: Bus, v: Valkey, issuer: string, audience: string) {
    this.bus = bus;
    this.v = v;
    this.issuer = issuer;
    this.audience = audience;
  }

  private async refresh(force = false): Promise<void> {
    if (!force && this.jwks && Date.now() - this.fetchedAt < 300_000) return;
    if (force && Date.now() - this.fetchedAt < 5_000) return;
    const set = await this.bus.request<{ keys: JWK[] }>("oidc.jwks", {}, { timeoutMs: 3000 });
    this.jwks = createLocalJWKSet(set);
    this.kids = new Set(set.keys.map((k) => k.kid!).filter(Boolean));
    this.fetchedAt = Date.now();
  }

  looksLikeJwt(token: string): boolean {
    return token.split(".").length === 3;
  }

  peek(token: string): AccessTokenClaims | null {
    try {
      return decodeJwt(token) as AccessTokenClaims;
    } catch {
      return null;
    }
  }

  async verify(token: string, kind: string): Promise<AccessTokenClaims> {
    if (!this.looksLikeJwt(token)) throw new ProblemError(401, "INVALID_TOKEN");
    let header;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new ProblemError(401, "INVALID_TOKEN");
    }
    if (header.typ !== "at+jwt") throw new ProblemError(401, "INVALID_TOKEN_TYPE");
    try {
      await this.refresh();
      if (header.kid && !this.kids.has(header.kid)) await this.refresh(true);
    } catch {
      throw new ProblemError(503, "TOKEN_VERIFICATION_UNAVAILABLE");
    }
    let payload: AccessTokenClaims;
    try {
      const r = await jwtVerify(token, this.jwks!, { issuer: this.issuer, audience: this.audience, typ: "at+jwt", algorithms: ["ES256", "RS256"] });
      payload = r.payload as AccessTokenClaims;
    } catch {
      inc("qtiauth_gateway_token_rejections_total", { kind, reason: "invalid" }, 1, "Rejected bearer tokens");
      throw new ProblemError(401, "INVALID_TOKEN");
    }
    const revoked = await this.v
      .mget(`gw:revoked:jti:${payload.jti}`, `gw:client_suspended:${payload.client_id}`, ...(payload.sid ? [`gw:revoked:sid:${payload.sid}`] : []))
      .catch(() => [] as (string | null)[]);
    if (revoked[0]) {
      inc("qtiauth_gateway_token_rejections_total", { kind, reason: "revoked" }, 1, "Rejected bearer tokens");
      throw new ProblemError(401, "TOKEN_REVOKED");
    }
    if (revoked[1]) throw new ProblemError(401, "CLIENT_SUSPENDED");
    if (revoked[2] && !(payload.scope ?? "").split(" ").includes("offline_access")) throw new ProblemError(401, "TOKEN_REVOKED");
    return payload;
  }
}
