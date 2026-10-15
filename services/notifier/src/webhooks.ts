import { createHmac, randomBytes } from "node:crypto";
import { sql, type Selectable } from "kysely";
import { decodeKey, decrypt, deriveSubkey, encrypt, fetchPinned, inc, observe, ulid, ProblemError } from "@qtiauth/common";
import { eventWildcardMatches, shortEventType, EVENTS, type EventEnvelope } from "@qtiauth/bus";
import { surfaceUrl } from "@qtiauth/config";
import type { ServiceContext } from "@qtiauth/service-kit";
import type { NotifierDB } from "./db.ts";

type Ctx = ServiceContext<NotifierDB>;
type Endpoint = Selectable<NotifierDB["webhook_endpoints"]>;

export const WEBHOOK_EVENTS = [
  EVENTS.safetyReportCreated,
  EVENTS.safetyReportActioned,
  EVENTS.safetyReportDismissed,
  EVENTS.safetyReportSlaBreached,
  EVENTS.safetyAppealCreated,
  EVENTS.userCreated,
  EVENTS.userBanned,
  EVENTS.userDeleted,
  EVENTS.supportTicketCreated,
  EVENTS.supportTicketStatusChanged,
  EVENTS.gamesEntitlementGranted,
  EVENTS.gamesEntitlementRevoked,
  EVENTS.oidcClientCreated,
];

const NEVER_WEBHOOK = [/^qtiauth\.safety\.csea\./, /csea/];

const ALLOWED_DATA_KEYS = new Set([
  "report_id",
  "appeal_id",
  "action_id",
  "case_id",
  "user_id",
  "reported_user_id",
  "ticket_id",
  "number",
  "product_id",
  "game_id",
  "entitlement_id",
  "client_id",
  "type",
  "subtype",
  "priority",
  "status",
  "previous_status",
  "source",
  "trust",
  "category",
  "reason_code",
  "effect",
  "sla_due_at",
  "due_at",
  "expires_at",
  "created_at",
  "resolved_at",
  "granted_at",
  "revoked_at",
  "state",
  "age_band",
  "method",
]);

function webhookKey(ctx: Ctx): Buffer {
  const m = ctx.config.secrets.app_encryption_key ?? ctx.config.secrets.key_encryption_key;
  if (!m) throw new ProblemError(503, "ENCRYPTION_KEY_MISSING");
  return deriveSubkey(decodeKey(m), "webhooks");
}

export function newSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

export function encryptSecret(ctx: Ctx, id: string, secret: string): string {
  return encrypt(webhookKey(ctx), secret, `webhook:${id}`);
}

export function decryptSecret(ctx: Ctx, id: string, enc: string): string {
  return decrypt(webhookKey(ctx), enc, `webhook:${id}`).toString();
}

export function sign(secret: string, msgId: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${msgId}.${timestamp}.${body}`).digest("base64")}`;
}

export function deepLink(ctx: Ctx, type: string, data: Record<string, unknown>): string | null {
  const acc = ctx.surfaces.account;
  const sup = ctx.surfaces.support;
  if (type.includes(".safety.report.") && data.report_id) return surfaceUrl(acc, `/admin/safety/reports/${data.report_id}`);
  if (type.includes(".safety.appeal.") && data.appeal_id) return surfaceUrl(acc, `/admin/safety/appeals/${data.appeal_id}`);
  if (type.includes(".support.ticket.") && data.number) return surfaceUrl(sup, `/staff/tickets/${data.number}`);
  if (type.includes(".oidc.client.") && data.client_id) return surfaceUrl(acc, `/admin/oidc/clients/${data.client_id}`);
  if (data.user_id) return surfaceUrl(acc, `/admin/users/${data.user_id}`);
  return null;
}

export function minimisePayload(ctx: Ctx, env: EventEnvelope<Record<string, unknown>>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env.data ?? {})) {
    if (ALLOWED_DATA_KEYS.has(k) && (v === null || ["string", "number", "boolean"].includes(typeof v))) data[k] = v;
  }
  if (env.subject?.type === "user" && !data.user_id) data.user_id = env.subject.id;
  return {
    id: env.event_id,
    type: shortEventType(env.type),
    occurred_at: env.occurred_at,
    subject: env.subject,
    data,
    link: deepLink(ctx, env.type, { ...data, ...(env.subject?.type === "user" ? { user_id: env.subject.id } : {}) }),
  };
}

const PRIORITY_COLOURS: Record<string, string> = { critical: "danger", high: "highlight", normal: "info", low: "success" };

