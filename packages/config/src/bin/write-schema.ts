import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { configJsonSchema } from "../load.ts";

const out = resolve(process.argv[2] ?? "config/qtiauth.schema.json");
writeFileSync(out, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
console.log(`Wrote ${out}`);
