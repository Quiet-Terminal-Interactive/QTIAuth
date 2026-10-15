import { sql } from "kysely";
import { isUuid, setGauge } from "@qtiauth/common";
import { EVENTS } from "@qtiauth/bus";
import { defineService } from "@qtiauth/service-kit";
import { migrations, type SupportDB } from "./db.ts";
import { appealCategory, createTicket, setStatus, ticketUrl, ticketView, type Ctx } from "./lib.ts";
import { deleteTicketObjects } from "./attachments.ts";
import { ticketRoutes } from "./routes/tickets.ts";
import { staffRoutes } from "./routes/staff.ts";
import { kbRoutes } from "./routes/kb.ts";

let gaugeTimer: NodeJS.Timeout | null = null;

async function autoClose(ctx: Ctx): Promise<void> {
  const after = ctx.config.support.auto_close_after;
  const now = Date.now();
  const due = await ctx.db.selectFrom("tickets").selectAll().where("status", "=", "waiting_on_user").where("last_staff_reply_at", "<", new Date(now - after)).limit(500).execute();
  for (const t of due) {
    if (t.last_user_activity_at > (t.last_staff_reply_at ?? t.created_at)) continue;
    await ctx.db.transaction().execute((trx) => setStatus(ctx, trx, t, "closed", "system", null, "Closed automatically because we didn't hear back."));
  }
  const remind = await ctx.db
    .selectFrom("tickets")
    .selectAll()
    .where("status", "=", "waiting_on_user")
    .where("reminder_sent_at", "is", null)
    .where("last_staff_reply_at", "<", new Date(now - after / 2))
    .limit(500)
    .execute();
  for (const t of remind) {
    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable("tickets").set({ reminder_sent_at: new Date() }).where("id", "=", t.id).execute();
      const to = t.user_id ? { user_id: t.user_id } : t.guest_email ? { email: t.guest_email } : null;
      if (!to) return;
      await ctx.email(trx, {
        template: "ticket_auto_close_reminder",
        to,
        locale: t.locale,
        vars: { number: t.number, subject: t.subject, close_at: new Date((t.last_staff_reply_at ?? t.created_at).getTime() + after).toISOString(), ticket_url: ticketUrl(ctx, t) },
        sender: "support",
        notification_category: "support.ticket_updates",
        dedupe_key: `ticket-remind-${t.id}-${t.last_staff_reply_at?.getTime() ?? 0}`,
      });
    });
  }
}

async function updateGauges(ctx: Ctx): Promise<void> {
  const rows = await ctx.db.selectFrom("tickets").select(["status", "category", sql<number>`count(*)::int`.as("n")]).where("status", "!=", "closed").groupBy(["status", "category"]).execute();
  for (const status of ["open", "waiting_on_user", "on_hold"]) {
    for (const cat of Object.keys(ctx.config.support.categories)) {
      setGauge("qtiauth_support_open_tickets", rows.find((r) => r.status === status && r.category === cat)?.n ?? 0, { status, category: cat }, "Open tickets by status and category");
    }
  }
}

