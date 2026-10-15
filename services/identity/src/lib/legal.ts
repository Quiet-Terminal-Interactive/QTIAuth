import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { configFile, parseFrontMatter } from "@qtiauth/config";
import { ProblemError, sha256, uuidv7, setGauge } from "@qtiauth/common";
import { EVENTS } from "@qtiauth/bus";
import type { User } from "../db/types.ts";
import type { Ctx, Exec } from "./ctx.ts";

export interface LegalVersion {
  id: string;
  version: string;
  effective_at: Date;
  material: boolean;
  requires_acceptance: boolean;
  title: string;
  summary: string | null;
}

export const COMPANION_DOCS = new Set(["children-summary"]);

export class LegalSyncError extends Error {}

export function readLegalDirectory(dir: string): { id: string; version: string; effective_at: Date; material: boolean; requires_acceptance: boolean; title: string; summary: string | null; body: string; body_hash: string }[] {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const { data, body } = parseFrontMatter(readFileSync(join(dir, file), "utf8"));
    const id = String(data.id ?? file.replace(/\.md$/, ""));
    if (!/^[a-z0-9-]+$/.test(id)) throw new LegalSyncError(`Legal document ${file}: id "${id}" must be lowercase letters, digits and dashes`);
    const version = data.version instanceof Date ? data.version.toISOString().slice(0, 10) : String(data.version ?? "");
    if (!version) throw new LegalSyncError(`Legal document ${file} has no version`);
    const effective = data.effective_at instanceof Date ? data.effective_at : new Date(String(data.effective_at ?? ""));
    if (Number.isNaN(effective.getTime())) throw new LegalSyncError(`Legal document ${file} has an invalid effective_at`);
    const titleMatch = /^#\s+(.+)$/m.exec(body);
    out.push({
      id,
      version,
      effective_at: effective,
      material: Boolean(data.material ?? false),
      requires_acceptance: data.requires_acceptance !== undefined ? Boolean(data.requires_acceptance) : !COMPANION_DOCS.has(id),
      title: String(data.title ?? titleMatch?.[1] ?? id),
      summary: data.summary ? String(data.summary) : null,
      body,
      body_hash: sha256(body),
    });
  }
  return out;
}

export async function syncLegalDocuments(ctx: Ctx): Promise<void> {
  const dir = configFile(ctx.config, ctx.config.legal.directory);
  const docs = readLegalDirectory(dir);
  for (const doc of docs) {
    const existing = await ctx.db.selectFrom("legal_documents").selectAll().where("id", "=", doc.id).where("version", "=", doc.version).executeTakeFirst();
    if (existing) {
      if (existing.body_hash !== doc.body_hash) {
        throw new LegalSyncError(`Legal document ${doc.id} version ${doc.version} was changed after publication. Bump "version" to publish a new version.`);
      }
      continue;
    }
    await ctx.db.transaction().execute(async (trx) => {
      await trx.insertInto("legal_documents").values(doc).execute();
      await ctx.emit(trx, EVENTS.legalVersionPublished, { document_id: doc.id, version: doc.version, effective_at: doc.effective_at.toISOString(), material: doc.material, summary: doc.summary }, { subject: { type: "legal_document", id: doc.id } });
    });
    ctx.log.info({ document: doc.id, version: doc.version }, "legal document version published");
  }
  cache = null;
}

let cache: { versions: LegalVersion[]; at: number } | null = null;

export async function allVersions(db: Exec): Promise<LegalVersion[]> {
  if (cache && Date.now() - cache.at < 60_000) return cache.versions;
  const rows = await db
    .selectFrom("legal_documents")
    .select(["id", "version", "effective_at", "material", "requires_acceptance", "title", "summary"])
    .orderBy("effective_at", "asc")
    .execute();
  cache = { versions: rows, at: Date.now() };
  return rows;
}

export function invalidateLegalCache(): void {
  cache = null;
}

export async function requiredVersions(db: Exec, now = new Date()): Promise<Map<string, LegalVersion>> {
  const versions = await allVersions(db);
  const required = new Map<string, LegalVersion>();
  for (const v of versions) {
    if (!v.requires_acceptance || !v.material || v.effective_at > now) continue;
    const prev = required.get(v.id);
    if (!prev || v.effective_at >= prev.effective_at) required.set(v.id, v);
  }
  return required;
}

export async function currentVersions(db: Exec, now = new Date()): Promise<Map<string, LegalVersion>> {
  const versions = await allVersions(db);
  const current = new Map<string, LegalVersion>();
  for (const v of versions) {
    if (v.effective_at > now) continue;
    const prev = current.get(v.id);
    if (!prev || v.effective_at >= prev.effective_at) current.set(v.id, v);
  }
  return current;
}

