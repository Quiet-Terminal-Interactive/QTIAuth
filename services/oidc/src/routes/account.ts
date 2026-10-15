import { z } from "zod";
import { ProblemError, hashToken, inc, randomToken, ulid } from "@qtiauth/common";
import { reply, route, type AnyRoute, zReason } from "@qtiauth/service-kit";
import { EVENTS } from "@qtiauth/bus";
import type { IdentityClaims } from "@qtiauth/auth-context";
import { getClient, hashSecret, iss, newClientSecret, revokeJtis, revokeRefresh, validateRedirectUri, type Ctx } from "../lib.ts";
import type { Client } from "../db.ts";

const account = { auth: "session" as const, module: "oidc" as const };

function scopeView(ctx: Ctx, scopes: string[]) {
  return scopes.map((s) => ({ scope: s, description: ctx.config.oidc.scopes[s]?.description ?? s, consent_text: ctx.config.oidc.scopes[s]?.consent_text ?? s }));
}

function clientView(c: Client) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    homepage_url: c.homepage_url,
    logo_url: c.logo_url,
    verified: c.verified || c.kind === "first_party",
    first_party: c.kind === "first_party",
    kind: c.kind,
  };
}

function acrOf(id: IdentityClaims): string {
  return id.aal >= 2 ? "aal2" : "aal1";
}

async function needsGuardian(ctx: Ctx, client: Client, id: IdentityClaims, scopes: string[]): Promise<boolean> {
  if (client.kind === "first_party") return false;
  const pc = id.parental_controls;
  if (!pc?.approve_third_party_apps) return false;
  const consent = await ctx.db.selectFrom("consents").selectAll().where("user_id", "=", id.sub!).where("client_id", "=", client.id).executeTakeFirst();
  return !(consent?.guardian_approved && scopes.every((s) => consent.scopes.includes(s)));
}

function redirectWith(uri: string, params: Record<string, string | null>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
}

async function filterName(ctx: Ctx, text: string, context: string): Promise<void> {
  const d = await ctx.rpc<{ action: string }>("identity.filter_text", { text, context });
  if (d.action === "block") throw new ProblemError(422, "TEXT_NOT_ALLOWED", undefined, { field: context });
}

const zClientInput = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(500).default(""),
  type: z.enum(["confidential", "public"]).default("confidential"),
  redirect_uris: z.array(z.string().max(2000)).max(20).default([]),
  post_logout_redirect_uris: z.array(z.string().max(2000)).max(20).default([]),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token", "client_credentials", "urn:ietf:params:oauth:grant-type:device_code"])).min(1).default(["authorization_code", "refresh_token"]),
  scopes: z.array(z.string().max(64)).max(30).default(["openid", "profile", "email", "offline_access"]),
  backchannel_logout_uri: z.url().nullable().optional(),
  backchannel_logout_session_required: z.boolean().default(false),
  require_par: z.boolean().default(false),
  homepage_url: z.url().nullable().optional(),
  logo_url: z.url().nullable().optional(),
});

