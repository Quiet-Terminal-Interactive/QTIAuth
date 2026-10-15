import { parse as parseYaml } from "yaml";

export function parseFrontMatter(source: string): { data: Record<string, unknown>; body: string } {
  const normalized = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!m) return { data: {}, body: normalized };
  const data = (parseYaml(m[1]!) ?? {}) as Record<string, unknown>;
  return { data, body: m[2]!.replace(/^\n+/, "") };
}
