import { createRemoteJWKSet, jwtVerify } from "jose";
import { ProblemError, sha256b64url, randomToken } from "@qtiauth/common";
import { externalApiPath } from "@qtiauth/config";
import type { Ctx } from "../ctx.ts";

export interface ProviderProfile {
  subject: string;
  email: string | null;
  email_verified: boolean;
  display_name: string | null;
  birthdate: string | null;
  data: Record<string, unknown>;
}

export interface FlowState {
  provider: string;
  intent: "login" | "connect" | "step_up";
  user_id: string | null;
  session_id: string | null;
  return_to: string;
  verifier: string;
  nonce: string;
  redirect_uri: string;
}

export interface SocialProvider {
  id: string;
  name: string;
  icon: string | null;
  identityType: string;
  authorizeUrl(state: string, flow: FlowState): Promise<string>;
  callback(params: URLSearchParams, flow: FlowState): Promise<ProviderProfile>;
}

export function pkceChallenge(verifier: string): string {
  return sha256b64url(verifier);
}

export function newFlowSecrets(): { verifier: string; nonce: string } {
  return { verifier: randomToken(48), nonce: randomToken(24) };
}

async function postForm(url: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = Object.fromEntries(new URLSearchParams(text));
  }
  if (!r.ok || json.error) throw new ProblemError(502, "PROVIDER_TOKEN_EXCHANGE_FAILED", String(json.error ?? r.status));
  return json;
}

async function getJson(url: string, token: string, extra: Record<string, string> = {}): Promise<unknown> {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "qtiauth", ...extra }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new ProblemError(502, "PROVIDER_PROFILE_FAILED", `${url} → ${r.status}`);
  return r.json();
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

const discoveryCache = new Map<string, { doc: Discovery; at: number }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.doc;
  const r = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new ProblemError(502, "PROVIDER_DISCOVERY_FAILED");
  const doc = (await r.json()) as Discovery;
  discoveryCache.set(issuer, { doc, at: Date.now() });
  return doc;
}

function oidcProvider(opts: { id: string; name: string; icon: string | null; identityType: string; issuer: string; clientId: string; clientSecret: string; scopes: string[] }): SocialProvider {
  return {
    id: opts.id,
    name: opts.name,
    icon: opts.icon,
    identityType: opts.identityType,
    async authorizeUrl(state, flow) {
      const d = await discover(opts.issuer);
      const u = new URL(d.authorization_endpoint);
      u.search = new URLSearchParams({
        response_type: "code",
        client_id: opts.clientId,
        redirect_uri: flow.redirect_uri,
        scope: opts.scopes.join(" "),
        state,
        nonce: flow.nonce,
        code_challenge: pkceChallenge(flow.verifier),
        code_challenge_method: "S256",
      }).toString();
      return u.toString();
    },
    async callback(params, flow) {
      const code = params.get("code");
      if (!code) throw new ProblemError(400, "PROVIDER_DENIED", params.get("error") ?? undefined);
      const d = await discover(opts.issuer);
      const tokens = await postForm(d.token_endpoint, {
        grant_type: "authorization_code",
        code,
        redirect_uri: flow.redirect_uri,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        code_verifier: flow.verifier,
      });
      const idToken = String(tokens.id_token ?? "");
      if (!idToken) throw new ProblemError(502, "PROVIDER_NO_ID_TOKEN");
      let jwks = jwksCache.get(d.jwks_uri);
      if (!jwks) {
        jwks = createRemoteJWKSet(new URL(d.jwks_uri));
        jwksCache.set(d.jwks_uri, jwks);
      }
      const { payload } = await jwtVerify(idToken, jwks, { issuer: d.issuer, audience: opts.clientId }).catch(() => {
        throw new ProblemError(502, "PROVIDER_ID_TOKEN_INVALID");
      });
      if (payload.nonce !== flow.nonce) throw new ProblemError(400, "PROVIDER_NONCE_MISMATCH");
      let claims: Record<string, unknown> = payload as Record<string, unknown>;
      if (d.userinfo_endpoint && tokens.access_token && (!claims.email || claims.email_verified === undefined)) {
        try {
          const info = (await getJson(d.userinfo_endpoint, String(tokens.access_token))) as Record<string, unknown>;
          if (info.sub === payload.sub) claims = { ...info, ...claims };
        } catch {
          claims = payload as Record<string, unknown>;
        }
      }
      return {
        subject: String(payload.sub),
        email: typeof claims.email === "string" ? claims.email : null,
        email_verified: claims.email_verified === true || claims.email_verified === "true",
        display_name: typeof claims.name === "string" ? claims.name : typeof claims.preferred_username === "string" ? claims.preferred_username : null,
        birthdate: typeof claims.birthdate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(claims.birthdate) ? claims.birthdate : null,
        data: { issuer: d.issuer },
      };
    },
  };
}

