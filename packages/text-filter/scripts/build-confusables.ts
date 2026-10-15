import { readFileSync, writeFileSync } from "node:fs";
import { buildConfusablesMap } from "../src/lists.ts";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: build-confusables.ts <confusables.txt> <out.json>");
  process.exit(2);
}
const map = buildConfusablesMap(readFileSync(src, "utf8"));
writeFileSync(out, `${JSON.stringify(map)}\n`);
console.log(`${Object.keys(map).length} confusables written to ${out}`);
