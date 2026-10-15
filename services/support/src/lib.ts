import { ProblemError, hashToken, inc, randomToken, uuidv7 } from "@qtiauth/common";
import { surfaceUrl } from "@qtiauth/config";
import { EVENTS, type Actor } from "@qtiauth/bus";
import type { ServiceContext, Exec as KitExec } from "@qtiauth/service-kit";
import type { AuthorType, Message, SupportDB, Ticket, TicketPriority, TicketStatus } from "./db.ts";

export type Ctx = ServiceContext<SupportDB>;
export type Exec = KitExec<SupportDB>;

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: "open",
  waiting_on_user: "waiting for your reply",
  on_hold: "on hold",
  closed: "closed",
};

export function category(ctx: Ctx, id: string) {
  const c = ctx.config.support.categories[id];
  if (!c) throw new ProblemError(422, "UNKNOWN_CATEGORY", undefined, { category: id });
  return c;
}

export function appealCategory(ctx: Ctx): string | null {
  return Object.entries(ctx.config.support.categories).find(([, c]) => c.appeal)?.[0] ?? null;
}

export function ticketUrl(ctx: Ctx, t: Pick<Ticket, "number" | "user_id">, guestToken?: string): string {
  if (!t.user_id && guestToken) return `${surfaceUrl(ctx.surfaces.support, `/guest/tickets/${t.number}`)}?token=${encodeURIComponent(guestToken)}`;
  return surfaceUrl(ctx.surfaces.support, `/tickets/${t.number}`);
}

function recipient(t: Ticket): { user_id?: string; email?: string } | null {
  if (t.user_id) return { user_id: t.user_id };
  if (t.guest_email) return { email: t.guest_email };
  return null;
}

export function actorFor(type: AuthorType, id: string | null): Actor {
  if (type === "staff") return { type: "staff", id: id! };
  if (type === "user") return { type: "user", id: id! };
  if (type === "guest") return { type: "user", id: "guest" };
  return { type: "system", id: "support" };
}

export interface NewTicket {
  user_id: string | null;
  guest_email: string | null;
  category: string;
  subject: string;
  body: string;
  locale: string | null;
  appeal_id?: string | null;
  action_id?: string | null;
  priority?: TicketPriority;
}