function github(ctx: Ctx): SocialProvider {
  const cfg = ctx.config.features.auth.social.github;
  return {
    id: "github",
    name: "GitHub",
    icon: "github",
    identityType: "github",
    async authorizeUrl(state, flow) {
      const u = new URL("https://github.com/login/oauth/authorize");
      u.search = new URLSearchParams({
        client_id: cfg.client_id!,
        redirect_uri: flow.redirect_uri,
        scope: (cfg.scopes ?? ["read:user", "user:email"]).join(" "),
        state,
        code_challenge: pkceChallenge(flow.verifier),
        code_challenge_method: "S256",
        allow_signup: "false",
      }).toString();
      return u.toString();
    },
    async callback(params, flow) {
      const code = params.get("code");
      if (!code) throw new ProblemError(400, "PROVIDER_DENIED", params.get("error") ?? undefined);
      const tokens = await postForm("https://github.com/login/oauth/access_token", {
        client_id: cfg.client_id!,
        client_secret: cfg.client_secret!,
        code,
        redirect_uri: flow.redirect_uri,
        code_verifier: flow.verifier,
      });
      const token = String(tokens.access_token ?? "");
      const user = (await getJson("https://api.github.com/user", token)) as { id: number; login: string; name: string | null };
      const emails = (await getJson("https://api.github.com/user/emails", token)) as { email: string; primary: boolean; verified: boolean }[];
      const primary = emails.find((e) => e.primary);
      return {
        subject: String(user.id),
        email: primary?.email ?? null,
        email_verified: Boolean(primary?.verified),
        display_name: user.name ?? user.login,
        birthdate: null,
        data: { login: user.login },
      };
    },
  };
}

function discord(ctx: Ctx): SocialProvider {
  const cfg = ctx.config.features.auth.social.discord;
  return {
    id: "discord",
    name: "Discord",
    icon: "discord",
    identityType: "discord",
    async authorizeUrl(state, flow) {
      const u = new URL("https://discord.com/oauth2/authorize");
      u.search = new URLSearchParams({
        response_type: "code",
        client_id: cfg.client_id!,
        redirect_uri: flow.redirect_uri,
        scope: (cfg.scopes ?? ["identify", "email"]).join(" "),
        state,
        prompt: "consent",
        code_challenge: pkceChallenge(flow.verifier),
        code_challenge_method: "S256",
      }).toString();
      return u.toString();
    },
    async callback(params, flow) {
      const code = params.get("code");
      if (!code) throw new ProblemError(400, "PROVIDER_DENIED", params.get("error") ?? undefined);
      const tokens = await postForm("https://discord.com/api/oauth2/token", {
        grant_type: "authorization_code",
        code,
        redirect_uri: flow.redirect_uri,
        client_id: cfg.client_id!,
        client_secret: cfg.client_secret!,
        code_verifier: flow.verifier,
      });
      const user = (await getJson("https://discord.com/api/users/@me", String(tokens.access_token))) as { id: string; username: string; global_name?: string; email?: string; verified?: boolean };
      return {
        subject: user.id,
        email: user.email ?? null,
        email_verified: user.verified === true,
        display_name: user.global_name ?? user.username,
        birthdate: null,
        data: { username: user.username },
      };
    },
  };
}

const STEAM_OPENID = "https://steamcommunity.com/openid/login";

