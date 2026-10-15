import { zipSync, strToU8 } from "fflate";
import { ProblemError, uuidv7, inc } from "@qtiauth/common";
import { isServiceNotRunning } from "@qtiauth/bus";
import type { Ctx, Exec } from "./ctx.ts";
import { displayName, getUser } from "./users.ts";
import { usernameHistory } from "./usernames.ts";
import { userRoles } from "./roles.ts";

export const EXPORTING_SERVICES = ["oidc", "safety", "support", "games", "notifier"];

export async function requestExport(ctx: Ctx, db: Exec, userId: string, requestedBy: string): Promise<string> {
  if (!ctx.config.features.data_export.enabled) throw new ProblemError(404, "FEATURE_DISABLED");
  const running = await db.selectFrom("data_exports").select("id").where("user_id", "=", userId).where("status", "in", ["pending", "running"]).executeTakeFirst();
  if (running) return running.id;
  const id = uuidv7();
  await db.insertInto("data_exports").values({ id, user_id: userId, requested_by: requestedBy, status: "pending", parts: JSON.stringify({}) }).execute();
  await ctx.enqueue(db, "identity.export", { export_id: id }, `export-${id}`);
  await ctx.audit(db, { actor: { type: requestedBy === userId ? "user" : "guardian", id: requestedBy }, action: "account.export_requested", target: { type: "user", id: userId } });
  return id;
}

export async function identityExport(ctx: Ctx, userId: string): Promise<Record<string, unknown>> {
  const db = ctx.db;
  const user = await getUser(db, userId);
  if (!user) return {};
  const identities = await db.selectFrom("identities").select(["type", "email", "email_verified", "created_at", "last_used_at"]).where("user_id", "=", userId).execute();
  const passkeys = await db.selectFrom("passkeys").select(["name", "created_at", "last_used_at", "device_type"]).where("user_id", "=", userId).execute();
  const sessions = await db.selectFrom("sessions").select(["created_at", "last_active_at", "device", "country", "auth_method", "revoked_at", "revoke_reason"]).where("user_id", "=", userId).execute();
  const events = await db.selectFrom("security_events").select(["type", "ip", "country", "user_agent", "created_at"]).where("user_id", "=", userId).orderBy("created_at", "desc").limit(5000).execute();
  const legal = await db.selectFrom("legal_acceptances").select(["document_id", "version", "accepted_at", "method", "ip"]).where("user_id", "=", userId).execute();
  const guardians = await db.selectFrom("guardians").select(["email", "display_name", "status", "approved_at"]).where("child_user_id", "=", userId).execute();
  const age = await db.selectFrom("age_assurance_results").select(["provider", "strength", "outcome", "trigger", "created_at"]).where("user_id", "=", userId).execute();
  const prefs = await db.selectFrom("notification_prefs").select(["category", "enabled"]).where("user_id", "=", userId).execute();
  const totp = await db.selectFrom("totp").select(["confirmed_at"]).where("user_id", "=", userId).executeTakeFirst();
  return {
    profile: {
      id: user.id,
      email: user.email,
      email_verified_at: user.email_verified_at,
      username: user.username,
      date_of_birth: user.dob,
      locale: user.locale,
      state: user.state,
      created_at: user.created_at,
      public_profile: user.public_profile,
      leaderboard_visible: user.leaderboard_visible,
      parental_controls: user.parental_controls,
      restrictions: user.restrictions,
    },
    sign_in_methods: identities,
    passkeys,
    two_factor: { totp_enabled: Boolean(totp?.confirmed_at) },
    sessions,
    security_events: events,
    legal_acceptances: legal,
    username_history: await usernameHistory(db, userId),
    guardians,
    age_assurance: age,
    notification_preferences: prefs,
    roles: await userRoles(db, userId),
  };
}

