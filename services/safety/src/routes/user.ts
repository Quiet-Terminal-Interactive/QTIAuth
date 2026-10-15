import { z } from "zod";
import { ProblemError, isUuid, uuidv7 } from "@qtiauth/common";
import { route, type AnyRoute } from "@qtiauth/service-kit";
import type { IdentityClaims } from "@qtiauth/auth-context";
import { actionView, appealView, createAppeal, createReport, cseaMetadata, classify, evidenceRetainUntil, sealEvidence, type Ctx } from "../lib.ts";

const tags = ["safety"];
const restrictedStates = ["active", "locked", "banned"] as const;

export const zUpload = z
  .object({
    uploaded_at: z.iso.datetime().nullable().optional(),
    ip: z.union([z.ipv4(), z.ipv6()]).nullable().optional(),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    ip_at: z.iso.datetime().nullable().optional(),
    exif: z
      .record(z.string(), z.unknown())
      .refine((v) => JSON.stringify(v).length <= 16_000, "EXIF data must be at most 16 KB")
      .nullable()
      .optional(),
    hash: z.object({ algorithm: z.string().trim().min(2).max(32), value: z.string().trim().min(8).max(256) }).nullable().optional(),
    platform: z.string().trim().max(100).nullable().optional(),
  })
  .nullable()
  .optional();

export const zContent = z
  .object({
    id: z.string().trim().min(1).max(200).nullable().optional(),
    type: z.string().trim().max(64).nullable().optional(),
    url: z.url().max(2000).nullable().optional(),
    upload: zUpload,
  })
  .nullable()
  .optional();

export const zSnapshot = z
  .record(z.string(), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 64_000, "Snapshot must be at most 64 KB")
  .nullable()
  .optional();

const zReportInput = z.object({
  type: z.string().max(64),
  subtype: z.string().max(64).nullable().optional(),
  reported_user_id: z.uuid().nullable().optional(),
  content: zContent,
  snapshot: zSnapshot,
  context: zSnapshot,
  description: z.string().trim().max(4000).nullable().optional(),
});

async function requireUserExists(ctx: Ctx, userId: string): Promise<void> {
  const u = await ctx.rpc<unknown | null>("identity.get_user_summary", { user_id: userId });
  if (!u) throw new ProblemError(404, "USER_NOT_FOUND");
}

function reportTarget(body: z.output<typeof zReportInput>, reporter: string | null): void {
  if (!body.reported_user_id && !body.content?.id) throw new ProblemError(422, "REPORT_TARGET_REQUIRED", "Report a user, a piece of content, or both");
  if (reporter && body.reported_user_id === reporter) throw new ProblemError(422, "CANNOT_REPORT_SELF");
}