function steam(ctx: Ctx): SocialProvider {
  return {
    id: "steam",
    name: "Steam",
    icon: "steam",
    identityType: "steam",
    async authorizeUrl(state, flow) {
      const returnTo = new URL(flow.redirect_uri);
      returnTo.searchParams.set("state", state);
      const realm = returnTo.origin;
      const u = new URL(STEAM_OPENID);
      u.search = new URLSearchParams({
        "openid.ns": "http://specs.openid.net/auth/2.0",
        "openid.mode": "checkid_setup",
        "openid.return_to": returnTo.toString(),
        "openid.realm": realm,
        "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
        "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
      }).toString();
      return u.toString();
    },
    async callback(params, flow) {
      if (params.get("openid.mode") !== "id_res") throw new ProblemError(400, "PROVIDER_DENIED");
      if (params.get("openid.op_endpoint") !== STEAM_OPENID) throw new ProblemError(400, "STEAM_OPENID_INVALID");
      const returnTo = params.get("openid.return_to") ?? "";
      if (!returnTo.startsWith(flow.redirect_uri)) throw new ProblemError(400, "STEAM_OPENID_INVALID");
      const claimed = params.get("openid.claimed_id") ?? "";
      const m = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claimed);
      if (!m) throw new ProblemError(400, "STEAM_OPENID_INVALID");
      const check = new URLSearchParams();
      for (const [k, v] of params) if (k.startsWith("openid.")) check.set(k, v);
      check.set("openid.mode", "check_authentication");
      const r = await fetch(STEAM_OPENID, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: check.toString(), signal: AbortSignal.timeout(10_000) });
      const text = await r.text();
      if (!/is_valid\s*:\s*true/.test(text)) throw new ProblemError(400, "STEAM_OPENID_INVALID");
      let display: string | null = null;
      const apiKey = ctx.config.features.auth.social.steam.api_key;
      if (apiKey) {
        try {
          const s = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${m[1]}`, { signal: AbortSignal.timeout(5000) });
          const j = (await s.json()) as { response?: { players?: { personaname?: string }[] } };
          display = j.response?.players?.[0]?.personaname ?? null;
        } catch {
          display = null;
        }
      }
      return { subject: m[1]!, email: null, email_verified: false, display_name: display, birthdate: null, data: {} };
    },
  };
}

export function enabledProviders(ctx: Ctx): Map<string, SocialProvider> {
  const social = ctx.config.features.auth.social;
  const out = new Map<string, SocialProvider>();
  if (social.google.enabled) {
    out.set(
      "google",
      oidcProvider({
        id: "google",
        name: "Google",
        icon: "google",
        identityType: "google",
        issuer: "https://accounts.google.com",
        clientId: social.google.client_id!,
        clientSecret: social.google.client_secret!,
        scopes: social.google.scopes ?? ["openid", "email", "profile"],
      }),
    );
  }
  if (social.github.enabled) out.set("github", github(ctx));
  if (social.discord.enabled) out.set("discord", discord(ctx));
  if (social.steam.enabled || ctx.config.features.games.steam.enabled) out.set("steam", steam(ctx));
  for (const p of social.generic_oidc) {
    if (!p.enabled) continue;
    out.set(
      `oidc:${p.id}`,
      oidcProvider({ id: `oidc:${p.id}`, name: p.name, icon: p.icon ?? null, identityType: `oidc:${p.id}`, issuer: p.issuer, clientId: p.client_id, clientSecret: p.client_secret, scopes: p.scopes }),
    );
  }
  return out;
}

export function loginProviders(ctx: Ctx): { id: string; name: string; icon: string | null }[] {
  const out = [];
  for (const p of enabledProviders(ctx).values()) {
    if (p.id === "steam" && !ctx.config.features.auth.social.steam.enabled) continue;
    out.push({ id: p.id, name: p.name, icon: p.icon });
  }
  return out;
}

export function callbackUri(ctx: Ctx, providerId: string): string {
  const s = ctx.surfaces.account;
  return s.origin + externalApiPath(s, `/api/v1/auth/social/${encodeURIComponent(providerId)}/callback`);
}
