import { sql } from "kysely";
import { canonicalJson, sha256 } from "@qtiauth/common";
import type { EventEnvelope } from "@qtiauth/bus";
import type { AuditEntry } from "@qtiauth/service-kit";
import type { Ctx, Exec } from "./ctx.ts";

export const GENESIS = "0".repeat(64);

export interface AuditRowInput {
  event_id: string;
  occurred_at: string;
  service: string;
  actor_type: string;
  actor_id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  ip: string | null;
  data: Record<string, unknown>;
}

export function auditHash(prev: string, row: AuditRowInput): string {
  return sha256(prev + canonicalJson(row));
}

export async function storeAudit(db: Exec, env: EventEnvelope<AuditEntry & { service: string; occurred_at: string }>): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext('qtiauth:audit_chain'))`.execute(db);
  const exists = await db.selectFrom("audit_log").select("id").where("event_id", "=", env.event_id).executeTakeFirst();
  if (exists) return;
  const last = await db.selectFrom("audit_log").select("hash").orderBy("id", "desc").limit(1).executeTakeFirst();
  const prev = last?.hash ?? GENESIS;
  const d = env.data;
  const row: AuditRowInput = {
    event_id: env.event_id,
    occurred_at: new Date(d.occurred_at ?? env.occurred_at).toISOString(),
    service: d.service ?? "unknown",
    actor_type: d.actor?.type ?? env.actor.type,
    actor_id: d.actor?.id ?? env.actor.id,
    action: d.action,
    target_type: d.target?.type ?? null,
    target_id: d.target?.id ?? null,
    reason: d.reason ?? null,
    ip: d.ip ?? null,
    data: (d.data ?? {}) as Record<string, unknown>,
  };
  await db
    .insertInto("audit_log")
    .values({ ...row, data: JSON.stringify(row.data), prev_hash: prev, hash: auditHash(prev, row) })
    .execute();
}

export async function verifyAuditChain(ctx: Ctx, onProgress?: (n: number) => void): Promise<{ ok: boolean; checked: number; first_bad_id: number | null; reason?: string }> {
  let lastId = 0;
  let prevHash: string | null = null;
  let checked = 0;
  for (;;) {
    const rows = await ctx.db.selectFrom("audit_log").selectAll().where("id", ">", lastId).orderBy("id").limit(1000).execute();
    if (!rows.length) break;
    for (const r of rows) {
      if (prevHash !== null && r.prev_hash !== prevHash) return { ok: false, checked, first_bad_id: r.id, reason: "prev_hash does not match the previous row" };
      const input: AuditRowInput = {
        event_id: r.event_id,
        occurred_at: r.occurred_at.toISOString(),
        service: r.service,
        actor_type: r.actor_type,
        actor_id: r.actor_id,
        action: r.action,
        target_type: r.target_type,
        target_id: r.target_id,
        reason: r.reason,
        ip: r.ip,
        data: r.data,
      };
      if (auditHash(r.prev_hash, input) !== r.hash) return { ok: false, checked, first_bad_id: r.id, reason: "row hash mismatch" };
      prevHash = r.hash;
      lastId = r.id;
      checked++;
    }
    onProgress?.(checked);
  }
  return { ok: true, checked, first_bad_id: null };
}

export async function pruneAudit(ctx: Ctx): Promise<number> {
  const interval = `${Math.floor(ctx.config.retention.audit_log / 1000)} seconds`;
  return ctx.db.transaction().execute(async (trx) => {
    await sql`select set_config('qtiauth.audit_retention', 'on', true)`.execute(trx);
    await sql`select set_config('qtiauth.audit_retention_interval', ${interval}, true)`.execute(trx);
    const r = await sql`delete from audit_log where occurred_at < now() - ${interval}::interval`.execute(trx);
    return Number(r.numAffectedRows ?? 0);
  });
}
