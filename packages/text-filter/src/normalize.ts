import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let confusables: Record<string, string> | null = null;

function loadConfusables(): Record<string, string> {
  if (confusables) return confusables;
  try {
    confusables = JSON.parse(readFileSync(fileURLToPath(new URL("../data/confusables.json", import.meta.url)), "utf8")) as Record<string, string>;
  } catch {
    confusables = {};
  }
  return confusables;
}

export function setConfusables(map: Record<string, string>): void {
  confusables = map;
}

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const COMBINING = /\p{M}/gu;

export const LEET: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

export function skeleton(input: string): string {
  const map = loadConfusables();
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) {
      out += ch;
      continue;
    }
    const mapped = map[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const decomposed = ch.normalize("NFD").replace(COMBINING, "");
    out += decomposed.length && [...decomposed].every((c) => c.codePointAt(0)! < 0x80) ? decomposed : ch;
  }
  return out;
}

export function stripInvisible(input: string): string {
  return input.replace(INVISIBLE, "");
}

export function leet(input: string): string {
  let out = "";
  for (const ch of input) out += LEET[ch] ?? ch;
  return out;
}

export function normalizeNoLeet(raw: string): string {
  return skeleton(stripInvisible(raw.normalize("NFKC"))).toLowerCase();
}

export function normalize(raw: string): string {
  return leet(normalizeNoLeet(raw));
}

export function tokenize(raw: string): string[] {
  const nfkc = stripInvisible(raw.normalize("NFKC"));
  const camelSplit = nfkc.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return camelSplit
    .split(/[\s_\-.0-9@$!#%^&*()+=\[\]{}|\\/:;"'<>,?~`]+/)
    .filter((t) => t.length > 0);
}

export function collapseSingletons(tokens: string[]): string[] {
  const out: string[] = [];
  let run = "";
  for (const t of tokens) {
    if ([...t].length === 1) {
      run += t;
      continue;
    }
    if (run) {
      out.push(run);
      run = "";
    }
    out.push(t);
  }
  if (run) out.push(run);
  return out;
}

const PADDING = /[0-9_\-.x]/g;

export function paddedWith(t: string, bucketLongestFirst: string[]): string | null {
  for (const b of bucketLongestFirst) {
    if (!b || !t.includes(b)) continue;
    const remainder = t.split(b).join("").replace(PADDING, "");
    if (remainder.length === 0) return b;
  }
  return null;
}
