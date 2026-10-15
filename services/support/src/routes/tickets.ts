import { z } from "zod";
import { ProblemError, hashToken, numericCode, safeEqual, sha256 } from "@qtiauth/common";
import { route, type AnyRoute, zCaptcha, zEmail } from "@qtiauth/service-kit";
import type { IdentityClaims } from "@qtiauth/auth-context";
import { addMessage, appealCategory, category, createTicket, messageView, setStatus, ticketView, type Ctx } from "../lib.ts";
import { attachmentView, completeUpload, downloadUrl, linkAttachments, startUpload, zAttachmentIds, zAttachmentInput } from "../attachments.ts";
import type { Ticket } from "../db.ts";

const tags = ["support"];
const restricted = { allow_account_states: ["active", "locked", "banned"] as ("active" | "locked" | "banned")[], allow_pending_legal: true };
const zNumber = z.object({ number: z.coerce.number().int().positive() });
const zNumberAttachment = z.object({ number: z.coerce.number().int().positive(), aid: z.uuid() });
const zBody = z.string().trim().min(1).max(20_000);
const zSubject = z.string().trim().min(3).max(200);

export function ticketRoutes(ctx: Ctx): AnyRoute[] {
  const cfg = ctx.config.support;
  const features = ctx.config.features.support;

  function requireTickets(): void {
    if (!features.tickets.enabled) throw new ProblemError(404, "TICKETS_DISABLED");
  }

  async function ownTicket(number: number, id: IdentityClaims): Promise<Ticket> {
    requireTickets();
    const t = await ctx.db.selectFrom("tickets").selectAll().where("number", "=", number).where("user_id", "=", id.sub!).executeTakeFirst();
    if (!t) throw new ProblemError(404, "TICKET_NOT_FOUND");
    return t;
  }

  async function guestTicket(number: number, token: string | undefined): Promise<Ticket> {
    if (!features.guest_tickets.enabled) throw new ProblemError(404, "GUEST_TICKETS_DISABLED");
    if (!token) throw new ProblemError(401, "GUEST_TOKEN_REQUIRED");
    const t = await ctx.db.selectFrom("tickets").selectAll().where("number", "=", number).where("user_id", "is", null).executeTakeFirst();
    if (!t?.guest_token_hash || !safeEqual(t.guest_token_hash, hashToken(token))) throw new ProblemError(404, "TICKET_NOT_FOUND");
    if (t.guest_token_expires_at && t.guest_token_expires_at < new Date()) throw new ProblemError(410, "GUEST_LINK_EXPIRED");
    return t;
  }

  async function thread(t: Ticket) {
    const messages = await ctx.db.selectFrom("messages").selectAll().where("ticket_id", "=", t.id).where("internal", "=", false).orderBy("created_at").execute();
    const attachments = await ctx.db.selectFrom("attachments").selectAll().where("ticket_id", "=", t.id).where("status", "=", "ready").execute();
    return {
      ...ticketView(ctx, t),
      messages: messages.map((m) => ({ ...messageView(m, { staff: false }), attachments: attachments.filter((a) => a.message_id === m.id).map(attachmentView) })),
      pending_attachments: attachments.filter((a) => !a.message_id).map(attachmentView),
      can_rate: t.status === "closed" && t.rating === null,
    };
  }

  function guestCodeKey(email: string): string {
    return `support:guestcode:${sha256(email.trim().toLowerCase())}`;
  }

  return [
    route({
      method: "GET",
      path: "/api/v1/support/categories",
      summary: "Ticket categories",
      tags,
      auth: "none",
      session_optional: true,
      allow_pending_legal: true,
      rate_limit: ["public_read"],
      async handler() {
        return {
          tickets: features.tickets.enabled,
          guest_tickets: features.guest_tickets.enabled,
          attachments: features.attachments.enabled && Boolean(ctx.storage) ? { max_bytes: cfg.attachments.max_bytes, max_per_message: cfg.attachments.max_per_message, allowed_types: cfg.attachments.allowed_types } : null,
          categories: Object.entries(cfg.categories).map(([id, c]) => ({ id, label: c.label, guest_allowed: c.guest_allowed, appeal: c.appeal })),
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/tickets",
      summary: "Open a ticket",
      description: "Locked and banned accounts can open appeal tickets. An appeal must name the moderation action it's about, and there can be one open appeal per action.",
      tags,
      auth: "session",
      ...restricted,
      rate_limit: ["ticket_create"],
      body: z.object({ category: z.string().max(64), subject: zSubject, body: zBody, action_id: z.uuid().optional(), attachment_ids: zAttachmentIds }),
      async handler({ body, id }) {
        requireTickets();
        const cat = category(ctx, body.category);
        const restrictedState = id.state === "locked" || id.state === "banned";
        if (restrictedState && !cat.appeal) throw new ProblemError(403, "APPEAL_CATEGORY_REQUIRED", "Restricted accounts can only open appeals", { category: appealCategory(ctx) });
        if (cat.appeal && !body.action_id) throw new ProblemError(422, "ACTION_REQUIRED", "Choose the moderation action you're appealing");
        if (!cat.appeal && body.action_id) throw new ProblemError(422, "ACTION_NOT_ALLOWED");
        if (body.attachment_ids.length) throw new ProblemError(422, "ATTACH_AFTER_CREATE", "Add attachments with a reply once the ticket exists");
        const safetyRunning = cat.appeal && (await ctx.registeredServices()).includes("safety");
        const { ticket } = await ctx.db.transaction().execute(async (trx) => {
          const created = await createTicket(ctx, trx, { user_id: id.sub!, guest_email: null, category: body.category, subject: body.subject, body: body.body, locale: id.locale, action_id: body.action_id ?? null });
          if (safetyRunning) {
            const appeal = await ctx.rpc<{ id: string }>("safety.register_appeal", { user_id: id.sub!, action_id: body.action_id, statement: body.body, ticket_id: created.ticket.id, ticket_number: created.ticket.number });
            await trx.updateTable("tickets").set({ appeal_id: appeal.id }).where("id", "=", created.ticket.id).execute();
            created.ticket.appeal_id = appeal.id;
          }
          return created;
        }).catch((err) => {
          if ((err as { code?: string }).code === "23505") throw new ProblemError(409, "APPEAL_ALREADY_OPEN");
          throw err;
        });
        return ticketView(ctx, ticket);
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/support/tickets",
      summary: "My tickets",
      tags,
      auth: "session",
      ...restricted,
      query: z.object({ status: z.enum(["open", "closed", "all"]).default("all"), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      async handler({ query, id }) {
        requireTickets();
        let q = ctx.db.selectFrom("tickets").selectAll().where("user_id", "=", id.sub!);
        if (query.status === "open") q = q.where("status", "!=", "closed");
        if (query.status === "closed") q = q.where("status", "=", "closed");
        const rows = await q.orderBy("updated_at", "desc").limit(query.limit).execute();
        return { items: rows.map((t) => ticketView(ctx, t)) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/support/tickets/:number",
      summary: "A ticket and its replies",
      tags,
      auth: "session",
      ...restricted,
      params: zNumber,
      async handler({ params, id }) {
        return thread(await ownTicket(params.number, id));
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/tickets/:number/replies",
      summary: "Reply to a ticket",
      tags,
      auth: "session",
      ...restricted,
      rate_limit: ["account_write"],
      params: zNumber,
      body: z.object({ body: zBody, attachment_ids: zAttachmentIds }),
      async handler({ params, body, id }) {
        const t = await ownTicket(params.number, id);
        const m = await ctx.db.transaction().execute(async (trx) => {
          const msg = await addMessage(ctx, trx, t, { author_type: "user", author_id: id.sub!, body: body.body });
          await linkAttachments(trx, t.id, msg.id, body.attachment_ids);
          return msg;
        });
        return messageView(m, { staff: false });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/tickets/:number/close",
      summary: "Close my ticket",
      tags,
      auth: "session",
      ...restricted,
      params: zNumber,
      async handler({ params, id }) {
        const t = await ownTicket(params.number, id);
        await ctx.db.transaction().execute((trx) => setStatus(ctx, trx, t, "closed", "user", id.sub!));
        return { status: "closed" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/tickets/:number/reopen",
      summary: "Reopen my ticket",
      tags,
      auth: "session",
      ...restricted,
      params: zNumber,
      async handler({ params, id }) {
        const t = await ownTicket(params.number, id);
        if (t.status !== "closed") throw new ProblemError(409, "TICKET_NOT_CLOSED");
        if (t.appeal_id) throw new ProblemError(409, "APPEAL_TICKET_CLOSED", "Open a new appeal instead");
        await ctx.db.transaction().execute((trx) => setStatus(ctx, trx, t, "open", "user", id.sub!));
        return { status: "open" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/tickets/:number/rating",
      summary: "Rate how we handled a closed ticket",
      tags,
      auth: "session",
      ...restricted,
      params: zNumber,
      body: z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(2000).optional() }),
      async handler({ params, body, id }) {
        const t = await ownTicket(params.number, id);
        if (t.status !== "closed") throw new ProblemError(409, "TICKET_NOT_CLOSED");
        if (t.rating !== null) throw new ProblemError(409, "ALREADY_RATED");
        await ctx.db.updateTable("tickets").set({ rating: body.rating, rating_comment: body.comment ?? null }).where("id", "=", t.id).execute();
        return { status: "rated" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/tickets/:number/attachments",
      summary: "Start an attachment upload",
      description: "Returns a short-lived presigned URL. The file goes straight to object storage, never through the gateway.",
      tags,
      auth: "session",
      ...restricted,
      rate_limit: ["account_write"],
      params: zNumber,
      body: zAttachmentInput,
      async handler({ params, body, id }) {
        return startUpload(ctx, await ownTicket(params.number, id), body, "user", id.sub!);
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/tickets/:number/attachments/:aid/complete",
      summary: "Finish an attachment upload",
      tags,
      auth: "session",
      ...restricted,
      params: zNumberAttachment,
      async handler({ params, id }) {
        return completeUpload(ctx, await ownTicket(params.number, id), params.aid);
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/support/tickets/:number/attachments/:aid",
      summary: "A short-lived download link for an attachment",
      tags,
      auth: "session",
      ...restricted,
      params: zNumberAttachment,
      async handler({ params, id }) {
        return downloadUrl(ctx, await ownTicket(params.number, id), params.aid);
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/guest/start",
      summary: "Verify an email address for a guest ticket",
      description: "Emails a short code. The response is the same whether or not the address has an account.",
      tags: ["support", "guest"],
      auth: "none",
      allow_pending_legal: true,
      captcha: true,
      rate_limit: ["guest_code"],
      rate_limit_keys: { email: "email" },
      body: z.object({ email: zEmail, captcha: zCaptcha }),
      async handler({ body }) {
        if (!features.guest_tickets.enabled || !features.tickets.enabled) throw new ProblemError(404, "GUEST_TICKETS_DISABLED");
        const code = numericCode(6);
        await ctx.valkey.set(guestCodeKey(body.email), JSON.stringify({ h: hashToken(code), n: 0 }), "PX", cfg.guest_code_ttl);
        await ctx.email(ctx.db, {
          template: "guest_ticket_code",
          to: { email: body.email },
          vars: { code, expires_minutes: Math.round(cfg.guest_code_ttl / 60_000) },
          sender: "support",
          priority: "high",
        });
        return { status: "code_sent" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/guest/tickets",
      summary: "Open a guest ticket",
      tags: ["support", "guest"],
      auth: "none",
      allow_pending_legal: true,
      captcha: true,
      rate_limit: ["guest_ticket"],
      body: z.object({ email: zEmail, code: z.string().regex(/^\d{6}$/), category: z.string().max(64), subject: zSubject, body: zBody, captcha: zCaptcha }),
      async handler({ body, id }) {
        if (!features.guest_tickets.enabled || !features.tickets.enabled) throw new ProblemError(404, "GUEST_TICKETS_DISABLED");
        const cat = category(ctx, body.category);
        if (!cat.guest_allowed || cat.appeal) throw new ProblemError(403, "CATEGORY_NOT_GUEST_ALLOWED");
        const key = guestCodeKey(body.email);
        const raw = await ctx.valkey.get(key);
        const state = raw ? (JSON.parse(raw) as { h: string; n: number }) : null;
        if (!state || state.n >= 5) throw new ProblemError(400, "INVALID_CODE");
        if (!safeEqual(state.h, hashToken(body.code))) {
          await ctx.valkey.set(key, JSON.stringify({ ...state, n: state.n + 1 }), "KEEPTTL");
          throw new ProblemError(400, "INVALID_CODE", undefined, {}, { "x-qtiauth-captcha-strike": "1" });
        }
        await ctx.valkey.del(key);
        const { ticket } = await ctx.db.transaction().execute((trx) => createTicket(ctx, trx, { user_id: null, guest_email: body.email, category: body.category, subject: body.subject, body: body.body, locale: id.locale }));
        return { number: ticket.number, status: "created", message: "We've emailed you a link to follow this ticket." };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/support/guest/tickets/:number",
      summary: "A guest ticket, using the link from the email",
      tags: ["support", "guest"],
      auth: "none",
      allow_pending_legal: true,
      rate_limit: ["auth_verify"],
      params: zNumber,
      query: z.object({ token: z.string().max(200) }),
      async handler({ params, query }) {
        return thread(await guestTicket(params.number, query.token));
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/guest/tickets/:number/replies",
      summary: "Reply to a guest ticket",
      tags: ["support", "guest"],
      auth: "none",
      allow_pending_legal: true,
      rate_limit: ["guest_ticket"],
      params: zNumber,
      body: z.object({ token: z.string().max(200), body: zBody, attachment_ids: zAttachmentIds }),
      async handler({ params, body }) {
        const t = await guestTicket(params.number, body.token);
        const m = await ctx.db.transaction().execute(async (trx) => {
          const msg = await addMessage(ctx, trx, t, { author_type: "guest", author_id: null, body: body.body });
          await linkAttachments(trx, t.id, msg.id, body.attachment_ids);
          return msg;
        });
        return messageView(m, { staff: false });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/guest/tickets/:number/attachments",
      summary: "Start an attachment upload on a guest ticket",
      tags: ["support", "guest"],
      auth: "none",
      allow_pending_legal: true,
      rate_limit: ["guest_ticket"],
      params: zNumber,
      body: zAttachmentInput.extend({ token: z.string().max(200) }),
      async handler({ params, body }) {
        return startUpload(ctx, await guestTicket(params.number, body.token), body, "guest", null);
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/guest/tickets/:number/attachments/:aid/complete",
      summary: "Finish an attachment upload on a guest ticket",
      tags: ["support", "guest"],
      auth: "none",
      allow_pending_legal: true,
      rate_limit: ["guest_ticket"],
      params: zNumberAttachment,
      body: z.object({ token: z.string().max(200) }),
      async handler({ params, body }) {
        return completeUpload(ctx, await guestTicket(params.number, body.token), params.aid);
      },
    }),
  ];
}
