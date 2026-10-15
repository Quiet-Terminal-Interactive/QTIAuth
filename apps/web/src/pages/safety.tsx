import type { Problem } from "../api.ts";
import { fieldErrors } from "../api.ts";
import { actions, attempt, page, unwrap, type PageRoute } from "../app.tsx";
import { href, requireUser, type RequestContext } from "../context.ts";
import { ActionForm, Alert, Card, Empty, Field, LinkButton, PageHead, ProblemAlert, Select, StateBadge, Submit, TextArea, fmtDate } from "../ui.tsx";
import { shell } from "./common.tsx";

interface Taxonomy {
  types: { id: string; label: string; subtypes: { id: string; label: string }[] }[];
}

interface MyAction {
  id: string;
  label: string;
  effect: string;
  rule_title: string;
  rule_text: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  can_appeal: boolean;
  appeal: { reference: string; status: string } | null;
}

async function safetyHome(rc: RequestContext, o: { problem?: Problem | null; sent?: string } = {}) {
  requireUser(rc, { restricted: true });
  const [tax, mine, acts] = await Promise.all([
    rc.api.get<Taxonomy>("/api/v1/safety/taxonomy"),
    rc.api.get<{ items: { reference: string; type_label: string; status: string; outcome: string | null; created_at: string }[] }>("/api/v1/safety/reports"),
    rc.api.get<{ items: MyAction[] }>("/api/v1/safety/actions/mine"),
  ]);
  const types = tax.ok ? tax.data.types : [];
  const subtypeOptions = types.flatMap((t) => t.subtypes.map((s) => ({ value: `${t.id}:${s.id}`, label: `${t.label} – ${s.label}` })));
  const errs = fieldErrors(o.problem);
  const restricted = rc.claims.state === "locked" || rc.claims.state === "banned";
  return shell(
    rc,
    { title: rc.t("nav.safety"), active: "safety" },
    <div class="stack-lg">
      <PageHead title={rc.t("safety.report_title")} lede={rc.t("safety.report_lede")} />
      {acts.ok && acts.data.items.length ? (
        <Card title={rc.t("safety.actions_title")}>
          <div class="list">
            {acts.data.items.map((a) => (
              <div class="item">
                <div>
                  <strong>{a.label}</strong> <StateBadge rc={rc} state={a.status} />
                  <div class="meta">
                    {a.rule_title} · {fmtDate(rc, a.created_at)}
                    {a.expires_at ? ` → ${fmtDate(rc, a.expires_at)}` : ""}
                  </div>
                  {a.appeal ? <div class="meta">{rc.t("safety.appeal_sent", { reference: a.appeal.reference })}</div> : null}
                </div>
                {a.can_appeal ? <LinkButton href={href(rc, `/safety/appeal/${a.id}`)} kind="secondary" small>{rc.t("safety.appeal")}</LinkButton> : null}
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {restricted ? null : (
        <Card>
          <ProblemAlert rc={rc} problem={o.problem} />
          {o.sent ? <Alert kind="success">{rc.t("safety.sent", { reference: o.sent })}</Alert> : null}
          <ActionForm action={href(rc, "/safety")} name="report">
            <Select name="kind" label={rc.t("safety.type")} options={subtypeOptions} value={rc.form.kind} required placeholder="–" error={errs.type} />
            <div class="grid-2">
              <Field name="reported_user_id" label={rc.t("safety.user_id")} value={rc.form.reported_user_id ?? rc.query.get("user")} error={errs.reported_user_id} />
              <Field name="content_id" label={rc.t("safety.content_id")} value={rc.form.content_id ?? rc.query.get("content")} />
            </div>
            <TextArea name="description" label={rc.t("safety.description")} value={rc.form.description} maxlength={4000} />
            <div>
              <Submit>{rc.t("safety.submit")}</Submit>
            </div>
          </ActionForm>
        </Card>
      )}
      <Card title={rc.t("safety.my_reports")}>
        {mine.ok && mine.data.items.length ? (
          <div class="table-wrap">
            <table class="table">
              <tbody>
                {mine.data.items.map((r) => (
                  <tr>
                    <td class="mono">{r.reference}</td>
                    <td>{r.type_label}</td>
                    <td>
                      <StateBadge rc={rc} state={r.status} />
                    </td>
                    <td class="muted">{fmtDate(rc, r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={rc.t("app.none")} />
        )}
      </Card>
    </div>,
  );
}

async function appealPage(rc: RequestContext, actionId: string, o: { problem?: Problem | null; sent?: string } = {}) {
  requireUser(rc, { restricted: true, legal: true });
  const acts = unwrap(rc, await rc.api.get<{ items: MyAction[] }>("/api/v1/safety/actions/mine"));
  const a = acts.items.find((x) => x.id === actionId);
  return shell(
    rc,
    { title: rc.t("safety.appeal_title"), active: "safety" },
    <div class="stack-lg">
      <PageHead title={rc.t("safety.appeal_title")} crumbs={[{ href: href(rc, "/safety"), label: rc.t("nav.safety") }]} />
      {!a ? (
        <Card>
          <Empty title={rc.t("error.NOT_FOUND")} />
        </Card>
      ) : (
        <Card title={a.label}>
          <p>
            <strong>{a.rule_title}.</strong> {a.rule_text}
          </p>
          <ProblemAlert rc={rc} problem={o.problem} />
          {o.sent ? (
            <Alert kind="success">{rc.t("safety.appeal_sent", { reference: o.sent })}</Alert>
          ) : a.can_appeal ? (
            <ActionForm action={href(rc, `/safety/appeal/${actionId}`)} name="appeal">
              <TextArea name="statement" label={rc.t("safety.appeal_statement")} required maxlength={5000} value={rc.form.statement} />
              <div>
                <Submit>{rc.t("safety.appeal_submit")}</Submit>
              </div>
            </ActionForm>
          ) : a.appeal ? (
            <Alert kind="info">{rc.t("safety.appeal_sent", { reference: a.appeal.reference })}</Alert>
          ) : null}
        </Card>
      )}
    </div>,
  );
}

export const safetyRoutes: PageRoute[] = [
  page("/safety", (rc) => safetyHome(rc)),
  actions("/safety", {
    report: async (rc) => {
      const [type, subtype] = (rc.form.kind ?? "").split(":");
      const r = attempt(
        rc,
        await rc.api.post<{ reference: string }>("/api/v1/safety/reports", {
          type: type ?? "",
          subtype: subtype || null,
          reported_user_id: rc.form.reported_user_id?.trim() || null,
          content: rc.form.content_id?.trim() ? { id: rc.form.content_id.trim() } : null,
          description: rc.form.description?.trim() || null,
        }),
      );
      return r.ok ? safetyHome(rc, { sent: r.data.reference }) : safetyHome(rc, { problem: r.problem });
    },
  }),
  page("/safety/appeal/:id", (rc, p) => appealPage(rc, p.id!)),
  actions("/safety/appeal/:id", {
    appeal: async (rc, p) => {
      const r = attempt(rc, await rc.api.post<{ reference: string }>("/api/v1/safety/appeals", { action_id: p.id, statement: rc.form.statement ?? "" }));
      return r.ok ? appealPage(rc, p.id!, { sent: r.data.reference }) : appealPage(rc, p.id!, { problem: r.problem });
    },
  }),
];

