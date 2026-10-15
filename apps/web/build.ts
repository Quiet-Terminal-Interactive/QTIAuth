import { build } from "esbuild";

await build({
  absWorkingDir: import.meta.dirname,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  packages: "external",
  jsx: "automatic",
  jsxImportSource: "hono/jsx",
  sourcemap: true,
  logLevel: "info",
});
