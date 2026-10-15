import { uuidv7, inc } from "@qtiauth/common";
import { onceKey } from "@qtiauth/service-kit";
import type { Ctx, Exec } from "./ctx.ts";
import { getUser, displayName } from "./users.ts";
import { guardianEmailsFor } from "./guardian-notify.ts";

export interface SecurityEventInput {
  userId: string | null;
  sessionId?: string | null;
  type: string;
  ip?: string | null;
  port?: number | null;
  country?: string | null;
  userAgent?: string | null;
  data?: Record<string, unknown>;
}

export async function securityEvent(db: Exec, e: SecurityEventInput): Promise<void> {
  await db
    .insertInto("security_events")
    .values({
      id: uuidv7(),
      user_id: e.userId,
      session_id: e.sessionId ?? null,
      type: e.type,
      ip: e.ip ?? null,
      port: e.port ?? null,
      country: e.country ?? null,
      user_agent: e.userAgent?.slice(0, 512) ?? null,
      data: JSON.stringify(e.data ?? {}),
    })
    .execute();
}

export async function securityAlert(
  ctx: Ctx,
  db: Exec,
  userId: string,
  template: string,
  vars: Record<string, unknown>,
  opts: { throttleKey?: string; notifyGuardians?: boolean } = {},
): Promise<void> {
  const key = `alert:${userId}:${opts.throttleKey ?? template}`;
  const allowed = await onceKey(ctx.valkey, key, ctx.config.security.security_alert_min_interval).catch(() => true);
  if (!allowed) return;
  const user = await getUser(db, userId);
  if (!user?.email) return;
  await ctx.email(db, {
    template,
    to: { user_id: userId },
    locale: user.locale,
    vars: { name: displayName(user), ...vars },
    sender: "security",
    priority: "high",
  });
  inc("qtiauth_security_alerts_total", { template }, 1, "Security alert emails queued");
  if (opts.notifyGuardians) {
    for (const g of await guardianEmailsFor(db, userId)) {
      await ctx.email(db, {
        template: `guardian_${template}`,
        to: { email: g.email, guardian_id: g.id },
        locale: user.locale,
        vars: { child_name: displayName(user), ...vars },
        sender: "security",
        priority: "high",
      });
    }
  }
}
