import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCAN = ["packages", "services", "apps", "scripts", "deploy", "config/qtiauth.yaml"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".yaml", ".yml", ".mjml", ".txt", ".css", ".html", ".md"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git", "data", "lists", "test"]);
const SKIP_FILES = new Set(["scripts/check-literals.ts", "packages/text-filter/data/confusables.json"]);

const ALLOWED_HOSTS = [
  /(^|\.)example\.(com|org|net)$/,
  /^localhost$/,
  /(^|\.)qtiauth\.qtidocs\.dev$/,
  /^(specs|schemas)\.openid\.net$/,
  /^(www\.)?standardwebhooks\.com$/,
  /^(api\.)?github\.com$/,
  /^raw\.githubusercontent\.com$/,
  /^discord\.com$/,
  /^accounts\.google\.com$/,
  /^(oauth2|openidconnect|www)\.googleapis\.com$/,
  /^steamcommunity\.com$/,
  /^(api|partner)\.steampowered\.com$/,
  /^partner\.steam-api\.com$/,
  /^api\.pwnedpasswords\.com$/,
  /^challenges\.cloudflare\.com$/,
  /^(api|js)\.hcaptcha\.com$/,
  /^hcaptcha\.com$/,
  /^fonts\.(googleapis|gstatic)\.com$/,
  /^apt\.postgresql\.org$/,
  /^(www\.)?postgresql\.org$/,
  /^api\.friendlycaptcha\.com$/,
  /^api\.(brevo|resend|postmarkapp)\.com$/,
  /^api(\.eu)?\.mailgun\.net$/,
  /(^|\.)amazonaws\.com$/,
  /^download\.(geonames|db-ip)\.org$/,
  /^(www\.)?(geonames|unicode)\.org$/,
  /^(www\.)?db-ip\.com$/,
  /^download\.maxmind\.com$/,
  /^www2\.census\.gov$/,
  /^(app|wordlist)\.aspell\.net$/,
  /^hooks\.slack\.com$/,
  /^cdn\.jsdelivr\.net$/,
  /^(www\.)?w3\.org$/,
  /^(www\.)?ietf\.org$/,
  /^(www\.)?rfc-editor\.org$/,
  /^(www\.)?ofcom\.org\.uk$/,
  /^(www\.)?gov\.uk$/,
  /^grafana\.com$/,
  /^(www\.)?nats\.io$/,
];

const BUILTIN_FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bQTI_/, reason: "reserved username prefix" },
  { pattern: /quiet\s*terminal/i, reason: "brand name" },
];

function extraForbidden(): { pattern: RegExp; reason: string }[] {
  const raw = process.env.QTIAUTH_FORBIDDEN_LITERALS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ({ pattern: new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), reason: "deployment literal from QTIAUTH_FORBIDDEN_LITERALS" }));
}

function* files(path: string): Generator<string> {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (EXTENSIONS.has(extname(path))) yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    yield* files(join(path, entry));
  }
}

const HOST_RE = /\bhttps?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?=[/:"'`\s)>]|$)/g;

export function findViolations(text: string, forbidden = [...BUILTIN_FORBIDDEN, ...extraForbidden()]): { line: number; message: string }[] {
  const out: { line: number; message: string }[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.includes("check-literals: allow")) return;
    for (const f of forbidden) if (f.pattern.test(line)) out.push({ line: i + 1, message: `${f.reason}: ${line.trim().slice(0, 120)}` });
    for (const m of line.matchAll(HOST_RE)) {
      const host = m[1]!.toLowerCase();
      if (!ALLOWED_HOSTS.some((re) => re.test(host))) out.push({ line: i + 1, message: `hostname ${host} is not on the allowlist (deployment domains belong in config)` });
    }
  });
  return out;
}

function main(): number {
  let count = 0;
  for (const target of SCAN) {
    for (const file of files(join(ROOT, target))) {
      const rel = relative(ROOT, file);
      if (SKIP_FILES.has(rel)) continue;
      for (const v of findViolations(readFileSync(file, "utf8"))) {
        console.log(`${rel}:${v.line}: ${v.message}`);
        count++;
      }
    }
  }
  if (count) {
    console.log(`\n${count} deployment-specific literal(s) found. Move them to config, or add "check-literals: allow" on the line if it's a third-party API.`);
    return 1;
  }
  console.log("No deployment-specific literals found.");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exit(main());
