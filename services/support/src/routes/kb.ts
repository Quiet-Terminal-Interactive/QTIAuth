import { z } from "zod";
import { sql } from "kysely";
import { ProblemError, inc, sha256, uuidv7 } from "@qtiauth/common";
import { renderMarkdown, markdownToText, slugify } from "@qtiauth/markdown";
import { reply, route, type AnyRoute, zSlug, zUuidParam } from "@qtiauth/service-kit";
import type { Article } from "../db.ts";
import type { Ctx, Exec } from "../lib.ts";

const tags = ["support", "kb"];
const editor = { auth: "session" as const, permissions: ["support.kb.edit"], rate_limit: ["admin"] };
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

const zArticle = z.object({
  title: z.string().trim().min(3).max(200),
  slug: zSlug.optional(),
  category_id: z.uuid().nullable().optional(),
  body: z.string().max(200_000),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).default([]),
  status: z.enum(["draft", "published"]).default("draft"),
  note: z.string().trim().max(500).optional(),
});

const zCategory = z.object({
  name: z.string().trim().min(1).max(100),
  slug: zSlug.optional(),
  description: z.string().trim().max(500).default(""),
  icon: z.string().trim().max(64).nullable().optional(),
  sort_order: z.number().int().min(-1000).max(1000).default(0),
});

function summary(a: Pick<Article, "body">): string {
  const text = markdownToText(a.body);
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

function listView(a: Article) {
  return { id: a.id, slug: a.slug, title: a.title, summary: summary(a), tags: a.tags, category_id: a.category_id, updated_at: a.updated_at.toISOString(), published_at: a.published_at?.toISOString() ?? null };
}

export interface DiffLine {
  op: " " | "+" | "-";
  line: string;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000) return [...a.map((line) => ({ op: "-" as const, line })), ...b.map((line) => ({ op: "+" as const, line }))];
  const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: "-", line: a[i++]! });
    else out.push({ op: "+", line: b[j++]! });
  }
  while (i < a.length) out.push({ op: "-", line: a[i++]! });
  while (j < b.length) out.push({ op: "+", line: b[j++]! });
  return out;
}

export async function suggestArticles(ctx: Ctx, text: string, limit = 5) {
  if (!ctx.config.features.support.kb.enabled || text.trim().length < 3) return [];
  const rows = await ctx.db
    .selectFrom("kb_articles")
    .select(["id", "slug", "title", sql<number>`ts_rank(search, websearch_to_tsquery('english', ${text}))`.as("rank")])
    .where("status", "=", "published")
    .where("deleted_at", "is", null)
    .where(sql<boolean>`search @@ to_tsquery('english', ${orQuery(text)})`)
    .orderBy("rank", "desc")
    .limit(limit)
    .execute()
    .catch(() => []);
  return rows.map((r) => ({ id: r.id, slug: r.slug, title: r.title }));
}

function orQuery(text: string): string {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2)
    .slice(0, 12);
  return words.length ? words.map((w) => `${w}:*`).join(" | ") : "''";
}

async function filterWarning(ctx: Ctx, title: string): Promise<string | null> {
  const d = await ctx.rpcOptional<{ action: string; rule: string } | null>("identity.filter_text", { text: title, context: "kb_title" }, null).catch(() => null);
  return d?.action === "block" ? "The title may contain offensive language. Check it before publishing." : null;
}

async function uniqueSlug(db: Exec, table: "kb_articles" | "kb_categories", wanted: string, exceptId?: string): Promise<string> {
  const base = wanted || "article";
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    let q = db.selectFrom(table).select("id").where("slug", "=", candidate);
    if (exceptId) q = q.where("id", "!=", exceptId);
    if (!(await q.executeTakeFirst())) return candidate;
  }
  throw new ProblemError(409, "SLUG_TAKEN");
}