function hexToInt(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

function title(payload: Record<string, unknown>): string {
  const t = String(payload.type).replace(/[._]/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function formatBody(ctx: Ctx, format: "standard" | "discord" | "slack", payload: Record<string, unknown>): string {
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const fields = Object.entries(data).filter(([k]) => k !== "user_id" || format === "standard");
  if (format === "discord") {
    const colourKey = PRIORITY_COLOURS[String(data.priority ?? "normal")] ?? "info";
    const colour = (ctx.config.branding.colors as unknown as Record<string, string>)[colourKey] ?? ctx.config.branding.colors.primary;
    return JSON.stringify({
      username: ctx.config.branding.product_name,
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: title(payload),
          ...(payload.link ? { url: payload.link } : {}),
          color: hexToInt(colour),
          timestamp: payload.occurred_at,
          fields: fields.slice(0, 20).map(([name, value]) => ({ name, value: String(value).slice(0, 1000), inline: true })),
          footer: { text: `${payload.type} · ${payload.id}` },
        },
      ],
    });
  }
  if (format === "slack") {
    return JSON.stringify({
      text: `${title(payload)}${payload.link ? ` <${payload.link}|Open>` : ""}`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: title(payload).slice(0, 150) } },
        ...(fields.length ? [{ type: "section", fields: fields.slice(0, 10).map(([k, v]) => ({ type: "mrkdwn", text: `*${k}*\n${String(v).slice(0, 200)}` })) }] : []),
        { type: "context", elements: [{ type: "mrkdwn", text: `${payload.type} · ${payload.occurred_at}` }] },
        ...(payload.link ? [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open" }, url: payload.link }] }] : []),
      ],
    });
  }
  return JSON.stringify(payload);
}

export async function fanOut(ctx: Ctx, env: EventEnvelope<Record<string, unknown>>): Promise<number> {
  if (NEVER_WEBHOOK.some((r) => r.test(env.type))) return 0;
  const endpoints = await ctx.db.selectFrom("webhook_endpoints").selectAll().where("enabled", "=", true).execute();
  const payload = minimisePayload(ctx, env);
  let n = 0;
  for (const e of endpoints) {
    if (!e.events.some((p) => eventWildcardMatches(p, env.type))) continue;
    const id = ulid();
    const r = await ctx.db
      .insertInto("webhook_deliveries")
      .values({ id, endpoint_id: e.id, event_id: env.event_id, event_type: shortEventType(env.type), payload: JSON.stringify(payload), status: "pending", next_attempt_at: new Date() })
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    if (Number(r.numInsertedOrUpdatedRows ?? 0)) n++;
  }
  return n;
}

const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600, 7200, 14400, 28800];

export async function deliver(ctx: Ctx, deliveryId: string): Promise<"success" | "retrying" | "failed" | "skipped"> {
  const d = await ctx.db.selectFrom("webhook_deliveries").selectAll().where("id", "=", deliveryId).executeTakeFirst();
  if (!d || d.status === "success" || d.status === "failed") return "skipped";
  const e = await ctx.db.selectFrom("webhook_endpoints").selectAll().where("id", "=", d.endpoint_id).executeTakeFirst();
  if (!e) return "skipped";
  if (!e.enabled && !d.replay_of) {
    await ctx.db.updateTable("webhook_deliveries").set({ status: "failed", error: "endpoint disabled", completed_at: new Date(), next_attempt_at: null }).where("id", "=", d.id).execute();
    return "failed";
  }
  const body = formatBody(ctx, e.format, d.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "QTIAuth-Webhooks/1" };
  if (e.format === "standard") {
    const secrets = [decryptSecret(ctx, e.id, e.secret_enc)];
    if (e.previous_secret_enc && e.previous_secret_expires_at && e.previous_secret_expires_at > new Date()) secrets.push(decryptSecret(ctx, e.id, e.previous_secret_enc));
    headers["webhook-id"] = d.event_id;
    headers["webhook-timestamp"] = String(timestamp);
    headers["webhook-signature"] = secrets.map((s) => sign(s, d.event_id, timestamp, body)).join(" ");
  }
  const started = performance.now();
  let status = 0;
  let responseBody = "";
  let error: string | null = null;
  try {
    const r = await fetchPinned(e.url, ctx.config.webhooks.allow_private_targets, { method: "POST", headers, body, signal: AbortSignal.timeout(ctx.config.webhooks.timeout) });
    status = r.status;
    responseBody = (await r.text()).slice(0, 4096);
  } catch (err) {
    error = (err as Error).message.slice(0, 500);
  }
  const ms = Math.round(performance.now() - started);
  observe("qtiauth_webhook_delivery_seconds", ms / 1000, { format: e.format }, undefined, "Webhook delivery latency");
  const ok = status >= 200 && status < 300;
  const attempts = d.attempts + 1;
  const age = Date.now() - d.created_at.getTime();
  const giveUp = !ok && (age >= ctx.config.webhooks.max_retry_window || attempts > BACKOFF_SECONDS.length || Boolean(d.replay_of));
  const next = ok || giveUp ? null : new Date(Date.now() + BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]! * 1000);
  const final: "success" | "retrying" | "failed" = ok ? "success" : giveUp ? "failed" : "retrying";
  await ctx.db
    .updateTable("webhook_deliveries")
    .set({
      status: final,
      attempts,
      last_status_code: status || null,
      request_body: body.slice(0, 4096),
      response_body: responseBody || null,
      duration_ms: ms,
      error: error ?? (ok ? null : `HTTP ${status}`),
      next_attempt_at: next,
      completed_at: ok || giveUp ? new Date() : null,
    })
    .where("id", "=", d.id)
    .execute();
  inc("qtiauth_webhook_deliveries_total", { format: e.format, status: final }, 1, "Webhook deliveries by format and status");
  if (ok) {
    if (e.consecutive_failures) await ctx.db.updateTable("webhook_endpoints").set({ consecutive_failures: 0 }).where("id", "=", e.id).execute();
  } else if (!d.replay_of) {
    const updated = await ctx.db
      .updateTable("webhook_endpoints")
      .set({ consecutive_failures: sql`consecutive_failures + 1` })
      .where("id", "=", e.id)
      .returning(["consecutive_failures", "enabled"])
      .executeTakeFirst();
    if (updated && updated.enabled && updated.consecutive_failures >= ctx.config.webhooks.disable_after_failures) await disableEndpoint(ctx, e, updated.consecutive_failures);
  }
  return final;
}

