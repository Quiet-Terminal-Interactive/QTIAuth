import { defineService } from "@qtiauth/service-kit";
import type { IdentityDB } from "./db/types.ts";
import { migrations } from "./db/migrations.ts";
import { authRoutes } from "./routes/auth.ts";
import { meRoutes, IDENTITY_CATEGORIES } from "./routes/me.ts";
import { familyRoutes, legalRoutes } from "./routes/family.ts";
import { adminRoutes } from "./routes/admin.ts";
import { registerRpc } from "./rpc.ts";
import { cronJobs, registerConsumers, retention, startGauges } from "./jobs.ts";
import { seedRoles } from "./lib/roles.ts";
import { syncLegalDocuments } from "./lib/legal.ts";
import { loadFilter, reloadCustomEntries } from "./lib/filter.ts";
import { identityExport } from "./lib/exports.ts";
import { loginProviders } from "./lib/social/providers.ts";
import { identityCli } from "./cli.ts";
import type { Ctx } from "./lib/ctx.ts";

let stopGauges: (() => void) | null = null;

export const identityService = defineService<IdentityDB>({
  name: "identity",
  schema: "identity",
  migrations,
  permissions: [
    "users.read",
    "users.ban",
    "users.lock",
    "users.sessions",
    "users.force_username_reset",
    "users.edit_dob",
    "roles.manage",
    "audit.read",
    "text_filter.manage",
    "system.retention",
    "system.health.read",
  ],
  notificationCategories: IDENTITY_CATEGORIES,
  policyDefaults: { module: "core" },
  routes: (ctx) => [...authRoutes(ctx as Ctx), ...meRoutes(ctx as Ctx), ...familyRoutes(ctx as Ctx), ...legalRoutes(ctx as Ctx), ...adminRoutes(ctx as Ctx).map((r) => ({ ...r, module: "admin" as const }))],
  features: (ctx) => {
    const a = ctx.config.features.auth;
    return [
      ...(a.password.enabled ? ["auth.password"] : []),
      ...(a.magic_link.enabled ? ["auth.magic_link"] : []),
      ...(a.passkeys.enabled ? ["auth.passkeys"] : []),
      ...(a.totp.enabled ? ["auth.totp"] : []),
      ...loginProviders(ctx as Ctx).map((p) => `auth.social.${p.id}`),
      ...(ctx.config.features.session_security.enabled ? ["session_security"] : []),
      ...(ctx.config.features.data_export.enabled ? ["data_export"] : []),
    ];
  },
  async init(ctx) {
    await seedRoles(ctx as Ctx);
    await syncLegalDocuments(ctx as Ctx);
    loadFilter(ctx as Ctx);
    await reloadCustomEntries(ctx as Ctx);
    if (ctx.storage) await ctx.storage.ensureBucket().catch((err) => ctx.log.warn({ err }, "could not ensure storage bucket"));
  },
  async start(ctx) {
    registerRpc(ctx as Ctx);
    await registerConsumers(ctx as Ctx);
    stopGauges = startGauges(ctx as Ctx);
  },
  async shutdown() {
    stopGauges?.();
  },
  cron: cronJobs() as never,
  retention: (ctx) => retention(ctx as Ctx),
  exportUser: (ctx, userId) => identityExport(ctx as Ctx, userId),
  async healthWarnings(ctx) {
    const warnings = [];
    if (!ctx.config.secrets.app_encryption_key) warnings.push({ code: "NO_APP_ENCRYPTION_KEY", severity: "error" as const, message: "APP_ENCRYPTION_KEY is not set; TOTP cannot be used." });
    const staff = await ctx.db
      .selectFrom("user_roles")
      .select("user_id")
      .distinct()
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom("totp").select("user_id").whereRef("totp.user_id", "=", "user_roles.user_id").where("totp.confirmed_at", "is not", null))),
      )
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom("passkeys").select("id").whereRef("passkeys.user_id", "=", "user_roles.user_id"))))
      .execute();
    if (staff.length) warnings.push({ code: "STAFF_WITHOUT_2FA", severity: "warning" as const, message: `${staff.length} staff account(s) have not enrolled in two-factor authentication.` });
    if (!ctx.storage && ctx.config.features.data_export.enabled) {
      warnings.push({ code: "EXPORT_NEEDS_STORAGE", severity: "warning" as const, message: "No object storage: data exports are emailed as attachments when small enough, otherwise unavailable." });
    }
    const ledgerBacklog = await ctx.db.selectFrom("deletion_ledger_outbox").select(ctx.db.fn.countAll<number>().as("n")).where("written_at", "is", null).where("attempts", ">", 3).executeTakeFirst();
    if (Number(ledgerBacklog?.n ?? 0) > 0) warnings.push({ code: "DELETION_LEDGER_UNREACHABLE", severity: "error" as const, message: "Deletion ledger entries could not be written to the backup destination." });
    return warnings;
  },
  cli: identityCli,
});
