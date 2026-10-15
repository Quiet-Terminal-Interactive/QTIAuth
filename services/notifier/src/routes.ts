import { z } from "zod";
import type { Selectable } from "kysely";
import { ProblemError, assertPublicUrl, decodeCursor, encodeCursor, inc, safeEqual, ulid } from "@qtiauth/common";
import { route, reply, type AnyRoute, type ServiceContext, zReason } from "@qtiauth/service-kit";
import { makeEvent } from "@qtiauth/bus";
import type { NotifierDB } from "./db.ts";
import { deliver, encryptSecret, minimisePayload, newSecret, WEBHOOK_EVENTS } from "./webhooks.ts";
import { emailHash } from "./email.ts";
import { parseProviderEvents } from "./providers/index.ts";
import type { TemplateStore } from "./templates.ts";

type Ctx = ServiceContext<NotifierDB>;

const admin = (step = false) => ({ auth: "session" as const, module: "admin" as const, permissions: ["webhooks.manage"], rate_limit: ["admin"], step_up: step });
const zEvents = z.array(z.string().regex(/^(qtiauth\.)?[a-z_*>]+(\.[a-z_*>]+)*(\.v\d+)?$/)).min(1).max(50);

function endpointView(e: Selectable<NotifierDB["webhook_endpoints"]>) {
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    events: e.events,
    format: e.format,
    enabled: e.enabled,
    disabled_reason: e.disabled_reason,
    consecutive_failures: e.consecutive_failures,
    seeded: e.seeded,
    secret_rotation_ends_at: e.previous_secret_expires_at?.toISOString() ?? null,
    created_at: e.created_at.toISOString(),
    updated_at: e.updated_at.toISOString(),
  };
}

async function checkUrl(ctx: Ctx, url: string): Promise<void> {
  try {
    await assertPublicUrl(url, ctx.config.webhooks.allow_private_targets);
  } catch (err) {
    throw new ProblemError(422, "WEBHOOK_URL_NOT_ALLOWED", (err as Error).message);
  }
}

