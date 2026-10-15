import { sql } from "kysely";
import { EVENTS, type EventEnvelope } from "@qtiauth/bus";
import { defineService, type EmailRequest, type ServiceContext } from "@qtiauth/service-kit";
import { migrations, type NotifierDB } from "./db.ts";
import { TemplateStore } from "./templates.ts";
import { createProvider } from "./providers/index.ts";
import { Mailer } from "./email.ts";
import { deliverDue, fanOut, seedEndpoints, WEBHOOK_EVENTS } from "./webhooks.ts";
import { continueNotices, cseaAlert, staffAlerts, startLegalNotice } from "./notices.ts";
import { notifierRoutes } from "./routes.ts";

type Ctx = ServiceContext<NotifierDB>;

let templates: TemplateStore | null = null;
let mailer: Mailer | null = null;

export const notifierService = defineService<NotifierDB>({
  name: "notifier",
  schema: "notify",
  migrations,
  permissions: ["webhooks.manage", "email.logs.read", "email.suppressions.manage"],
  notificationCategories: [
    { id: "staff.new_ticket", label: "New support tickets", staff: true, default: true },
    { id: "staff.high_priority_report", label: "High-priority safety reports", staff: true, default: true },
  ],
  policyDefaults: { module: "admin" },
  async init(ctx) {
    templates = new TemplateStore(ctx.config, ctx.surfaces);
    const r = await templates.load();
    ctx.log.info(r, "email templates loaded");
    mailer = new Mailer(ctx as Ctx, templates, createProvider(ctx.config, ctx.log));
    await seedEndpoints(ctx as Ctx);
  },
  routes: (ctx) => notifierRoutes(ctx as Ctx, templates!),
  async start(ctx) {
    const c = ctx as Ctx;
    for (const priority of ["high", "normal"] as const) {
      await c.bus.consumeQueue<EmailRequest & { id: string }>({
        queue: `email.${priority}`,
        durable: `notifier-email-${priority}`,
        concurrency: priority === "high" ? 16 : 8,
        maxDeliver: c.config.email.max_attempts + 2,
        handler: async (req, msg) => {
          await mailer!.process(req, msg.info.deliveryCount);
        },
      });
    }
    await c.on<Record<string, unknown>>("webhooks", WEBHOOK_EVENTS, async (env, trx) => {
      const n = await fanOut({ ...c, db: trx } as Ctx, env as EventEnvelope<Record<string, unknown>>);
      if (n) setImmediate(() => void deliverDue(c, 50));
    });
    await c.on<Record<string, unknown>>("legal-notices", [EVENTS.legalVersionEffective], async (env) => {
      await startLegalNotice(c, env as EventEnvelope<Record<string, unknown>>);
      setImmediate(() => void continueNotices(c).catch((err) => c.log.warn({ err }, "legal notices failed")));
    });
    await c.on<Record<string, unknown>>("staff-alerts", [EVENTS.supportTicketCreated, EVENTS.safetyReportCreated], async (env) => {
      await staffAlerts(c, env as EventEnvelope<Record<string, unknown>>);
    });
    await c.on<Record<string, unknown>>("csea-alerts", [EVENTS.safetyCseaCaseOpened], async (env) => {
      await cseaAlert(c, env as EventEnvelope<Record<string, unknown>>);
    });
  },
  cron: {
    "webhooks.retry": async (ctx) => {
      await deliverDue(ctx as Ctx);
      await continueNotices(ctx as Ctx);
    },
  },
  async retention(ctx) {
    const cutoff = new Date(Date.now() - ctx.config.retention.delivery_logs);
    const e = await ctx.db.deleteFrom("email_deliveries").where("created_at", "<", cutoff).executeTakeFirst();
    const w = await ctx.db.deleteFrom("webhook_deliveries").where("created_at", "<", cutoff).where("status", "in", ["success", "failed"]).executeTakeFirst();
    const n = await ctx.db.deleteFrom("notice_runs").where("done", "=", true).where("created_at", "<", cutoff).executeTakeFirst();
    await sql`update webhook_endpoints set previous_secret_enc = null, previous_secret_expires_at = null where previous_secret_expires_at < now()`.execute(ctx.db);
    return { email_deliveries: Number(e.numDeletedRows), webhook_deliveries: Number(w.numDeletedRows), notice_runs: Number(n.numDeletedRows) };
  },
  async exportUser(ctx, userId) {
    const rows = await ctx.db.selectFrom("email_deliveries").select(["template", "status", "created_at", "sent_at", "to_email"]).where("user_id", "=", userId).orderBy("created_at", "desc").limit(1000).execute();
    return { emails_sent: rows };
  },
  async eraseUser(ctx, userId) {
    await ctx.db.deleteFrom("email_deliveries").where("user_id", "=", userId).execute();
  },
  async healthWarnings(ctx) {
    const w = [];
    if (ctx.config.email.provider === "console") w.push({ code: "CONSOLE_EMAIL", severity: "warning" as const, message: "email.provider is console: emails are printed to the log instead of being sent." });
    const disabled = await ctx.db.selectFrom("webhook_endpoints").select("id").where("enabled", "=", false).where("disabled_reason", "like", "Disabled after%").execute();
    if (disabled.length) w.push({ code: "WEBHOOKS_AUTO_DISABLED", severity: "warning" as const, message: `${disabled.length} webhook endpoint(s) were auto-disabled after repeated failures.` });
    if (!ctx.config.email.webhook_secret && ctx.config.email.provider !== "console" && ctx.config.email.provider !== "smtp") {
      w.push({ code: "NO_BOUNCE_WEBHOOK_SECRET", severity: "info" as const, message: "email.webhook_secret is not set, so bounce and complaint webhooks are refused." });
    }
    return w;
  },
});
