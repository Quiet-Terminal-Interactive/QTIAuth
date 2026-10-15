export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export function encodeCursor(values: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(values)).toString("base64url");
}

export function decodeCursor<T extends Record<string, unknown>>(cursor: string | null | undefined): T | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function pageOf<T>(rows: T[], limit: number, cursorOf: (last: T) => Record<string, unknown>): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, next_cursor: rows.length > limit && last ? encodeCursor(cursorOf(last)) : null };
}

export function clampLimit(limit: number | undefined, def = 25, max = 100): number {
  if (!limit || Number.isNaN(limit)) return def;
  return Math.min(Math.max(1, Math.floor(limit)), max);
}
