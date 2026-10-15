import { generateSigningKey, type SigningKey } from "@qtiauth/auth-context";
import { setGauge, type Logger } from "@qtiauth/common";
import type { JWK } from "jose";

export class InternalKeys {
  private current!: SigningKey;
  private previous: SigningKey | null = null;
  private readonly rotateEveryMs: number;
  private readonly log: Logger;
  private onRotate: (() => void)[] = [];

  constructor(rotateEveryMs: number, log: Logger) {
    this.rotateEveryMs = Math.min(rotateEveryMs, 7 * 86_400_000);
    this.log = log;
  }

  async init(): Promise<void> {
    this.current = await generateSigningKey("EdDSA", "gw");
    const timer = setInterval(() => void this.rotateIfDue(), 60_000);
    timer.unref();
  }

  listen(fn: () => void): void {
    this.onRotate.push(fn);
  }

  signing(): SigningKey {
    return this.current;
  }

  publicKeys(): JWK[] {
    return [this.current.publicJwk, ...(this.previous ? [this.previous.publicJwk] : [])];
  }

  find(kid: string): JWK | null {
    return this.publicKeys().find((k) => k.kid === kid) ?? null;
  }

  async rotate(): Promise<void> {
    const next = await generateSigningKey("EdDSA", "gw");
    this.previous = this.current;
    this.current = next;
    this.log.info({ kid: next.kid }, "internal identity key rotated");
    for (const fn of this.onRotate) fn();
  }

  async rotateIfDue(): Promise<void> {
    setGauge("qtiauth_signing_key_age_seconds", (Date.now() - this.current.createdAt) / 1000, { purpose: "internal_identity" }, "Age of the active signing key");
    if (Date.now() - this.current.createdAt >= this.rotateEveryMs) await this.rotate();
  }
}
