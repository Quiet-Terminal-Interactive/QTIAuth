import { hashToken, inc, randomToken, ProblemError } from "@qtiauth/common";
import { surfaceUrl } from "@qtiauth/config";
import { reply, route, type AnyRoute } from "@qtiauth/service-kit";
import {
  OAuthError,
  allowedScopes,
  authenticateClient,
  getClient,
  getKeys,
  iss,
  issueTokens,
  oauthErrorResponse,
  pkceMatches,
  redirectAllowed,
  refreshGrant,
  revokeJtis,
  revokeRefresh,
  startDeviceAuthorization,
  verifyAccessToken,
  type Ctx,
} from "../lib.ts";

const root = { auth: "none" as const, mount: "root" as const, module: "oidc" as const, csrf: false, tags: ["oauth"] };

function form(raw: Uint8Array | null): URLSearchParams {
  return new URLSearchParams(new TextDecoder().decode(raw ?? new Uint8Array()));
}

function noStore(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache" } });
}

async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OAuthError) return oauthErrorResponse(err);
    if (err instanceof ProblemError && err.status < 500) return oauthErrorResponse(new OAuthError(err.status === 401 ? 401 : 400, err.status === 401 ? "invalid_client" : "invalid_request", err.message));
    throw err;
  }
}

function errorRedirect(redirectUri: string, error: string, state: string | null, issuer: string, description?: string): Response {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (description) u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", issuer);
  return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
}

export function discoveryDocument(ctx: Ctx, alg: string) {
  const i = iss(ctx.config);
  const scopes = Object.entries(ctx.config.oidc.scopes)
    .filter(([, d]) => !d.hidden)
    .map(([s]) => s);
  const claims = new Set<string>(["sub", "iss", "aud", "exp", "iat", "auth_time", "nonce", "acr", "amr", "sid", "at_hash", "azp"]);
  for (const d of Object.values(ctx.config.oidc.scopes)) for (const c of d.claims) claims.add(c);
  return {
    issuer: i,
    authorization_endpoint: `${i}/oauth/authorize`,
    token_endpoint: `${i}/oauth/token`,
    userinfo_endpoint: `${i}/oauth/userinfo`,
    revocation_endpoint: `${i}/oauth/revoke`,
    introspection_endpoint: `${i}/oauth/introspect`,
    jwks_uri: `${i}/.well-known/jwks.json`,
    ...(ctx.config.features.oidc.device_flow.enabled ? { device_authorization_endpoint: `${i}/oauth/device/code` } : {}),
    ...(ctx.config.features.oidc.par.enabled ? { pushed_authorization_request_endpoint: `${i}/oauth/par` } : {}),
    scopes_supported: scopes,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token", "client_credentials", ...(ctx.config.features.oidc.device_flow.enabled ? ["urn:ietf:params:oauth:grant-type:device_code"] : [])],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    introspection_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [alg],
    claims_supported: [...claims].sort(),
    backchannel_logout_supported: ctx.config.features.oidc.backchannel_logout.enabled,
    backchannel_logout_session_supported: ctx.config.features.oidc.backchannel_logout.enabled,
    authorization_response_iss_parameter_supported: true,
    require_pushed_authorization_requests: false,
    ui_locales_supported: ctx.config.branding.locales,
    acr_values_supported: ["aal1", "aal2"],
  };
}

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string | null;
  response_type: string | null;
  scope: string;
  state: string | null;
  nonce: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  prompt: string | null;
  max_age: string | null;
}

function readParams(p: URLSearchParams): AuthorizeParams {
  return {
    client_id: p.get("client_id") ?? "",
    redirect_uri: p.get("redirect_uri"),
    response_type: p.get("response_type"),
    scope: p.get("scope") ?? "",
    state: p.get("state"),
    nonce: p.get("nonce"),
    code_challenge: p.get("code_challenge"),
    code_challenge_method: p.get("code_challenge_method"),
    prompt: p.get("prompt"),
    max_age: p.get("max_age"),
  };
}

