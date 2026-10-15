import { configFile } from "@qtiauth/config";
import { inc, uuidv7 } from "@qtiauth/common";
import { filterFromDirectory, type FilterDecision, type LoadedLists, type TextFilter } from "@qtiauth/text-filter";
import type { Ctx, Exec } from "./ctx.ts";

let filter: TextFilter | null = null;
let base: LoadedLists | null = null;

export function loadFilter(ctx: Ctx): TextFilter {
  const dir = configFile(ctx.config, ctx.config.text_filter.lists_directory);
  const loaded = filterFromDirectory(dir);
  filter = loaded.filter;
  base = loaded.lists;
  ctx.log.info({ ...filter.stats(), ldnoobw_commit: loaded.lists.ldnoobwCommit }, "text filter loaded");
  return filter;
}

export function getFilter(): TextFilter {
  if (!filter) throw new Error("Text filter not loaded");
  return filter;
}

export async function reloadCustomEntries(ctx: Ctx): Promise<void> {
  const f = getFilter();
  const rows = await ctx.db.selectFrom("filter_entries").select(["list", "word"]).execute();
  f.resetCustom(
    rows.filter((r) => r.list === "allow").map((r) => r.word),
    rows.filter((r) => r.list === "block").map((r) => r.word),
    base?.allow ?? [],
    base?.extraBlock ?? [],
  );
}

export async function checkText(ctx: Ctx, db: Exec, text: string, context: string): Promise<FilterDecision> {
  const decision = getFilter().check(text);
  inc("qtiauth_text_filter_decisions_total", { rule: decision.rule, action: decision.action }, 1, "Text filter decisions");
  if (decision.rule === "unknown") inc("qtiauth_text_filter_unknowns_total", {}, 1, "Text filter unknowns logged");
  await db
    .insertInto("filter_decisions")
    .values({
      id: uuidv7(),
      input_hash: decision.input_hash,
      raw_input: text.slice(0, 500),
      normalized: decision.normalized.slice(0, 500),
      rule: decision.rule,
      matched: decision.matched,
      action: decision.action,
      context: context.slice(0, 64),
    })
    .execute();
  return decision;
}
