import { hashToken, randomToken, uuidv7, ProblemError } from "@qtiauth/common";
import type { TokenRow } from "../db/types.ts";
import type { Exec } from "./ctx.ts";

export type TokenKind =
  | "email_verify"
  | "magic_link"
  | "password_reset"
  | "email_change"
  | "email_revert"
  | "signup_continue"
  | "account_choice"
  | "guardian_consent"
  | "guardian_access"
  | "guardian_invite"
  | "step_up_link"
  | "mfa_pending"
  | "admin_bootstrap"
  | "provider_email_verify";

export async function issueToken(
  db: Exec,
  kind: TokenKind,
  opts: { userId?: string | null; email?: string | null; data?: Record<string, unknown>; ttlMs: number },
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = randomToken(32);
  const id = uuidv7();
  const expiresAt = new Date(Date.now() + opts.ttlMs);
  await db
    .insertInto("tokens")
    .values({
      id,
      kind,
      token_hash: hashToken(token),
      user_id: opts.userId ?? null,
      email: opts.email ?? null,
      data: JSON.stringify(opts.data ?? {}),
      expires_at: expiresAt,
    })
    .execute();
  return { token, id, expiresAt };
}

export async function peekToken(db: Exec, kind: TokenKind, token: string): Promise<TokenRow | null> {
  if (!token || token.length > 200) return null;
  const row = await db
    .selectFrom("tokens")
    .selectAll()
    .where("token_hash", "=", hashToken(token))
    .where("kind", "=", kind)
    .executeTakeFirst();
  if (!row || row.used_at || row.expires_at.getTime() < Date.now()) return null;
  return row;
}

export async function consumeToken(db: Exec, kind: TokenKind, token: string): Promise<TokenRow> {
  if (!token || token.length > 200) throw new ProblemError(400, "INVALID_TOKEN");
  const row = await db
    .updateTable("tokens")
    .set({ used_at: new Date() })
    .where("token_hash", "=", hashToken(token))
    .where("kind", "=", kind)
    .where("used_at", "is", null)
    .where("expires_at", ">", new Date())
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new ProblemError(400, "INVALID_OR_EXPIRED_TOKEN");
  return row;
}

export async function invalidateTokens(db: Exec, userId: string, kinds: TokenKind[]): Promise<void> {
  if (!kinds.length) return;
  await db.updateTable("tokens").set({ used_at: new Date() }).where("user_id", "=", userId).where("kind", "in", kinds).where("used_at", "is", null).execute();
}