export function notifierRoutes(ctx: Ctx, templates: TemplateStore): AnyRoute[] {
  const tags = ["webhooks"];
  return [
    route({
      method: "GET",
      path: "/api/v1/admin/webhooks",
      summary: "Webhook endpoints",
      tags,
      ...admin(),
      async handler() {
        const rows = await ctx.db.selectFrom("webhook_endpoints").selectAll().orderBy("created_at").execute();
        return { items: rows.map(endpointView), available_events: WEBHOOK_EVENTS.map((e) => e.replace(/^qtiauth\./, "").replace(/\.v\d+$/, "")) };
      },
    }),
    route({
      method: "POST",
      path: "/api/v1/admin/webhooks",
      summary: "Create a webhook endpoint",
      description: "Returns the signing secret once. Private, loopback and link-local targets are refused unless webhooks.allow_private_targets is true.",
      tags,
      ...admin(true),
      body: z.object({ url: z.url(), description: z.string().max(200).default(""), events: zEvents, format: z.enum(["standard", "discord", "slack"]).default("standard") }),
      async handler({ body, id }) {
        await checkUrl(ctx, body.url);
        const eid = `wh_${ulid().toLowerCase()}`;
        const secret = newSecret();
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .insertInto("webhook_endpoints")
            .values({ id: eid, url: body.url, description: body.description, events: JSON.stringify(body.events), format: body.format, secret_enc: encryptSecret(ctx, eid, secret), enabled: true, seeded: false, created_by: id.sub ?? null })
            .execute();
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "webhook.endpoint_created", target: { type: "webhook_endpoint", id: eid }, ip: id.ip, data: { events: body.events, format: body.format } });
        });
        return reply(201, { id: eid, secret });
      },
    }),
    route({
      method: "PATCH",
      path: "/api/v1/admin/webhooks/:id",
      summary: "Update a webhook endpoint",
      tags,
      ...admin(true),
      params: z.object({ id: z.string().max(64) }),
      body: z.object({ url: z.url().optional(), description: z.string().max(200).optional(), events: zEvents.optional(), format: z.enum(["standard", "discord", "slack"]).optional(), enabled: z.boolean().optional() }),
      async handler({ params, body, id }) {
        if (body.url) await checkUrl(ctx, body.url);
        await ctx.db.transaction().execute(async (trx) => {
          const r = await trx
            .updateTable("webhook_endpoints")
            .set({
              ...(body.url ? { url: body.url } : {}),
              ...(body.description !== undefined ? { description: body.description } : {}),
              ...(body.events ? { events: JSON.stringify(body.events) } : {}),
              ...(body.format ? { format: body.format } : {}),
              ...(body.enabled !== undefined ? { enabled: body.enabled, disabled_reason: body.enabled ? null : "Disabled by staff", consecutive_failures: 0 } : {}),
              updated_at: new Date(),
            })
            .where("id", "=", params.id)
            .executeTakeFirst();
          if (!Number(r.numUpdatedRows)) throw new ProblemError(404, "ENDPOINT_NOT_FOUND");
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "webhook.endpoint_updated", target: { type: "webhook_endpoint", id: params.id }, ip: id.ip, data: { ...body } });
        });
        return { status: "updated" };
      },
    }),
    route({
      method: "DELETE",
      path: "/api/v1/admin/webhooks/:id",
      summary: "Delete a webhook endpoint",
      tags,
      ...admin(true),
      params: z.object({ id: z.string().max(64) }),
      async handler({ params, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          const r = await trx.deleteFrom("webhook_endpoints").where("id", "=", params.id).executeTakeFirst();
          if (!Number(r.numDeletedRows)) throw new ProblemError(404, "ENDPOINT_NOT_FOUND");
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "webhook.endpoint_deleted", target: { type: "webhook_endpoint", id: params.id }, ip: id.ip });
        });
        return { status: "deleted" };
      },
    }),
    route({
      method: "POST",
      path: "/api/v1/admin/webhooks/:id/rotate-secret",
      summary: "Rotate the signing secret",
      description: "Both the old and new secrets sign deliveries until the overlap window (webhooks.secret_overlap) ends.",
      tags,
      ...admin(true),
      params: z.object({ id: z.string().max(64) }),
      async handler({ params, id }) {
        const e = await ctx.db.selectFrom("webhook_endpoints").selectAll().where("id", "=", params.id).executeTakeFirst();
        if (!e) throw new ProblemError(404, "ENDPOINT_NOT_FOUND");
        const secret = newSecret();
        const until = new Date(Date.now() + ctx.config.webhooks.secret_overlap);
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .updateTable("webhook_endpoints")
            .set({ secret_enc: encryptSecret(ctx, e.id, secret), previous_secret_enc: e.secret_enc, previous_secret_expires_at: until, updated_at: new Date() })
            .where("id", "=", e.id)
            .execute();
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "webhook.secret_rotated", target: { type: "webhook_endpoint", id: e.id }, ip: id.ip });
        });
        return { secret, previous_valid_until: until.toISOString() };
      },
    }),
    route({
      method: "POST",
      path: "/api/v1/admin/webhooks/:id/test",
      summary: "Send a test event",
      tags,
      ...admin(),
      params: z.object({ id: z.string().max(64) }),
      async handler({ params, id }) {
        const e = await ctx.db.selectFrom("webhook_endpoints").select("id").where("id", "=", params.id).executeTakeFirst();
        if (!e) throw new ProblemError(404, "ENDPOINT_NOT_FOUND");
        const env = makeEvent("qtiauth.notifier.webhook.test.v1", { status: "test" }, { subject: { type: "webhook_endpoint", id: e.id }, actor: { type: "staff", id: id.sub! } });
        const deliveryId = ulid();
        await ctx.db
          .insertInto("webhook_deliveries")
          .values({ id: deliveryId, endpoint_id: e.id, event_id: env.event_id, event_type: "notifier.webhook.test", payload: JSON.stringify(minimisePayload(ctx, env as never)), status: "pending", next_attempt_at: new Date(), replay_of: "test" })
          .execute();
        const status = await deliver(ctx, deliveryId);
        const d = await ctx.db.selectFrom("webhook_deliveries").select(["last_status_code", "error", "duration_ms"]).where("id", "=", deliveryId).executeTakeFirst();
        return { delivery_id: deliveryId, status, status_code: d?.last_status_code ?? null, error: d?.error ?? null, duration_ms: d?.duration_ms ?? null };
      },
    }),
    route({
      method: "GET",
      path: "/api/v1/admin/webhooks/:id/deliveries",
      summary: "Delivery log for an endpoint",
      tags,
      ...admin(),
      params: z.object({ id: z.string().max(64) }),
      query: z.object({ status: z.enum(["pending", "retrying", "success", "failed"]).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      async handler({ params, query }) {
        let q = ctx.db.selectFrom("webhook_deliveries").selectAll().where("endpoint_id", "=", params.id);
        if (query.status) q = q.where("status", "=", query.status);
        const cur = decodeCursor<{ id: string }>(query.cursor);
        if (cur) q = q.where("id", "<", cur.id);
        const rows = await q.orderBy("id", "desc").limit(query.limit + 1).execute();
        const items = rows.slice(0, query.limit);
        return {
          items: items.map((d) => ({ ...d, created_at: d.created_at.toISOString(), completed_at: d.completed_at?.toISOString() ?? null, next_attempt_at: d.next_attempt_at?.toISOString() ?? null })),
          next_cursor: rows.length > query.limit ? encodeCursor({ id: items[items.length - 1]!.id }) : null,
        };
      },
    }),
    route({
      method: "POST",
      path: "/api/v1/admin/webhooks/deliveries/:id/replay",
      summary: "Replay a delivery",
      tags,
      ...admin(),
      params: z.object({ id: z.string().max(64) }),
      async handler({ params, id }) {
        const d = await ctx.db.selectFrom("webhook_deliveries").selectAll().where("id", "=", params.id).executeTakeFirst();
        if (!d) throw new ProblemError(404, "DELIVERY_NOT_FOUND");
        const newId = ulid();
        await ctx.db
          .insertInto("webhook_deliveries")
          .values({ id: newId, endpoint_id: d.endpoint_id, event_id: d.event_id, event_type: d.event_type, payload: JSON.stringify(d.payload), status: "pending", next_attempt_at: new Date(), replay_of: d.id })
          .execute();
        await ctx.db.transaction().execute((trx) => ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "webhook.delivery_replayed", target: { type: "webhook_delivery", id: d.id }, ip: id.ip }));
        return { delivery_id: newId, status: await deliver(ctx, newId) };
      },
    }),
    route({
      method: "GET",
      path: "/api/v1/admin/email/deliveries",
      summary: "Email delivery log",
      tags: ["email"],
      auth: "session",
      module: "admin",
      permissions: ["email.logs.read"],
      rate_limit: ["admin"],
      query: z.object({ email: z.string().max(254).optional(), user_id: z.uuid().optional(), template: z.string().max(64).optional(), status: z.string().max(32).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
      async handler({ query }) {
        let q = ctx.db.selectFrom("email_deliveries").select(["id", "template", "sender", "user_id", "priority", "status", "provider", "provider_message_id", "attempts", "last_error", "created_at", "sent_at"]);
        if (query.email) q = q.where("to_hash", "=", emailHash(query.email));
        if (query.user_id) q = q.where("user_id", "=", query.user_id);
        if (query.template) q = q.where("template", "=", query.template);
        if (query.status) q = q.where("status", "=", query.status as never);
        const rows = await q.orderBy("created_at", "desc").limit(query.limit).execute();
        return { items: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString(), sent_at: r.sent_at?.toISOString() ?? null })), templates: templates.names() };
      },
    }),
    route({
      method: "GET",
      path: "/api/v1/admin/email/suppressions",
      summary: "Look up whether an address is suppressed",
      tags: ["email"],
      auth: "session",
      module: "admin",
      permissions: ["email.logs.read"],
      rate_limit: ["admin"],
      query: z.object({ email: z.email() }),
      async handler({ query }) {
        const s = await ctx.db.selectFrom("suppressions").selectAll().where("email_hash", "=", emailHash(query.email)).executeTakeFirst();
        return { suppressed: Boolean(s), reason: s?.reason ?? null, since: s?.created_at.toISOString() ?? null };
      },
    }),
    route({
      method: "DELETE",
      path: "/api/v1/admin/email/suppressions",
      summary: "Remove an address from the suppression list",
      tags: ["email"],
      auth: "session",
      module: "admin",
      permissions: ["email.suppressions.manage"],
      rate_limit: ["admin"],
      step_up: true,
      body: z.object({ email: z.email(), reason: zReason }),
      async handler({ body, id }) {
        await ctx.db.transaction().execute(async (trx) => {
          await trx.deleteFrom("suppressions").where("email_hash", "=", emailHash(body.email)).execute();
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "email.suppression_removed", target: { type: "email", id: emailHash(body.email) }, reason: body.reason, ip: id.ip });
        });
        return { status: "removed" };
      },
    }),
    route({
      method: "POST",
      path: "/api/v1/notifier/providers/:provider/events",
      summary: "Bounce and complaint webhooks from the email provider",
      description: "Authenticated with email.webhook_secret, sent as the `secret` query parameter or the X-QTIAuth-Webhook-Secret header. Hard bounces and complaints suppress the address.",
      tags: ["email"],
      auth: "none",
      module: "core",
      rate_limit: ["intake"],
      csrf: false,
      body_limit: 2_000_000,
      raw_body: true,
      params: z.object({ provider: z.enum(["postmark", "brevo", "resend", "mailgun", "ses"]) }),
      async handler({ params, raw, c }) {
        const secret = ctx.config.email.webhook_secret;
        const given = c.req.query("secret") ?? c.req.header("x-qtiauth-webhook-secret") ?? "";
        if (!secret || !safeEqual(secret, given)) throw new ProblemError(401, "INVALID_WEBHOOK_SECRET");
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array()));
        } catch {
          throw new ProblemError(400, "INVALID_JSON");
        }
        const b = body as Record<string, unknown>;
        if (params.provider === "ses" && b.Type === "SubscriptionConfirmation" && typeof b.SubscribeURL === "string" && /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//.test(b.SubscribeURL)) {
          await fetch(b.SubscribeURL).catch(() => undefined);
          return { status: "subscribed" };
        }
        const events = parseProviderEvents(params.provider, body);
        for (const e of events) {
          if (e.provider_message_id) {
            const status = e.kind === "hard_bounce" || e.kind === "soft_bounce" ? "bounced" : e.kind === "complaint" ? "complained" : "delivered";
            await ctx.db.updateTable("email_deliveries").set({ status }).where("provider_message_id", "=", e.provider_message_id).execute();
          }
          if (e.kind === "hard_bounce" || e.kind === "complaint") {
            await ctx.db
              .insertInto("suppressions")
              .values({ email_hash: emailHash(e.email), reason: e.kind, source: params.provider })
              .onConflict((oc) => oc.column("email_hash").doNothing())
              .execute();
            inc("qtiauth_email_suppressions_total", { reason: e.kind }, 1, "Addresses suppressed");
          }
          if (e.kind !== "delivered") inc("qtiauth_email_bounces_total", { kind: e.kind, provider: params.provider }, 1, "Bounces and complaints");
        }
        return { processed: events.length };
      },
    }),
  ];
}
