import { sha256 } from "@qtiauth/common";
import { collapseSingletons, normalize, normalizeNoLeet, paddedWith, tokenize } from "./normalize.ts";

export type FilterRule =
  | "allowlist"
  | "exact_block"
  | "dictionary"
  | "token_block"
  | "token_padded_loose"
  | "padded_loose"
  | "unknown"
  | "empty";

export interface FilterDecision {
  action: "allow" | "block";
  rule: FilterRule;
  matched: string | null;
  normalized: string;
  input_hash: string;
}

export interface FilterLists {
  ldnoobw: string[];
  dictionary: Iterable<string>;
  names?: Iterable<string>;
  surnames?: Iterable<string>;
  places?: Iterable<string>;
  allow?: Iterable<string>;
  extraBlock?: Iterable<string>;
}

function clean(word: string): string {
  return normalize(word.trim()).replace(/\s+/g, "");
}

export class TextFilter {
  readonly A = new Set<string>();
  readonly D = new Set<string>();
  readonly Denglish = new Set<string>();
  readonly Bexact = new Set<string>();
  readonly Bloose = new Set<string>();
  readonly Bextra = new Set<string>();
  private looseSorted: string[] = [];
  private allBSorted: string[] = [];

  constructor(lists: FilterLists) {
    for (const w of lists.dictionary) {
      const c = clean(w);
      if (c) {
        this.D.add(c);
        this.Denglish.add(c);
      }
    }
    for (const src of [lists.names, lists.surnames, lists.places]) {
      if (!src) continue;
      for (const w of src) {
        const c = clean(w);
        if (c) this.D.add(c);
      }
    }
    for (const w of lists.allow ?? []) {
      const c = clean(w);
      if (c) this.A.add(c);
    }
    for (const raw of lists.ldnoobw) {
      const c = clean(raw);
      if (!c) continue;
      if (this.Denglish.has(c) || [...c].length <= 3) this.Bexact.add(c);
      else this.Bloose.add(c);
    }
    for (const w of lists.extraBlock ?? []) {
      const c = clean(w);
      if (c) this.Bextra.add(c);
    }
    this.reindex();
  }

  private reindex(): void {
    this.looseSorted = [...this.Bloose, ...[...this.Bextra].filter((w) => [...w].length > 3 && !this.Denglish.has(w))].sort((a, b) => b.length - a.length);
    this.allBSorted = [...this.Bexact, ...this.Bloose, ...this.Bextra].sort((a, b) => b.length - a.length);
  }

  inB(s: string): string | null {
    if (this.Bexact.has(s) || this.Bloose.has(s) || this.Bextra.has(s)) return s;
    return null;
  }

  addAllow(words: Iterable<string>): void {
    for (const w of words) {
      const c = clean(w);
      if (c) this.A.add(c);
    }
  }

  addBlock(words: Iterable<string>): void {
    for (const w of words) {
      const c = clean(w);
      if (c) this.Bextra.add(c);
    }
    this.reindex();
  }

  resetCustom(allow: Iterable<string>, block: Iterable<string>, baseAllow: Iterable<string>, baseBlock: Iterable<string>): void {
    this.A.clear();
    this.Bextra.clear();
    this.addAllow(baseAllow);
    this.addAllow(allow);
    for (const w of [...baseBlock, ...block]) {
      const c = clean(w);
      if (c) this.Bextra.add(c);
    }
    this.reindex();
  }

  check(raw: string): FilterDecision {
    const s = normalize(raw).replace(/\s+/g, "");
    const decision = (action: "allow" | "block", rule: FilterRule, matched: string | null = null): FilterDecision => ({
      action,
      rule,
      matched,
      normalized: s,
      input_hash: sha256(raw),
    });
    if (!s) return decision("allow", "empty");
    if (this.A.has(s)) return decision("allow", "allowlist", s);
    const whole = this.inB(s);
    if (whole) return decision("block", "exact_block", whole);
    if (this.D.has(s)) return decision("allow", "dictionary", s);

    const rawTokens = collapseSingletons(tokenize(raw));
    const normTokens = collapseSingletons(tokenize(s));
    const seen = new Set<string>();
    for (const tok of [...rawTokens, ...normTokens]) {
      const t = normalize(tok);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      if (this.A.has(t)) continue;
      const hit = this.inB(t);
      if (hit) return decision("block", "token_block", hit);
      if (this.D.has(t)) continue;
      const padded = paddedWith(t, this.looseSorted) ?? paddedWith(normalizeNoLeet(tok), this.looseSorted);
      if (padded) return decision("block", "token_padded_loose", padded);
    }
    const padded = paddedWith(s, this.looseSorted) ?? paddedWith(normalizeNoLeet(raw).replace(/\s+/g, ""), this.looseSorted);
    if (padded) return decision("block", "padded_loose", padded);
    return decision("allow", "unknown");
  }

  audit(): { word: string; contains: string }[] {
    const out: { word: string; contains: string }[] = [];
    const buckets = this.allBSorted.filter((b) => b.length >= 3);
    for (const w of this.D) {
      for (const b of buckets) {
        if (w !== b && w.includes(b)) {
          out.push({ word: w, contains: b });
          break;
        }
      }
    }
    return out.sort((a, b) => (a.contains === b.contains ? a.word.localeCompare(b.word) : a.contains.localeCompare(b.contains)));
  }

  stats(): Record<string, number> {
    return { A: this.A.size, D: this.D.size, B_exact: this.Bexact.size, B_loose: this.Bloose.size, B_extra: this.Bextra.size };
  }
}