export function protocolRoutes(ctx: Ctx): AnyRoute[] {
  const cfg = ctx.config;
  const ttl = (ms: number) => new Date(Date.now() + ms);

  async function createAuthorizationRequest(params: AuthorizeParams, par: boolean): Promise<{ id: string; redirectUri: string }> {
    const client = await getClient(ctx.db, params.client_id);
    if (!client) throw new ProblemError(400, "UNKNOWN_CLIENT", "Unknown client_id");
    if (client.suspended_at) throw new ProblemError(400, "CLIENT_SUSPENDED", "This app has been suspended");
    if (!client.grant_types.includes("authorization_code") && client.kind !== "first_party" && client.kind !== "game") throw new ProblemError(400, "GRANT_NOT_ALLOWED");
    let redirectUri = params.redirect_uri;
    if (!redirectUri) {
      if (client.redirect_uris.length !== 1) throw new ProblemError(400, "REDIRECT_URI_REQUIRED");
      redirectUri = client.redirect_uris[0]!;
    }
    if (!redirectAllowed(client, redirectUri)) throw new ProblemError(400, "REDIRECT_URI_MISMATCH", "redirect_uri is not registered for this app");
    const fail = (error: string, desc: string) => {
      throw Object.assign(new OAuthError(400, error, desc), { redirectUri, state: params.state });
    };
    if (params.response_type !== "code") fail("unsupported_response_type", "Only response_type=code is supported");
    if (!params.code_challenge || params.code_challenge_method !== "S256") fail("invalid_request", "PKCE with S256 is required");
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge!)) fail("invalid_request", "Invalid code_challenge");
    let scopes: string[] = [];
    try {
      scopes = allowedScopes(ctx, client, params.scope.split(" ").filter(Boolean), "user");
    } catch (e) {
      fail("invalid_scope", (e as Error).message);
    }
    if (params.prompt && !params.prompt.split(" ").every((p) => ["none", "login", "consent", "select_account"].includes(p))) fail("invalid_request", "Unsupported prompt");
    const id = `ar_${randomToken(18)}`;
    await ctx.db
      .insertInto("authorization_requests")
      .values({
        id,
        client_id: client.id,
        redirect_uri: redirectUri,
        scopes: JSON.stringify(scopes),
        state: params.state,
        nonce: params.nonce,
        code_challenge: params.code_challenge!,
        response_mode: "query",
        prompt: params.prompt,
        max_age: params.max_age ? Number(params.max_age) : null,
        par,
        status: "pending",
        expires_at: ttl(par ? cfg.oidc.par_ttl : cfg.oidc.authorization_request_ttl),
      })
      .execute();
    return { id, redirectUri };
  }

  return [
    route({
      method: "GET",
      path: "/.well-known/openid-configuration",
      summary: "OpenID Connect discovery",
      ...root,
      rate_limit: ["public_read"],
      async handler() {
        const k = await getKeys().current();
        return reply(200, discoveryDocument(ctx, (k.publicJwk.alg as string) ?? cfg.oidc.id_token_alg), { "cache-control": "public, max-age=300" });
      },
    }),

    route({
      method: "GET",
      path: "/.well-known/jwks.json",
      summary: "Signing keys for ID tokens, access tokens and logout tokens",
      ...root,
      rate_limit: ["public_read"],
      async handler() {
        return reply(200, await getKeys().jwks(), { "cache-control": "public, max-age=300" });
      },
    }),

    route({
      method: "GET",
      path: "/oauth/authorize",
      summary: "Authorization endpoint",
      description: "Validates the request (PKCE S256 is mandatory) and sends the user to the consent screen on the account surface.",
      ...root,
      rate_limit: ["oauth_device"],
      async handler({ c }) {
        const url = new URL(c.req.url);
        let params = readParams(url.searchParams);
        const requestUri = url.searchParams.get("request_uri");
        try {
          let id: string;
          if (requestUri) {
            const m = /^urn:ietf:params:oauth:request_uri:(ar_[A-Za-z0-9_-]+)$/.exec(requestUri);
            const ar = m ? await ctx.db.selectFrom("authorization_requests").selectAll().where("id", "=", m[1]!).where("par", "=", true).executeTakeFirst() : undefined;
            if (!ar || ar.client_id !== params.client_id || ar.expires_at <= new Date() || ar.status !== "pending") throw new ProblemError(400, "INVALID_REQUEST_URI");
            await ctx.db.updateTable("authorization_requests").set({ par: false, expires_at: ttl(cfg.oidc.authorization_request_ttl) }).where("id", "=", ar.id).execute();
            id = ar.id;
          } else {
            const client = await getClient(ctx.db, params.client_id);
            if (client?.require_par) throw new ProblemError(400, "PAR_REQUIRED", "This app must use pushed authorization requests");
            id = (await createAuthorizationRequest(params, false)).id;
          }
          inc("qtiauth_oidc_authorizations_total", { stage: "started" }, 1, "Authorization requests");
          const silent = (params.prompt ?? "").split(" ").includes("none") ? "&prompt=none" : "";
          return reply(302, undefined, { location: `${surfaceUrl(ctx.surfaces.account, "/oauth/consent")}?request=${encodeURIComponent(id)}${silent}`, "cache-control": "no-store" });
        } catch (err) {
          const e = err as OAuthError & { redirectUri?: string; state?: string | null };
          if (e instanceof OAuthError && e.redirectUri) return errorRedirect(e.redirectUri, e.oauthError, e.state ?? null, iss(cfg), e.message);
          throw err;
        }
      },
    }),

    route({
      method: "POST",
      path: "/oauth/par",
      summary: "Pushed authorization request (RFC 9126)",
      ...root,
      raw_body: true,
      rate_limit: ["oauth_token"],
      async handler({ raw, c }) {
        return guarded(async () => {
          if (!cfg.features.oidc.par.enabled) throw new OAuthError(400, "invalid_request", "PAR is disabled");
          const f = form(raw);
          const { client } = await authenticateClient(ctx, c.req.raw.headers, f);
          const params = { ...readParams(f), client_id: client.id };
          try {
            const { id } = await createAuthorizationRequest(params, true);
            return noStore({ request_uri: `urn:ietf:params:oauth:request_uri:${id}`, expires_in: Math.floor(cfg.oidc.par_ttl / 1000) }, 201);
          } catch (err) {
            if (err instanceof OAuthError) throw err;
            throw new OAuthError(400, "invalid_request", (err as Error).message);
          }
        });
      },
    }),

    route({
      method: "POST",
      path: "/oauth/token",
      summary: "Token endpoint",
      description: "Grants: authorization_code (PKCE), refresh_token (rotating, reuse revokes the family), client_credentials and the device code grant.",
      ...root,
      raw_body: true,
      rate_limit: ["oauth_token"],
      async handler({ raw, c }) {
        return guarded(async () => {
          const f = form(raw);
          const grant = f.get("grant_type");
          const { client } = await authenticateClient(ctx, c.req.raw.headers, f);
          if (grant === "authorization_code") {
            const code = f.get("code") ?? "";
            const tokens = await ctx.db.transaction().execute(async (trx) => {
              const row = await trx.selectFrom("auth_codes").selectAll().where("code_hash", "=", hashToken(code)).forUpdate().executeTakeFirst();
              if (!row || row.client_id !== client.id) throw new OAuthError(400, "invalid_grant");
              const family = `c_${row.code_hash.slice(0, 24)}`;
              if (row.used_at) {
                await revokeRefresh(trx, { family_id: family, include_offline: true }, "code_reuse");
                await revokeJtis(ctx, trx, { family_id: family }, "code_reuse");
                throw new OAuthError(400, "invalid_grant", "Code already used");
              }
              if (row.expires_at <= new Date()) throw new OAuthError(400, "invalid_grant", "Code expired");
              if ((f.get("redirect_uri") ?? row.redirect_uri) !== row.redirect_uri) throw new OAuthError(400, "invalid_grant", "redirect_uri mismatch");
              if (!pkceMatches(f.get("code_verifier") ?? "", row.code_challenge)) throw new OAuthError(400, "invalid_grant", "PKCE verification failed");
              await trx.updateTable("auth_codes").set({ used_at: new Date() }).where("code_hash", "=", row.code_hash).execute();
              return issueTokens(ctx, trx, {
                client,
                userId: row.user_id,
                sessionId: row.session_id,
                scopes: row.scopes,
                nonce: row.nonce,
                authTime: row.auth_time,
                acr: row.acr,
                amr: row.amr,
                familyId: family,
                grant: "authorization_code",
                withRefresh: true,
              });
            });
            return noStore(tokens);
          }
          if (grant === "refresh_token") {
            const scope = f.get("scope");
            return noStore(await refreshGrant(ctx, client, f.get("refresh_token") ?? "", scope ? scope.split(" ").filter(Boolean) : null));
          }
          if (grant === "client_credentials") {
            if (client.type !== "confidential") throw new OAuthError(400, "unauthorized_client", "Client credentials need a confidential client");
            if (!client.grant_types.includes("client_credentials") && client.kind !== "game_server") throw new OAuthError(400, "unauthorized_client");
            const requested = (f.get("scope") ?? client.scopes.join(" ")).split(" ").filter(Boolean);
            const scopes = client.kind === "game_server" ? requested.filter((s) => client.scopes.includes(s)) : allowedScopes(ctx, client, requested, "service");
            const tokens = await ctx.db.transaction().execute((trx) => issueTokens(ctx, trx, { client, userId: null, sessionId: null, scopes, grant: "client_credentials" }));
            return noStore(tokens);
          }
          if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
            const deviceCode = f.get("device_code") ?? "";
            const tokens = await ctx.db.transaction().execute(async (trx) => {
              const row = await trx.selectFrom("device_codes").selectAll().where("device_code_hash", "=", hashToken(deviceCode)).forUpdate().executeTakeFirst();
              if (!row || row.client_id !== client.id) throw new OAuthError(400, "invalid_grant");
              if (row.expires_at <= new Date()) throw new OAuthError(400, "expired_token");
              const now = Date.now();
              if (row.last_polled_at && now - row.last_polled_at.getTime() < row.interval_s * 1000) {
                await trx.updateTable("device_codes").set({ interval_s: row.interval_s + 5, last_polled_at: new Date() }).where("id", "=", row.id).execute();
                throw new OAuthError(400, "slow_down");
              }
              await trx.updateTable("device_codes").set({ last_polled_at: new Date() }).where("id", "=", row.id).execute();
              if (row.status === "pending") throw new OAuthError(400, "authorization_pending");
              if (row.status === "denied") throw new OAuthError(400, "access_denied");
              if (row.status === "used") throw new OAuthError(400, "invalid_grant");
              await trx.updateTable("device_codes").set({ status: "used" }).where("id", "=", row.id).execute();
              inc("qtiauth_oidc_device_approvals_total", { result: "redeemed" }, 1, "Device flow approvals");
              return issueTokens(ctx, trx, {
                client,
                userId: row.user_id!,
                sessionId: row.session_id,
                scopes: row.scopes,
                authTime: row.auth_time,
                acr: row.acr,
                amr: row.amr,
                grant: "device_code",
                withRefresh: true,
              });
            });
            return noStore(tokens);
          }
          throw new OAuthError(400, "unsupported_grant_type");
        });
      },
    }),

    route({
      method: "GET",
      path: "/oauth/userinfo",
      summary: "UserInfo endpoint",
      ...root,
      auth: "oauth",
      scopes: ["openid"],
      allow_account_states: ["active", "locked", "banned"],
      allow_pending_legal: true,
      rate_limit: ["public_read"],
      async handler({ id }) {
        const claims = await ctx.rpc<Record<string, unknown> | null>("identity.oidc_claims", { user_id: id.sub, scopes: id.scopes ?? [] });
        if (!claims) throw new ProblemError(401, "INVALID_TOKEN");
        const { locale: _l, ...rest } = claims;
        return { sub: id.sub, ...rest };
      },
    }),

    route({
      method: "POST",
      path: "/oauth/revoke",
      summary: "Token revocation (RFC 7009)",
      ...root,
      raw_body: true,
      rate_limit: ["oauth_token"],
      async handler({ raw, c }) {
        return guarded(async () => {
          const f = form(raw);
          const { client } = await authenticateClient(ctx, c.req.raw.headers, f);
          const token = f.get("token") ?? "";
          await ctx.db.transaction().execute(async (trx) => {
            const rt = await trx.selectFrom("refresh_tokens").selectAll().where("token_hash", "=", hashToken(token)).executeTakeFirst();
            if (rt && rt.client_id === client.id) {
              await revokeRefresh(trx, { family_id: rt.family_id, include_offline: true }, "revoked_by_client");
              await revokeJtis(ctx, trx, { family_id: rt.family_id }, "revoked_by_client");
              return;
            }
            const at = await verifyAccessToken(ctx, token);
            if (at && at.client_id === client.id) await revokeJtis(ctx, trx, { jti: String(at.jti) }, "revoked_by_client");
          });
          return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
        });
      },
    }),

    route({
      method: "POST",
      path: "/oauth/introspect",
      summary: "Token introspection (RFC 7662)",
      description: "A client may introspect its own tokens. A game's server may introspect its players' tokens for that game.",
      ...root,
      raw_body: true,
      rate_limit: ["oauth_token"],
      async handler({ raw, c }) {
        return guarded(async () => {
          const f = form(raw);
          const { client, authenticated } = await authenticateClient(ctx, c.req.raw.headers, f);
          if (!authenticated) throw new OAuthError(401, "invalid_client", "Introspection needs a confidential client");
          inc("qtiauth_oidc_introspections_total", {}, 1, "Token introspections");
          const token = f.get("token") ?? "";
          const mayView = (tokenClientId: string, gid: string | null | undefined) =>
            tokenClientId === client.id || client.kind === "first_party" || (client.kind === "game_server" && gid && gid === client.game_id);
          const at = await verifyAccessToken(ctx, token);
          if (at) {
            if (!mayView(String(at.client_id), at.gid as string | undefined)) return noStore({ active: false });
            return noStore({ active: true, token_type: "Bearer", ...at });
          }
          const rt = await ctx.db.selectFrom("refresh_tokens").selectAll().where("token_hash", "=", hashToken(token)).executeTakeFirst();
          if (rt && !rt.revoked_at && !rt.rotated_at && rt.expires_at > new Date()) {
            const tc = await getClient(ctx.db, rt.client_id);
            if (!mayView(rt.client_id, tc?.game_id)) return noStore({ active: false });
            return noStore({ active: true, token_type: "refresh_token", client_id: rt.client_id, sub: rt.user_id, scope: rt.scopes.join(" "), exp: Math.floor(rt.expires_at.getTime() / 1000), iss: iss(cfg) });
          }
          return noStore({ active: false });
        });
      },
    }),

    route({
      method: "POST",
      path: "/oauth/device/code",
      summary: "Device authorization (RFC 8628)",
      ...root,
      raw_body: true,
      rate_limit: ["oauth_device"],
      async handler({ raw, c }) {
        return guarded(async () => {
          if (!cfg.features.oidc.device_flow.enabled) throw new OAuthError(400, "invalid_request", "Device flow is disabled");
          const f = form(raw);
          const { client } = await authenticateClient(ctx, c.req.raw.headers, f);
          if (!client.grant_types.includes("urn:ietf:params:oauth:grant-type:device_code") && client.kind !== "game" && client.kind !== "first_party") throw new OAuthError(400, "unauthorized_client");
          const scopes = allowedScopes(ctx, client, (f.get("scope") ?? "openid").split(" ").filter(Boolean), "user");
          return noStore(await startDeviceAuthorization(ctx, client, scopes));
        });
      },
    }),
  ];
}

