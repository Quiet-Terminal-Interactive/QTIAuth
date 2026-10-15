import { SignJWT, jwtVerify, createLocalJWKSet, decodeProtectedHeader } from "jose";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { ProblemError, hashToken, humanCode, inc, randomToken, safeEqual, ulid } from "@qtiauth/common";
import { apiResource, issuer, surfaceUrl, type Config } from "@qtiauth/config";
import { EVENTS } from "@qtiauth/bus";
import type { KeyStore, ServiceContext, Exec as KitExec } from "@qtiauth/service-kit";
import type { Client, ClientKind, OidcDB } from "./db.ts";

export type Ctx = ServiceContext<OidcDB>;
export type Exec = KitExec<OidcDB>;

export class OAuthError extends ProblemError {
  readonly oauthError: string;
  constructor(status: number, error: string, description?: string) {
    super(status, error.toUpperCase(), description, { error, ...(description ? { error_description: description } : {}) });
    this.oauthError = error;
  }
}

export function oauthErrorResponse(err: OAuthError): Response {
  return new Response(JSON.stringify({ error: err.oauthError, ...(err.message && err.message !== err.code ? { error_description: err.message } : {}) }), {
    status: err.status,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...(err.status === 401 ? { "www-authenticate": 'Basic realm="oauth"' } : {}) },
  });
}

let keys: KeyStore | null = null;

export function setKeys(k: KeyStore): void {
  keys = k;
}

export function getKeys(): KeyStore {
  if (!keys) throw new Error("OIDC keys not initialised");
  return keys;
}

export function iss(cfg: Config): string {
  return issuer(cfg);
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(`qtiauth-client-secret:${secret}`).digest("hex");
}

export function newClientSecret(): string {
  return `qcs_${randomToken(32)}`;
}

export async function getClient(db: Exec, clientId: string): Promise<Client | undefined> {
  return db.selectFrom("clients").selectAll().where("id", "=", clientId).where("deleted_at", "is", null).executeTakeFirst();
}

export function isLoopback(u: URL): boolean {
  return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "localhost");
}

export function redirectAllowed(client: Pick<Client, "redirect_uris">, uri: string): boolean {
  let given: URL;
  try {
    given = new URL(uri);
  } catch {
    return false;
  }
  if (given.hash) return false;
  for (const reg of client.redirect_uris) {
    if (reg === uri) return true;
    try {
      const r = new URL(reg);
      if (isLoopback(r) && isLoopback(given) && r.hostname === given.hostname && r.pathname === given.pathname && r.search === given.search) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function validateRedirectUri(uri: string): void {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new ProblemError(422, "INVALID_REDIRECT_URI", uri);
  }
  if (u.hash) throw new ProblemError(422, "INVALID_REDIRECT_URI", "Redirect URIs cannot contain a fragment");
  if (u.protocol === "https:") return;
  if (isLoopback(u)) return;
  if (u.protocol === "http:") throw new ProblemError(422, "INVALID_REDIRECT_URI", "Use https, a loopback address or a private-use scheme");
  if (/^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(u.protocol)) return;
  throw new ProblemError(422, "INVALID_REDIRECT_URI", "Private-use schemes must be reverse domain names (com.example.app:/callback)");
}

export interface ClientAuth {
  client: Client;
  authenticated: boolean;
}

export async function authenticateClient(ctx: Ctx, headers: Headers, form: URLSearchParams): Promise<ClientAuth> {
  let clientId = form.get("client_id");
  let secret = form.get("client_secret");
  const authz = headers.get("authorization");
  if (authz?.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(authz.slice(6), "base64").toString();
    const i = decoded.indexOf(":");
    if (i > 0) {
      clientId = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    }
  }
  if (!clientId) throw new OAuthError(401, "invalid_client", "Client authentication required");
  const client = await getClient(ctx.db, clientId);
  if (!client) throw new OAuthError(401, "invalid_client");
  if (client.suspended_at) throw new OAuthError(401, "invalid_client", "Client suspended");
  if (client.type === "confidential") {
    if (!secret || !client.secret_hash || !safeEqual(hashSecret(secret), client.secret_hash)) throw new OAuthError(401, "invalid_client");
    return { client, authenticated: true };
  }
  if (secret) throw new OAuthError(401, "invalid_client", "Public clients do not have a secret");
  return { client, authenticated: false };
}

export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return safeEqual(createHash("sha256").update(verifier).digest("base64url"), challenge);
}

export function allowedScopes(ctx: Ctx, client: Client, requested: string[], grant: "user" | "service"): string[] {
  const defs = ctx.config.oidc.scopes;
  const out: string[] = [];
  for (const s of requested) {
    const def = defs[s];
    if (!def) throw new OAuthError(400, "invalid_scope", `Unknown scope ${s}`);
    if (def.game_client_only && client.kind !== "game") throw new OAuthError(400, "invalid_scope", `${s} is only available to the game's own client`);
    if (def.service_only && grant !== "service") throw new OAuthError(400, "invalid_scope", `${s} needs client credentials`);
    if (grant === "service" && !def.service_only && s !== "safety.intake") throw new OAuthError(400, "invalid_scope", `${s} needs a user`);
    if (client.scopes.length && !client.scopes.includes(s) && client.kind !== "first_party") throw new OAuthError(400, "invalid_scope", `${s} is not allowed for this client`);
    out.push(s);
  }
  return [...new Set(out)];
}

export interface TokenSet {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
  id_token?: string;
}

interface IssueInput {
  client: Client;
  userId: string | null;
  sessionId: string | null;
  scopes: string[];
  nonce?: string | null;
  authTime?: number | null;
  acr?: string | null;
  amr?: string[];
  familyId?: string | null;
  grant: string;
  withRefresh?: boolean;
}

async function sign(payload: Record<string, unknown>, typ: string, ttlSeconds: number): Promise<string> {
  const k = await getKeys().current();
  const alg = (k.publicJwk.alg as string) ?? "ES256";
  return new SignJWT(payload).setProtectedHeader({ alg, kid: k.kid, typ }).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds).sign(k.privateKey);
}

