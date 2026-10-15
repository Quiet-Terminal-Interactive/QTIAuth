import { z } from "zod";
import { ProblemError, uuidv7 } from "@qtiauth/common";
import { sniffContentType } from "@qtiauth/service-kit";
import type { Attachment, AuthorType, Ticket } from "./db.ts";
import type { Ctx, Exec } from "./lib.ts";

export const zAttachmentInput = z.object({
  filename: z.string().trim().min(1).max(200),
  content_type: z.string().max(100),
  size: z.number().int().positive(),
});

export const zAttachmentIds = z.array(z.uuid()).max(20).default([]);

export function attachmentsEnabled(ctx: Ctx): boolean {
  return ctx.config.features.support.attachments.enabled && Boolean(ctx.storage);
}

function requireEnabled(ctx: Ctx): void {
  if (!attachmentsEnabled(ctx)) throw new ProblemError(404, "ATTACHMENTS_DISABLED");
}

export async function startUpload(ctx: Ctx, t: Ticket, input: z.output<typeof zAttachmentInput>, by: AuthorType, byId: string | null) {
  requireEnabled(ctx);
  const cfg = ctx.config.support.attachments;
  if (!cfg.allowed_types.includes(input.content_type)) throw new ProblemError(415, "ATTACHMENT_TYPE_NOT_ALLOWED", undefined, { allowed: cfg.allowed_types });
  if (input.size > cfg.max_bytes) throw new ProblemError(413, "ATTACHMENT_TOO_LARGE", undefined, { max_bytes: cfg.max_bytes });
  const pending = await ctx.db.selectFrom("attachments").select(ctx.db.fn.countAll<number>().as("n")).where("ticket_id", "=", t.id).where("message_id", "is", null).where("status", "!=", "rejected").executeTakeFirst();
  if (Number(pending?.n ?? 0) >= cfg.max_per_message) throw new ProblemError(409, "TOO_MANY_ATTACHMENTS", undefined, { max: cfg.max_per_message });
  const id = uuidv7();
  const key = `support/tickets/${t.id}/${id}`;
  await ctx.db
    .insertInto("attachments")
    .values({ id, ticket_id: t.id, storage_key: key, filename: input.filename.replace(/[\\/\r\n"]/g, "_"), declared_type: input.content_type, size: input.size, status: "pending", uploaded_by_type: by, uploaded_by: byId })
    .execute();
  const upload = await ctx.storage!.presignPut(key, input.content_type, input.size);
  return { attachment_id: id, upload };
}

function compatible(declared: string, sniffed: string): boolean {
  if (sniffed === "text/html") return false;
  if (declared === sniffed) return true;
  if (declared === "text/plain") return sniffed === "text/plain";
  return false;
}

export async function completeUpload(ctx: Ctx, t: Ticket, attachmentId: string) {
  requireEnabled(ctx);
  const a = await ctx.db.selectFrom("attachments").selectAll().where("id", "=", attachmentId).where("ticket_id", "=", t.id).executeTakeFirst();
  if (!a) throw new ProblemError(404, "ATTACHMENT_NOT_FOUND");
  if (a.status !== "pending") return attachmentView(a);
  const head = await ctx.storage!.head(a.storage_key);
  if (!head) throw new ProblemError(409, "UPLOAD_NOT_FOUND", "Upload the file before completing it");
  const sniffed = sniffContentType(await ctx.storage!.readHead(a.storage_key, 512));
  const ok = compatible(a.declared_type, sniffed) && head.size <= ctx.config.support.attachments.max_bytes;
  const updated = await ctx.db
    .updateTable("attachments")
    .set({ sniffed_type: sniffed, size: head.size, status: ok ? "ready" : "rejected" })
    .where("id", "=", a.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  if (!ok) {
    await ctx.storage!.delete(a.storage_key).catch(() => undefined);
    throw new ProblemError(415, "ATTACHMENT_CONTENT_MISMATCH", "The file's contents don't match its type", { sniffed_type: sniffed });
  }
  return attachmentView(updated);
}

export async function linkAttachments(trx: Exec, ticketId: string, messageId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const r = await trx.updateTable("attachments").set({ message_id: messageId }).where("ticket_id", "=", ticketId).where("id", "in", ids).where("status", "=", "ready").where("message_id", "is", null).executeTakeFirst();
  if (Number(r.numUpdatedRows) !== ids.length) throw new ProblemError(422, "ATTACHMENT_NOT_READY");
}

export async function downloadUrl(ctx: Ctx, t: Ticket, attachmentId: string) {
  requireEnabled(ctx);
  const a = await ctx.db.selectFrom("attachments").selectAll().where("id", "=", attachmentId).where("ticket_id", "=", t.id).where("status", "=", "ready").executeTakeFirst();
  if (!a) throw new ProblemError(404, "ATTACHMENT_NOT_FOUND");
  const url = await ctx.storage!.presignGet(a.storage_key, { filename: a.filename, attachment: true, contentType: a.sniffed_type ?? a.declared_type, ttlSeconds: 300 });
  return { url, filename: a.filename, content_type: a.sniffed_type ?? a.declared_type, non_image_warning: !(a.sniffed_type ?? "").startsWith("image/") };
}

export function attachmentView(a: Attachment) {
  return { id: a.id, message_id: a.message_id, filename: a.filename, content_type: a.sniffed_type ?? a.declared_type, size: a.size, status: a.status, is_image: (a.sniffed_type ?? "").startsWith("image/"), created_at: a.created_at.toISOString() };
}

export async function deleteTicketObjects(ctx: Ctx, ticketIds: string[]): Promise<void> {
  if (!ctx.storage || !ticketIds.length) return;
  for (const id of ticketIds) await ctx.storage.deletePrefix(`support/tickets/${id}/`).catch((err) => ctx.log.warn({ err }, "attachment cleanup failed"));
}