export function kbRoutes(ctx: Ctx): AnyRoute[] {
  const kb = ctx.config.features.support.kb;

  function requireKb(): void {
    if (!kb.enabled) throw new ProblemError(404, "KB_DISABLED");
  }

  async function publishedBySlug(slug: string): Promise<Article> {
    requireKb();
    const a = await ctx.db.selectFrom("kb_articles").selectAll().where("slug", "=", slug).where("status", "=", "published").where("deleted_at", "is", null).executeTakeFirst();
    if (!a) throw new ProblemError(404, "ARTICLE_NOT_FOUND");
    return a;
  }

  async function loadArticle(id: string): Promise<Article> {
    const a = await ctx.db.selectFrom("kb_articles").selectAll().where("id", "=", id).where("deleted_at", "is", null).executeTakeFirst();
    if (!a) throw new ProblemError(404, "ARTICLE_NOT_FOUND");
    return a;
  }

  const pub = { auth: "none" as const, session_optional: true, allow_pending_legal: true, rate_limit: ["public_read"] };

  return [
    route({
      method: "GET",
      path: "/api/v1/support/kb/categories",
      summary: "Knowledge base categories",
      tags,
      ...pub,
      async handler() {
        requireKb();
        const rows = await ctx.db
          .selectFrom("kb_categories")
          .leftJoin("kb_articles", (j) => j.onRef("kb_articles.category_id", "=", "kb_categories.id").on("kb_articles.status", "=", "published").on("kb_articles.deleted_at", "is", null))
          .select(["kb_categories.id", "kb_categories.slug", "kb_categories.name", "kb_categories.description", "kb_categories.icon", "kb_categories.sort_order", sql<number>`count(kb_articles.id)::int`.as("article_count")])
          .groupBy("kb_categories.id")
          .orderBy("kb_categories.sort_order")
          .orderBy("kb_categories.name")
          .execute();
        return { items: rows };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/support/kb/articles",
      summary: "Published articles",
      tags,
      ...pub,
      query: z.object({ category: z.string().max(80).optional(), tag: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
      async handler({ query }) {
        requireKb();
        let q = ctx.db.selectFrom("kb_articles").selectAll("kb_articles").where("kb_articles.status", "=", "published").where("kb_articles.deleted_at", "is", null);
        if (query.category) q = q.innerJoin("kb_categories", "kb_categories.id", "kb_articles.category_id").where("kb_categories.slug", "=", query.category);
        if (query.tag) q = q.where(sql<boolean>`kb_articles.tags ? ${query.tag}`);
        const rows = await q.orderBy("kb_articles.title").limit(query.limit).execute();
        return { items: rows.map(listView) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/support/kb/search",
      summary: "Search the knowledge base",
      description: "Postgres full-text search, weighted title > tags > body.",
      tags,
      ...pub,
      query: z.object({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().min(1).max(50).default(20) }),
      async handler({ query }) {
        requireKb();
        const rows = await ctx.db
          .selectFrom("kb_articles")
          .selectAll()
          .select([sql<number>`ts_rank(search, websearch_to_tsquery('english', ${query.q}))`.as("rank"), sql<string>`ts_headline('english', body, websearch_to_tsquery('english', ${query.q}), 'MaxWords=30, MinWords=10, StartSel=«, StopSel=»')`.as("headline")])
          .where("status", "=", "published")
          .where("deleted_at", "is", null)
          .where(sql<boolean>`search @@ websearch_to_tsquery('english', ${query.q})`)
          .orderBy("rank", "desc")
          .limit(query.limit)
          .execute();
        return { items: rows.map((r) => ({ ...listView(r), excerpt: r.headline.replace(/[<>]/g, "") })) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/support/kb/suggest",
      summary: "Related articles for a ticket subject",
      tags,
      ...pub,
      query: z.object({ q: z.string().trim().max(200) }),
      async handler({ query }) {
        return { items: await suggestArticles(ctx, query.q) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/support/kb/articles/:slug",
      summary: "An article, rendered",
      description: "Markdown is rendered server-side with raw HTML disabled.",
      tags,
      ...pub,
      params: z.object({ slug: zSlug }),
      async handler({ params }) {
        const a = await publishedBySlug(params.slug);
        await ctx.db.updateTable("kb_articles").set({ views: sql`views + 1` }).where("id", "=", a.id).execute();
        inc("qtiauth_support_kb_views_total", {}, 1, "Knowledge base article views");
        const cat = a.category_id ? await ctx.db.selectFrom("kb_categories").select(["slug", "name"]).where("id", "=", a.category_id).executeTakeFirst() : null;
        const related = await suggestArticles(ctx, `${a.title} ${a.tags.join(" ")}`, 6);
        return {
          ...listView(a),
          html: renderMarkdown(a.body),
          category: cat ?? null,
          helpful: { yes: a.helpful_yes, no: a.helpful_no },
          related: related.filter((r) => r.id !== a.id).slice(0, 5),
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/support/kb/articles/:slug/feedback",
      summary: "Was this helpful?",
      description: "Rate-limited per IP and counted once per session.",
      tags,
      auth: "none",
      session_optional: true,
      allow_pending_legal: true,
      rate_limit: ["kb_feedback"],
      params: z.object({ slug: zSlug }),
      body: z.object({ helpful: z.boolean() }),
      async handler({ params, body, id }) {
        const a = await publishedBySlug(params.slug);
        const voter = sha256(id.sid ? `sid:${id.sid}` : `ip:${id.ip}:${id.ua ?? ""}`);
        await ctx.db.transaction().execute(async (trx) => {
          const prev = await trx.selectFrom("kb_feedback").select("helpful").where("article_id", "=", a.id).where("voter_key", "=", voter).executeTakeFirst();
          if (prev?.helpful === body.helpful) return;
          await trx
            .insertInto("kb_feedback")
            .values({ article_id: a.id, voter_key: voter, helpful: body.helpful })
            .onConflict((oc) => oc.columns(["article_id", "voter_key"]).doUpdateSet({ helpful: body.helpful, created_at: new Date() }))
            .execute();
          const yes = (body.helpful ? 1 : 0) - (prev?.helpful === true ? 1 : 0);
          const no = (body.helpful ? 0 : 1) - (prev?.helpful === false ? 1 : 0);
          await trx.updateTable("kb_articles").set({ helpful_yes: sql`helpful_yes + ${yes}`, helpful_no: sql`helpful_no + ${no}` }).where("id", "=", a.id).execute();
        });
        inc("qtiauth_support_kb_feedback_total", { helpful: String(body.helpful) }, 1, "Knowledge base feedback");
        return { status: "recorded" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/support/kb/images/:id",
      summary: "A knowledge base image",
      tags,
      ...pub,
      params: zUuidParam,
      async handler({ params }) {
        if (!ctx.storage) throw new ProblemError(404, "IMAGE_NOT_FOUND");
        const img = await ctx.db.selectFrom("kb_images").selectAll().where("id", "=", params.id).executeTakeFirst();
        if (!img) throw new ProblemError(404, "IMAGE_NOT_FOUND");
        const url = await ctx.storage.presignGet(img.storage_key, { attachment: false, contentType: img.content_type, ttlSeconds: 3600 });
        return reply(302, undefined, { location: url, "cache-control": "public, max-age=3000" });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/support/kb/articles",
      summary: "All articles, including drafts",
      tags: ["admin", ...tags],
      ...editor,
      query: z.object({ status: z.enum(["draft", "published", "all"]).default("all"), q: z.string().trim().max(200).optional() }),
      async handler({ query }) {
        let q = ctx.db.selectFrom("kb_articles").selectAll().where("deleted_at", "is", null);
        if (query.status !== "all") q = q.where("status", "=", query.status);
        if (query.q) q = q.where(sql<boolean>`search @@ websearch_to_tsquery('english', ${query.q})`);
        const rows = await q.orderBy("updated_at", "desc").limit(500).execute();
        return { items: rows.map((a) => ({ ...listView(a), status: a.status, views: a.views, helpful: { yes: a.helpful_yes, no: a.helpful_no } })) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/support/kb/articles/:id",
      summary: "An article for editing",
      tags: ["admin", ...tags],
      ...editor,
      params: zUuidParam,
      async handler({ params }) {
        const a = await loadArticle(params.id);
        return { ...listView(a), body: a.body, status: a.status, html: renderMarkdown(a.body), views: a.views, helpful: { yes: a.helpful_yes, no: a.helpful_no }, created_at: a.created_at.toISOString() };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/support/kb/articles",
      summary: "Create an article",
      tags: ["admin", ...tags],
      ...editor,
      body: zArticle,
      async handler({ body, id }) {
        requireKb();
        const warning = await filterWarning(ctx, body.title);
        const a = await ctx.db.transaction().execute(async (trx) => {
          const slug = await uniqueSlug(trx, "kb_articles", body.slug ?? slugify(body.title));
          const row = await trx
            .insertInto("kb_articles")
            .values({ id: uuidv7(), slug, category_id: body.category_id ?? null, title: body.title, body: body.body, tags: JSON.stringify(body.tags), status: body.status, published_at: body.status === "published" ? new Date() : null, author_id: id.sub!, updated_by: id.sub! })
            .returningAll()
            .executeTakeFirstOrThrow();
          await trx.insertInto("kb_revisions").values({ id: uuidv7(), article_id: row.id, title: row.title, body: row.body, tags: JSON.stringify(body.tags), author_id: id.sub!, note: body.note ?? "Created" }).execute();
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "support.kb.article_created", target: { type: "kb_article", id: row.id } });
          return row;
        });
        return { ...listView(a), status: a.status, warning };
      },
    }),

    route({
      method: "PUT",
      path: "/api/v1/admin/support/kb/articles/:id",
      summary: "Update an article",
      description: "Every save records a revision.",
      tags: ["admin", ...tags],
      ...editor,
      params: zUuidParam,
      body: zArticle,
      async handler({ params, body, id }) {
        const existing = await loadArticle(params.id);
        const warning = await filterWarning(ctx, body.title);
        const a = await ctx.db.transaction().execute(async (trx) => {
          const slug = body.slug && body.slug !== existing.slug ? await uniqueSlug(trx, "kb_articles", body.slug, existing.id) : existing.slug;
          const row = await trx
            .updateTable("kb_articles")
            .set({
              slug,
              category_id: body.category_id ?? null,
              title: body.title,
              body: body.body,
              tags: JSON.stringify(body.tags),
              status: body.status,
              published_at: body.status === "published" ? (existing.published_at ?? new Date()) : null,
              updated_by: id.sub!,
              updated_at: new Date(),
            })
            .where("id", "=", existing.id)
            .returningAll()
            .executeTakeFirstOrThrow();
          const changed = existing.title !== body.title || existing.body !== body.body || JSON.stringify(existing.tags) !== JSON.stringify(body.tags);
          if (changed) await trx.insertInto("kb_revisions").values({ id: uuidv7(), article_id: row.id, title: row.title, body: row.body, tags: JSON.stringify(body.tags), author_id: id.sub!, note: body.note ?? null }).execute();
          return row;
        });
        return { ...listView(a), status: a.status, warning };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/admin/support/kb/articles/:id",
      summary: "Delete an article",
      tags: ["admin", ...tags],
      ...editor,
      params: zUuidParam,
      async handler({ params, id }) {
        const a = await loadArticle(params.id);
        await ctx.db.transaction().execute(async (trx) => {
          await trx.updateTable("kb_articles").set({ deleted_at: new Date(), slug: `${a.slug}--deleted-${a.id.slice(0, 8)}` }).where("id", "=", a.id).execute();
          await ctx.audit(trx, { actor: { type: "staff", id: id.sub! }, action: "support.kb.article_deleted", target: { type: "kb_article", id: a.id } });
        });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/support/kb/articles/:id/revisions",
      summary: "Revision history",
      tags: ["admin", ...tags],
      ...editor,
      params: zUuidParam,
      async handler({ params }) {
        await loadArticle(params.id);
        const rows = await ctx.db.selectFrom("kb_revisions").select(["id", "title", "author_id", "note", "created_at"]).where("article_id", "=", params.id).orderBy("created_at", "desc").limit(200).execute();
        return { items: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/admin/support/kb/articles/:id/revisions/:rev/diff",
      summary: "Diff a revision against the current article",
      tags: ["admin", ...tags],
      ...editor,
      params: z.object({ id: z.uuid(), rev: z.uuid() }),
      async handler({ params }) {
        const a = await loadArticle(params.id);
        const r = await ctx.db.selectFrom("kb_revisions").selectAll().where("id", "=", params.rev).where("article_id", "=", a.id).executeTakeFirst();
        if (!r) throw new ProblemError(404, "REVISION_NOT_FOUND");
        return { revision: { id: r.id, title: r.title, created_at: r.created_at.toISOString() }, title_changed: r.title !== a.title, diff: lineDiff(r.body, a.body) };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/support/kb/articles/:id/revisions/:rev/restore",
      summary: "Restore a revision",
      tags: ["admin", ...tags],
      ...editor,
      params: z.object({ id: z.uuid(), rev: z.uuid() }),
      async handler({ params, id }) {
        const a = await loadArticle(params.id);
        const r = await ctx.db.selectFrom("kb_revisions").selectAll().where("id", "=", params.rev).where("article_id", "=", a.id).executeTakeFirst();
        if (!r) throw new ProblemError(404, "REVISION_NOT_FOUND");
        await ctx.db.transaction().execute(async (trx) => {
          await trx.updateTable("kb_articles").set({ title: r.title, body: r.body, tags: JSON.stringify(r.tags), updated_by: id.sub!, updated_at: new Date() }).where("id", "=", a.id).execute();
          await trx.insertInto("kb_revisions").values({ id: uuidv7(), article_id: a.id, title: r.title, body: r.body, tags: JSON.stringify(r.tags), author_id: id.sub!, note: `Restored revision from ${r.created_at.toISOString()}` }).execute();
        });
        return { status: "restored" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/support/kb/categories",
      summary: "Create a category",
      tags: ["admin", ...tags],
      ...editor,
      body: zCategory,
      async handler({ body }) {
        requireKb();
        const slug = await uniqueSlug(ctx.db, "kb_categories", body.slug ?? slugify(body.name));
        return ctx.db.insertInto("kb_categories").values({ id: uuidv7(), slug, name: body.name, description: body.description, icon: body.icon ?? null, sort_order: body.sort_order }).returningAll().executeTakeFirstOrThrow();
      },
    }),

    route({
      method: "PUT",
      path: "/api/v1/admin/support/kb/categories/:id",
      summary: "Update a category",
      tags: ["admin", ...tags],
      ...editor,
      params: zUuidParam,
      body: zCategory,
      async handler({ params, body }) {
        const slug = body.slug ? await uniqueSlug(ctx.db, "kb_categories", body.slug, params.id) : undefined;
        const r = await ctx.db
          .updateTable("kb_categories")
          .set({ name: body.name, description: body.description, icon: body.icon ?? null, sort_order: body.sort_order, ...(slug ? { slug } : {}) })
          .where("id", "=", params.id)
          .executeTakeFirst();
        if (!Number(r.numUpdatedRows)) throw new ProblemError(404, "CATEGORY_NOT_FOUND");
        return { status: "updated" };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/admin/support/kb/categories/:id",
      summary: "Delete a category",
      description: "Articles in it become uncategorised.",
      tags: ["admin", ...tags],
      ...editor,
      params: zUuidParam,
      async handler({ params }) {
        await ctx.db.deleteFrom("kb_categories").where("id", "=", params.id).execute();
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/admin/support/kb/images",
      summary: "Start a knowledge base image upload",
      tags: ["admin", ...tags],
      ...editor,
      body: z.object({ content_type: z.enum(IMAGE_TYPES as [string, ...string[]]), size: z.number().int().positive() }),
      async handler({ body, id }) {
        if (!ctx.config.features.support.kb_images.enabled || !ctx.storage) throw new ProblemError(404, "KB_IMAGES_DISABLED");
        if (body.size > ctx.config.support.kb_image_max_bytes) throw new ProblemError(413, "IMAGE_TOO_LARGE");
        const imageId = uuidv7();
        const key = `support/kb/${imageId}`;
        await ctx.db.insertInto("kb_images").values({ id: imageId, storage_key: key, content_type: body.content_type, size: body.size, uploaded_by: id.sub! }).execute();
        const upload = await ctx.storage.presignPut(key, body.content_type, body.size);
        const url = `${ctx.surfaces.support.apiPath}/v1/support/kb/images/${imageId}`;
        return { image_id: imageId, upload, markdown: `![](${url})`, url };
      },
    }),
  ];
}
