import { z } from "zod";
import { ProblemError } from "@qtiauth/common";
import { reply, route, type AnyRoute } from "@qtiauth/service-kit";
import type { Ctx } from "../lib/ctx.ts";
import { zDob, zEmailIn, zLegalAcceptance, zToken } from "./common.ts";
import { consumeToken, issueToken, peekToken } from "../lib/tokens.ts";
import { displayName, normalizeEmail, requireUser } from "../lib/users.ts";
import {
  activitySummary,
  approveConsent,
  childOverview,
  decideRequest,
  declineConsent,
  familyAccessUrl,
  guardianAssurance,
  guardianRowsForPrincipal,
  requireGuardianOf,
  startGuardianConsent,
  updateControls,
} from "../lib/parental.ts";
import { acceptDocuments, pendingDocumentsFor, latestVersions } from "../lib/legal.ts";
import { createSession, metaFrom, revokeSession, sessionList } from "../lib/sessions.ts";
import { requestExport } from "../lib/exports.ts";
import { requestDeletion } from "../lib/deletion.ts";

const tags = ["family"];
const guardianSession = { auth: "session" as const, principals: ["guardian" as const, "user" as const], allow_pending_legal: true };

const zControls = z.object({
  approve_third_party_apps: z.boolean().optional(),
  online_play: z.boolean().optional(),
  in_game_chat: z.boolean().optional(),
  user_generated_content: z.boolean().optional(),
  purchases: z.boolean().optional(),
  daily_playtime_minutes: z.number().int().min(0).max(1440).nullable().optional(),
  leaderboards: z.boolean().optional(),
  public_profile: z.boolean().optional(),
  username_changes_require_approval: z.boolean().optional(),
});