export async function latestVersions(db: Exec): Promise<Map<string, LegalVersion>> {
  const versions = await allVersions(db);
  const latest = new Map<string, LegalVersion>();
  for (const v of versions) {
    const prev = latest.get(v.id);
    if (!prev || v.effective_at >= prev.effective_at) latest.set(v.id, v);
  }
  return latest;
}

export async function pendingDocumentsFor(db: Exec, user: Pick<User, "id">): Promise<LegalVersion[]> {
  const required = await requiredVersions(db);
  if (!required.size) return [];
  const accepted = await db.selectFrom("legal_acceptances").select(["document_id", "version"]).where("user_id", "=", user.id).execute();
  const all = await allVersions(db);
  const effectiveOf = new Map(all.map((v) => [`${v.id}@${v.version}`, v.effective_at.getTime()]));
  const pending: LegalVersion[] = [];
  for (const [id, req] of required) {
    const ok = accepted.some((a) => a.document_id === id && (effectiveOf.get(`${a.document_id}@${a.version}`) ?? 0) >= req.effective_at.getTime());
    if (!ok) pending.push(req);
  }
  return pending;
}

export async function pendingLegalFor(_ctx: Ctx, db: Exec, user: Pick<User, "id">): Promise<boolean> {
  return (await pendingDocumentsFor(db, user)).length > 0;
}

export async function acceptDocuments(
  ctx: Ctx,
  db: Exec,
  userId: string,
  items: { id: string; version: string }[],
  meta: { ip: string | null; method: string; guardianId?: string | null },
): Promise<void> {
  const all = await allVersions(db);
  for (const item of items) {
    const v = all.find((d) => d.id === item.id && d.version === item.version);
    if (!v) throw new ProblemError(422, "UNKNOWN_LEGAL_VERSION", undefined, { document_id: item.id, version: item.version });
    if (!v.requires_acceptance) continue;
    await db
      .insertInto("legal_acceptances")
      .values({ id: uuidv7(), user_id: userId, document_id: item.id, version: item.version, ip: meta.ip, method: meta.method, guardian_id: meta.guardianId ?? null })
      .onConflict((oc) => oc.columns(["user_id", "document_id", "version"]).doNothing())
      .execute();
  }
  await ctx.emit(db, EVENTS.userUpdated, { user_id: userId, reason: "legal_accepted" }, { subject: { type: "user", id: userId } });
}

export async function assertSignupAcceptance(ctx: Ctx, db: Exec, accepted: { id: string; version: string }[] | undefined): Promise<{ id: string; version: string }[]> {
  const current = await latestVersions(db);
  const list = accepted ?? [];
  for (const id of ctx.config.legal.required_at_signup) {
    const doc = current.get(id);
    if (!doc) continue;
    const given = list.find((a) => a.id === id);
    if (!given) throw new ProblemError(422, "LEGAL_ACCEPTANCE_REQUIRED", undefined, { document_id: id, version: doc.version });
    const effective = (await allVersions(db)).find((v) => v.id === id && v.version === given.version);
    if (!effective) throw new ProblemError(422, "UNKNOWN_LEGAL_VERSION", undefined, { document_id: id });
    const req = (await requiredVersions(db)).get(id);
    if (req && effective.effective_at < req.effective_at) throw new ProblemError(422, "OUTDATED_LEGAL_VERSION", undefined, { document_id: id, version: req.version });
  }
  return list;
}

export async function legalPendingGauge(ctx: Ctx): Promise<void> {
  const required = await requiredVersions(ctx.db);
  let total = 0;
  for (const [id, v] of required) {
    const r = await ctx.db
      .selectFrom("users")
      .select(ctx.db.fn.countAll<number>().as("n"))
      .where("state", "in", ["active", "locked", "banned"])
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("legal_acceptances")
              .innerJoin("legal_documents", (j) => j.onRef("legal_documents.id", "=", "legal_acceptances.document_id").onRef("legal_documents.version", "=", "legal_acceptances.version"))
              .select("legal_acceptances.id")
              .whereRef("legal_acceptances.user_id", "=", "users.id")
              .where("legal_acceptances.document_id", "=", id)
              .where("legal_documents.effective_at", ">=", v.effective_at),
          ),
        ),
      )
      .executeTakeFirst();
    total += Number(r?.n ?? 0);
  }
  setGauge("qtiauth_legal_reacceptance_pending", total, {}, "Users with pending legal re-acceptance (sum over documents)");
}
