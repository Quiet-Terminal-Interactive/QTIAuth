import { writeFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";
import { configFile, surfaceUrl } from "@qtiauth/config";
import { filterFromDirectory, updateLists } from "@qtiauth/text-filter";
import type { CliCommand } from "@qtiauth/service-kit";
import type { Ctx } from "./lib/ctx.ts";
import { issueToken } from "./lib/tokens.ts";
import { verifyAuditChain } from "./lib/audit.ts";
import { identityExport, EXPORTING_SERVICES } from "./lib/exports.ts";
import { purgeAccount } from "./lib/deletion.ts";
import { getUser } from "./lib/users.ts";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

export const identityCli: Record<string, CliCommand> = {
  "admin create": {
    description: "Issue a one-time signup link for the first admin",
    usage: "qtiauth admin create --email <address> [--role admin] [--ttl-hours 24]",
    async run(args, cli) {
      const email = flag(args, "email");
      if (!email || !email.includes("@")) {
        cli.print("--email is required");
        return 2;
      }
      const roles = (flag(args, "role") ?? "admin").split(",");
      const ttl = Number(flag(args, "ttl-hours") ?? 24) * 3_600_000;
      const ctx = (await cli.boot()) as Ctx;
      const known = await ctx.db.selectFrom("roles").select("name").execute();
      for (const r of roles) {
        if (!known.some((k) => k.name === r)) {
          cli.print(`Unknown role ${r}`);
          return 2;
        }
      }
      const { token, expiresAt } = await issueToken(ctx.db, "admin_bootstrap", { email, data: { roles }, ttlMs: ttl });
      const url = new URL(surfaceUrl(ctx.surfaces.account, "/signup"));
      url.searchParams.set("bootstrap", token);
      url.searchParams.set("email", email);
      cli.print(`One-time admin signup link for ${email} (roles: ${roles.join(", ")}), valid until ${expiresAt.toISOString()}:`);
      cli.print(url.toString());
      return 0;
    },
  },

  "audit verify": {
    description: "Check the audit log hash chain for tampering",
    async run(_args, cli) {
      const ctx = (await cli.boot()) as Ctx;
      const r = await verifyAuditChain(ctx, (n) => process.stderr.write(`\rchecked ${n} rows`));
      process.stderr.write("\n");
      if (r.ok) {
        cli.print(`Audit chain OK (${r.checked} rows).`);
        return 0;
      }
      cli.print(`Audit chain BROKEN at row ${r.first_bad_id}: ${r.reason} (${r.checked} rows verified before it).`);
      return 1;
    },
  },

  "lists update": {
    description: "Refresh the vendored text-filter word lists",
    usage: "qtiauth lists update [--ldnoobw <commit>] [--only dictionary,names,surnames,places]",
    async run(args, cli) {
      const dir = configFile(cli.config, cli.config.text_filter.lists_directory);
      const only = flag(args, "only")?.split(",");
      const counts = await updateLists(dir, { ldnoobwCommit: flag(args, "ldnoobw"), only: only ?? (flag(args, "ldnoobw") ? undefined : ["dictionary", "names", "surnames", "places"]), log: cli.print });
      cli.print(`Updated ${dir}: ${JSON.stringify(counts)}`);
      cli.print("Run `qtiauth lists audit` and add any false positives to the dictionary lists or allow.txt.");
      return 0;
    },
  },

  "lists audit": {
    description: "Print every dictionary word that contains a block-list entry",
    async run(args, cli) {
      const dir = configFile(cli.config, cli.config.text_filter.lists_directory);
      const { filter, lists } = filterFromDirectory(dir);
      const rows = filter.audit();
      const limit = Number(flag(args, "limit") ?? Infinity);
      cli.print(`LDNOOBW commit: ${lists.ldnoobwCommit ?? "unknown"}; ${JSON.stringify(filter.stats())}`);
      let shown = 0;
      for (const r of rows) {
        if (shown++ >= limit) break;
        cli.print(`${r.contains}\t${r.word}`);
      }
      cli.print(`${rows.length} dictionary words contain a block-list entry.`);
      return 0;
    },
  },

  "user export": {
    description: "Write a user's full data export to a zip file",
    usage: "qtiauth user export <user-id> [--out export.zip]",
    async run(args, cli) {
      const userId = args.find((a) => !a.startsWith("--") && a !== flag(args, "out"));
      if (!userId) return 2;
      const ctx = (await cli.boot()) as Ctx;
      const files: Record<string, Uint8Array> = { "identity.json": strToU8(JSON.stringify(await identityExport(ctx, userId), null, 2)) };
      for (const svc of EXPORTING_SERVICES) {
        const data = await ctx.rpcOptional<unknown>(`${svc}.export_user`, { user_id: userId }, null, { timeoutMs: 120_000 });
        if (data !== null) files[`${svc}.json`] = strToU8(JSON.stringify(data, null, 2));
      }
      const out = flag(args, "out") ?? `export-${userId}.zip`;
      writeFileSync(out, zipSync(files));
      cli.print(`Wrote ${out} (${Object.keys(files).join(", ")})`);
      return 0;
    },
  },

  "user delete": {
    description: "Delete a user immediately (skips the grace period)",
    usage: "qtiauth user delete <user-id> --yes",
    async run(args, cli) {
      const userId = args.find((a) => !a.startsWith("--"));
      if (!userId || !args.includes("--yes")) {
        cli.print("Pass the user id and --yes to confirm.");
        return 2;
      }
      const ctx = (await cli.boot()) as Ctx;
      const user = await getUser(ctx.db, userId);
      if (!user || user.state === "deleted") {
        cli.print("No such user.");
        return 1;
      }
      await ctx.db.transaction().execute(async (trx) => {
        await purgeAccount(ctx, trx, user, "cli");
        await ctx.audit(trx, { actor: { type: "system", id: "cli" }, action: "account.deleted_by_cli", target: { type: "user", id: user.id } });
      });
      cli.print(`Deleted ${userId}. Other services erase their data when they receive identity.user.deleted.`);
      return 0;
    },
  },
};