function atHash(accessToken: string, alg: string): string {
  const algo = alg.endsWith("512") ? "sha512" : alg.endsWith("384") ? "sha384" : "sha256";
  const digest = createHash(algo).update(accessToken).digest();
  return digest.subarray(0, digest.length / 2).toString("base64url");
}

export async function issueTokens(ctx: Ctx, db: Exec, input: IssueInput): Promise<TokenSet> {
  const cfg = ctx.config;
  const service = input.grant === "client_credentials";
  const ttl = Math.floor((service ? cfg.oidc.client_credentials_ttl : cfg.oidc.access_token_ttl) / 1000);
  const jti = ulid();
  const offline = input.scopes.includes("offline_access");
  const familyId = input.familyId ?? (input.withRefresh ? ulid() : null);
  const atClaims: Record<string, unknown> = {
    iss: iss(cfg),
    sub: input.userId ?? input.client.id,
    aud: apiResource(cfg),
    client_id: input.client.id,
    scope: input.scopes.join(" "),
    jti,
    ckd: input.client.kind,
    ...(input.client.game_id ? { gid: input.client.game_id } : {}),
    ...(service ? { gty: "client_credentials" } : {}),
    ...(input.sessionId ? { sid: input.sessionId } : {}),
    ...(input.authTime ? { auth_time: input.authTime } : {}),
    ...(input.acr ? { acr: input.acr } : {}),
    ...(input.amr?.length ? { amr: input.amr } : {}),
  };
  const accessToken = await sign(atClaims, "at+jwt", ttl);
  await db
    .insertInto("issued_tokens")
    .values({ jti, client_id: input.client.id, user_id: input.userId, session_id: input.sessionId, family_id: familyId, expires_at: new Date(Date.now() + ttl * 1000) })
    .execute();
  const set: TokenSet = { access_token: accessToken, token_type: "Bearer", expires_in: ttl, scope: input.scopes.join(" ") };
  if (input.userId && input.sessionId) {
    await db.insertInto("session_clients").values({ session_id: input.sessionId, client_id: input.client.id, user_id: input.userId }).onConflict((oc) => oc.doNothing()).execute();
  }
  if (input.userId && input.withRefresh && (input.client.grant_types.includes("refresh_token") || input.client.kind === "first_party" || input.client.kind === "game")) {
    const rt = `qrt_${randomToken(32)}`;
    const rttl = offline ? cfg.oidc.offline_refresh_token_ttl : cfg.oidc.refresh_token_ttl;
    await db
      .insertInto("refresh_tokens")
      .values({
        id: ulid(),
        token_hash: hashToken(rt),
        family_id: familyId!,
        client_id: input.client.id,
        user_id: input.userId,
        session_id: input.sessionId,
        scopes: JSON.stringify(input.scopes),
        offline,
        auth_time: input.authTime ?? null,
        acr: input.acr ?? null,
        amr: JSON.stringify(input.amr ?? []),
        expires_at: new Date(Date.now() + rttl),
      })
      .execute();
    set.refresh_token = rt;
  }
  if (input.userId && input.scopes.includes("openid")) {
    const claims = await ctx.rpc<Record<string, unknown> | null>("identity.oidc_claims", { user_id: input.userId, scopes: input.scopes });
    if (!claims) throw new OAuthError(400, "invalid_grant", "User is not available");
    const k = await getKeys().current();
    const { locale: _locale, ...rest } = claims;
    set.id_token = await sign(
      {
        iss: iss(cfg),
        sub: input.userId,
        aud: input.client.id,
        azp: input.client.id,
        at_hash: atHash(accessToken, (k.publicJwk.alg as string) ?? "ES256"),
        ...(input.nonce ? { nonce: input.nonce } : {}),
        ...(input.authTime ? { auth_time: input.authTime } : {}),
        ...(input.acr ? { acr: input.acr } : {}),
        ...(input.amr?.length ? { amr: input.amr } : {}),
        ...(input.sessionId ? { sid: input.sessionId } : {}),
        ...rest,
      },
      "JWT",
      Math.floor(cfg.oidc.id_token_ttl / 1000),
    );
  }
  if (input.userId) {
    await db.updateTable("consents").set({ last_used_at: new Date() }).where("user_id", "=", input.userId).where("client_id", "=", input.client.id).execute();
  }
  inc("qtiauth_oidc_token_grants_total", { grant_type: input.grant, client_kind: input.client.kind }, 1, "Token grants by grant type");
  return set;
}

