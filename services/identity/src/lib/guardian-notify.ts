import type { Exec } from "./ctx.ts";

export async function guardianEmailsFor(db: Exec, childId: string): Promise<{ id: string; email: string; user_id: string | null }[]> {
  return db.selectFrom("guardians").select(["id", "email", "user_id"]).where("child_user_id", "=", childId).where("status", "=", "active").execute();
}

export async function hasActiveGuardian(db: Exec, childId: string): Promise<boolean> {
  const r = await db.selectFrom("guardians").select("id").where("child_user_id", "=", childId).where("status", "=", "active").executeTakeFirst();
  return Boolean(r);
}
