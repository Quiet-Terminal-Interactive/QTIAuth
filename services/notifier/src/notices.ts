import { surfaceUrl } from "@qtiauth/config";
import { EVENTS, type EventEnvelope } from "@qtiauth/bus";
import type { ServiceContext } from "@qtiauth/service-kit";
import type { NotifierDB } from "./db.ts";

type Ctx = ServiceContext<NotifierDB>;

interface NoticeRecipient {
  user_id: string;
  email: string;
  locale: string | null;
  name: string;
  age_band: string | null;
  guardians: { id: string; email: string }[];
}

export async function startLegalNotice(ctx: Ctx, env: EventEnvelope<Record<string, unknown>>): Promise<void> {
  await ctx.db
    .insertInto("notice_runs")
    .values({ id: `legal-${env.event_id}`, kind: "legal_update", data: JSON.stringify(env.data) })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
}

export async function continueNotices(ctx: Ctx, budget = 2000): Promise<number> {
  const runs = await ctx.db.selectFrom("notice_runs").selectAll().where("done", "=", false).orderBy("created_at").limit(5).execute();
  let sent = 0;
  for (const run of runs) {
    let cursor = run.cursor;
    while (sent < budget) {
      const page = await ctx.rpc<{ items: NoticeRecipient[]; next_cursor: string | null }>("identity.list_notice_recipients", { cursor, limit: 500 }, { timeoutMs: 30_000 });
      const d = run.data as { title: string; summary: string | null; material: boolean; url: string; document_id: string; version: string };
      await ctx.db.transaction().execute(async (trx) => {
        for (const r of page.items) {
          const childManaged = r.guardians.length > 0 && r.age_band === "under_13";
          await ctx.email(trx, {
            template: "legal_update",
            to: { user_id: r.user_id },
            locale: r.locale,
            vars: { name: r.name, title: d.title, summary: d.summary ?? "", material: d.material && !childManaged, url: d.url },
            sender: "auth",
            notification_category: "legal",
            dedupe_key: `legal-${d.document_id}-${d.version}-${r.user_id}`,
          });
          for (const g of r.guardians) {
            await ctx.email(trx, {
              template: "guardian_legal_update",
              to: { email: g.email, guardian_id: g.id },
              locale: r.locale,
              vars: { child_name: r.name, title: d.title, summary: d.summary ?? "", material: d.material, url: d.url },
              sender: "auth",
              dedupe_key: `legal-${d.document_id}-${d.version}-g${g.id}`,
            });
          }
        }
        cursor = page.next_cursor;
        await trx
          .updateTable("notice_runs")
          .set({ cursor, sent: run.sent + page.items.length, done: !page.next_cursor })
          .where("id", "=", run.id)
          .execute();
      });
      sent += page.items.length;
      if (!page.next_cursor) break;
    }
  }
  return sent;
}

export async function staffAlerts(ctx: Ctx, env: EventEnvelope<Record<string, unknown>>): Promise<void> {
  const d = env.data;
  if (env.type === EVENTS.supportTicketCreated) {
    const staff = await ctx.rpcOptional<{ user_id: string }[]>("identity.staff_recipients", { permission: "support.tickets.staff", category: "staff.new_ticket" }, []);
    await ctx.db.transaction().execute(async (trx) => {
      for (const s of staff) {
        await ctx.email(trx, {
          template: "staff_new_ticket",
          to: { user_id: s.user_id },
          vars: { number: d.number, subject: d.subject ?? "", category: d.category ?? "", priority: d.priority ?? "normal", ticket_url: surfaceUrl(ctx.surfaces.support, `/staff/tickets/${d.number}`) },
          sender: "support",
          notification_category: "staff.new_ticket",
          dedupe_key: `staff-ticket-${d.ticket_id}-${s.user_id}`,
        });
      }
    });
    return;
  }
  if (env.type === EVENTS.safetyReportCreated && (d.priority === "high" || d.priority === "critical") && !d.csea) {
    const staff = await ctx.rpcOptional<{ user_id: string }[]>("identity.staff_recipients", { permission: "safety.reports.read", category: "staff.high_priority_report" }, []);
    await ctx.db.transaction().execute(async (trx) => {
      for (const s of staff) {
        await ctx.email(trx, {
          template: "staff_high_priority_report",
          to: { user_id: s.user_id },
          vars: { report_id: d.report_id, type: d.type, priority: d.priority, sla_due_at: d.sla_due_at ?? "", report_url: surfaceUrl(ctx.surfaces.account, `/admin/safety/reports/${d.report_id}`) },
          sender: "security",
          priority: "high",
          notification_category: "staff.high_priority_report",
          dedupe_key: `staff-report-${d.report_id}-${s.user_id}`,
        });
      }
    });
  }
}

export async function cseaAlert(ctx: Ctx, env: EventEnvelope<Record<string, unknown>>): Promise<void> {
  const caseId = String(env.data.case_id ?? "");
  await ctx.db.transaction().execute(async (trx) => {
    for (const email of ctx.config.safety.csea_alert_emails) {
      await ctx.email(trx, {
        template: "csea_case_alert",
        to: { email },
        vars: { case_url: surfaceUrl(ctx.surfaces.account, `/admin/safety/csea/${caseId}`) },
        sender: "security",
        priority: "high",
        bypass_suppression: true,
        dedupe_key: `csea-${caseId}-${email}`,
      });
    }
  });
}