export function accountRoutes(ctx: Ctx): AnyRoute[] {
  const cfg = ctx.config;
  const portal = cfg.features.oidc.developer_portal;

  async function loadRequest(requestId: string) {
    const ar = await ctx.db.selectFrom("authorization_requests").selectAll().where("id", "=", requestId).executeTakeFirst();
    if (!ar || ar.expires_at <= new Date()) throw new ProblemError(404, "AUTHORIZATION_REQUEST_EXPIRED");
    const client = await getClient(ctx.db, ar.client_id);
    if (!client || client.suspended_at) throw new ProblemError(400, "CLIENT_SUSPENDED");
    return { ar, client };
  }

  async function validateClientInput(input: z.output<typeof zClientInput>, id: IdentityClaims, verified: boolean): Promise<void> {
    for (const u of input.redirect_uris) validateRedirectUri(u);
    if (input.type === "public" && input.grant_types.includes("client_credentials")) throw new ProblemError(422, "PUBLIC_CLIENT_CREDENTIALS", "Public clients cannot use client credentials");
    for (const s of input.scopes) {
      const def = cfg.oidc.scopes[s];
      if (!def) throw new ProblemError(422, "UNKNOWN_SCOPE", undefined, { scope: s });
      if (def.hidden || def.game_client_only || def.service_only) throw new ProblemError(422, "SCOPE_NOT_SELF_SERVICE", undefined, { scope: s });
    }
    if (!verified && input.name.toLowerCase().includes(cfg.branding.product_name.toLowerCase())) throw new ProblemError(422, "NAME_USES_PRODUCT_NAME");
    await filterName(ctx, input.name, "oidc_client_name");
    if (input.description) await filterName(ctx, input.description, "oidc_client_description");
    if (id.age_band && id.age_band !== "adult") throw new ProblemError(403, "CHILD_ACCOUNTS_CANNOT_CREATE_CLIENTS");
  }

  return [
    route({
      method: "GET",
      path: "/api/v1/oauth/requests/:id",
      summary: "Authorization request for the consent screen",
      tags: ["oauth"],
      ...account,
      params: z.object({ id: z.string().max(64) }),
      async handler({ params, id }) {
        const { ar, client } = await loadRequest(params.id);
        const consent = await ctx.db.selectFrom("consents").selectAll().where("user_id", "=", id.sub!).where("client_id", "=", client.id).executeTakeFirst();
        const newScopes = ar.scopes.filter((s) => !consent?.scopes.includes(s));
        const forceConsent = (ar.prompt ?? "").includes("consent");
        const reauth = Boolean(ar.max_age !== null && id.auth_time && Date.now() / 1000 - id.auth_time > ar.max_age) || (ar.prompt ?? "").includes("login");
        return {
          id: ar.id,
          status: ar.status,
          client: clientView(client),
          scopes: scopeView(ctx, ar.scopes),
          new_scopes: newScopes,
          unverified: !client.verified && client.kind !== "first_party",
          skip_consent: !forceConsent && (client.kind === "first_party" || (newScopes.length === 0 && Boolean(consent))),
          requires_guardian: await needsGuardian(ctx, client, id, ar.scopes),
          reauth_required: reauth,
          prompt: ar.prompt,
          redirect_origin: new URL(ar.redirect_uri).origin,
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/oauth/requests/:id/decision",
      summary: "Approve or deny an authorization request",
      description: "On approval returns the redirect back to the app with a code. Child accounts whose guardian approves third-party apps get a pending guardian request instead.",
      tags: ["oauth"],
      ...account,
      rate_limit: ["account_write"],
      params: z.object({ id: z.string().max(64) }),
      body: z.object({ approve: z.boolean() }),
      async handler({ params, body, id }) {
        const { ar, client } = await loadRequest(params.id);
        if (ar.status === "completed" || ar.status === "denied") throw new ProblemError(409, "AUTHORIZATION_REQUEST_USED");
        if (!body.approve) {
          await ctx.db.updateTable("authorization_requests").set({ status: "denied", user_id: id.sub! }).where("id", "=", ar.id).execute();
          inc("qtiauth_oidc_authorizations_total", { stage: "denied" }, 1, "Authorization requests");
          return { redirect_to: redirectWith(ar.redirect_uri, { error: "access_denied", state: ar.state, iss: iss(cfg) }) };
        }
        if (await needsGuardian(ctx, client, id, ar.scopes)) {
          const r = await ctx.rpc<{ required: boolean; request_id?: string }>("identity.request_guardian_approval", {
            user_id: id.sub,
            type: "app_approval",
            data: { client_id: client.id, client_name: client.name, scopes: ar.scopes.join(" ") },
          });
          if (r.required) {
            await ctx.db.updateTable("authorization_requests").set({ status: "awaiting_guardian", user_id: id.sub!, guardian_request_id: r.request_id ?? null }).where("id", "=", ar.id).execute();
            inc("qtiauth_oidc_authorizations_total", { stage: "awaiting_guardian" }, 1, "Authorization requests");
            return reply(202, { status: "awaiting_guardian" });
          }
        }
        const code = randomToken(32);
        await ctx.db.transaction().execute(async (trx) => {
          if (client.kind !== "first_party") {
            const existing = await trx.selectFrom("consents").selectAll().where("user_id", "=", id.sub!).where("client_id", "=", client.id).executeTakeFirst();
            const scopes = [...new Set([...(existing?.scopes ?? []), ...ar.scopes])];
            await trx
              .insertInto("consents")
              .values({ user_id: id.sub!, client_id: client.id, scopes: JSON.stringify(scopes) })
              .onConflict((oc) => oc.columns(["user_id", "client_id"]).doUpdateSet({ scopes: JSON.stringify(scopes), updated_at: new Date() }))
              .execute();
            if (!existing) await ctx.emit(trx, EVENTS.oidcConsentGranted, { user_id: id.sub, client_id: client.id }, { actor: { type: "user", id: id.sub! }, subject: { type: "user", id: id.sub! } });
            if (!existing && id.age_band && id.age_band !== "adult") {
              const guardians = await ctx.rpcOptional<{ id: string; email: string }[]>("identity.resolve_guardians", { user_id: id.sub }, []);
              const child = guardians.length ? await ctx.rpcOptional<{ username: string | null } | null>("identity.get_user_summary", { user_id: id.sub }, null) : null;
              for (const g of guardians) {
                await ctx.email(trx, {
                  template: "guardian_app_connected",
                  to: { email: g.email, guardian_id: g.id },
                  vars: { child_name: child?.username ?? "Your child", client_name: client.name, scopes: ar.scopes.join(", "), dashboard_url: `${ctx.surfaces.account.url}/family` },
                  sender: "security",
                });
              }
            }
          }
          await trx
            .insertInto("auth_codes")
            .values({
              code_hash: hashToken(code),
              client_id: client.id,
              user_id: id.sub!,
              session_id: id.sid ?? null,
              redirect_uri: ar.redirect_uri,
              scopes: JSON.stringify(ar.scopes),
              nonce: ar.nonce,
              code_challenge: ar.code_challenge,
              auth_time: id.auth_time ?? null,
              acr: acrOf(id),
              amr: JSON.stringify(id.amr),
              expires_at: new Date(Date.now() + cfg.oidc.auth_code_ttl),
            })
            .execute();
          await trx.updateTable("authorization_requests").set({ status: "completed", user_id: id.sub! }).where("id", "=", ar.id).execute();
        });
        inc("qtiauth_oidc_authorizations_total", { stage: "approved", client_kind: client.kind }, 1, "Authorization requests");
        return { redirect_to: redirectWith(ar.redirect_uri, { code, state: ar.state, iss: iss(cfg) }) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/oauth/requests/:id/cancel",
      summary: "Return an error to the app",
      description: "Used for prompt=none when the user is not signed in (login_required), or when the user backs out.",
      tags: ["oauth"],
      auth: "none",
      session_optional: true,
      module: "oidc",
      rate_limit: ["account_write"],
      params: z.object({ id: z.string().max(64) }),
      body: z.object({ error: z.enum(["login_required", "consent_required", "access_denied", "interaction_required"]) }),
      async handler({ params, body }) {
        const { ar } = await loadRequest(params.id);
        if (ar.status === "completed") throw new ProblemError(409, "AUTHORIZATION_REQUEST_USED");
        await ctx.db.updateTable("authorization_requests").set({ status: "denied" }).where("id", "=", ar.id).execute();
        return { redirect_to: redirectWith(ar.redirect_uri, { error: body.error, state: ar.state, iss: iss(cfg) }) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/oauth/device/:user_code",
      summary: "Look up a device code to approve",
      tags: ["oauth"],
      ...account,
      rate_limit: ["oauth_device"],
      params: z.object({ user_code: z.string().max(16) }),
      async handler({ params }) {
        const code = params.user_code.toUpperCase().replace(/[^A-Z]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");
        const row = await ctx.db.selectFrom("device_codes").selectAll().where("user_code", "=", code).executeTakeFirst();
        if (!row || row.expires_at <= new Date() || row.status !== "pending") throw new ProblemError(404, "DEVICE_CODE_NOT_FOUND");
        const client = await getClient(ctx.db, row.client_id);
        if (!client) throw new ProblemError(404, "DEVICE_CODE_NOT_FOUND");
        return { user_code: code, client: clientView(client), scopes: scopeView(ctx, row.scopes), unverified: !client.verified && client.kind !== "first_party" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/oauth/device/:user_code/decision",
      summary: "Approve or deny a device sign-in",
      tags: ["oauth"],
      ...account,
      rate_limit: ["oauth_device"],
      params: z.object({ user_code: z.string().max(16) }),
      body: z.object({ approve: z.boolean() }),
      async handler({ params, body, id }) {
        const code = params.user_code.toUpperCase().replace(/[^A-Z]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");
        const row = await ctx.db.selectFrom("device_codes").selectAll().where("user_code", "=", code).executeTakeFirst();
        if (!row || row.expires_at <= new Date() || row.status !== "pending") throw new ProblemError(404, "DEVICE_CODE_NOT_FOUND");
        const client = await getClient(ctx.db, row.client_id);
        if (!client) throw new ProblemError(404, "DEVICE_CODE_NOT_FOUND");
        if (body.approve && (await needsGuardian(ctx, client, id, row.scopes))) {
          const r = await ctx.rpc<{ required: boolean }>("identity.request_guardian_approval", { user_id: id.sub, type: "app_approval", data: { client_id: client.id, client_name: client.name, scopes: row.scopes.join(" ") } });
          if (r.required) return reply(202, { status: "awaiting_guardian" });
        }
        await ctx.db
          .updateTable("device_codes")
          .set(body.approve ? { status: "approved", user_id: id.sub!, session_id: id.sid ?? null, auth_time: id.auth_time ?? null, acr: acrOf(id), amr: JSON.stringify(id.amr) } : { status: "denied", user_id: id.sub! })
          .where("id", "=", row.id)
          .execute();
        inc("qtiauth_oidc_device_approvals_total", { result: body.approve ? "approved" : "denied" }, 1, "Device flow approvals");
        return { status: body.approve ? "approved" : "denied" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/me/apps",
      summary: "Apps you have authorized",
      tags: ["apps"],
      ...account,
      allow_pending_legal: true,
      async handler({ id }) {
        const rows = await ctx.db
          .selectFrom("consents")
          .innerJoin("clients", "clients.id", "consents.client_id")
          .selectAll("consents")
          .select(["clients.name", "clients.verified", "clients.kind", "clients.homepage_url", "clients.logo_url"])
          .where("consents.user_id", "=", id.sub!)
          .orderBy("consents.updated_at", "desc")
          .execute();
        return {
          items: rows.map((r) => ({
            client_id: r.client_id,
            name: r.name,
            verified: r.verified,
            homepage_url: r.homepage_url,
            logo_url: r.logo_url,
            scopes: scopeView(ctx, r.scopes),
            granted_at: r.granted_at.toISOString(),
            last_used_at: r.last_used_at?.toISOString() ?? null,
            guardian_approved: r.guardian_approved,
          })),
        };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/me/apps/:client_id",
      summary: "Revoke an app's access",
      tags: ["apps"],
      ...account,
      allow_pending_legal: true,
      rate_limit: ["account_write"],
      params: z.object({ client_id: z.string().max(128) }),
      async handler({ params, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          await trx.deleteFrom("consents").where("user_id", "=", id.sub!).where("client_id", "=", params.client_id).execute();
          await revokeRefresh(trx, { user_id: id.sub!, client_id: params.client_id, include_offline: true }, "user_revoked_app");
          await revokeJtis(ctx, trx, { user_id: id.sub!, client_id: params.client_id }, "user_revoked_app");
          await ctx.audit(trx, { actor: { type: "user", id: id.sub! }, action: "oidc.app_revoked", target: { type: "client", id: params.client_id } });
        });
        return { status: "revoked" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/developer/clients",
      summary: "Your OAuth clients",
      tags: ["developer"],
      ...account,
      rate_limit: ["developer"],
      async handler({ id }) {
        if (!portal.enabled) throw new ProblemError(404, "FEATURE_DISABLED");
        const rows = await ctx.db.selectFrom("clients").selectAll().where("owner_user_id", "=", id.sub!).where("deleted_at", "is", null).orderBy("created_at").execute();
        return { items: rows.map(ownerView), max_clients: portal.max_clients_per_user };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/developer/clients",
      summary: "Create an OAuth client",
      description: "Works immediately. Unverified clients show an 'Unverified app' notice on the consent screen. The secret is returned once.",
      tags: ["developer"],
      ...account,
      rate_limit: ["developer"],
      body: zClientInput,
      async handler({ body, id }) {
        if (!portal.enabled) throw new ProblemError(404, "FEATURE_DISABLED");
        await validateClientInput(body, id, false);
        const count = await ctx.db.selectFrom("clients").select(ctx.db.fn.countAll<number>().as("n")).where("owner_user_id", "=", id.sub!).where("deleted_at", "is", null).executeTakeFirst();
        if (Number(count?.n ?? 0) >= portal.max_clients_per_user) throw new ProblemError(409, "CLIENT_LIMIT_REACHED");
        const clientId = `c_${ulid().toLowerCase()}`;
        const secret = body.type === "confidential" ? newClientSecret() : null;
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .insertInto("clients")
            .values({
              id: clientId,
              name: body.name,
              description: body.description,
              type: body.type,
              kind: "third_party",
              secret_hash: secret ? hashSecret(secret) : null,
              owner_user_id: id.sub!,
              redirect_uris: JSON.stringify(body.redirect_uris),
              post_logout_redirect_uris: JSON.stringify(body.post_logout_redirect_uris),
              grant_types: JSON.stringify(body.grant_types),
              scopes: JSON.stringify(body.scopes),
              backchannel_logout_uri: body.backchannel_logout_uri ?? null,
              backchannel_logout_session_required: body.backchannel_logout_session_required,
              require_par: body.require_par,
              homepage_url: body.homepage_url ?? null,
              logo_url: body.logo_url ?? null,
            })
            .execute();
          await ctx.emit(trx, EVENTS.oidcClientCreated, { client_id: clientId, user_id: id.sub }, { actor: { type: "user", id: id.sub! }, subject: { type: "client", id: clientId } });
          await ctx.audit(trx, { actor: { type: "user", id: id.sub! }, action: "oidc.client_created", target: { type: "client", id: clientId } });
        });
        return reply(201, { client_id: clientId, client_secret: secret });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/developer/clients/:id",
      summary: "One of your OAuth clients",
      tags: ["developer"],
      ...account,
      rate_limit: ["developer"],
      params: z.object({ id: z.string().max(128) }),
      async handler({ params, id }) {
        const c = await ownedClient(ctx, params.id, id.sub!);
        const deliveries = await ctx.db.selectFrom("backchannel_deliveries").selectAll().where("client_id", "=", c.id).orderBy("created_at", "desc").limit(50).execute();
        return {
          ...ownerView(c),
          backchannel_deliveries: deliveries.map((d) => ({ ...d, created_at: d.created_at.toISOString(), completed_at: d.completed_at?.toISOString() ?? null, next_attempt_at: d.next_attempt_at?.toISOString() ?? null })),
        };
      },
    }),

    route({
      method: "PATCH",
      path: "/api/v1/developer/clients/:id",
      summary: "Update one of your OAuth clients",
      tags: ["developer"],
      ...account,
      rate_limit: ["developer"],
      params: z.object({ id: z.string().max(128) }),
      body: zClientInput.partial(),
      async handler({ params, body, id }) {
        const c = await ownedClient(ctx, params.id, id.sub!);
        const merged = zClientInput.parse({ ...ownerView(c), type: c.type, ...body });
        await validateClientInput(merged, id, c.verified);
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .updateTable("clients")
            .set({
              name: merged.name,
              description: merged.description,
              redirect_uris: JSON.stringify(merged.redirect_uris),
              post_logout_redirect_uris: JSON.stringify(merged.post_logout_redirect_uris),
              grant_types: JSON.stringify(merged.grant_types),
              scopes: JSON.stringify(merged.scopes),
              backchannel_logout_uri: merged.backchannel_logout_uri ?? null,
              backchannel_logout_session_required: merged.backchannel_logout_session_required,
              require_par: merged.require_par,
              homepage_url: merged.homepage_url ?? null,
              logo_url: merged.logo_url ?? null,
              updated_at: new Date(),
              ...(merged.name !== c.name && c.verified ? { verified: false } : {}),
            })
            .where("id", "=", c.id)
            .execute();
          await ctx.audit(trx, { actor: { type: "user", id: id.sub! }, action: "oidc.client_updated", target: { type: "client", id: c.id } });
        });
        return { status: "updated" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/developer/clients/:id/secret",
      summary: "Regenerate the client secret",
      description: "Requires step-up. The old secret stops working immediately.",
      tags: ["developer"],
      ...account,
      step_up: true,
      rate_limit: ["developer"],
      params: z.object({ id: z.string().max(128) }),
      async handler({ params, id }) {
        const c = await ownedClient(ctx, params.id, id.sub!);
        if (c.type !== "confidential") throw new ProblemError(409, "PUBLIC_CLIENT_HAS_NO_SECRET");
        const secret = newClientSecret();
        await ctx.db.transaction().execute(async (trx) => {
          await trx.updateTable("clients").set({ secret_hash: hashSecret(secret), updated_at: new Date() }).where("id", "=", c.id).execute();
          await ctx.audit(trx, { actor: { type: "user", id: id.sub! }, action: "oidc.client_secret_regenerated", target: { type: "client", id: c.id } });
        });
        return { client_secret: secret };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/developer/clients/:id",
      summary: "Delete one of your OAuth clients",
      tags: ["developer"],
      ...account,
      rate_limit: ["developer"],
      params: z.object({ id: z.string().max(128) }),
      async handler({ params, id }) {
        const c = await ownedClient(ctx, params.id, id.sub!);
        await ctx.db.transaction().execute(async (trx) => {
          await trx.updateTable("clients").set({ deleted_at: new Date(), secret_hash: null }).where("id", "=", c.id).execute();
          await trx.deleteFrom("consents").where("client_id", "=", c.id).execute();
          await revokeRefresh(trx, { client_id: c.id, include_offline: true }, "client_deleted");
          await revokeJtis(ctx, trx, { client_id: c.id }, "client_deleted");
          await ctx.audit(trx, { actor: { type: "user", id: id.sub! }, action: "oidc.client_deleted", target: { type: "client", id: c.id } });
        });
        return { status: "deleted" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/oidc/clients",
      summary: "All OAuth clients",
      tags: ["admin"],
      auth: "session",
      module: "admin",
      permissions: ["oidc.clients.read"],
      rate_limit: ["admin"],
      query: z.object({ q: z.string().max(100).optional(), kind: z.enum(["first_party", "third_party", "game", "game_server"]).optional(), suspended: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
      async handler({ query }) {
        let q = ctx.db.selectFrom("clients").selectAll().where("deleted_at", "is", null);
        if (query.q) q = q.where((eb) => eb.or([eb("name", "ilike", `%${query.q!.replace(/[%_\\]/g, "\\$&")}%`), eb("id", "=", query.q!)]));
        if (query.kind) q = q.where("kind", "=", query.kind);
        if (query.suspended !== undefined) q = q.where("suspended_at", query.suspended ? "is not" : "is", null);
        const rows = await q.orderBy("created_at", "desc").limit(query.limit).execute();
        return { items: rows.map((c) => ({ ...ownerView(c), owner_user_id: c.owner_user_id, suspended_reason: c.suspended_reason })) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/oidc/clients/:id/suspend",
      summary: "Suspend a client",
      description: "Revokes all its tokens and blocks new authorizations.",
      tags: ["admin"],
      auth: "session",
      module: "admin",
      permissions: ["oidc.clients.suspend"],
      step_up: true,
      rate_limit: ["admin"],
      params: z.object({ id: z.string().max(128) }),
      body: z.object({ reason: zReason }),
      async handler({ params, body, id }) {
        const c = await getClient(ctx.db, params.id);
        if (!c) throw new ProblemError(404, "CLIENT_NOT_FOUND");
        await ctx.db.transaction().execute(async (trx) => {
          await trx.updateTable("clients").set({ suspended_at: new Date(), suspended_reason: body.reason, updated_at: new Date() }).where("id", "=", c.id).execute();
          await revokeRefresh(trx, { client_id: c.id, include_offline: true }, "client_suspended");
          await revokeJtis(ctx, trx, { client_id: c.id }, "client_suspended");
          await ctx.emit(trx, EVENTS.oidcClientSuspended, { client_id: c.id, suspended: true }, { actor: { type: "staff", id: id.sub! }, subject: { type: "client", id: c.id } });
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "oidc.client_suspended", target: { type: "client", id: c.id }, reason: body.reason, ip: id.ip });
          if (c.owner_user_id) await ctx.email(trx, { template: "client_suspended", to: { user_id: c.owner_user_id }, vars: { client_name: c.name, reason: body.reason }, sender: "security" });
        });
        return { status: "suspended" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/oidc/clients/:id/unsuspend",
      summary: "Lift a client suspension",
      tags: ["admin"],
      auth: "session",
      module: "admin",
      permissions: ["oidc.clients.suspend"],
      step_up: true,
      rate_limit: ["admin"],
      params: z.object({ id: z.string().max(128) }),
      body: z.object({ reason: zReason }),
      async handler({ params, body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const r = await trx.updateTable("clients").set({ suspended_at: null, suspended_reason: null, updated_at: new Date() }).where("id", "=", params.id).executeTakeFirst();
          if (!Number(r.numUpdatedRows)) throw new ProblemError(404, "CLIENT_NOT_FOUND");
          await ctx.emit(trx, EVENTS.oidcClientSuspended, { client_id: params.id, suspended: false }, { actor: { type: "staff", id: id.sub! }, subject: { type: "client", id: params.id } });
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "oidc.client_unsuspended", target: { type: "client", id: params.id }, reason: body.reason, ip: id.ip });
        });
        return { status: "active" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/oidc/clients/:id/verification",
      summary: "Mark a client as verified or unverified",
      description: "Verification is a badge on the consent screen, not a gate.",
      tags: ["admin"],
      auth: "session",
      module: "admin",
      permissions: ["oidc.clients.verify"],
      step_up: true,
      rate_limit: ["admin"],
      params: z.object({ id: z.string().max(128) }),
      body: z.object({ verified: z.boolean(), reason: zReason }),
      async handler({ params, body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const r = await trx.updateTable("clients").set({ verified: body.verified, updated_at: new Date() }).where("id", "=", params.id).executeTakeFirst();
          if (!Number(r.numUpdatedRows)) throw new ProblemError(404, "CLIENT_NOT_FOUND");
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: body.verified ? "oidc.client_verified" : "oidc.client_unverified", target: { type: "client", id: params.id }, reason: body.reason, ip: id.ip });
        });
        return { status: "updated" };
      },
    }),

    route({
      method: "PUT",
      path: "/api/v1/admin/oidc/clients/:id/scopes",
      summary: "Set the scopes a client may request",
      description: "Lets staff grant service scopes such as games.entitlements.write to an external payment system's client.",
      tags: ["admin"],
      auth: "session",
      module: "admin",
      permissions: ["oidc.clients.verify"],
      step_up: true,
      rate_limit: ["admin"],
      params: z.object({ id: z.string().max(128) }),
      body: z.object({ scopes: z.array(z.string().max(64)).max(50), grant_types: z.array(z.string().max(80)).optional(), reason: zReason }),
      async handler({ params, body, id }) {
        for (const s of body.scopes) if (!cfg.oidc.scopes[s]) throw new ProblemError(422, "UNKNOWN_SCOPE", undefined, { scope: s });
        await ctx.db.transaction().execute(async (trx) => {
          const r = await trx
            .updateTable("clients")
            .set({ scopes: JSON.stringify(body.scopes), ...(body.grant_types ? { grant_types: JSON.stringify(body.grant_types) } : {}), updated_at: new Date() })
            .where("id", "=", params.id)
            .executeTakeFirst();
          if (!Number(r.numUpdatedRows)) throw new ProblemError(404, "CLIENT_NOT_FOUND");
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "oidc.client_scopes_changed", target: { type: "client", id: params.id }, reason: body.reason, ip: id.ip, data: { scopes: body.scopes } });
        });
        return { status: "updated" };
      },
    }),
  ];
}

function ownerView(c: Client) {
  return {
    client_id: c.id,
    name: c.name,
    description: c.description,
    type: c.type,
    kind: c.kind,
    redirect_uris: c.redirect_uris,
    post_logout_redirect_uris: c.post_logout_redirect_uris,
    grant_types: c.grant_types,
    scopes: c.scopes,
    backchannel_logout_uri: c.backchannel_logout_uri,
    backchannel_logout_session_required: c.backchannel_logout_session_required,
    require_par: c.require_par,
    homepage_url: c.homepage_url,
    logo_url: c.logo_url,
    verified: c.verified,
    suspended: Boolean(c.suspended_at),
    created_at: c.created_at.toISOString(),
  };
}

async function ownedClient(ctx: Ctx, clientId: string, userId: string): Promise<Client> {
  const c = await getClient(ctx.db, clientId);
  if (!c || c.owner_user_id !== userId) throw new ProblemError(404, "CLIENT_NOT_FOUND");
  return c;
}