export async function createTicket(ctx: Ctx, trx: Exec, input: NewTicket): Promise<{ ticket: Ticket; guestToken: string | null }> {
  const cat = category(ctx, input.category);
  const guestToken = input.user_id ? null : randomToken(32);
  const ticket = await trx
    .insertInto("tickets")
    .values({
      id: uuidv7(),
      user_id: input.user_id,
      guest_email: input.guest_email,
      guest_token_hash: guestToken ? hashToken(guestToken) : null,
      guest_token_expires_at: guestToken ? new Date(Date.now() + ctx.config.support.guest_access_ttl) : null,
      category: input.category,
      subject: input.subject,
      status: "open",
      priority: input.priority ?? cat.default_priority,
      appeal_id: input.appeal_id ?? null,
      action_id: input.action_id ?? null,
      locale: input.locale,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await trx.insertInto("messages").values({ id: uuidv7(), ticket_id: ticket.id, author_type: input.user_id ? "user" : "guest", author_id: input.user_id, body: input.body }).execute();
  await ctx.emit(
    trx,
    EVENTS.supportTicketCreated,
    { ticket_id: ticket.id, number: ticket.number, subject: ticket.subject, category: ticket.category, priority: ticket.priority, status: ticket.status, guest: !input.user_id },
    { actor: actorFor(input.user_id ? "user" : "guest", input.user_id), subject: { type: "ticket", id: ticket.id } },
  );
  const to = recipient(ticket);
  if (to) {
    await ctx.email(trx, {
      template: guestToken ? "guest_ticket_link" : "ticket_created",
      to,
      locale: input.locale,
      vars: { number: ticket.number, subject: ticket.subject, ticket_url: ticketUrl(ctx, ticket, guestToken ?? undefined) },
      sender: "support",
      notification_category: "support.ticket_updates",
      dedupe_key: `ticket-created-${ticket.id}`,
    });
  }
  inc("qtiauth_support_tickets_created_total", { category: ticket.category, guest: String(!input.user_id) }, 1, "Tickets created");
  return { ticket, guestToken };
}

export async function addMessage(ctx: Ctx, trx: Exec, t: Ticket, m: { author_type: AuthorType; author_id: string | null; body: string; internal?: boolean; status?: TicketStatus }): Promise<Message> {
  if (t.status === "closed" && m.author_type !== "staff" && m.author_type !== "system") throw new ProblemError(409, "TICKET_CLOSED", "Reopen the ticket to reply");
  const message = await trx
    .insertInto("messages")
    .values({ id: uuidv7(), ticket_id: t.id, author_type: m.author_type, author_id: m.author_id, body: m.body, internal: m.internal ?? false })
    .returningAll()
    .executeTakeFirstOrThrow();
  if (m.internal) return message;
  const now = new Date();
  const isStaff = m.author_type === "staff";
  const nextStatus: TicketStatus = m.status ?? (isStaff ? "waiting_on_user" : t.status === "closed" ? "closed" : "open");
  await trx
    .updateTable("tickets")
    .set({
      updated_at: now,
      ...(isStaff ? { last_staff_reply_at: now, first_response_at: t.first_response_at ?? now, reminder_sent_at: null } : { last_user_activity_at: now }),
      ...(nextStatus !== t.status ? { status: nextStatus, ...(nextStatus === "closed" ? { closed_at: now, closed_by: m.author_type } : {}) } : {}),
    })
    .where("id", "=", t.id)
    .execute();
  await ctx.emit(trx, EVENTS.supportTicketReplied, { ticket_id: t.id, number: t.number, author_type: m.author_type, status: nextStatus }, { actor: actorFor(m.author_type, m.author_id), subject: { type: "ticket", id: t.id } });
  if (nextStatus !== t.status) await statusChanged(ctx, trx, t, nextStatus, m.author_type, m.author_id, false);
  const to = recipient(t);
  if (isStaff && to) {
    await ctx.email(trx, {
      template: "ticket_reply",
      to,
      locale: t.locale,
      vars: { number: t.number, subject: t.subject, ticket_url: ticketUrl(ctx, t) },
      sender: "support",
      notification_category: "support.ticket_updates",
      dedupe_key: `ticket-reply-${message.id}`,
    });
  }
  return message;
}

export async function setStatus(ctx: Ctx, trx: Exec, t: Ticket, status: TicketStatus, by: AuthorType, byId: string | null, note?: string, notify = true): Promise<void> {
  if (t.status === status) return;
  const now = new Date();
  await trx
    .updateTable("tickets")
    .set({ status, updated_at: now, ...(status === "closed" ? { closed_at: now, closed_by: by } : { closed_at: null, closed_by: null, reminder_sent_at: null }) })
    .where("id", "=", t.id)
    .execute();
  if (note) await trx.insertInto("messages").values({ id: uuidv7(), ticket_id: t.id, author_type: "system", author_id: null, body: note }).execute();
  await statusChanged(ctx, trx, t, status, by, byId, notify);
}

async function statusChanged(ctx: Ctx, trx: Exec, t: Ticket, status: TicketStatus, by: AuthorType, byId: string | null, notify: boolean): Promise<void> {
  await ctx.emit(
    trx,
    EVENTS.supportTicketStatusChanged,
    { ticket_id: t.id, number: t.number, status, previous_status: t.status, category: t.category },
    { actor: actorFor(by, byId), subject: { type: "ticket", id: t.id } },
  );
  if (status === "closed") {
    inc("qtiauth_support_tickets_closed_total", { category: t.category, by }, 1, "Tickets closed");
  }
  const to = recipient(t);
  if (!notify || !to || by === "user" || by === "guest") return;
  await ctx.email(trx, {
    template: "ticket_status_changed",
    to,
    locale: t.locale,
    vars: { number: t.number, subject: t.subject, status: STATUS_LABELS[status], ticket_url: ticketUrl(ctx, t) },
    sender: "support",
    notification_category: "support.ticket_updates",
    dedupe_key: `ticket-status-${t.id}-${status}-${Date.now()}`,
  });
}

export function ticketView(ctx: Ctx, t: Ticket) {
  return {
    id: t.id,
    number: t.number,
    category: t.category,
    category_label: ctx.config.support.categories[t.category]?.label ?? t.category,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    appeal_id: t.appeal_id,
    action_id: t.action_id,
    rating: t.rating,
    created_at: t.created_at.toISOString(),
    updated_at: t.updated_at.toISOString(),
    closed_at: t.closed_at?.toISOString() ?? null,
  };
}

export function messageView(m: Message, opts: { staff: boolean }) {
  return {
    id: m.id,
    author_type: m.author_type,
    author_id: opts.staff || m.author_type !== "staff" ? m.author_id : null,
    body: m.body,
    internal: m.internal,
    created_at: m.created_at.toISOString(),
  };
}
