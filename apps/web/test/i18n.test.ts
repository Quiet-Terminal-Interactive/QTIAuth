import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { enGB } from "../src/i18n/en-GB.ts";

const SRC = join(import.meta.dirname, "../src");
const files = [...readdirSync(join(SRC, "pages")).map((f) => join(SRC, "pages", f)), join(SRC, "ui.tsx"), join(SRC, "nav.ts")].filter((f) => /\.tsx?$/.test(f));

describe("web i18n", () => {
  it("only uses keys that exist in the en-GB catalogue", () => {
    const missing: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/\.t\("([a-z0-9_.]+)"/g)) {
        if (!(m[1]! in enGB)) missing.push(`${f.slice(SRC.length + 1)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has no hard-coded English labels or text in pages", () => {
    const found: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/\b(label|hint|aria-label|title)="[A-Z][a-z]/.test(line) || />\s*[A-Z][a-z]+( [a-z]+)+\s*</.test(line)) found.push(`${f.slice(SRC.length + 1)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(found).toEqual([]);
  });
});
