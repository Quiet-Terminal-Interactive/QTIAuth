import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { ProblemError, type Logger } from "@qtiauth/common";
import type { Config } from "@qtiauth/config";

export interface OutgoingEmail {
  from: { name: string; address: string };
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content_base64: string; content_type: string }[];
  headers?: Record<string, string>;
}

export interface EmailProvider {
  id: string;
  send(message: OutgoingEmail): Promise<{ provider_message_id: string | null }>;
}

export class PermanentSendError extends Error {}

function fmt(a: { name: string; address: string }): string {
  return `"${a.name.replace(/"/g, "'")}" <${a.address}>`;
}

async function http(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (r.status >= 400 && r.status < 500 && r.status !== 429) throw new PermanentSendError(`${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

function consoleProvider(log: Logger): EmailProvider {
  return {
    id: "console",
    async send(m) {
      process.stdout.write(
        `\n===== EMAIL (console provider) =====\nFrom: ${fmt(m.from)}\nTo: ${m.to}\nSubject: ${m.subject}\n${m.attachments?.length ? `Attachments: ${m.attachments.map((a) => a.filename).join(", ")}\n` : ""}\n${m.text}\n===== END EMAIL =====\n`,
      );
      log.debug({ subject: m.subject }, "email printed by console provider");
      return { provider_message_id: null };
    },
  };
}

function smtp(cfg: Config["email"]): EmailProvider {
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    ...(cfg.smtp.user ? { auth: { user: cfg.smtp.user, pass: cfg.smtp.password ?? "" } } : {}),
  });
  return {
    id: "smtp",
    async send(m) {
      try {
        const info = await transport.sendMail({
          from: fmt(m.from),
          to: m.to,
          replyTo: m.replyTo,
          subject: m.subject,
          html: m.html,
          text: m.text,
          headers: m.headers,
          attachments: m.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content_base64, "base64"), contentType: a.content_type })),
        });
        return { provider_message_id: info.messageId ?? null };
      } catch (err) {
        const code = (err as { responseCode?: number }).responseCode;
        if (code && code >= 500 && code < 600 && code !== 503) throw new PermanentSendError(String((err as Error).message));
        throw err;
      }
    },
  };
}

function brevo(cfg: Config["email"]): EmailProvider {
  return {
    id: "brevo",
    async send(m) {
      const r = await http("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": cfg.api_key!, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { name: m.from.name, email: m.from.address },
          to: [{ email: m.to }],
          ...(m.replyTo ? { replyTo: { email: m.replyTo } } : {}),
          subject: m.subject,
          htmlContent: m.html,
          textContent: m.text,
          ...(m.headers ? { headers: m.headers } : {}),
          ...(m.attachments?.length ? { attachment: m.attachments.map((a) => ({ name: a.filename, content: a.content_base64 })) } : {}),
        }),
      });
      return { provider_message_id: (r.messageId as string) ?? null };
    },
  };
}

function postmark(cfg: Config["email"]): EmailProvider {
  return {
    id: "postmark",
    async send(m) {
      const r = await http("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { "X-Postmark-Server-Token": cfg.api_key!, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          From: fmt(m.from),
          To: m.to,
          ReplyTo: m.replyTo,
          Subject: m.subject,
          HtmlBody: m.html,
          TextBody: m.text,
          MessageStream: "outbound",
          Headers: Object.entries(m.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
          Attachments: m.attachments?.map((a) => ({ Name: a.filename, Content: a.content_base64, ContentType: a.content_type })),
        }),
      });
      return { provider_message_id: (r.MessageID as string) ?? null };
    },
  };
}

function resend(cfg: Config["email"]): EmailProvider {
  return {
    id: "resend",
    async send(m) {
      const r = await http("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.api_key}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: fmt(m.from),
          to: [m.to],
          ...(m.replyTo ? { reply_to: m.replyTo } : {}),
          subject: m.subject,
          html: m.html,
          text: m.text,
          headers: m.headers,
          attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content_base64 })),
        }),
      });
      return { provider_message_id: (r.id as string) ?? null };
    },
  };
}

function mailgun(cfg: Config["email"]): EmailProvider {
  const host = cfg.mailgun_region === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
  return {
    id: "mailgun",
    async send(m) {
      const form = new FormData();
      form.set("from", fmt(m.from));
      form.set("to", m.to);
      form.set("subject", m.subject);
      form.set("html", m.html);
      form.set("text", m.text);
      if (m.replyTo) form.set("h:Reply-To", m.replyTo);
      for (const [k, v] of Object.entries(m.headers ?? {})) form.set(`h:${k}`, v);
      for (const a of m.attachments ?? []) form.append("attachment", new Blob([Buffer.from(a.content_base64, "base64")], { type: a.content_type }), a.filename);
      const r = await http(`${host}/v3/${cfg.mailgun_domain}/messages`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`api:${cfg.api_key}`).toString("base64")}` },
        body: form,
      });
      return { provider_message_id: (r.id as string) ?? null };
    },
  };
}

