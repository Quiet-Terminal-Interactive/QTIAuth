import { sql, type Kysely } from "kysely";
import type { JWK } from "jose";
import { decrypt, deriveSubkey, encrypt, decodeKey, type Logger, setGauge } from "@qtiauth/common";
import { generateSigningKey, importSigningKey, type SigningKey } from "@qtiauth/auth-context";

export interface KeyStoreOptions {
  db: Kysely<any>;
  purpose: string;
  alg: "EdDSA" | "ES256" | "RS256";
  kek: string | undefined;
  rotateEveryMs: number;
  overlapMs: number;
  log: Logger;
}

interface KeyRow {
  kid: string;
  purpose: string;
  alg: string;
  public_jwk: JWK;
  private_enc: string;
  created_at: Date;
  retires_at: Date | null;
  expires_at: Date | null;
}

export class KeyStore {
  private readonly opts: KeyStoreOptions;
  private readonly kek: Buffer;
  private cache: { current: SigningKey; publicKeys: JWK[]; loadedAt: number } | null = null;

  constructor(opts: KeyStoreOptions) {
    if (!opts.kek) throw new Error("KEY_ENCRYPTION_KEY is required to store signing keys");
    this.opts = opts;
    this.kek = deriveSubkey(decodeKey(opts.kek), `keys:${opts.purpose}`);
  }

  get purpose(): string {
    return this.opts.purpose;
  }

  private async load(): Promise<{ current: SigningKey; publicKeys: JWK[] }> {
    if (this.cache && Date.now() - this.cache.loadedAt < 30_000) return this.cache;
    const rows = (
      await sql<KeyRow>`select * from service_keys where purpose = ${this.opts.purpose} and (expires_at is null or expires_at > now()) order by created_at desc`.execute(this.opts.db)
    ).rows;
    let active = rows.find((r) => !r.retires_at);
    if (!active) {
      await this.rotate("initial");
      return this.load();
    }
    const privateJwk = JSON.parse(decrypt(this.kek, active.private_enc, active.kid).toString()) as JWK;
    const current = await importSigningKey(privateJwk, active.public_jwk, new Date(active.created_at).getTime());
    const publicKeys = rows.map((r) => r.public_jwk);
    this.cache = { current, publicKeys, loadedAt: Date.now() };
    setGauge("qtiauth_signing_key_age_seconds", (Date.now() - new Date(active.created_at).getTime()) / 1000, { purpose: this.opts.purpose }, "Age of the active signing key");
    return this.cache;
  }

  async current(): Promise<SigningKey> {
    return (await this.load()).current;
  }

  async jwks(): Promise<{ keys: JWK[] }> {
    return { keys: (await this.load()).publicKeys };
  }

  async allPublic(): Promise<JWK[]> {
    return (await this.load()).publicKeys;
  }

  async rotate(reason = "scheduled"): Promise<string> {
    const key = await generateSigningKey(this.opts.alg, this.opts.purpose.replace(/[^a-z]/g, "").slice(0, 6) || "k");
    const enc = encrypt(this.kek, JSON.stringify(key.privateJwk), key.kid);
    await this.opts.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`qtiauth:keys:${this.opts.purpose}`}))`.execute(trx);
      await sql`update service_keys set retires_at = now(), expires_at = now() + ${`${Math.ceil(this.opts.overlapMs / 1000)} seconds`}::interval
                where purpose = ${this.opts.purpose} and retires_at is null`.execute(trx);
      await sql`insert into service_keys (kid, purpose, alg, public_jwk, private_enc) values (${key.kid}, ${this.opts.purpose}, ${this.opts.alg}, ${JSON.stringify(key.publicJwk)}::jsonb, ${enc})`.execute(trx);
    });
    this.cache = null;
    this.opts.log.info({ purpose: this.opts.purpose, kid: key.kid, reason }, "signing key rotated");
    return key.kid;
  }

  async rotateIfDue(): Promise<boolean> {
    const { current } = await this.load();
    if (Date.now() - current.createdAt < this.opts.rotateEveryMs) return false;
    await this.rotate("due");
    return true;
  }

  async status(): Promise<{ kid: string; created_at: string; retires_at: string | null; expires_at: string | null }[]> {
    const rows = (await sql<KeyRow>`select * from service_keys where purpose = ${this.opts.purpose} order by created_at desc`.execute(this.opts.db)).rows;
    return rows.map((r) => ({
      kid: r.kid,
      created_at: new Date(r.created_at).toISOString(),
      retires_at: r.retires_at ? new Date(r.retires_at).toISOString() : null,
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    }));
  }

  async prune(): Promise<number> {
    const r = await sql`delete from service_keys where purpose = ${this.opts.purpose} and expires_at is not null and expires_at < now()`.execute(this.opts.db);
    return Number(r.numAffectedRows ?? 0);
  }
}