export const supportService = defineService<SupportDB>({
  name: "support",
  schema: "support",
  migrations,
  permissions: ["support.tickets.staff", "support.macros.manage", "support.kb.edit"],
  notificationCategories: [
    { id: "support.ticket_updates", label: "Replies and updates on your support tickets", default: true },
    { id: "staff.new_ticket", label: "New support tickets", staff: true, default: true },
  ],
  policyDefaults: { module: "support" },
  features: (ctx) => {
    const f = ctx.config.features.support;
    return [
      ...(f.tickets.enabled ? ["support.tickets"] : []),
      ...(f.kb.enabled ? ["support.kb"] : []),
      ...(f.guest_tickets.enabled && f.tickets.enabled ? ["support.guest_tickets"] : []),
      ...(f.attachments.enabled && ctx.storage ? ["support.attachments"] : []),
      ...(f.kb_images.enabled && ctx.storage ? ["support.kb_images"] : []),
    ];
  },
  async init(ctx) {
    if (ctx.storage) await ctx.storage.ensureBucket().catch((err) => ctx.log.warn({ err }, "could not ensure storage bucket"));
  },
  routes: (ctx) => [...ticketRoutes(ctx as Ctx), ...staffRoutes(ctx as Ctx), ...kbRoutes(ctx as Ctx)],
  async start(ctx) {
    const c = ctx as Ctx;
    c.bus.handle<{ user_id: string; appeal_id: string; appeal_reference: string; action_id: string; action_label: string; statement: string }, unknown>("support.create_appeal_ticket", async (req) => {
      const cat = appealCategory(c);
      if (!cat || !c.config.features.support.tickets.enabled) return null;
      const { ticket } = await c.db.transaction().execute((trx) =>
        createTicket(c, trx, { user_id: req.user_id, guest_email: null, category: cat, subject: `Appeal ${req.appeal_reference}: ${req.action_label}`.slice(0, 200), body: req.statement, locale: null, appeal_id: req.appeal_id, action_id: req.action_id }),
      );
      return { ticket_id: ticket.id, number: ticket.number };
    });

    c.bus.handle<{ user_id: string }, unknown>("support.user_tickets", async (req) => {
      if (!isUuid(req.user_id)) return { items: [] };
      const rows = await c.db.selectFrom("tickets").selectAll().where("user_id", "=", req.user_id).orderBy("created_at", "desc").limit(50).execute();
      return { items: rows.map((t) => ticketView(c, t)) };
    });

    await c.on<{ appeal_id: string; status: string; ticket_id: string | null }>("appeal-resolved", [EVENTS.safetyAppealResolved], async (env, trx) => {
      const t = env.data.ticket_id && isUuid(env.data.ticket_id) ? await trx.selectFrom("tickets").selectAll().where("id", "=", env.data.ticket_id).executeTakeFirst() : await trx.selectFrom("tickets").selectAll().where("appeal_id", "=", env.data.appeal_id).executeTakeFirst();
      if (!t || t.status === "closed") return;
      const outcome = env.data.status === "lifted" ? "The appeal was successful and the action was lifted." : "The appeal was reviewed and the action stays in place.";
      await setStatus(c, trx, t, "closed", "system", null, outcome, false);
    });

    await updateGauges(c).catch(() => undefined);
    gaugeTimer = setInterval(() => void updateGauges(c).catch(() => undefined), 30_000);
    gaugeTimer.unref();
  },
  async shutdown() {
    if (gaugeTimer) clearInterval(gaugeTimer);
  },
  cron: {
    "support.auto_close": (ctx) => autoClose(ctx as Ctx),
  },
  async retention(ctx) {
    const c = ctx as Ctx;
    const old = await c.db.selectFrom("tickets").select("id").where("status", "=", "closed").where("closed_at", "<", new Date(Date.now() - c.config.retention.closed_tickets)).limit(5000).execute();
    const ids = old.map((t) => t.id);
    await deleteTicketObjects(c, ids);
    if (ids.length) await c.db.deleteFrom("tickets").where("id", "in", ids).execute();
    const orphans = await c.db.deleteFrom("attachments").where("status", "!=", "ready").where("created_at", "<", new Date(Date.now() - 86_400_000)).executeTakeFirst();
    return { closed_tickets: ids.length, abandoned_uploads: Number(orphans.numDeletedRows) };
  },
  async exportUser(ctx, userId) {
    const c = ctx as Ctx;
    const tickets = await c.db.selectFrom("tickets").selectAll().where("user_id", "=", userId).execute();
    const ids = tickets.map((t) => t.id);
    const messages = ids.length ? await c.db.selectFrom("messages").select(["ticket_id", "author_type", "body", "created_at"]).where("ticket_id", "in", ids).where("internal", "=", false).orderBy("created_at").execute() : [];
    return { tickets: tickets.map((t) => ({ ...ticketView(c, t), rating_comment: t.rating_comment, messages: messages.filter((m) => m.ticket_id === t.id).map(({ ticket_id: _t, ...m }) => m) })) };
  },
  async eraseUser(ctx, userId) {
    const c = ctx as Ctx;
    const tickets = await c.db.selectFrom("tickets").select("id").where("user_id", "=", userId).execute();
    const ids = tickets.map((t) => t.id);
    await deleteTicketObjects(c, ids);
    if (ids.length) await c.db.deleteFrom("tickets").where("id", "in", ids).execute();
    await c.db.updateTable("tickets").set({ assignee_id: null }).where("assignee_id", "=", userId).execute();
    await c.db.updateTable("messages").set({ author_id: null }).where("author_id", "=", userId).execute();
  },
  async healthWarnings(ctx) {
    const w = [];
    const f = ctx.config.features.support;
    if ((f.attachments.enabled || f.kb_images.enabled) && !ctx.storage) w.push({ code: "SUPPORT_STORAGE_MISSING", severity: "error" as const, message: "Support attachments or KB images are enabled but no object storage is configured." });
    if (f.tickets.enabled && !appealCategory(ctx as Ctx)) w.push({ code: "NO_APPEAL_CATEGORY", severity: "warning" as const, message: "No support category is marked appeal: true, so restricted accounts cannot appeal through Support." });
    return w;
  },
});
