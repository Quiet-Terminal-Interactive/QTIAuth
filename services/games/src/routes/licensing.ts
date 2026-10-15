import { z } from "zod";
import { ProblemError } from "@qtiauth/common";
import { reply, route, type AnyRoute, zSlug } from "@qtiauth/service-kit";
import { playerRead, requireGame, type Ctx } from "../lib/core.ts";
import { issueLease, licensingKeys, signedRevocations, verifyLease } from "../lib/licensing.ts";

const tags = ["games", "licensing"];

export function licensingRoutes(ctx: Ctx): AnyRoute[] {
  const enabled = ctx.config.features.games.licensing.enabled;
  const requireLicensing = () => {
    if (!enabled) throw new ProblemError(404, "LICENSING_DISABLED");
  };

  return [
    route({
      method: "POST",
      path: "/api/v1/games/:slug/license",
      summary: "Issue a signed offline lease",
      description: "The lease lists every owned product for the game and can be verified offline against /.well-known/qtiauth-license-keys.json. Games with device binding need a stable client-generated device_id.",
      tags,
      auth: ["session", "oauth"],
      scopes: ["games"],
      rate_limit: ["game_write"],
      params: z.object({ slug: zSlug }),
      body: z.object({ device_id: z.string().min(8).max(200).optional(), device_name: z.string().trim().max(100).optional() }),
      async handler({ params, body, id }) {
        requireLicensing();
        const g = await requireGame(ctx.db, params.slug);
        if (id.auth === "oauth" && id.game_id && id.game_id !== g.id) throw new ProblemError(403, "WRONG_GAME");
        return issueLease(ctx, g, playerRead(id), body.device_id ?? null, body.device_name ?? null);
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/games/licensing/verify",
      summary: "Verify a lease online",
      description: "For game servers that prefer an online check. No credentials needed.",
      tags,
      auth: "none",
      rate_limit: ["license_verify"],
      body: z.object({ lease: z.string().min(20).max(8000) }),
      async handler({ body }) {
        requireLicensing();
        const r = await verifyLease(ctx, body.lease);
        return {
          valid: r.valid,
          reason: r.reason ?? null,
          ...(r.claims ? { user_id: r.claims.sub, game: r.claims.game, products: r.claims.products, jti: r.claims.jti, expires_at: r.claims.exp ? new Date(r.claims.exp * 1000).toISOString() : null } : {}),
        };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/games/licensing/revocations",
      summary: "Signed list of revoked leases",
      description: "For occasionally-online servers. The token is signed with the licensing key and lists revocations after `since` (unix seconds) for leases that haven't expired yet.",
      tags,
      auth: "none",
      rate_limit: ["license_verify"],
      query: z.object({ since: z.coerce.number().int().min(0).default(0) }),
      async handler({ query }) {
        requireLicensing();
        return { token: await signedRevocations(ctx, new Date(query.since * 1000)) };
      },
    }),

    route({
      method: "GET",
      path: "/.well-known/qtiauth-license-keys.json",
      summary: "Public keys for verifying leases offline",
      tags,
      auth: "none",
      mount: "root",
      csrf: false,
      rate_limit: ["public_read"],
      async handler() {
        requireLicensing();
        return reply(200, await licensingKeys(ctx).jwks(), { "cache-control": "public, max-age=3600" });
      },
    }),
  ];
}
