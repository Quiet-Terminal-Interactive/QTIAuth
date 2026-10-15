import { z } from "zod";
import { sql } from "kysely";
import { ProblemError, decodeCursor, encodeCursor, uuidv7 } from "@qtiauth/common";
import { route, type AnyRoute, zUuidParam } from "@qtiauth/service-kit";
import { addMessage, category, messageView, setStatus, ticketView, type Ctx } from "../lib.ts";
import { attachmentView, downloadUrl, linkAttachments, startUpload, zAttachmentIds, zAttachmentInput } from "../attachments.ts";
import { suggestArticles } from "./kb.ts";
import type { Ticket } from "../db.ts";

const tags = ["admin", "support"];
const staff = (permissions: string[] = ["support.tickets.staff"]) => ({ auth: "session" as const, permissions, rate_limit: ["admin"] });
const zNumber = z.object({ number: z.coerce.number().int().positive() });
const zStatus = z.enum(["open", "waiting_on_user", "on_hold", "closed"]);
const zPriority = z.enum(["low", "normal", "high", "urgent"]);

export function staffRoutes(ctx: Ctx): AnyRoute[] {
  async function load(number: number): Promise<Ticket> {
    const t = await ctx.db.selectFrom("tickets").selectAll().where("number", "=", number).executeTakeFirst();
    if (!t) throw new ProblemError(404, "TICKET_NOT_FOUND");
    return t;
  }

  async function users(ids: (string | null)[]): Promise<Record<string, unknown>> {
    const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    return unique.length ? ctx.rpcOptional<Record<string, unknown>>("identity.get_users", { ids: unique }, {}) : {};
  }

  return [
    route({
      method: "GET",
      path: "/api/v1/admin/support/tickets",
      summary: "Ticket queue",
      tags,
      ...staff(),
      query: z.object({
        status: z.enum(["open", "waiting_on_user", "on_hold", "closed", "active", "all"]).default("active"),
        category: z.string().max(64).optional(),
        priority: zPriority.optional(),
        assignee: z.union([z.uuid(), z.literal("me"), z.literal("none")]).optional(),
        q: z.string().trim().max(200).optional(),
        cursor: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      async handler({ query, id }) {
        const offset = Number(decodeCursor<{ o: number }>(query.cursor)?.o ?? 0);
        let q = ctx.db.selectFrom("tickets").selectAll();
        if (query.status === "active") q = q.where("status", "in", ["open", "on_hold", "waiting_on_user"]);
        else if (query.status !== "all") q = q.where("status", "=", query.status);
        if (query.category) q = q.where("category", "=", query.category);
        if (query.priority) q = q.where("priority", "=", query.priority);
        if (query.assignee === "me") q = q.where("assignee_id", "=", id.sub!);
        else if (query.assignee === "none") q = q.where("assignee_id", "is", null);
        else if (query.assignee) q = q.where("assignee_id", "=", query.assignee);
        if (query.q) {
          const n = /^#?(\d+)$/.exec(query.q);
          q = n ? q.where("number", "=", Number(n[1])) : q.where(sql<boolean>`search @@ plainto_tsquery('simple', ${query.q})`);
        }
        const rows = await q
          .orderBy(sql`case status when 'open' then 0 when 'on_hold' then 1 when 'waiting_on_user' then 2 else 3 end`)
          .orderBy(sql`case priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`)
          .orderBy("updated_at")
          .offset(offset)
          .limit(query.limit + 1)
          .execute();
        const page = rows.slice(0, query.limit);
        const u = await users(page.flatMap((t) => [t.user_id, t.assignee_id]));
        return {
          items: page.map((t) => ({ ...ticketView(ctx, t), requester: t.user_id ? (u[t.user_id] ?? null) : { guest_email: t.guest_email }, assignee: t.assignee_id ? (u[t.assignee_id] ?? null) : null })),
          next_cursor: rows.length > query.limit ? encodeCursor({ o: offset + query.limit }) : null,
        };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/support/tickets/:number",
      summary: "Ticket detail with internal notes",
      tags,
      ...staff(),
      params: zNumber,
      async handler({ params }) {
        const t = await load(params.number);
        const messages = await ctx.db.selectFrom("messages").selectAll().where("ticket_id", "=", t.id).orderBy("created_at").execute();
        const attachments = await ctx.db.selectFrom("attachments").selectAll().where("ticket_id", "=", t.id).where("status", "=", "ready").execute();
        const u = await users([t.user_id, t.assignee_id, ...messages.map((m) => m.author_id)]);
        const other = t.user_id
          ? await ctx.db.selectFrom("tickets").select(["number", "subject", "status", "created_at"]).where("user_id", "=", t.user_id).where("id", "!=", t.id).orderBy("created_at", "desc").limit(10).execute()
          : [];
        return {
          ...ticketView(ctx, t),
          requester: t.user_id ? (u[t.user_id] ?? null) : { guest_email: t.guest_email },
          assignee: t.assignee_id ? (u[t.assignee_id] ?? null) : null,
          rating_comment: t.rating_comment,
          first_response_at: t.first_response_at?.toISOString() ?? null,
          messages: messages.map((m) => ({ ...messageView(m, { staff: true }), author: m.author_id ? (u[m.author_id] ?? null) : null, attachments: attachments.filter((a) => a.message_id === m.id).map(attachmentView) })),
          other_tickets: other.map((o) => ({ ...o, created_at: o.created_at.toISOString() })),
          suggested_articles: await suggestArticles(ctx, t.subject, 3),
          macros: await macroList(ctx),
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/support/tickets/:number/replies",
      summary: "Reply or add an internal note",
      tags,
      ...staff(),
      params: zNumber,
      body: z.object({ body: z.string().trim().min(1).max(20_000), internal: z.boolean().default(false), status: zStatus.optional(), attachment_ids: zAttachmentIds }),
      async handler({ params, body, id }) {
        const t = await load(params.number);
        const m = await ctx.db.transaction().execute(async (trx) => {
          const msg = await addMessage(ctx, trx, t, { author_type: "staff", author_id: id.sub!, body: body.body, internal: body.internal, status: body.status });
          await linkAttachments(trx, t.id, msg.id, body.attachment_ids);
          if (!t.assignee_id && !body.internal) await trx.updateTable("tickets").set({ assignee_id: id.sub! }).where("id", "=", t.id).execute();
          if (body.internal && body.status) await setStatus(ctx, trx, t, body.status, "staff", id.sub!);
          return msg;
        });
        return messageView(m, { staff: true });
      },
    }),

    route({
      method: "PATCH",
      path: "/api/v1/admin/support/tickets/:number",
      summary: "Change status, priority, category or assignee",
      tags,
      ...staff(),
      params: zNumber,
      body: z.object({ status: zStatus.optional(), priority: zPriority.optional(), category: z.string().max(64).optional(), assignee_id: z.union([z.uuid(), z.literal("me")]).nullable().optional() }),
      async handler({ params, body, id }) {
        const t = await load(params.number);
        if (body.category) category(ctx, body.category);
        await ctx.db.transaction().execute(async (trx) => {
          const assignee = body.assignee_id === "me" ? id.sub! : body.assignee_id;
          await trx
            .updateTable("tickets")
            .set({
              ...(body.priority ? { priority: body.priority } : {}),
              ...(body.category ? { category: body.category } : {}),
              ...(assignee !== undefined ? { assignee_id: assignee } : {}),
              updated_at: new Date(),
            })
            .where("id", "=", t.id)
            .execute();
          if (body.status) await setStatus(ctx, trx, t, body.status, "staff", id.sub!);
        });
        return ticketView(ctx, await load(params.number));
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/support/tickets/:number/attachments",
      summary: "Start a staff attachment upload",
      tags,
      ...staff(),
      params: zNumber,
      body: zAttachmentInput,
      async handler({ params, body, id }) {
        return startUpload(ctx, await load(params.number), body, "staff", id.sub!);
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/support/tickets/:number/attachments/:aid",
      summary: "Download an attachment",
      description: "non_image_warning is true for anything that isn't an image, so the UI can warn before opening it.",
      tags,
      ...staff(),
      params: z.object({ number: z.coerce.number().int().positive(), aid: z.uuid() }),
      async handler({ params }) {
        return downloadUrl(ctx, await load(params.number), params.aid);
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/support/macros",
      summary: "Canned responses",
      tags,
      ...staff(),
      async handler() {
        return { items: await macroList(ctx) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/support/macros",
      summary: "Create a canned response",
      tags,
      ...staff(["support.macros.manage"]),
      body: z.object({ title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(20_000) }),
      async handler({ body, id }) {
        const row = await ctx.db.insertInto("macros").values({ id: uuidv7(), title: body.title, body: body.body, created_by: id.sub! }).returningAll().executeTakeFirstOrThrow();
        return { id: row.id, title: row.title, body: row.body, source: "custom" };
      },
    }),

    route({
      method: "PUT",
      path: "/api/v1/admin/support/macros/:id",
      summary: "Edit a canned response",
      tags,
      ...staff(["support.macros.manage"]),
      params: zUuidParam,
      body: z.object({ title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(20_000) }),
      async handler({ params, body }) {
        const r = await ctx.db.updateTable("macros").set({ title: body.title, body: body.body, updated_at: new Date() }).where("id", "=", params.id).executeTakeFirst();
        if (!Number(r.numUpdatedRows)) throw new ProblemError(404, "MACRO_NOT_FOUND");
        return { status: "updated" };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/admin/support/macros/:id",
      summary: "Delete a canned response",
      tags,
      ...staff(["support.macros.manage"]),
      params: zUuidParam,
      async handler({ params }) {
        await ctx.db.deleteFrom("macros").where("id", "=", params.id).execute();
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/support/metrics",
      summary: "Staff metrics",
      description: "First response time, resolution time and CSAT, per agent and per category.",
      tags,
      ...staff(),
      query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
      async handler({ query }) {
        const since = new Date(Date.now() - query.days * 86_400_000);
        const agg = (group: "assignee_id" | "category") =>
          ctx.db
            .selectFrom("tickets")
            .select([
              sql<string | null>`${sql.ref(group)}::text`.as("key"),
              sql<number>`count(*)::int`.as("tickets"),
              sql<number>`count(*) filter (where status = 'closed')::int`.as("closed"),
              sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from first_response_at - created_at)) filter (where first_response_at is not null)`.as("median_first_response_s"),
              sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from closed_at - created_at)) filter (where closed_at is not null)`.as("median_resolution_s"),
              sql<number | null>`avg(rating)::float`.as("csat_avg"),
              sql<number>`count(rating)::int`.as("ratings"),
            ])
            .where("created_at", ">=", since)
            .groupBy(group)
            .execute();
        const [byAgent, byCategory] = await Promise.all([agg("assignee_id"), agg("category")]);
        const dist = await ctx.db.selectFrom("tickets").select(["rating", sql<number>`count(*)::int`.as("n")]).where("rating", "is not", null).where("created_at", ">=", since).groupBy("rating").execute();
        const round = (v: number | null) => (v === null ? null : Math.round(Number(v)));
        const u = await users(byAgent.map((a) => a.key));
        return {
          since: since.toISOString(),
          per_agent: byAgent.map((a) => ({ ...a, agent: a.key ? (u[a.key] ?? null) : null, median_first_response_s: round(a.median_first_response_s), median_resolution_s: round(a.median_resolution_s) })),
          per_category: byCategory.map((c) => ({ ...c, median_first_response_s: round(c.median_first_response_s), median_resolution_s: round(c.median_resolution_s) })),
          csat_distribution: Object.fromEntries(dist.map((d) => [String(d.rating), d.n])),
        };
      },
    }),
  ];
}

async function macroList(ctx: Ctx) {
  const rows = await ctx.db.selectFrom("macros").selectAll().orderBy("title").execute();
  return [...ctx.config.support.macros.map((m) => ({ id: m.id, title: m.title, body: m.body, source: "config" })), ...rows.map((m) => ({ id: m.id, title: m.title, body: m.body, source: "custom" }))];
}