function ses(cfg: Config["email"]): EmailProvider {
  const client = new SESv2Client({ region: cfg.ses_region, credentials: { accessKeyId: cfg.ses_access_key_id ?? "", secretAccessKey: cfg.ses_secret_access_key ?? "" } });
  return {
    id: "ses",
    async send(m) {
      const raw = await new Promise<Buffer>((resolve, reject) => {
        new MailComposer({
          from: fmt(m.from),
          to: m.to,
          replyTo: m.replyTo,
          subject: m.subject,
          html: m.html,
          text: m.text,
          headers: m.headers,
          attachments: m.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content_base64, "base64"), contentType: a.content_type })),
        })
          .compile()
          .build((err, msg) => (err ? reject(err) : resolve(msg)));
      });
      try {
        const r = await client.send(new SendEmailCommand({ Content: { Raw: { Data: raw } } }));
        return { provider_message_id: r.MessageId ?? null };
      } catch (err) {
        const name = (err as { name?: string }).name ?? "";
        if (["MessageRejected", "MailFromDomainNotVerifiedException", "AccountSuspendedException", "BadRequestException"].includes(name)) throw new PermanentSendError(name);
        throw err;
      }
    },
  };
}

export function createProvider(cfg: Config, log: Logger): EmailProvider {
  const e = cfg.email;
  switch (e.provider) {
    case "smtp":
      return smtp(e);
    case "brevo":
      return brevo(e);
    case "postmark":
      return postmark(e);
    case "resend":
      return resend(e);
    case "mailgun":
      return mailgun(e);
    case "ses":
      return ses(e);
    case "console":
      return consoleProvider(log);
    default:
      throw new ProblemError(500, "UNKNOWN_EMAIL_PROVIDER");
  }
}

export interface BounceEvent {
  email: string;
  kind: "hard_bounce" | "soft_bounce" | "complaint" | "delivered";
  provider_message_id?: string | null;
}

export function parseProviderEvents(provider: string, body: unknown): BounceEvent[] {
  const out: BounceEvent[] = [];
  const items = Array.isArray(body) ? body : [body];
  for (const raw of items) {
    const b = (raw ?? {}) as Record<string, any>;
    switch (provider) {
      case "postmark":
        if (b.RecordType === "Bounce") out.push({ email: b.Email, kind: ["HardBounce", "BadEmailAddress", "Blocked"].includes(b.Type) ? "hard_bounce" : "soft_bounce", provider_message_id: b.MessageID });
        if (b.RecordType === "SpamComplaint") out.push({ email: b.Email, kind: "complaint", provider_message_id: b.MessageID });
        if (b.RecordType === "Delivery") out.push({ email: b.Recipient, kind: "delivered", provider_message_id: b.MessageID });
        break;
      case "brevo":
        if (b.event === "hard_bounce" || b.event === "invalid_email") out.push({ email: b.email, kind: "hard_bounce", provider_message_id: b["message-id"] });
        if (b.event === "soft_bounce") out.push({ email: b.email, kind: "soft_bounce", provider_message_id: b["message-id"] });
        if (b.event === "spam" || b.event === "complaint") out.push({ email: b.email, kind: "complaint", provider_message_id: b["message-id"] });
        if (b.event === "delivered") out.push({ email: b.email, kind: "delivered", provider_message_id: b["message-id"] });
        break;
      case "resend": {
        const to = Array.isArray(b.data?.to) ? b.data.to : [b.data?.to];
        for (const email of to.filter(Boolean)) {
          if (b.type === "email.bounced") out.push({ email, kind: b.data?.bounce?.type === "Transient" ? "soft_bounce" : "hard_bounce", provider_message_id: b.data?.email_id });
          if (b.type === "email.complained") out.push({ email, kind: "complaint", provider_message_id: b.data?.email_id });
          if (b.type === "email.delivered") out.push({ email, kind: "delivered", provider_message_id: b.data?.email_id });
        }
        break;
      }
      case "mailgun": {
        const ev = b["event-data"] ?? {};
        if (ev.event === "failed") out.push({ email: ev.recipient, kind: ev.severity === "permanent" ? "hard_bounce" : "soft_bounce", provider_message_id: ev.message?.headers?.["message-id"] });
        if (ev.event === "complained") out.push({ email: ev.recipient, kind: "complaint", provider_message_id: ev.message?.headers?.["message-id"] });
        if (ev.event === "delivered") out.push({ email: ev.recipient, kind: "delivered", provider_message_id: ev.message?.headers?.["message-id"] });
        break;
      }
      case "ses": {
        const msg = typeof b.Message === "string" ? (JSON.parse(b.Message) as Record<string, any>) : b;
        const id = msg.mail?.messageId;
        if (msg.notificationType === "Bounce" || msg.eventType === "Bounce") {
          for (const r of msg.bounce?.bouncedRecipients ?? []) out.push({ email: r.emailAddress, kind: msg.bounce?.bounceType === "Permanent" ? "hard_bounce" : "soft_bounce", provider_message_id: id });
        }
        if (msg.notificationType === "Complaint" || msg.eventType === "Complaint") {
          for (const r of msg.complaint?.complainedRecipients ?? []) out.push({ email: r.emailAddress, kind: "complaint", provider_message_id: id });
        }
        if (msg.notificationType === "Delivery" || msg.eventType === "Delivery") for (const e of msg.delivery?.recipients ?? []) out.push({ email: e, kind: "delivered", provider_message_id: id });
        break;
      }
      default:
        break;
    }
  }
  return out.filter((e) => typeof e.email === "string" && e.email.includes("@"));
}