export async function runExport(ctx: Ctx, exportId: string): Promise<void> {
  const job = await ctx.db.selectFrom("data_exports").selectAll().where("id", "=", exportId).executeTakeFirst();
  if (!job || (job.status !== "pending" && job.status !== "running")) return;
  await ctx.db.updateTable("data_exports").set({ status: "running" }).where("id", "=", exportId).execute();
  const user = await getUser(ctx.db, job.user_id);
  if (!user || user.state === "deleted") {
    await ctx.db.updateTable("data_exports").set({ status: "failed", error: "user deleted" }).where("id", "=", exportId).execute();
    return;
  }
  const files: Record<string, Uint8Array> = {};
  const parts: Record<string, string> = {};
  files["identity.json"] = strToU8(JSON.stringify(await identityExport(ctx, user.id), null, 2));
  parts.identity = "ok";
  for (const svc of EXPORTING_SERVICES) {
    try {
      const data = await ctx.rpc<unknown>(`${svc}.export_user`, { user_id: user.id }, { timeoutMs: 120_000 });
      files[`${svc}.json`] = strToU8(JSON.stringify(data, null, 2));
      parts[svc] = "ok";
    } catch (err) {
      parts[svc] = isServiceNotRunning(err) ? "not_running" : "error";
      if (!isServiceNotRunning(err)) ctx.log.warn({ err, service: svc }, "export part failed");
    }
  }
  files["README.txt"] = strToU8(
    `Data export for ${displayName(user)} from ${ctx.config.branding.product_name}.\nGenerated ${new Date().toISOString()}.\nEach file contains the data held by one part of the service, as JSON.\n`,
  );
  const zip = zipSync(files, { level: 6 });
  const expiresAt = new Date(Date.now() + ctx.config.accounts.export_link_ttl);
  if (ctx.storage) {
    const key = `exports/${user.id}/${exportId}.zip`;
    await ctx.storage.put(key, zip, "application/zip");
    const url = await ctx.storage.presignGet(key, { filename: "data-export.zip", ttlSeconds: Math.min(604_800, Math.floor(ctx.config.accounts.export_link_ttl / 1000)) });
    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable("data_exports").set({ status: "ready", object_key: key, size_bytes: zip.length, parts: JSON.stringify(parts), completed_at: new Date(), expires_at: expiresAt }).where("id", "=", exportId).execute();
      await ctx.email(trx, { template: "data_export_ready", to: { user_id: user.id }, locale: user.locale, vars: { name: displayName(user), download_url: url, expires_at: expiresAt.toISOString() }, sender: "security", priority: "high" });
    });
  } else if (zip.length <= ctx.config.email.attachment_max_bytes) {
    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable("data_exports").set({ status: "emailed", size_bytes: zip.length, parts: JSON.stringify(parts), completed_at: new Date() }).where("id", "=", exportId).execute();
      await ctx.email(trx, {
        template: "data_export_attached",
        to: { user_id: user.id },
        locale: user.locale,
        vars: { name: displayName(user) },
        sender: "security",
        priority: "high",
        attachments: [{ filename: "data-export.zip", content_base64: Buffer.from(zip).toString("base64"), content_type: "application/zip" }],
      });
    });
  } else {
    await ctx.db.updateTable("data_exports").set({ status: "failed", error: "export too large to email and no object storage is configured", parts: JSON.stringify(parts) }).where("id", "=", exportId).execute();
    inc("qtiauth_data_exports_total", { result: "unavailable" }, 1, "Data exports");
    return;
  }
  inc("qtiauth_data_exports_total", { result: "ok" }, 1, "Data exports");
}

export async function exportStatus(db: Exec, userId: string) {
  const rows = await db.selectFrom("data_exports").selectAll().where("user_id", "=", userId).orderBy("requested_at", "desc").limit(10).execute();
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    requested_at: r.requested_at.toISOString(),
    completed_at: r.completed_at?.toISOString() ?? null,
    expires_at: r.expires_at?.toISOString() ?? null,
    size_bytes: r.size_bytes,
    error: r.status === "failed" ? r.error : null,
  }));
}
