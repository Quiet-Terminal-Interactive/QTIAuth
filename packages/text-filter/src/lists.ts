import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { TextFilter } from "./filter.ts";

export const LIST_FILES = {
  ldnoobw: "ldnoobw-en.txt",
  dictionary: "dictionary.txt",
  names: "names.txt",
  surnames: "surnames.txt",
  places: "places.txt",
  allow: "allow.txt",
  extraBlock: "extra-block.txt",
} as const;

export function readList(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

export interface LoadedLists {
  ldnoobw: string[];
  dictionary: string[];
  names: string[];
  surnames: string[];
  places: string[];
  allow: string[];
  extraBlock: string[];
  ldnoobwCommit: string | null;
}

export function loadLists(dir: string): LoadedLists {
  const ldPath = join(dir, LIST_FILES.ldnoobw);
  const commit = existsSync(ldPath) ? (/^#\s*commit:\s*([0-9a-f]{7,40})/m.exec(readFileSync(ldPath, "utf8"))?.[1] ?? null) : null;
  return {
    ldnoobw: readList(ldPath).map((w) => w.replace(/\s+/g, "")),
    dictionary: readList(join(dir, LIST_FILES.dictionary)),
    names: readList(join(dir, LIST_FILES.names)),
    surnames: readList(join(dir, LIST_FILES.surnames)),
    places: readList(join(dir, LIST_FILES.places)),
    allow: readList(join(dir, LIST_FILES.allow)),
    extraBlock: readList(join(dir, LIST_FILES.extraBlock)),
    ldnoobwCommit: commit,
  };
}

export function filterFromDirectory(dir: string): { filter: TextFilter; lists: LoadedLists } {
  const lists = loadLists(dir);
  return { filter: new TextFilter(lists), lists };
}

export function buildConfusablesMap(source: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const [srcField, targetField] = line.split(";").map((f) => f.trim());
    if (!srcField || !targetField) continue;
    const srcCodes = srcField.split(/\s+/).map((h) => parseInt(h, 16));
    if (srcCodes.length !== 1 || srcCodes[0]! < 0x80) continue;
    const target = String.fromCodePoint(...targetField.split(/\s+/).map((h) => parseInt(h, 16)));
    if (!/^[\x21-\x7e]+$/.test(target)) continue;
    map[String.fromCodePoint(srcCodes[0]!)] = target.toLowerCase();
  }
  return map;
}

function words(lines: Iterable<string>, minLen = 2): string[] {
  const out = new Set<string>();
  for (const raw of lines) {
    const w = raw
      .trim()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase();
    if (!w || w.length < minLen) continue;
    if (!/^[a-z][a-z' -]*$/.test(w)) continue;
    out.add(w.replace(/'s$/, "").replace(/['\s-]/g, ""));
  }
  return [...out].filter((w) => w.length >= minLen).sort();
}

export function parseScowl(text: string): string[] {
  const body = text.includes("---") ? text.slice(text.indexOf("---") + 3) : text;
  return words(body.split(/\r?\n/), 2);
}

export function parseBabyNames(csv: string): string[] {
  return words(
    csv
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.split(",")[1]?.replace(/"/g, "") ?? ""),
    3,
  );
}

export function parseCensusSurnames(csv: string, minCount = 1000): string[] {
  const lines = csv.split(/\r?\n/).slice(1);
  return words(
    lines.filter((l) => Number(l.split(",")[2]) >= minCount).map((l) => l.split(",")[0] ?? ""),
    3,
  );
}

export function parseGeonamesCities(tsv: string): string[] {
  const out: string[] = [];
  for (const line of tsv.split(/\r?\n/)) {
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    out.push(cols[1]!, cols[2]!);
  }
  return words(out, 3);
}

export function parseGeonamesAdmin1(tsv: string): string[] {
  const out: string[] = [];
  for (const line of tsv.split(/\r?\n/)) {
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    out.push(cols[1]!, cols[2]!);
  }
  return words(out, 3);
}

export function parseCountries(tsv: string): string[] {
  const out: string[] = [];
  for (const line of tsv.split(/\r?\n/)) {
    if (line.startsWith("#")) continue;
    const cols = line.split("\t");
    if (cols.length > 4) out.push(cols[4]!);
  }
  return words(out, 3);
}

export const SOURCES = {
  ldnoobw: (commit: string) => `https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/${commit}/en`,
  scowl:
    "http://app.aspell.net/create?max_size=70&spelling=US&spelling=GBs&spelling=GBz&spelling=CA&spelling=AU&max_variant=1&diacritic=strip&special=hacker&download=wordlist&encoding=utf-8&format=inline",
  givenNames: "https://raw.githubusercontent.com/hadley/data-baby-names/master/baby-names.csv",
  surnames: "https://www2.census.gov/topics/genealogy/2010surnames/names.zip",
  cities: "https://download.geonames.org/export/dump/cities15000.zip",
  admin1: "https://download.geonames.org/export/dump/admin1CodesASCII.txt",
  countries: "https://download.geonames.org/export/dump/countryInfo.txt",
  confusables: "https://www.unicode.org/Public/security/latest/confusables.txt",
};

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { headers: { "user-agent": "qtiauth-lists-update" } });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function unzipFirst(bytes: Uint8Array, match: RegExp): string {
  const files = unzipSync(bytes);
  const name = Object.keys(files).find((n) => match.test(n));
  if (!name) throw new Error(`No file matching ${match} in archive`);
  return strFromU8(files[name]!);
}

const HEADER = (title: string, source: string) => `# ${title}\n# Source: ${source}\n# Generated by qtiauth lists update on ${new Date().toISOString().slice(0, 10)}\n`;

export async function updateLists(dir: string, opts: { ldnoobwCommit?: string; only?: string[]; log?: (m: string) => void } = {}): Promise<Record<string, number>> {
  const log = opts.log ?? (() => undefined);
  mkdirSync(dir, { recursive: true });
  const want = (k: string) => !opts.only || opts.only.includes(k);
  const counts: Record<string, number> = {};
  if (opts.ldnoobwCommit && want("ldnoobw")) {
    const text = new TextDecoder().decode(await fetchBytes(SOURCES.ldnoobw(opts.ldnoobwCommit)));
    const entries = text.split(/\r?\n/).filter((l) => l.trim());
    writeFileSync(join(dir, LIST_FILES.ldnoobw), `# LDNOOBW en\n# commit: ${opts.ldnoobwCommit}\n# Source: https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words\n${entries.join("\n")}\n`);
    counts.ldnoobw = entries.length;
    log(`ldnoobw: ${entries.length} entries at ${opts.ldnoobwCommit}`);
  }
  if (want("dictionary")) {
    const list = parseScowl(new TextDecoder().decode(await fetchBytes(SOURCES.scowl)));
    writeFileSync(join(dir, LIST_FILES.dictionary), HEADER("SCOWL size 70 English word list", "http://wordlist.aspell.net/") + list.join("\n") + "\n");
    counts.dictionary = list.length;
    log(`dictionary: ${list.length}`);
  }
  if (want("names")) {
    const list = parseBabyNames(new TextDecoder().decode(await fetchBytes(SOURCES.givenNames)));
    const extra = readList(join(dir, "names-extra.txt"));
    const merged = [...new Set([...list, ...extra.map((n) => n.toLowerCase())])].sort();
    writeFileSync(join(dir, LIST_FILES.names), HEADER("Given names (US SSA top names via hadley/data-baby-names, plus names-extra.txt for ONS and others)", SOURCES.givenNames) + merged.join("\n") + "\n");
    counts.names = merged.length;
    log(`names: ${merged.length}`);
  }
  if (want("surnames")) {
    const list = parseCensusSurnames(unzipFirst(await fetchBytes(SOURCES.surnames), /\.csv$/i));
    writeFileSync(join(dir, LIST_FILES.surnames), HEADER("Surnames (US Census 2010, count >= 1000)", SOURCES.surnames) + list.join("\n") + "\n");
    counts.surnames = list.length;
    log(`surnames: ${list.length}`);
  }
  if (want("places")) {
    const cities = parseGeonamesCities(unzipFirst(await fetchBytes(SOURCES.cities), /cities15000\.txt$/));
    const admin = parseGeonamesAdmin1(new TextDecoder().decode(await fetchBytes(SOURCES.admin1)));
    const countries = parseCountries(new TextDecoder().decode(await fetchBytes(SOURCES.countries)));
    const merged = [...new Set([...cities, ...admin, ...countries])].sort();
    writeFileSync(join(dir, LIST_FILES.places), HEADER("Place names (GeoNames cities15000 + admin1 + countries, CC-BY 4.0)", "https://www.geonames.org/") + merged.join("\n") + "\n");
    counts.places = merged.length;
    log(`places: ${merged.length}`);
  }
  for (const f of [LIST_FILES.allow, LIST_FILES.extraBlock]) {
    if (!existsSync(join(dir, f))) writeFileSync(join(dir, f), `# One entry per line. Lines starting with # are ignored.\n`);
  }
  return counts;
}