export function userRoutes(ctx: Ctx): AnyRoute[] {
  const cfg = ctx.config.safety;

  async function submit(id: IdentityClaims, body: z.output<typeof zReportInput>, source: "user" | "game", reporter: string | null) {
    classify(ctx, body.type, body.subtype ?? null);
    reportTarget(body, reporter);
    if (body.reported_user_id) await requireUserExists(ctx, body.reported_user_id);
    const meta = cfg.taxonomy[body.type]?.csea ? await cseaMetadata(ctx, body.reported_user_id ?? null, reporter) : null;
    const report = await ctx.db.transaction().execute((trx) =>
      createReport(
        ctx,
        trx,
        {
          source,
          type: body.type,
          subtype: body.subtype ?? null,
          reporter_user_id: reporter,
          reporter_client_id: id.client_id ?? null,
          game_id: id.game_id ?? null,
          reported_user_id: body.reported_user_id ?? null,
          content: body.content ?? null,
          snapshot: body.snapshot ?? null,
          context: body.context ? { ...body.context, reporter_ip: id.ip } : { reporter_ip: id.ip },
          description: body.description ?? null,
        },
        meta,
      ),
    );
    return { report_id: report.id, reference: report.reference, status: report.status };
  }

  return [
    route({
      method: "GET",
      path: "/api/v1/safety/taxonomy",
      summary: "Report types, subtypes and rules for building a report form",
      tags,
      auth: "none",
      session_optional: true,
      allow_pending_legal: true,
      rate_limit: ["public_read"],
      async handler() {
        return {
          types: Object.entries(cfg.taxonomy).map(([id, t]) => ({
            id,
            label: t.label,
            subtypes: Object.entries(t.subtypes).map(([sid, s]) => ({ id: sid, label: s.label })),
          })),
          rules: Object.entries(cfg.rules).map(([id, r]) => ({ id, title: r.title, text: r.text })),
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/safety/reports",
      summary: "Report a user or content",
      description: "Signed-in users report from the account site; game clients report with the player's access token. Reporters are never identified to the reported user.",
      tags,
      auth: ["session", "oauth"],
      rate_limit: ["report_create"],
      body: zReportInput,
      async handler({ body, id }) {
        return submit(id, body, id.auth === "oauth" ? "game" : "user", id.sub!);
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/safety/intake/reports",
      summary: "Submit a report from a game server",
      description: "For games with chat or user-generated content. The game is taken from the server credential.",
      tags: ["safety", "intake"],
      auth: "service",
      scopes: ["safety.intake"],
      rate_limit: ["intake"],
      body: zReportInput.extend({ reporter_user_id: z.uuid().nullable().optional() }),
      async handler({ body, id }) {
        return submit(id, body, "game", body.reporter_user_id ?? null);
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/safety/intake/flags",
      summary: "Submit an automated flag",
      description: "Machine-generated flags with a score from 0 to 1. Flags at or above safety.flag_auto_report_threshold open a report in the moderation queue; the rest wait for review.",
      tags: ["safety", "intake"],
      auth: "service",
      scopes: ["safety.intake"],
      rate_limit: ["intake"],
      body: z.object({
        classifier: z.string().trim().min(1).max(100),
        score: z.number().min(0).max(1),
        labels: z.array(z.string().max(64)).max(20).default([]),
        type: z.string().max(64),
        subtype: z.string().max(64).nullable().optional(),
        user_id: z.uuid().nullable().optional(),
        content: zContent,
        snapshot: zSnapshot,
      }),
      async handler({ body, id }) {
        classify(ctx, body.type, body.subtype ?? null);
        const flagId = uuidv7();
        const auto = body.score >= cfg.flag_auto_report_threshold;
        const meta = auto && cfg.taxonomy[body.type]?.csea ? await cseaMetadata(ctx, body.user_id ?? null, null) : null;
        return ctx.db.transaction().execute(async (trx) => {
          await trx
            .insertInto("flags")
            .values({
              id: flagId,
              client_id: id.client_id ?? null,
              game_id: id.game_id ?? null,
              user_id: body.user_id ?? null,
              classifier: body.classifier,
              score: body.score,
              labels: JSON.stringify([body.type, ...(body.subtype ? [body.subtype] : []), ...body.labels]),
              content: body.content ? JSON.stringify(body.content) : null,
              snapshot: body.snapshot ? JSON.stringify(body.snapshot) : null,
              status: auto ? "reported" : "pending",
            })
            .execute();
          if (!auto) return { flag_id: flagId, report_id: null };
          const report = await createReport(
            ctx,
            trx,
            {
              source: "flag",
              type: body.type,
              subtype: body.subtype ?? null,
              reporter_user_id: null,
              reporter_client_id: id.client_id ?? null,
              game_id: id.game_id ?? null,
              reported_user_id: body.user_id ?? null,
              content: body.content ?? null,
              snapshot: body.snapshot ?? null,
              context: { classifier: body.classifier, score: body.score, labels: body.labels },
              description: null,
              flag_id: flagId,
            },
            meta,
          );
          await trx.updateTable("flags").set({ report_id: report.id }).where("id", "=", flagId).execute();
          return { flag_id: flagId, report_id: report.id };
        });
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/safety/intake/preservation-requests",
      summary: "Data preservation requests for this game",
      description: "When moderation needs a user's related data preserved, the game is asked for it here. Send what you hold for the user between window_start and window_end: chat logs, messages, comments, files with their metadata, location data and connections with other accounts.",
      tags: ["safety", "intake"],
      auth: "service",
      scopes: ["safety.intake"],
      rate_limit: ["intake"],
      async handler({ id }) {
        if (!id.game_id) return { items: [] };
        const rows = await ctx.db.selectFrom("preservation_requests").selectAll().where("game_id", "=", id.game_id).where("status", "=", "pending").orderBy("created_at").limit(100).execute();
        return {
          items: rows.map((r) => ({
            id: r.id,
            user_id: r.user_id,
            content: r.content ? { id: r.content.id ?? null, type: r.content.type ?? null } : null,
            window_start: r.window_start.toISOString(),
            window_end: r.window_end.toISOString(),
            created_at: r.created_at.toISOString(),
          })),
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/safety/intake/preservation-requests/:id",
      params: z.object({ id: z.string().min(1).max(128) }),
      summary: "Fulfil a data preservation request",
      description: "The data is encrypted into the evidence store and kept under legal hold. Send an empty object for anything you don't hold.",
      tags: ["safety", "intake"],
      auth: "service",
      scopes: ["safety.intake"],
      rate_limit: ["intake"],
      body_limit: 10_000_000,
      body: z.object({
        files: z.array(z.record(z.string(), z.unknown())).max(1000).default([]),
        messages: z.array(z.record(z.string(), z.unknown())).max(20_000).default([]),
        comments: z.array(z.record(z.string(), z.unknown())).max(20_000).default([]),
        connections: z.array(z.record(z.string(), z.unknown())).max(5000).default([]),
        geolocation: z.array(z.record(z.string(), z.unknown())).max(5000).default([]),
        other: z.record(z.string(), z.unknown()).default({}),
      }),
      async handler({ params, body, id }) {
        if (!id.game_id || !isUuid(params.id)) throw new ProblemError(404, "REQUEST_NOT_FOUND");
        const req = await ctx.db.selectFrom("preservation_requests").selectAll().where("id", "=", params.id).where("game_id", "=", id.game_id).executeTakeFirst();
        if (!req) throw new ProblemError(404, "REQUEST_NOT_FOUND");
        if (req.status !== "pending") throw new ProblemError(409, "REQUEST_NOT_PENDING");
        const c = await ctx.db.selectFrom("csea_cases").select(["nca_submitted_at", "foreign_reported_at", "closed_at"]).where("id", "=", req.case_id).executeTakeFirstOrThrow();
        const sent = c.nca_submitted_at ?? c.foreign_reported_at ?? c.closed_at;
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .insertInto("evidence")
            .values({
              id: uuidv7(),
              case_id: req.case_id,
              user_id: req.user_id,
              kind: "preservation",
              ciphertext: sealEvidence(ctx, req.case_id, { preservation_request_id: req.id, game_id: req.game_id, window_start: req.window_start.toISOString(), window_end: req.window_end.toISOString(), received_at: new Date().toISOString(), ...body }),
              destroy_after: sent ? evidenceRetainUntil(ctx, sent) : null,
            })
            .execute();
          await trx.updateTable("preservation_requests").set({ status: "fulfilled", fulfilled_at: new Date(), fulfilled_by: id.client_id ?? null }).where("id", "=", req.id).execute();
          await ctx.audit(trx, { actor: { type: "service", id: id.client_id ?? "game" }, action: "safety.preservation.fulfilled", target: { type: "preservation_request", id: req.id } });
        });
        return { status: "fulfilled" };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/safety/reports",
      summary: "Reports I've made and their status",
      tags,
      auth: "session",
      query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }),
      async handler({ query, id }) {
        const rows = await ctx.db
          .selectFrom("reports")
          .select(["id", "reference", "type", "status", "created_at", "resolved_at"])
          .where("reporter_user_id", "=", id.sub!)
          .orderBy("created_at", "desc")
          .limit(query.limit)
          .execute();
        return {
          items: rows.map((r) => ({
            id: r.id,
            reference: r.reference,
            type: r.type,
            type_label: cfg.taxonomy[r.type]?.label ?? r.type,
            status: r.status === "actioned" || r.status === "dismissed" ? "resolved" : "open",
            outcome: r.status === "actioned" ? "action_taken" : r.status === "dismissed" ? "no_action" : null,
            created_at: r.created_at.toISOString(),
            resolved_at: r.resolved_at?.toISOString() ?? null,
          })),
        };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/safety/actions/mine",
      summary: "Moderation actions on my account",
      description: "Available to locked and banned accounts so they can read the statement of reasons and appeal.",
      tags,
      auth: "session",
      allow_account_states: [...restrictedStates],
      allow_pending_legal: true,
      async handler({ id }) {
        const rows = await ctx.db.selectFrom("actions").selectAll().where("user_id", "=", id.sub!).where("status", "in", ["active", "completed", "lifted", "expired"]).orderBy("created_at", "desc").limit(100).execute();
        const appeals = await ctx.db.selectFrom("appeals").selectAll().where("user_id", "=", id.sub!).execute();
        return {
          items: rows.map((a) => {
            const ap = appeals.filter((x) => x.action_id === a.id).sort((x, y) => y.created_at.getTime() - x.created_at.getTime())[0];
            const appealable = a.status === "active" || a.status === "completed";
            return { ...actionView(ctx, a, { staff: false }), appeal: ap ? appealView(ap) : null, can_appeal: appealable && ap?.status !== "open" };
          }),
        };
      },
    }),

    route({
      method: "POST",
      path: "/api/v1/safety/appeals",
      summary: "Appeal a moderation action",
      description: "One open appeal per action. When Support is running the appeal is also opened as a support ticket.",
      tags,
      auth: "session",
      allow_account_states: [...restrictedStates],
      allow_pending_legal: true,
      rate_limit: ["report_create"],
      body: z.object({ action_id: z.uuid(), statement: z.string().trim().min(10).max(5000) }),
      async handler({ body, id }) {
        const action = await ctx.db.selectFrom("actions").selectAll().where("id", "=", body.action_id).executeTakeFirst();
        if (!action) throw new ProblemError(404, "ACTION_NOT_FOUND");
        const appeal = await ctx.db.transaction().execute((trx) => createAppeal(ctx, trx, { action, user_id: id.sub!, statement: body.statement }));
        const ticket = await ctx
          .rpcOptional<{ ticket_id: string; number: number } | null>(
            "support.create_appeal_ticket",
            { user_id: id.sub!, appeal_id: appeal.id, appeal_reference: appeal.reference, action_id: action.id, action_label: ctx.config.safety.actions[action.action_type]?.label ?? action.action_type, statement: body.statement },
            null,
          )
          .catch((err) => {
            ctx.log.warn({ err: (err as Error).message }, "could not open appeal ticket");
            return null;
          });
        if (ticket) await ctx.db.updateTable("appeals").set({ ticket_id: ticket.ticket_id, ticket_number: ticket.number }).where("id", "=", appeal.id).execute();
        return { ...appealView({ ...appeal, ticket_id: ticket?.ticket_id ?? null, ticket_number: ticket?.number ?? null }) };
      },
    }),

    route({
      method: "GET",
      path: "/api/v1/safety/appeals/mine",
      summary: "My appeals",
      tags,
      auth: "session",
      allow_account_states: [...restrictedStates],
      allow_pending_legal: true,
      async handler({ id }) {
        const rows = await ctx.db.selectFrom("appeals").selectAll().where("user_id", "=", id.sub!).orderBy("created_at", "desc").limit(100).execute();
        return { items: rows.map(appealView) };
      },
    }),
  ];
}
