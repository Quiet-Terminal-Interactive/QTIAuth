import { z } from "zod";

export const zUuid = z.uuid();
export const zEmail = z.email().max(254).transform((e) => e.trim());
export const zCursor = z.string().max(1024).optional();
export const zLimit = z.coerce.number().int().min(1).max(100).default(25);
export const zPage = z.object({ cursor: zCursor, limit: zLimit });
export const zReason = z.string().trim().min(3).max(2000);
export const zBool = z.union([z.boolean(), z.enum(["true", "false", "1", "0", "on", "off"]).transform((v) => v === "true" || v === "1" || v === "on")]);
export const zIdParam = z.object({ id: z.string().min(1).max(128) });
export const zUuidParam = z.object({ id: z.uuid() });
export const zSlug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const zCaptcha = z.string().max(8192).optional();

export function pageResponse<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), next_cursor: z.string().nullable() });
}