export function familyRoutes(ctx: Ctx): AnyRoute[] {
  return [
    route({
      method: "POST",
      path: "/api/v1/family/consent/lookup",
      summary: "Look up a consent request from its link",
      description: "Shows the guardian what they are being asked to approve: the service, the data collected and the children's privacy summary.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_verify"],
      body: z.object({ token: zToken }),
      async handler({ body }) {
        const t = await peekToken(ctx.db, "guardian_consent", body.token);
        if (!t) throw new ProblemError(400, "INVALID_OR_EXPIRED_TOKEN");
        const child = await requireUser(ctx.db, t.user_id!);
        const latest = await latestVersions(ctx.db);
        return {
          child: { display_name: displayName(child), email: child.email, username: child.username },
          product_name: ctx.config.branding.product_name,
          company_name: ctx.config.branding.company_name,
          documents: [...latest.values()].map((d) => ({ id: d.id, version: d.version, title: d.title, summary: d.summary, requires_acceptance: d.requires_acceptance })),
          expires_at: t.expires_at.toISOString(),
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/family/consent/approve",
      summary: "Approve a child's account",
      description: "The guardian confirms they are an adult and accepts the terms on the child's behalf. Signs the guardian in to the family dashboard.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_verify"],
      body: z.object({ token: zToken, guardian_dob: zDob, display_name: z.string().max(80).optional(), accept_legal: zLegalAcceptance }),
      async handler({ body, id }) {
        return ctx.db.transaction().execute(async (trx) => {
          const t = await consumeToken(trx, "guardian_consent", body.token);
          const child = await requireUser(trx, t.user_id!);
          await guardianAssurance(ctx, trx, child, body.guardian_dob);
          const latest = await latestVersions(trx);
          for (const req of ctx.config.legal.required_at_signup) {
            const v = latest.get(req);
            if (v && !body.accept_legal.some((a) => a.id === req && a.version === v.version)) throw new ProblemError(422, "LEGAL_ACCEPTANCE_REQUIRED", undefined, { document_id: req, version: v.version });
          }
          const { guardian } = await approveConsent(ctx, trx, String(t.data.guardian_id), { guardian_dob: body.guardian_dob, display_name: body.display_name });
          await acceptDocuments(ctx, trx, child.id, body.accept_legal, { ip: id.ip, method: "guardian", guardianId: guardian.id });
          const created = await createSession(ctx, trx, { guardianId: guardian.id, principal: "guardian", aal: 1, amr: ["email"], method: "guardian_link", meta: metaFrom(id), ttlMs: ctx.config.parental.guardian_session_ttl });
          return reply(200, { status: "approved", child_id: child.id }, created.headers);
        });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/family/consent/decline",
      summary: "Decline a child's account",
      description: "The account and its data are deleted.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_verify"],
      body: z.object({ token: zToken }),
      async handler({ body }) {
        await ctx.db.transaction().execute(async (trx) => {
          const t = await consumeToken(trx, "guardian_consent", body.token);
          await declineConsent(ctx, trx, String(t.data.guardian_id));
        });
        return { status: "declined" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/family/access",
      summary: "Email a family dashboard sign-in link",
      description: "Guardians do not need an account. The response is identical whether or not the email belongs to a guardian.",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["magic_link_email", "magic_link_ip"],
      rate_limit_keys: { email: "email" },
      captcha: true,
      body: z.object({ email: zEmailIn }),
      async handler({ body }) {
        await ctx.db.transaction().execute(async (trx) => {
          const rows = await trx.selectFrom("guardians").selectAll().where("email_normalized", "=", normalizeEmail(ctx.config, body.email)).where("status", "=", "active").execute();
          if (!rows.length) return;
          const { token } = await issueToken(trx, "guardian_access", { email: rows[0]!.email, data: { guardian_id: rows[0]!.id }, ttlMs: ctx.config.parental.access_link_ttl });
          await ctx.email(trx, {
            template: "guardian_access_link",
            to: { email: rows[0]!.email, guardian_id: rows[0]!.id },
            vars: { link_url: familyAccessUrl(ctx, token) },
            sender: "auth",
            priority: "high",
          });
        });
        return { status: "sent_if_exists" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/family/access/verify",
      summary: "Sign in to the family dashboard with a link",
      tags,
      auth: "none",
      session_optional: true,
      rate_limit: ["auth_verify"],
      body: z.object({ token: zToken }),
      async handler({ body, id }) {
        return ctx.db.transaction().execute(async (trx) => {
          const t = await consumeToken(trx, "guardian_access", body.token);
          const g = await trx.selectFrom("guardians").selectAll().where("id", "=", String(t.data.guardian_id)).where("status", "=", "active").executeTakeFirst();
          if (!g) throw new ProblemError(400, "INVALID_OR_EXPIRED_TOKEN");
          if (id.sub && id.principal !== "guardian") {
            await trx.updateTable("guardians").set({ user_id: id.sub }).where("email_normalized", "=", g.email_normalized).where("user_id", "is", null).execute();
            return { status: "linked" };
          }
          const created = await createSession(ctx, trx, { guardianId: g.id, principal: "guardian", aal: 1, amr: ["email"], method: "guardian_link", meta: metaFrom(id), ttlMs: ctx.config.parental.guardian_session_ttl });
          return reply(200, { status: "signed_in" }, created.headers);
        });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/family/children",
      summary: "Children linked to this guardian",
      tags,
      ...guardianSession,
      async handler({ id }) {
        const rows = await guardianRowsForPrincipal(ctx.db, id);
        const out = [];
        for (const g of rows) {
          const child = await requireUser(ctx.db, g.child_user_id).catch(() => null);
          if (child) out.push(await childOverview(ctx, ctx.db, child));
        }
        return { items: out };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/family/children/:id",
      summary: "One child's overview",
      tags,
      ...guardianSession,
      params: z.object({ id: z.uuid() }),
      async handler({ params, id }) {
        await requireGuardianOf(ctx.db, id, params.id);
        const child = await requireUser(ctx.db, params.id);
        const pending = await pendingDocumentsFor(ctx.db, child);
        return { ...(await childOverview(ctx, ctx.db, child)), pending_legal: pending.map((d) => ({ id: d.id, version: d.version, title: d.title, summary: d.summary })) };
      },
    }),

    route({
      method: "PATCH",
      path: "/api/v1/family/children/:id/controls",
      summary: "Change parental controls",
      description: "Game restrictions reach games through the internal identity token and the parental_controls claim.",
      tags,
      ...guardianSession,
      rate_limit: ["account_write"],
      params: z.object({ id: z.uuid() }),
      body: zControls,
      async handler({ params, body, id }) {
        const g = await requireGuardianOf(ctx.db, id, params.id);
        const child = await requireUser(ctx.db, params.id);
        const controls = await ctx.db.transaction().execute((trx) => updateControls(ctx, trx, child, body as never, { type: "guardian", id: g.id }));
        return { controls };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/family/children/:id/sessions",
      summary: "A child's sessions and devices",
      tags,
      ...guardianSession,
      params: z.object({ id: z.uuid() }),
      async handler({ params, id }) {
        await requireGuardianOf(ctx.db, id, params.id);
        return { items: await sessionList(ctx.db, params.id) };
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/family/children/:id/sessions/:sid",
      summary: "Revoke one of a child's sessions",
      tags,
      ...guardianSession,
      rate_limit: ["account_write"],
      params: z.object({ id: z.uuid(), sid: z.uuid() }),
      async handler({ params, id }) {
        const g = await requireGuardianOf(ctx.db, id, params.id);
        const s = await ctx.db.selectFrom("sessions").select(["id", "user_id"]).where("id", "=", params.sid).executeTakeFirst();
        if (!s || s.user_id !== params.id) throw new ProblemError(404, "SESSION_NOT_FOUND");
        await ctx.db.transaction().execute(async (trx) => {
          await revokeSession(ctx, trx, s.id, "guardian_revoked", { type: "guardian", id: g.id });
          await ctx.audit(trx, { actor: { type: "guardian", id: g.id }, action: "parental.session_revoked", target: { type: "user", id: params.id } });
        });
        return { status: "revoked" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/family/children/:id/activity",
      summary: "Activity summary",
      description: "Sign-ins, games played, playtime and apps connected. Never any content.",
      tags,
      ...guardianSession,
      params: z.object({ id: z.uuid() }),
      query: z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }),
      async handler({ params, query, id }) {
        await requireGuardianOf(ctx.db, id, params.id);
        return activitySummary(ctx, ctx.db, params.id, query.days * 86_400_000);
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/family/children/:id/requests/:rid",
      summary: "Approve or deny a request",
      description: "Requests cover third-party app approvals, username changes and removing the guardian link (which the guardian must approve).",
      tags,
      ...guardianSession,
      rate_limit: ["account_write"],
      params: z.object({ id: z.uuid(), rid: z.uuid() }),
      body: z.object({ approve: z.boolean() }),
      async handler({ params, body, id }) {
        const g = await requireGuardianOf(ctx.db, id, params.id);
        const r = await ctx.db.transaction().execute((trx) => decideRequest(ctx, trx, g, params.rid, body.approve));
        return { status: body.approve ? "approved" : "denied", type: r.type };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/family/children/:id/guardians",
      summary: "Invite another guardian",
      tags,
      ...guardianSession,
      rate_limit: ["magic_link_ip"],
      params: z.object({ id: z.uuid() }),
      body: z.object({ email: zEmailIn }),
      async handler({ params, body, id }) {
        const g = await requireGuardianOf(ctx.db, id, params.id);
        const child = await requireUser(ctx.db, params.id);
        const count = await ctx.db.selectFrom("guardians").select("id").where("child_user_id", "=", child.id).where("status", "in", ["active", "pending"]).execute();
        if (count.length >= ctx.config.parental.max_guardians) throw new ProblemError(409, "MAX_GUARDIANS_REACHED");
        await ctx.db.transaction().execute((trx) => startGuardianConsent(ctx, trx, child, body.email, g.id));
        return reply(202, { status: "invited" });
      },
    }),

    route({
      method: "DELETE",
      path: "/api/v1/family/children/:id/guardians/me",
      summary: "Stop being a guardian",
      description: "Allowed when another guardian remains or the child has reached the adult band.",
      tags,
      ...guardianSession,
      rate_limit: ["account_write"],
      params: z.object({ id: z.uuid() }),
      async handler({ params, id }) {
        const g = await requireGuardianOf(ctx.db, id, params.id);
        const child = await requireUser(ctx.db, params.id);
        const others = await ctx.db.selectFrom("guardians").select("id").where("child_user_id", "=", child.id).where("status", "=", "active").where("id", "<>", g.id).execute();
        const { bandOf } = await import("../lib/users.ts");
        if (!others.length && bandOf(ctx, child) !== "adult") throw new ProblemError(409, "LAST_GUARDIAN");
        await ctx.db.transaction().execute(async (trx) => {
          await trx.updateTable("guardians").set({ status: "removed", removed_at: new Date() }).where("id", "=", g.id).execute();
          await ctx.audit(trx, { actor: { type: "guardian", id: g.id }, action: "parental.guardian_left", target: { type: "user", id: child.id } });
        });
        return { status: "removed" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/family/children/:id/legal/accept",
      summary: "Accept updated terms on a child's behalf",
      tags,
      ...guardianSession,
      rate_limit: ["account_write"],
      params: z.object({ id: z.uuid() }),
      body: z.object({ documents: z.array(z.object({ id: z.string().max(64), version: z.string().max(64) })).min(1).max(20) }),
      async handler({ params, body, id }) {
        const g = await requireGuardianOf(ctx.db, id, params.id);
        await ctx.db.transaction().execute((trx) => acceptDocuments(ctx, trx, params.id, body.documents, { ip: id.ip, method: "guardian", guardianId: g.id }));
        return { status: "accepted" };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/family/children/:id/export",
      summary: "Request a data export for a child",
      tags,
      ...guardianSession,
      rate_limit: ["account_write"],
      params: z.object({ id: z.uuid() }),
      async handler({ params, id }) {
        const g = await requireGuardianOf(ctx.db, id, params.id);
        const exportId = await ctx.db.transaction().execute((trx) => requestExport(ctx, trx, params.id, g.id));
        return reply(202, { id: exportId, status: "pending" });
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/family/children/:id/delete",
      summary: "Request deletion of a child's account",
      tags,
      ...guardianSession,
      rate_limit: ["account_write"],
      params: z.object({ id: z.uuid() }),
      body: z.object({ confirm: z.literal(true) }),
      async handler({ params, id }) {
        const g = await requireGuardianOf(ctx.db, id, params.id);
        const child = await requireUser(ctx.db, params.id);
        const due = await ctx.db.transaction().execute((trx) => requestDeletion(ctx, trx, child, { type: "guardian", id: g.id }));
        return { status: "pending_deletion", due_at: due.toISOString() };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/family/me",
      summary: "The signed-in guardian",
      tags,
      ...guardianSession,
      async handler({ id }) {
        const rows = await guardianRowsForPrincipal(ctx.db, id);
        return { email: rows[0]?.email ?? null, display_name: rows[0]?.display_name ?? null, children: rows.length, linked_account: Boolean(rows[0]?.user_id) };
      },
    }),
  ];
}

export function legalRoutes(ctx: Ctx): AnyRoute[] {
  const pub = { auth: "none" as const, session_optional: true, rate_limit: ["public_read"], tags: ["legal"] };
  return [
    route({
      method: "GET",
      path: "/api/v1/legal",
      summary: "Current legal documents",
      ...pub,
      async handler() {
        const { currentVersions, latestVersions } = await import("../lib/legal.ts");
        const current = await currentVersions(ctx.db);
        const latest = await latestVersions(ctx.db);
        return {
          items: [...latest.values()].map((l) => {
            const c = current.get(l.id);
            return {
              id: l.id,
              title: (c ?? l).title,
              current_version: c?.version ?? null,
              effective_at: c?.effective_at.toISOString() ?? null,
              upcoming: l.effective_at > new Date() ? { version: l.version, effective_at: l.effective_at.toISOString(), material: l.material, summary: l.summary } : null,
              requires_acceptance: l.requires_acceptance,
            };
          }),
          public_history: ctx.config.legal.public_history,
          accountable_person: ctx.config.safety.accountable_person,
        };
      },
    }),
    route({
      method: "GET",
      path: "/api/v1/legal/:id",
      summary: "A legal document (current version)",
      ...pub,
      params: z.object({ id: z.string().max(64) }),
      async handler({ params }) {
        const { currentVersions, latestVersions } = await import("../lib/legal.ts");
        const v = (await currentVersions(ctx.db)).get(params.id) ?? (await latestVersions(ctx.db)).get(params.id);
        if (!v) throw new ProblemError(404, "DOCUMENT_NOT_FOUND");
        return documentBody(ctx, params.id, v.version);
      },
    }),
    route({
      method: "GET",
      path: "/api/v1/legal/:id/versions",
      summary: "Version history of a legal document",
      description: "Only available when legal.public_history is true.",
      ...pub,
      params: z.object({ id: z.string().max(64) }),
      async handler({ params }) {
        if (!ctx.config.legal.public_history) throw new ProblemError(404, "HISTORY_NOT_PUBLIC");
        const rows = await ctx.db.selectFrom("legal_documents").select(["version", "effective_at", "material", "summary", "title"]).where("id", "=", params.id).orderBy("effective_at", "desc").execute();
        return { items: rows.map((r) => ({ version: r.version, effective_at: r.effective_at.toISOString(), material: r.material, summary: r.summary, title: r.title })) };
      },
    }),
    route({
      method: "GET",
      path: "/api/v1/legal/:id/:version",
      summary: "A specific version of a legal document",
      ...pub,
      params: z.object({ id: z.string().max(64), version: z.string().max(64) }),
      async handler({ params }) {
        const { currentVersions } = await import("../lib/legal.ts");
        const current = (await currentVersions(ctx.db)).get(params.id);
        const isUpcoming = !(await ctx.db.selectFrom("legal_documents").select("effective_at").where("id", "=", params.id).where("version", "=", params.version).where("effective_at", "<=", new Date()).executeTakeFirst());
        if (!ctx.config.legal.public_history && current?.version !== params.version && !isUpcoming) throw new ProblemError(404, "HISTORY_NOT_PUBLIC");
        return documentBody(ctx, params.id, params.version);
      },
    }),
  ];
}

async function documentBody(ctx: Ctx, id: string, version: string) {
  const row = await ctx.db.selectFrom("legal_documents").selectAll().where("id", "=", id).where("version", "=", version).executeTakeFirst();
  if (!row) throw new ProblemError(404, "DOCUMENT_NOT_FOUND");
  const { renderMarkdown } = await import("../lib/markdown.ts");
  const vars = {
    product_name: ctx.config.branding.product_name,
    company_name: ctx.config.branding.company_name,
    support_email: ctx.config.branding.support_email,
    accountable_person_name: ctx.config.safety.accountable_person.name,
    accountable_person_role: ctx.config.safety.accountable_person.role,
  };
  const body = row.body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k: string) => (k in vars ? String(vars[k as keyof typeof vars]) : m));
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    effective_at: row.effective_at.toISOString(),
    material: row.material,
    summary: row.summary,
    markdown: body,
    html: renderMarkdown(body),
  };
}