export async function verifyAccessToken(ctx: Ctx, token: string): Promise<Record<string, unknown> | null> {
  try {
    const header = decodeProtectedHeader(token);
    if (header.typ !== "at+jwt") return null;
    const jwks = createLocalJWKSet(await getKeys().jwks());
    const { payload } = await jwtVerify(token, jwks, { issuer: iss(ctx.config), audience: apiResource(ctx.config), typ: "at+jwt" });
    const row = await ctx.db.selectFrom("issued_tokens").select(["revoked_at"]).where("jti", "=", String(payload.jti)).executeTakeFirst();
    if (!row || row.revoked_at) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function revokeJtis(ctx: Ctx, db: Exec, where: { family_id?: string; user_id?: string; client_id?: string; session_id?: string; jti?: string }, reason: string): Promise<number> {
  let q = db.updateTable("issued_tokens").set({ revoked_at: new Date() }).where("revoked_at", "is", null).where("expires_at", ">", new Date());
  if (where.family_id) q = q.where("family_id", "=", where.family_id);
  if (where.user_id) q = q.where("user_id", "=", where.user_id);
  if (where.client_id) q = q.where("client_id", "=", where.client_id);
  if (where.session_id) q = q.where("session_id", "=", where.session_id);
  if (where.jti) q = q.where("jti", "=", where.jti);
  const rows = await q.returning("jti").execute();
  if (rows.length) {
    for (let i = 0; i < rows.length; i += 500) {
      await ctx.emit(db, EVENTS.oidcTokenRevoked, { jtis: rows.slice(i, i + 500).map((r) => r.jti), reason }, { subject: { type: "token", id: rows[i]!.jti } });
    }
  }
  return rows.length;
}

export async function revokeRefresh(db: Exec, where: { family_id?: string; user_id?: string; client_id?: string; session_id?: string; include_offline?: boolean }, reason: string): Promise<string[]> {
  let q = db.updateTable("refresh_tokens").set({ revoked_at: new Date(), revoke_reason: reason }).where("revoked_at", "is", null);
  if (where.family_id) q = q.where("family_id", "=", where.family_id);
  if (where.user_id) q = q.where("user_id", "=", where.user_id);
  if (where.client_id) q = q.where("client_id", "=", where.client_id);
  if (where.session_id) q = q.where("session_id", "=", where.session_id);
  if (!where.include_offline) q = q.where("offline", "=", false);
  const rows = await q.returning("family_id").execute();
  return [...new Set(rows.map((r) => r.family_id))];
}

export async function refreshGrant(ctx: Ctx, client: Client, token: string, requestedScopes: string[] | null): Promise<TokenSet> {
  return ctx.db.transaction().execute(async (trx) => {
    const row = await trx.selectFrom("refresh_tokens").selectAll().where("token_hash", "=", hashToken(token)).forUpdate().executeTakeFirst();
    if (!row || row.client_id !== client.id) throw new OAuthError(400, "invalid_grant");
    if (row.rotated_at || row.revoked_at) {
      if (row.rotated_at && !row.revoked_at) {
        await revokeRefresh(trx, { family_id: row.family_id, include_offline: true }, "reuse_detected");
        await revokeJtis(ctx, trx, { family_id: row.family_id }, "refresh_token_reuse");
        inc("qtiauth_oidc_refresh_reuse_total", {}, 1, "Refresh token reuse detections");
        ctx.log.warn({ client_id: client.id, family: row.family_id }, "refresh token reuse detected; family revoked");
      }
      throw new OAuthError(400, "invalid_grant");
    }
    if (row.expires_at <= new Date()) throw new OAuthError(400, "invalid_grant", "Refresh token expired");
    if (row.session_id && !row.offline) {
      const s = await ctx.rpc<{ active: boolean } | null>("identity.session_info", { session_id: row.session_id });
      if (!s?.active) {
        await revokeRefresh(trx, { family_id: row.family_id }, "session_ended");
        throw new OAuthError(400, "invalid_grant", "Session ended");
      }
    }
    const user = await ctx.rpc<{ state: string } | null>("identity.resolve_user", { user_id: row.user_id });
    if (!user || ["banned", "locked", "deleted", "pending_deletion"].includes(user.state)) throw new OAuthError(400, "invalid_grant", "Account unavailable");
    const scopes = requestedScopes ?? row.scopes;
    if (!scopes.every((s) => row.scopes.includes(s))) throw new OAuthError(400, "invalid_scope", "Cannot widen scope on refresh");
    await trx.updateTable("refresh_tokens").set({ rotated_at: new Date() }).where("id", "=", row.id).execute();
    return issueTokens(ctx, trx, {
      client,
      userId: row.user_id,
      sessionId: row.session_id,
      scopes,
      authTime: row.auth_time,
      acr: row.acr,
      amr: row.amr,
      familyId: row.family_id,
      grant: "refresh_token",
      withRefresh: true,
    });
  });
}

export async function queueBackchannel(ctx: Ctx, db: Exec, userId: string, sessionId: string | null, reason: string): Promise<number> {
  if (!ctx.config.features.oidc.backchannel_logout.enabled) return 0;
  let q = db.selectFrom("session_clients").innerJoin("clients", "clients.id", "session_clients.client_id").select(["clients.id", "session_clients.session_id"]).where("session_clients.user_id", "=", userId).where("clients.backchannel_logout_uri", "is not", null);
  if (sessionId) q = q.where("session_clients.session_id", "=", sessionId);
  const rows = await q.execute();
  for (const r of rows) {
    await db
      .insertInto("backchannel_deliveries")
      .values({ id: ulid(), client_id: r.id, session_id: r.session_id, user_id: userId, reason, status: "pending", next_attempt_at: new Date() })
      .execute();
  }
  if (sessionId) await db.deleteFrom("session_clients").where("session_id", "=", sessionId).execute();
  else await db.deleteFrom("session_clients").where("user_id", "=", userId).execute();
  return rows.length;
}

const BC_BACKOFF = [10, 30, 120, 600, 1800, 3600, 7200, 14400, 28800, 43200];

export async function deliverBackchannel(ctx: Ctx, limit = 100): Promise<number> {
  const due = await ctx.db.selectFrom("backchannel_deliveries").selectAll().where("status", "in", ["pending", "retrying"]).where("next_attempt_at", "<=", new Date()).limit(limit).execute();
  for (const d of due) {
    const client = await getClient(ctx.db, d.client_id);
    if (!client?.backchannel_logout_uri) {
      await ctx.db.updateTable("backchannel_deliveries").set({ status: "failed", last_error: "client has no back-channel logout URI", completed_at: new Date() }).where("id", "=", d.id).execute();
      continue;
    }
    const logoutToken = await sign(
      {
        iss: iss(ctx.config),
        aud: client.id,
        sub: d.user_id,
        jti: ulid(),
        events: { "http://schemas.openid.net/event/backchannel-logout": {} },
        ...(d.session_id ? { sid: d.session_id } : {}),
      },
      "logout+jwt",
      120,
    );
    let status = 0;
    let error: string | null = null;
    try {
      const r = await fetch(client.backchannel_logout_uri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-store" },
        body: new URLSearchParams({ logout_token: logoutToken }).toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      status = r.status;
    } catch (err) {
      error = (err as Error).message.slice(0, 300);
    }
    const ok = status >= 200 && status < 300;
    const attempts = d.attempts + 1;
    const giveUp = !ok && attempts >= ctx.config.oidc.backchannel_logout_max_attempts;
    await ctx.db
      .updateTable("backchannel_deliveries")
      .set({
        status: ok ? "success" : giveUp ? "failed" : "retrying",
        attempts,
        last_status: status || null,
        last_error: ok ? null : (error ?? `HTTP ${status}`),
        next_attempt_at: ok || giveUp ? null : new Date(Date.now() + BC_BACKOFF[Math.min(attempts - 1, BC_BACKOFF.length - 1)]! * 1000),
        completed_at: ok || giveUp ? new Date() : null,
      })
      .where("id", "=", d.id)
      .execute();
    inc("qtiauth_oidc_backchannel_deliveries_total", { result: ok ? "success" : giveUp ? "failed" : "retry" }, 1, "Back-channel logout deliveries");
  }
  return due.length;
}

export async function ensureFirstPartyClients(ctx: Ctx): Promise<void> {
  for (const c of ctx.config.oidc.first_party_clients) {
    const values = {
      id: c.client_id,
      name: c.name,
      type: c.type,
      kind: "first_party" as ClientKind,
      secret_hash: c.client_secret ? hashSecret(c.client_secret) : null,
      redirect_uris: JSON.stringify(c.redirect_uris),
      post_logout_redirect_uris: JSON.stringify(c.post_logout_redirect_uris),
      grant_types: JSON.stringify(c.grant_types),
      scopes: JSON.stringify(c.scopes),
      backchannel_logout_uri: c.backchannel_logout_uri ?? null,
      backchannel_logout_session_required: c.backchannel_logout_session_required,
      require_par: c.require_par,
      verified: true,
    };
    await ctx.db
      .insertInto("clients")
      .values({ ...values, description: "" })
      .onConflict((oc) => oc.column("id").doUpdateSet({ ...values, updated_at: new Date(), deleted_at: null }))
      .execute();
  }
}

export async function purgeExpired(ctx: Ctx): Promise<Record<string, number>> {
  const now = new Date();
  const n = async (q: Promise<{ numDeletedRows: bigint }>) => Number((await q).numDeletedRows);
  return {
    authorization_requests: await n(ctx.db.deleteFrom("authorization_requests").where("expires_at", "<", new Date(now.getTime() - 86_400_000)).executeTakeFirst()),
    auth_codes: await n(ctx.db.deleteFrom("auth_codes").where("expires_at", "<", new Date(now.getTime() - 86_400_000)).executeTakeFirst()),
    device_codes: await n(ctx.db.deleteFrom("device_codes").where("expires_at", "<", new Date(now.getTime() - 86_400_000)).executeTakeFirst()),
    issued_tokens: await n(ctx.db.deleteFrom("issued_tokens").where("expires_at", "<", new Date(now.getTime() - 86_400_000)).executeTakeFirst()),
    refresh_tokens: await n(ctx.db.deleteFrom("refresh_tokens").where((eb) => eb.or([eb("expires_at", "<", now), eb("revoked_at", "<", new Date(now.getTime() - 30 * 86_400_000))])).executeTakeFirst()),
    backchannel_deliveries: await n(ctx.db.deleteFrom("backchannel_deliveries").where("created_at", "<", new Date(now.getTime() - ctx.config.retention.delivery_logs)).executeTakeFirst()),
  };
}

export async function activeSessionClientCount(db: Exec, userId: string): Promise<number> {
  const r = await sql<{ n: number }>`select count(*)::int as n from session_clients where user_id = ${userId}`.execute(db);
  return r.rows[0]?.n ?? 0;
}

export const DEVICE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export async function startDeviceAuthorization(ctx: Ctx, client: Client, scopes: string[]): Promise<DeviceAuthorization> {
  const cfg = ctx.config;
  const deviceCode = randomToken(32);
  const userCode = humanCode(8, 4, DEVICE_ALPHABET);
  const interval = Math.max(5, Math.floor(cfg.oidc.device_poll_interval / 1000));
  await ctx.db
    .insertInto("device_codes")
    .values({ id: ulid(), device_code_hash: hashToken(deviceCode), user_code: userCode, client_id: client.id, scopes: JSON.stringify(scopes), status: "pending", interval_s: interval, expires_at: new Date(Date.now() + cfg.oidc.device_code_ttl) })
    .execute();
  const verify = surfaceUrl(ctx.surfaces.account, "/device");
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verify,
    verification_uri_complete: `${verify}?user_code=${encodeURIComponent(userCode)}`,
    expires_in: Math.floor(cfg.oidc.device_code_ttl / 1000),
    interval,
  };
}