async function disableEndpoint(ctx: Ctx, e: Endpoint, failures: number): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    await trx.updateTable("webhook_endpoints").set({ enabled: false, disabled_reason: `Disabled after ${failures} consecutive failures`, updated_at: new Date() }).where("id", "=", e.id).execute();
    await trx.updateTable("webhook_deliveries").set({ status: "failed", error: "endpoint disabled", next_attempt_at: null, completed_at: new Date() }).where("endpoint_id", "=", e.id).where("status", "in", ["pending", "retrying"]).execute();
    await ctx.emit(trx, EVENTS.notifierEndpointDisabled, { endpoint_id: e.id, failures }, { subject: { type: "webhook_endpoint", id: e.id } });
    await ctx.audit(trx, { actor: { type: "system", id: "notifier" }, action: "webhook.endpoint_auto_disabled", target: { type: "webhook_endpoint", id: e.id }, data: { failures } });
  });
  inc("qtiauth_webhook_endpoints_disabled_total", {}, 1, "Webhook endpoints auto-disabled");
  const admins = await ctx.rpcOptional<{ user_id: string }[]>("identity.staff_recipients", { permission: "webhooks.manage" }, []);
  await ctx.db.transaction().execute(async (trx) => {
    for (const a of admins) {
      await ctx.email(trx, {
        template: "webhook_endpoint_disabled",
        to: { user_id: a.user_id },
        vars: { url: e.url, failures, admin_url: surfaceUrl(ctx.surfaces.account, `/admin/webhooks/${e.id}`) },
        sender: "security",
        priority: "high",
      });
    }
  });
}

export async function deliverDue(ctx: Ctx, limit = 200): Promise<number> {
  const due = await ctx.db
    .selectFrom("webhook_deliveries")
    .select("id")
    .where("status", "in", ["pending", "retrying"])
    .where("next_attempt_at", "<=", new Date())
    .orderBy("next_attempt_at")
    .limit(limit)
    .execute();
  await Promise.all(due.map((d) => deliver(ctx, d.id).catch((err) => ctx.log.warn({ err }, "webhook delivery error"))));
  return due.length;
}

export async function seedEndpoints(ctx: Ctx): Promise<void> {
  for (const e of ctx.config.webhooks.endpoints) {
    const secret = e.secret ?? newSecret();
    await ctx.db
      .insertInto("webhook_endpoints")
      .values({ id: e.id, url: e.url, description: e.description, events: JSON.stringify(e.events), format: e.format, secret_enc: encryptSecret(ctx, e.id, secret), enabled: true, seeded: true })
      .onConflict((oc) => oc.column("id").doUpdateSet({ url: e.url, description: e.description, events: JSON.stringify(e.events), format: e.format, updated_at: new Date() }))
      .execute();
  }
}
