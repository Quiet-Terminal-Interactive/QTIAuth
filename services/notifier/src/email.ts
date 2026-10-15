import { inc, observe, sha256, ulid } from "@qtiauth/common";
import type { ServiceContext, EmailRequest } from "@qtiauth/service-kit";
import type { NotifierDB } from "./db.ts";
import type { TemplateStore } from "./templates.ts";
import { PermanentSendError, type EmailProvider } from "./providers/index.ts";

type Ctx = ServiceContext<NotifierDB>;

export function emailHash(email: string): string {
  return sha256(`email:${email.trim().toLowerCase()}`);
}

interface Recipient {
  user_id: string;
  email: string;
  name: string;
  locale: string | null;
  allowed: boolean;
  state: string;
}

export class Mailer {
  private readonly ctx: Ctx;
  private readonly templates: TemplateStore;
  private readonly provider: EmailProvider;

  constructor(ctx: Ctx, templates: TemplateStore, provider: EmailProvider) {
    this.ctx = ctx;
    this.templates = templates;
    this.provider = provider;
  }

  get providerId(): string {
    return this.provider.id;
  }

  async process(req: EmailRequest & { id?: string }, attempt: number): Promise<void> {
    const ctx = this.ctx;
    const id = req.id ?? ulid();
    let to = req.to.email ?? null;
    let locale = req.locale ?? null;
    let userId = req.to.user_id ?? null;
    const vars = { ...req.vars };
    if (req.to.user_id) {
      const r = await ctx.rpc<Recipient | null>("identity.resolve_recipient", { user_id: req.to.user_id, category: req.notification_category });
      if (!r) return this.log(id, req, null, null, "skipped", "recipient not found");
      if (!r.allowed) return this.log(id, req, r.email, r.user_id, "skipped", "disabled by preference");
      to = to ?? r.email;
      locale = locale ?? r.locale;
      userId = r.user_id;
      if (!("name" in vars)) vars.name = r.name;
    }
    if (!to) return this.log(id, req, null, userId, "skipped", "no address");
    if (!req.bypass_suppression) {
      const suppressed = await ctx.db.selectFrom("suppressions").select("reason").where("email_hash", "=", emailHash(to)).executeTakeFirst();
      if (suppressed) {
        inc("qtiauth_emails_total", { provider: this.provider.id, template: req.template, status: "suppressed" }, 1, "Emails by provider, template and status");
        return this.log(id, req, to, userId, "suppressed", suppressed.reason);
      }
    }
    const rendered = await this.templates.render(req.template, locale, vars);
    const from = ctx.config.email.from[req.sender] ?? ctx.config.email.from.auth;
    const started = performance.now();
    try {
      const r = await this.provider.send({
        from,
        to,
        replyTo: req.sender === "support" ? ctx.config.email.reply_to ?? ctx.config.branding.support_email : ctx.config.email.reply_to,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        attachments: req.attachments,
        headers: { "X-QTIAuth-Template": req.template, "X-Entity-Ref-ID": id },
      });
      observe("qtiauth_email_send_seconds", (performance.now() - started) / 1000, { provider: this.provider.id }, undefined, "Email send latency");
      inc("qtiauth_emails_total", { provider: this.provider.id, template: req.template, status: "sent" }, 1, "Emails by provider, template and status");
      await this.log(id, req, to, userId, "sent", null, r.provider_message_id, attempt);
    } catch (err) {
      const permanent = err instanceof PermanentSendError || attempt >= ctx.config.email.max_attempts;
      inc("qtiauth_emails_total", { provider: this.provider.id, template: req.template, status: permanent ? "failed" : "retry" }, 1, "Emails by provider, template and status");
      await this.log(id, req, to, userId, permanent ? "failed" : "queued", (err as Error).message.slice(0, 500), null, attempt);
      if (!permanent) throw err;
      ctx.log.error({ template: req.template, err: (err as Error).message }, "email permanently failed");
    }
  }

  private async log(id: string, req: EmailRequest, to: string | null, userId: string | null, status: NotifierDB["email_deliveries"]["status"], error: string | null, providerId: string | null = null, attempt = 1): Promise<void> {
    await this.ctx.db
      .insertInto("email_deliveries")
      .values({
        id,
        template: req.template,
        sender: req.sender,
        to_email: to,
        to_hash: to ? emailHash(to) : "",
        user_id: userId,
        priority: req.priority ?? "normal",
        status,
        provider: this.provider.id,
        provider_message_id: providerId,
        attempts: attempt,
        last_error: error,
        sent_at: status === "sent" ? new Date() : null,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({ status, attempts: attempt, last_error: error, provider_message_id: providerId, sent_at: status === "sent" ? new Date() : null, to_email: to, to_hash: to ? emailHash(to) : "" }),
      )
      .execute();
  }
}
