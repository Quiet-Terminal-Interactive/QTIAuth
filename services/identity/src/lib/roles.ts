import type { Ctx, Exec } from "./ctx.ts";

export async function seedRoles(ctx: Ctx): Promise<void> {
  for (const [name, role] of Object.entries(ctx.config.roles)) {
    await ctx.db
      .insertInto("roles")
      .values({ name, description: role.description, permissions: JSON.stringify(role.permissions), builtin: true })
      .onConflict((oc) => oc.column("name").doNothing())
      .execute();
  }
}

export async function userGrants(db: Exec, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("user_roles")
    .innerJoin("roles", "roles.name", "user_roles.role")
    .select(["roles.permissions"])
    .where("user_roles.user_id", "=", userId)
    .execute();
  const out = new Set<string>();
  for (const r of rows) for (const p of r.permissions) out.add(p);
  return [...out].sort();
}

export async function userRoles(db: Exec, userId: string): Promise<string[]> {
  const rows = await db.selectFrom("user_roles").select("role").where("user_id", "=", userId).orderBy("role").execute();
  return rows.map((r) => r.role);
}

export async function staffUserIds(db: Exec): Promise<string[]> {
  const rows = await db.selectFrom("user_roles").select("user_id").distinct().execute();
  return rows.map((r) => r.user_id);
}
