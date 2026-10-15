import { decodeKey, decrypt, deriveSubkey, encrypt, hashToken, humanCode, ProblemError, uuidv7, inc } from "@qtiauth/common";
import type { Ctx, Exec } from "./ctx.ts";
import { verifyTotp } from "./totp.ts";

export async function has2fa(db: Exec, userId: string): Promise<boolean> {
  const totp = await db.selectFrom("totp").select("user_id").where("user_id", "=", userId).where("confirmed_at", "is not", null).executeTakeFirst();
  if (totp) return true;
  const pk = await db.selectFrom("passkeys").select("id").where("user_id", "=", userId).executeTakeFirst();
  return Boolean(pk);
}

export async function hasSecondFactor(db: Exec, userId: string): Promise<{ totp: boolean; passkeys: number; recovery_codes: number }> {
  const totp = await db.selectFrom("totp").select("user_id").where("user_id", "=", userId).where("confirmed_at", "is not", null).executeTakeFirst();
  const pk = await db.selectFrom("passkeys").select(db.fn.countAll<number>().as("n")).where("user_id", "=", userId).executeTakeFirst();
  const rc = await db.selectFrom("recovery_codes").select(db.fn.countAll<number>().as("n")).where("user_id", "=", userId).where("used_at", "is", null).executeTakeFirst();
  return { totp: Boolean(totp), passkeys: Number(pk?.n ?? 0), recovery_codes: Number(rc?.n ?? 0) };
}

function totpKey(ctx: Ctx): Buffer {
  const material = ctx.config.secrets.app_encryption_key;
  if (!material) throw new ProblemError(503, "ENCRYPTION_KEY_MISSING", "APP_ENCRYPTION_KEY is not configured");
  return deriveSubkey(decodeKey(material), "totp");
}

export function encryptTotpSecret(ctx: Ctx, userId: string, secret: string): string {
  return encrypt(totpKey(ctx), secret, `totp:${userId}`);
}

export function decryptTotpSecret(ctx: Ctx, userId: string, enc: string): string {
  return decrypt(totpKey(ctx), enc, `totp:${userId}`).toString();
}

export async function checkTotp(ctx: Ctx, db: Exec, userId: string, code: string): Promise<boolean> {
  const row = await db.selectFrom("totp").selectAll().where("user_id", "=", userId).where("confirmed_at", "is not", null).executeTakeFirst();
  if (!row) return false;
  const step = verifyTotp(decryptTotpSecret(ctx, userId, row.secret_enc), code.replace(/\s+/g, ""), { lastUsedStep: row.last_used_step });
  inc("qtiauth_auth_2fa_challenges_total", { factor: "totp", result: step === null ? "failure" : "success" }, 1, "Second-factor challenges");
  if (step === null) return false;
  const updated = await db
    .updateTable("totp")
    .set({ last_used_step: step })
    .where("user_id", "=", userId)
    .where((eb) => eb.or([eb("last_used_step", "is", null), eb("last_used_step", "<", step)]))
    .executeTakeFirst();
  return Number(updated.numUpdatedRows) > 0;
}

function normalizeRecovery(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

export async function generateRecoveryCodes(ctx: Ctx, db: Exec, userId: string): Promise<string[]> {
  await db.deleteFrom("recovery_codes").where("user_id", "=", userId).execute();
  const codes: string[] = [];
  for (let i = 0; i < ctx.config.security.recovery_code_count; i++) {
    const code = humanCode(10, 5);
    codes.push(code);
    await db.insertInto("recovery_codes").values({ id: uuidv7(), user_id: userId, code_hash: hashToken(normalizeRecovery(code)) }).execute();
  }
  return codes;
}

export async function useRecoveryCode(db: Exec, userId: string, code: string): Promise<boolean> {
  const r = await db
    .updateTable("recovery_codes")
    .set({ used_at: new Date() })
    .where("user_id", "=", userId)
    .where("code_hash", "=", hashToken(normalizeRecovery(code)))
    .where("used_at", "is", null)
    .executeTakeFirst();
  const ok = Number(r.numUpdatedRows) > 0;
  inc("qtiauth_auth_2fa_challenges_total", { factor: "recovery_code", result: ok ? "success" : "failure" }, 1, "Second-factor challenges");
  return ok;
}
