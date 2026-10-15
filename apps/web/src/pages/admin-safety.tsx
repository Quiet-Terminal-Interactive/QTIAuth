import type { Problem } from "../api.ts";
import { actions, attempt, back, page, unwrap, type PageRoute } from "../app.tsx";
import { can, href, requirePermission, type RequestContext } from "../context.ts";
import { ActionForm, Alert, Badge, Card, Empty, Field, Json, PageHead, Pager, ProblemAlert, Select, StateBadge, Submit, TextArea, fmtDate, fmtDateTime, fmtRelative, stateLabel } from "../ui.tsx";
import { ReasonForm, adminShell } from "./admin.tsx";

interface Overview {
  queue: Record<string, { open: number; overdue: number }>;
  open_appeals: number;
  pending_flags: number;
  pending_approvals: number;
  open_csea_cases: number | null;
  accountable_person: { name: string; role: string };
  taxonomy: { id: string; label: string; subtypes: { id: string; label: string }[] }[];
  actions: { id: string; label: string; effect: string; requires_duration: boolean; default_duration_ms: number | null }[];
  rules: { id: string; title: string }[];
}

interface ReportRow {
  id: string;
  reference: string;
  type: string;
  type_label: string;
  priority: string;
  status: string;
  source: string;
  csea: boolean;
  sla_due_at: string;
  sla_breached: boolean;
  created_at: string;
  reported_user: { id: string; username: string | null } | null;
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

async function overview(rc: RequestContext): Promise<Overview> {
  return unwrap(rc, await rc.api.get<Overview>("/api/v1/admin/safety/overview"));
}

async function queue(rc: RequestContext) {
  requirePermission(rc, "safety.reports.read");
  const q = Object.fromEntries(["status", "priority", "type", "source", "assigned_to", "cursor"].map((k) => [k, rc.query.get(k) ?? undefined])) as Record<string, string | undefined>;
  const [o, r] = await Promise.all([overview(rc), rc.api.get<{ items: ReportRow[]; next_cursor: string | null }>("/api/v1/admin/safety/reports", q)]);
  const list = unwrap(rc, r);
  return adminShell(
    rc,
    "safety",
    rc.t("nav.admin_safety"),
    <>
      <PageHead title={rc.t("nav.admin_safety")} lede={`${o.accountable_person.name} · ${o.accountable_person.role}`} />
      <div class="grid-3">
        {(["critical", "high", "normal", "low"] as const).map((p) => (
          <a class="tile link-card" href={href(rc, "/admin/safety", { priority: p })}>
            <div class="label">{p}</div>
            <div class="value">{o.queue[p]?.open ?? 0}</div>
            {o.queue[p]?.overdue ? <Badge color="red">{o.queue[p]!.overdue} overdue</Badge> : null}
          </a>
        ))}
        <a class="tile link-card" href={href(rc, "/admin/safety/appeals")}>
          <div class="label">{rc.t("nav.admin_appeals")}</div>
          <div class="value">{o.open_appeals}</div>
        </a>
        <a class="tile link-card" href={href(rc, "/admin/safety/flags")}>
          <div class="label">{rc.t("nav.admin_flags")}</div>
          <div class="value">{o.pending_flags}</div>
        </a>
        {o.pending_approvals ? (
          <a class="tile link-card" href={href(rc, "/admin/safety/actions", { status: "pending_approval" })}>
            <div class="label">{rc.t("ui.pending_ban_approvals")}</div>
            <div class="value">{o.pending_approvals}</div>
          </a>
        ) : null}
        {o.open_csea_cases !== null ? (
          <a class="tile link-card" href={href(rc, "/admin/safety/csea")}>
            <div class="label">{rc.t("nav.admin_csea")}</div>
            <div class="value">{o.open_csea_cases}</div>
          </a>
        ) : null}
      </div>
      <form method="get" action={href(rc, "/admin/safety")} class="row">
        <select name="status" aria-label={rc.t("staff.status")}>
          {["unresolved", "open", "in_review", "actioned", "dismissed", "all"].map((s) => (
            <option value={s} selected={(q.status ?? "unresolved") === s}>
              {stateLabel(rc, s)}
            </option>
          ))}
        </select>
        <select name="type" aria-label={rc.t("ui.type")}>
          <option value="">{rc.t("app.all")}</option>
          {o.taxonomy.map((t) => (
            <option value={t.id} selected={q.type === t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <select name="assigned_to" aria-label={rc.t("ui.assigned")}>
          <option value="">{rc.t("app.all")}</option>
          <option value="me" selected={q.assigned_to === "me"}>{rc.t("ui.assigned_me")}</option>
          <option value="none" selected={q.assigned_to === "none"}>{rc.t("ui.unassigned")}</option>
        </select>
        <button class="btn secondary">{rc.t("app.search")}</button>
      </form>
      <div class="card flush">
        <div class="table-wrap">
          <table class="table">
            <tbody>
              {list.items.map((r) => (
                <tr>
                  <td>
                    <StateBadge rc={rc} state={r.priority} />
                  </td>
                  <td>
                    <a class="row-link" href={href(rc, `/admin/safety/reports/${r.id}`)}>
                      {r.type_label}
                    </a>
                    <div class="hint mono">{r.reference}</div>
                  </td>
                  <td>{r.reported_user?.username ?? r.reported_user?.id?.slice(0, 8) ?? "–"}</td>
                  <td>
                    <StateBadge rc={rc} state={r.status} />
                  </td>
                  <td>{r.sla_breached ? <Badge color="red">{rc.t("ui.sla")}</Badge> : <span class="muted">{fmtRelative(rc, r.sla_due_at)}</span>}</td>
                  <td class="muted">{r.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.items.length ? null : <Empty title={rc.t("app.none")} />}
      </div>
      <Pager rc={rc} next={list.next_cursor} path={href(rc, "/admin/safety")} query={{ ...q, cursor: undefined }} />
    </>,
  );
}

function ActionPanel({ rc, o, userId, reportId, gameId, contentId, path }: { rc: RequestContext; o: Overview; userId: string; reportId?: string; gameId?: string | null; contentId?: string | null; path: string }) {
  return (
    <ActionForm action={path} name="apply" fields={{ user_id: userId, report_id: reportId, game_id: gameId ?? undefined, content_id: contentId ?? undefined }}>
      <div class="grid-2">
        <Select name="action_type" label={rc.t("ui.action")} required options={o.actions.map((a) => ({ value: a.id, label: `${a.label}${a.requires_duration ? " *" : ""}` }))} />
        <Select name="rule" label={rc.t("ui.rule")} required placeholder="–" options={o.rules.map((r) => ({ value: r.id, label: r.title }))} />
      </div>
      <Field name="duration" label={rc.t("ui.duration_e_g_7d_12h")} pattern="[0-9]+(ms|s|m|h|d|w|y)" hint={rc.t("ui.required_for_actions_marked_defaults_app")} />
      <TextArea name="note" label={rc.t("ui.internal_note")} rows={3} />
      <div>
        <Submit kind="danger">{rc.t("ui.apply_action")}</Submit>
      </div>
    </ActionForm>
  );
}

async function reportDetail(rc: RequestContext, id: string, problem?: Problem | null) {
  requirePermission(rc, "safety.reports.read");
  const [o, r] = await Promise.all([
    overview(rc),
    rc.api.get<
      ReportRow & {
        reporter: { username: string | null } | null;
        description?: string | null;
        snapshot?: unknown;
        context?: unknown;
        content: { id?: string; type?: string; url?: string } | null;
        game_id: string | null;
        case_id: string | null;
        resolution: string | null;
        resolution_note?: string | null;
        user_actions: { id: string; label: string; status: string; created_at: string; rule_title: string }[];
        related_reports: { id: string; reference: string; type: string; status: string; created_at: string }[];
        subtype: string | null;
        reported_user_id: string | null;
      }
    >(`/api/v1/admin/safety/reports/${enc(id)}`),
  ]);
  const rep = unwrap(rc, r);
  const path = href(rc, `/admin/safety/reports/${id}`);
  const resolved = rep.status === "actioned" || rep.status === "dismissed";
  return adminShell(
    rc,
    "safety",
    rep.reference,
    <>
      <PageHead title={rep.type_label} lede={<span class="mono">{rep.reference}</span>} crumbs={[{ href: href(rc, "/admin/safety"), label: rc.t("nav.admin_safety") }]} actions={<><StateBadge rc={rc} state={rep.priority} /> <StateBadge rc={rc} state={rep.status} /></>} />
      <ProblemAlert rc={rc} problem={problem} />
      {rep.csea ? (
        <Alert kind="danger" title="CSEA">
          {rep.case_id ? <a href={href(rc, `/admin/safety/csea/${rep.case_id}`)}>{rc.t("ui.open_case")}</a> : null}
        </Alert>
      ) : null}
      <div class="grid-2">
        <Card title={<h3>{rc.t("ui.report")}</h3>}>
          <dl class="kv">
            <dt>{rc.t("ui.reported_user")}</dt>
            <dd>{rep.reported_user_id ? <a href={href(rc, `/admin/users/${rep.reported_user_id}`)}>{rep.reported_user?.username ?? rep.reported_user_id}</a> : "–"}</dd>
            <dt>{rc.t("ui.reporter")}</dt>
            <dd>{rep.reporter?.username ?? (rep.source === "user" ? "–" : rep.source)}</dd>
            <dt>{rc.t("ui.content")}</dt>
            <dd>{rep.content ? <code>{[rep.content.type, rep.content.id].filter(Boolean).join(":")}</code> : "–"}</dd>
            <dt>{rc.t("ui.created")}</dt>
            <dd>{fmtDateTime(rc, rep.created_at)}</dd>
            <dt>{rc.t("ui.sla")}</dt>
            <dd>{rep.sla_breached ? <Badge color="red">{stateLabel(rc, "breached")}</Badge> : fmtDateTime(rc, rep.sla_due_at)}</dd>
            {rep.resolution ? (
              <>
                <dt>{rc.t("ui.resolution")}</dt>
                <dd>
                  {rep.resolution} {rep.resolution_note ? `· ${rep.resolution_note}` : ""}
                </dd>
              </>
            ) : null}
          </dl>
          {rep.description ? (
            <>
              <hr />
              <div class="msg-body">{rep.description}</div>
            </>
          ) : null}
          {rep.snapshot ? <Json value={rep.snapshot} /> : null}
        </Card>
        <div class="stack">
          {!resolved && rep.reported_user_id && can(rc, "safety.actions.apply") ? (
            <Card title={<h3>{rc.t("ui.take_action")}</h3>}>
              <ActionPanel rc={rc} o={o} userId={rep.reported_user_id} reportId={rep.id} gameId={rep.game_id} contentId={rep.content?.id ?? null} path={path} />
            </Card>
          ) : null}
          {!resolved && can(rc, "safety.actions.apply") ? (
            <Card>
              <div class="stack">
                <ActionForm action={path} name="assign" class="row">
                  <Submit kind="secondary" small>
                    {rc.t("staff.assign_me")}
                  </Submit>
                </ActionForm>
                <ReasonForm rc={rc} action={path} name="dismiss" label={rc.t("ui.dismiss_no_breach")} />
                <ReasonForm rc={rc} action={path} name="reclassify" label={rc.t("ui.reclassify")}>
                  <Select name="kind" label={rc.t("ui.type")} options={o.taxonomy.flatMap((t) => t.subtypes.map((s) => ({ value: `${t.id}:${s.id}`, label: `${t.label} – ${s.label}` })))} />
                </ReasonForm>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
      {rep.user_actions.length ? (
        <Card title={<h3>{rc.t("ui.history")}</h3>}>
          <ul>
            {rep.user_actions.map((a) => (
              <li>
                {a.label} · {a.rule_title} <StateBadge rc={rc} state={a.status} /> <span class="muted">{fmtDate(rc, a.created_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {rep.related_reports.length ? (
        <Card title={<h3>{rc.t("ui.other_reports")}</h3>}>
          <ul>
            {rep.related_reports.map((x) => (
              <li>
                <a href={href(rc, `/admin/safety/reports/${x.id}`)}>{x.reference}</a> {x.type} <StateBadge rc={rc} state={x.status} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>,
  );
}

async function applyFromForm(rc: RequestContext) {
  return rc.api.post("/api/v1/admin/safety/actions", {
    user_id: rc.form.user_id ?? "",
    action_type: rc.form.action_type ?? "",
    rule: rc.form.rule ?? "",
    duration: rc.form.duration?.trim() || undefined,
    note: rc.form.note?.trim() || undefined,
    report_id: rc.form.report_id || undefined,
    game_id: rc.form.game_id || undefined,
    content: rc.form.content_id ? { id: rc.form.content_id } : undefined,
  });
}

async function actionsList(rc: RequestContext, problem?: Problem | null) {
  requirePermission(rc, "safety.reports.read");
  const q = Object.fromEntries(["user_id", "moderator_id", "status", "cursor"].map((k) => [k, rc.query.get(k) ?? undefined])) as Record<string, string | undefined>;
  const r = unwrap(rc, await rc.api.get<{ items: { id: string; label: string; status: string; rule_title: string; user: { username: string | null } | null; user_id: string; moderator: { username: string | null } | null; created_at: string; expires_at: string | null }[]; next_cursor: string | null }>("/api/v1/admin/safety/actions", q));
  const path = href(rc, "/admin/safety/actions");
  return adminShell(
    rc,
    "safety",
    rc.t("ui.actions"),
    <>
      <PageHead title={rc.t("ui.actions")} crumbs={[{ href: href(rc, "/admin/safety"), label: rc.t("nav.admin_safety") }]} />
      <ProblemAlert rc={rc} problem={problem} />
      <div class="card flush">
        <div class="list">
          {r.items.map((a) => (
            <div class="item">
              <div>
                <strong>{a.label}</strong> <StateBadge rc={rc} state={a.status} />
                <div class="meta">
                  <a href={href(rc, `/admin/users/${a.user_id}`)}>{a.user?.username ?? a.user_id.slice(0, 8)}</a> · {a.rule_title} · {a.moderator?.username ?? ""} · {fmtDate(rc, a.created_at)}
                  {a.expires_at ? ` → ${fmtDate(rc, a.expires_at)}` : ""}
                </div>
              </div>
              {can(rc, "safety.actions.apply") ? (
                <div class="row">
                  {a.status === "pending_approval" ? (
                    <ActionForm action={path} name="approve" class="inline-form" fields={{ id: a.id }}>
                      <Submit small>{rc.t("family.approve")}</Submit>
                    </ActionForm>
                  ) : null}
                  {a.status === "active" || a.status === "pending_approval" ? (
                    <details>
                      <summary>{a.status === "pending_approval" ? rc.t("ui.reject") : rc.t("ui.lift")}</summary>
                      <ReasonForm rc={rc} action={path} name="lift" label={a.status === "pending_approval" ? rc.t("ui.reject") : rc.t("ui.lift")} fields={{ id: a.id }} />
                    </details>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        {r.items.length ? null : <Empty title={rc.t("app.none")} />}
      </div>
      <Pager rc={rc} next={r.next_cursor} path={path} query={{ ...q, cursor: undefined }} />
    </>,
  );
}

async function appeals(rc: RequestContext) {
  requirePermission(rc, "safety.appeals.resolve");
  const status = rc.query.get("status") ?? "open";
  const r = unwrap(rc, await rc.api.get<{ items: { id: string; reference: string; statement: string; status: string; created_at: string; user: { username: string | null } | null; action: { label: string; status: string } }[] }>("/api/v1/admin/safety/appeals", { status }));
  return adminShell(
    rc,
    "appeals",
    rc.t("nav.admin_appeals"),
    <>
      <PageHead title={rc.t("nav.admin_appeals")} />
      <div class="tabs">
        {["open", "upheld", "lifted", "all"].map((s) => (
          <a href={href(rc, "/admin/safety/appeals", { status: s })} aria-current={status === s ? "page" : undefined}>
            {s}
          </a>
        ))}
      </div>
      <div class="card flush">
        <div class="list">
          {r.items.map((a) => (
            <a class="item link-card" href={href(rc, `/admin/safety/appeals/${a.id}`)}>
              <div>
                <strong>{a.action.label}</strong> <span class="mono hint">{a.reference}</span>
                <div class="meta">
                  {a.user?.username ?? ""} · {fmtRelative(rc, a.created_at)}
                </div>
              </div>
              <StateBadge rc={rc} state={a.status} />
            </a>
          ))}
        </div>
        {r.items.length ? null : <Empty title={rc.t("app.none")} />}
      </div>
    </>,
  );
}

async function appealDetail(rc: RequestContext, id: string, problem?: Problem | null) {
  requirePermission(rc, "safety.appeals.resolve");
  const a = unwrap(rc, await rc.api.get<{ id: string; reference: string; statement: string; status: string; ticket_number: number | null; created_at: string; resolution_note: string | null; user_id: string; user: { username: string | null } | null; action: { label: string; rule_title: string; rule_text: string; note: string | null; status: string; created_at: string; moderator: { username: string | null } | null } }>(`/api/v1/admin/safety/appeals/${enc(id)}`));
  const path = href(rc, `/admin/safety/appeals/${id}`);
  return adminShell(
    rc,
    "appeals",
    a.reference,
    <>
      <PageHead title={a.action.label} lede={<span class="mono">{a.reference}</span>} crumbs={[{ href: href(rc, "/admin/safety/appeals"), label: rc.t("nav.admin_appeals") }]} actions={<StateBadge rc={rc} state={a.status} />} />
      <ProblemAlert rc={rc} problem={problem} />
      <div class="grid-2">
        <Card title={<h3>{rc.t("safety.appeal")}</h3>}>
          <p class="muted">
            <a href={href(rc, `/admin/users/${a.user_id}`)}>{a.user?.username ?? a.user_id}</a> · {fmtDateTime(rc, a.created_at)}
            {a.ticket_number ? ` · #${a.ticket_number}` : ""}
          </p>
          <div class="msg-body">{a.statement}</div>
        </Card>
        <Card title={<h3>{rc.t("ui.decision")}</h3>}>
          <p>
            <strong>{a.action.rule_title}.</strong> {a.action.rule_text}
          </p>
          <p class="muted">
            {a.action.moderator?.username ?? ""} · {fmtDate(rc, a.action.created_at)} <StateBadge rc={rc} state={a.action.status} />
          </p>
          {a.action.note ? <div class="msg-body">{a.action.note}</div> : null}
        </Card>
      </div>
      {a.status === "open" ? (
        <Card title={<h3>{rc.t("ui.resolve")}</h3>}>
          <ActionForm action={path} name="resolve">
            <Select name="outcome" label={rc.t("ui.outcome")} options={[{ value: "uphold", label: rc.t("ui.appeal_uphold") }, { value: "lift", label: rc.t("ui.appeal_lift") }]} />
            <TextArea name="note" label={rc.t("ui.explanation_to_the_user")} required rows={4} />
            <div>
              <Submit>{rc.t("app.confirm")}</Submit>
            </div>
          </ActionForm>
        </Card>
      ) : (
        <Card>{a.resolution_note}</Card>
      )}
    </>,
  );
}

async function flags(rc: RequestContext) {
  requirePermission(rc, "safety.flags.read");
  const [o, r] = await Promise.all([overview(rc), rc.api.get<{ threshold: number; items: { id: string; classifier: string; score: number; labels: string[]; user_id: string | null; content: { id?: string } | null; created_at: string }[] }>("/api/v1/admin/safety/flags")]);
  const list = unwrap(rc, r);
  const path = href(rc, "/admin/safety/flags");
  return adminShell(
    rc,
    "flags",
    rc.t("nav.admin_flags"),
    <>
      <PageHead title={rc.t("nav.admin_flags")} lede={`Auto-report threshold ${list.threshold}`} />
      <div class="card flush">
        <div class="list">
          {list.items.map((f) => (
            <div class="item">
              <div>
                <strong>{f.classifier}</strong> <Badge color={f.score > 0.6 ? "orange" : "neutral"}>{f.score.toFixed(2)}</Badge>
                <div class="meta">
                  {f.labels.join(", ")} · {f.content?.id ?? ""} · {fmtRelative(rc, f.created_at)}
                </div>
              </div>
              <div class="row">
                <ActionForm action={path} name="report" class="row" fields={{ id: f.id }}>
                  <select name="kind" aria-label={rc.t("ui.type")}>
                    {o.taxonomy.flatMap((t) => t.subtypes.map((s) => <option value={`${t.id}:${s.id}`} selected={f.labels[0] === t.id}>{`${t.label} – ${s.label}`}</option>))}
                  </select>
                  <Submit small>{rc.t("ui.report")}</Submit>
                </ActionForm>
                <ActionForm action={path} name="dismiss" class="inline-form" fields={{ id: f.id }}>
                  <Submit kind="secondary" small>
                    {rc.t("ui.dismiss")}
                  </Submit>
                </ActionForm>
              </div>
            </div>
          ))}
        </div>
        {list.items.length ? null : <Empty title={rc.t("app.none")} />}
      </div>
    </>,
  );
}

async function cseaList(rc: RequestContext) {
  requirePermission(rc, "safety.csea.access");
  const status = rc.query.get("status") ?? "open";
  const r = unwrap(rc, await rc.api.get<{ items: { id: string; status: string; deadline_at: string; overdue: boolean; nca_priority: number | null; nca_reference: string | null; created_at: string }[] }>("/api/v1/admin/safety/csea", { status }));
  return adminShell(
    rc,
    "csea",
    rc.t("nav.admin_csea"),
    <>
      <PageHead title={rc.t("nav.admin_csea")} />
      <Alert kind="warning">{rc.t("ui.access_to_this_area_is_audited")}</Alert>
      <div class="tabs">
        {["open", "submitted", "closed", "all"].map((s) => (
          <a href={href(rc, "/admin/safety/csea", { status: s })} aria-current={status === s ? "page" : undefined}>
            {s === "all" ? rc.t("app.all") : stateLabel(rc, s)}
          </a>
        ))}
      </div>
      <div class="card flush">
        <div class="list">
          {r.items.map((c) => (
            <a class="item link-card" href={href(rc, `/admin/safety/csea/${c.id}`)}>
              <div>
                <strong class="mono">{c.id.slice(0, 8)}</strong> {c.overdue ? <Badge color="red">{stateLabel(rc, "overdue")}</Badge> : null}{" "}
                {c.nca_priority ? <Badge color={c.nca_priority === 1 ? "red" : "orange"}>{rc.t("csea.priority_n", { level: c.nca_priority })}</Badge> : <Badge color="red">{rc.t("csea.unassessed")}</Badge>}
                <div class="meta">
                  {fmtDateTime(rc, c.created_at)} · {c.status === "open" ? rc.t("csea.target", { date: fmtDateTime(rc, c.deadline_at) }) : (c.nca_reference ?? "")}
                </div>
              </div>
              <StateBadge rc={rc} state={c.status} />
            </a>
          ))}
        </div>
        {r.items.length ? null : <Empty title={rc.t("app.none")} />}
      </div>
    </>,
  );
}

interface NcaField {
  group: string;
  id: string;
  label: string;
  value: string | null;
  source: "qtiauth" | "game" | "staff" | "not_held";
}

interface CseaCaseView {
  id: string;
  status: string;
  deadline_at: string;
  overdue: boolean;
  nca_priority: 1 | 2 | 3 | null;
  priority_reason: string | null;
  nca_reference: string | null;
  nca_submitted_at: string | null;
  reported_elsewhere: { body: string; reference: string | null; reported_at: string | null } | null;
  reference_retain_until: string | null;
  close_outcome: string | null;
  protective_action_id: string | null;
  legal_hold: boolean;
  report: ReportRow & { reported_user_id: string | null };
  evidence: { id: string; kind: string; created_at: string; destroy_after: string | null; destroyed: boolean; data: unknown }[];
  nca_sheet: NcaField[];
  supplementary: { id: string; nca_reference: string; submitted_at: string; note: string | null }[];
  nca_requests: { id: string; received_at: string; due_at: string; overdue: boolean; summary: string; responded_at: string | null; response_note: string | null }[];
  preservation_requests: { id: string; game_id: string; status: string; window_start: string; window_end: string; fulfilled_at: string | null }[];
}

function utcInput(v: string | undefined): string | undefined {
  return v ? `${v.length === 16 ? `${v}:00` : v}Z` : undefined;
}

async function cseaCase(rc: RequestContext, id: string, problem?: Problem | null) {
  requirePermission(rc, "safety.csea.access");
  const c = unwrap(rc, await rc.api.get<CseaCaseView>(`/api/v1/admin/safety/csea/${enc(id)}`));
  const path = href(rc, `/admin/safety/csea/${id}`);
  const open = c.status === "open";
  const groups = ["priority", "reporter", "content", "content_info", "user", "declaration"];
  const sourceBadge = (f: NcaField) =>
    f.source === "qtiauth" ? <Badge color="green">{rc.t("csea.source_qtiauth")}</Badge> : f.source === "game" ? <Badge color="orange">{rc.t("csea.source_game")}</Badge> : f.source === "staff" ? <Badge color="blue">{rc.t("csea.source_staff")}</Badge> : <Badge>{rc.t("csea.source_not_held")}</Badge>;
  return adminShell(
    rc,
    "csea",
    rc.t("nav.admin_csea"),
    <>
      <PageHead
        title={rc.t("csea.case_title", { id: c.id.slice(0, 8) })}
        lede={open ? `${c.report.reference} · ${rc.t("csea.target", { date: fmtDateTime(rc, c.deadline_at) })}` : c.report.reference}
        crumbs={[{ href: href(rc, "/admin/safety/csea"), label: rc.t("nav.admin_csea") }]}
        actions={<><StateBadge rc={rc} state={c.status} /> {c.legal_hold ? <Badge color="purple">{stateLabel(rc, "legal_hold")}</Badge> : null}</>}
      />
      <ProblemAlert rc={rc} problem={problem} />
      {c.overdue ? <Alert kind="danger">{rc.t("ui.the_nca_submission_deadline_has_passed")}</Alert> : null}
      {open && c.nca_priority === 1 ? <Alert kind="danger">{rc.t("csea.priority_1_now")}</Alert> : null}
      {c.nca_requests.some((r) => r.overdue) ? <Alert kind="danger">{rc.t("csea.request_overdue")}</Alert> : null}
      <div class="grid-2">
        <Card title={<h3>{rc.t("csea.priority")}</h3>}>
          {c.nca_priority ? (
            <p>
              <strong>{rc.t("csea.priority_n", { level: c.nca_priority })}</strong> · {c.priority_reason}
            </p>
          ) : (
            <p class="muted">{rc.t("csea.priority_hint")}</p>
          )}
          {open ? (
            <ReasonForm rc={rc} action={path} name="priority" label={rc.t("csea.set_priority")}>
              <Select
                name="level"
                label={rc.t("csea.priority")}
                value={c.nca_priority ? String(c.nca_priority) : "1"}
                options={[1, 2, 3].map((l) => ({ value: String(l), label: rc.t(`csea.priority_${l}`) }))}
              />
            </ReasonForm>
          ) : null}
        </Card>
        <Card title={<h3>{rc.t("ui.immediate_protection")}</h3>}>
          {c.protective_action_id ? (
            <p>{rc.t("ui.protective_action_applied")}</p>
          ) : c.report.reported_user_id ? (
            <ActionForm action={path} name="protect" confirm={rc.t("app.confirm")}>
              <p class="muted">{rc.t("ui.locks_the_account_and_requests_removal_o")}</p>
              <Submit kind="danger">{rc.t("ui.lock_account_and_remove_content")}</Submit>
            </ActionForm>
          ) : (
            <p class="muted">{rc.t("ui.no_reported_account")}</p>
          )}
        </Card>
      </div>
      <Card title={<h3>{rc.t("csea.sheet")}</h3>}>
        <p class="muted">{rc.t("csea.sheet_hint")}</p>
        {groups.map((g) => {
          const fields = c.nca_sheet.filter((f) => f.group === g);
          return fields.length ? (
            <>
              <h4>{rc.t(`csea.group_${g}`)}</h4>
              <dl class="kv stacked">
                {fields.map((f) => (
                  <>
                    <dt>
                      {f.label} {sourceBadge(f)}
                    </dt>
                    <dd>{f.value ? <pre class="mono wrap">{f.value}</pre> : <span class="muted">{rc.t(`csea.missing_${f.source}`)}</span>}</dd>
                  </>
                ))}
              </dl>
            </>
          ) : null;
        })}
      </Card>
      <div class="grid-2">
        <Card title={<h3>{rc.t("ui.nca_submission")}</h3>}>
          {c.nca_reference ? (
            <p>
              <code>{c.nca_reference}</code> · {fmtDateTime(rc, c.nca_submitted_at)}
            </p>
          ) : c.reported_elsewhere ? (
            <p>
              {rc.t("csea.reported_to", { body: c.reported_elsewhere.body })} · <code>{c.reported_elsewhere.reference}</code> · {fmtDateTime(rc, c.reported_elsewhere.reported_at)}
            </p>
          ) : (
            <ActionForm action={path} name="submission">
              <Field name="nca_reference" label={rc.t("ui.nca_reference")} required />
              <Field name="submitted_at" type="datetime-local" label={rc.t("csea.submitted_at")} hint={rc.t("csea.submitted_at_hint")} />
              <Submit>{rc.t("app.save")}</Submit>
            </ActionForm>
          )}
          {c.supplementary.length ? (
            <ul>
              {c.supplementary.map((x) => (
                <li>
                  {rc.t("csea.supplementary")}: <code>{x.nca_reference}</code> · {fmtDateTime(rc, x.submitted_at)}
                  {x.note ? ` · ${x.note}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          {c.nca_submitted_at && c.status !== "closed" ? (
            <ActionForm action={path} name="supplementary">
              <h4>{rc.t("csea.add_supplementary")}</h4>
              <p class="muted">{rc.t("csea.supplementary_hint")}</p>
              <Field name="nca_reference" label={rc.t("ui.nca_reference")} required />
              <Field name="note" label={rc.t("csea.note")} />
              <Submit kind="secondary">{rc.t("app.save")}</Submit>
            </ActionForm>
          ) : null}
          {c.reference_retain_until ? <p class="muted">{rc.t("csea.reference_kept_until", { date: fmtDate(rc, c.reference_retain_until) })}</p> : null}
        </Card>
        <Card title={<h3>{rc.t("csea.reported_elsewhere")}</h3>}>
          {open ? (
            <ActionForm action={path} name="elsewhere">
              <p class="muted">{rc.t("csea.reported_elsewhere_hint")}</p>
              <Field name="body" label={rc.t("csea.foreign_body")} placeholder="NCMEC" required />
              <Field name="reference" label={rc.t("csea.foreign_reference")} required />
              <Submit kind="secondary">{rc.t("app.save")}</Submit>
            </ActionForm>
          ) : (
            <p class="muted">{c.reported_elsewhere ? rc.t("csea.reported_to", { body: c.reported_elsewhere.body }) : rc.t("app.none")}</p>
          )}
        </Card>
      </div>
      <Card title={<h3>{rc.t("csea.nca_requests")}</h3>}>
        <p class="muted">{rc.t("csea.nca_requests_hint")}</p>
        {c.nca_requests.map((r) => (
          <div class="item">
            <p>
              {r.overdue ? <Badge color="red">{stateLabel(rc, "overdue")}</Badge> : null} {fmtDateTime(rc, r.received_at)} · {rc.t("csea.due", { date: fmtDateTime(rc, r.due_at) })}
            </p>
            <p>{r.summary}</p>
            {r.responded_at ? (
              <p class="muted">
                {rc.t("csea.answered", { date: fmtDateTime(rc, r.responded_at) })} · {r.response_note}
              </p>
            ) : (
              <ReasonForm rc={rc} action={path} name="respond" label={rc.t("csea.mark_answered")} fields={{ request_id: r.id }} />
            )}
          </div>
        ))}
        {c.status !== "closed" ? (
          <ActionForm action={path} name="nca_request">
            <TextArea name="summary" label={rc.t("csea.request_summary")} required rows={3} />
            <Field name="received_at" type="datetime-local" label={rc.t("csea.received_at")} hint={rc.t("csea.submitted_at_hint")} />
            <Submit kind="secondary">{rc.t("csea.log_request")}</Submit>
          </ActionForm>
        ) : null}
      </Card>
      {c.preservation_requests.length ? (
        <Card title={<h3>{rc.t("csea.preservation")}</h3>}>
          <p class="muted">{rc.t("csea.preservation_hint")}</p>
          <ul>
            {c.preservation_requests.map((p) => (
              <li>
                <code>{p.game_id}</code> · {fmtDate(rc, p.window_start)} – {fmtDate(rc, p.window_end)} · <StateBadge rc={rc} state={p.status} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {c.status !== "closed" ? (
        <Card title={<h3>{rc.t("ui.close_case")}</h3>}>
          {open ? <p class="muted">{rc.t("csea.close_not_csea_hint")}</p> : null}
          <ReasonForm rc={rc} action={path} name="close" label={open ? rc.t("csea.close_not_csea") : rc.t("ui.close_case")} fields={open ? { outcome: "not_csea" } : undefined} confirm={open} />
        </Card>
      ) : null}
      {c.evidence.map((e) => (
        <Card
          title={<h3>{rc.t(e.kind === "preservation" ? "csea.evidence_preservation" : "csea.evidence", { date: fmtDateTime(rc, e.created_at) })}</h3>}
          actions={<span class="muted">{e.destroy_after ? rc.t("csea.destroy_after", { date: fmtDate(rc, e.destroy_after) }) : rc.t("csea.kept_until_reported")}</span>}
        >
          {e.destroyed ? <p class="muted">{rc.t("ui.destroyed")}</p> : <Json value={e.data} />}
        </Card>
      ))}
    </>,
  );
}

export const adminSafetyRoutes: PageRoute[] = [
  page("/admin/safety", (rc) => queue(rc)),
  page("/admin/safety/reports/:id", (rc, p) => reportDetail(rc, p.id!)),
  actions("/admin/safety/reports/:id", {
    apply: async (rc, p) => {
      const r = attempt(rc, await applyFromForm(rc));
      return r.ok ? back(rc, `/admin/safety/reports/${p.id}`, { ok: "action_applied" }) : reportDetail(rc, p.id!, r.problem);
    },
    assign: async (rc, p) => {
      unwrap(rc, await rc.api.post(`/api/v1/admin/safety/reports/${enc(p.id!)}/assign`, { assignee: "me" }));
      return back(rc, `/admin/safety/reports/${p.id}`, { ok: "saved" });
    },
    dismiss: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/reports/${enc(p.id!)}/dismiss`, { reason: rc.form.reason ?? "" }));
      return r.ok ? back(rc, "/admin/safety", { ok: "done" }) : reportDetail(rc, p.id!, r.problem);
    },
    reclassify: async (rc, p) => {
      const [type, subtype] = (rc.form.kind ?? "").split(":");
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/reports/${enc(p.id!)}/reclassify`, { type, subtype: subtype || null, reason: rc.form.reason ?? "" }));
      return r.ok ? back(rc, `/admin/safety/reports/${p.id}`, { ok: "saved" }) : reportDetail(rc, p.id!, r.problem);
    },
  }),
  page("/admin/safety/actions", (rc) => actionsList(rc)),
  actions("/admin/safety/actions", {
    approve: async (rc) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/actions/${enc(rc.form.id ?? "")}/approve`, {}));
      return r.ok ? back(rc, "/admin/safety/actions", { ok: "action_applied" }) : actionsList(rc, r.problem);
    },
    lift: async (rc) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/actions/${enc(rc.form.id ?? "")}/lift`, { reason: rc.form.reason ?? "" }));
      return r.ok ? back(rc, "/admin/safety/actions", { ok: "done" }) : actionsList(rc, r.problem);
    },
  }),
  page("/admin/safety/appeals", (rc) => appeals(rc)),
  page("/admin/safety/appeals/:id", (rc, p) => appealDetail(rc, p.id!)),
  actions("/admin/safety/appeals/:id", {
    resolve: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/appeals/${enc(p.id!)}/resolve`, { outcome: rc.form.outcome === "lift" ? "lift" : "uphold", note: rc.form.note ?? "" }));
      return r.ok ? back(rc, "/admin/safety/appeals", { ok: "done" }) : appealDetail(rc, p.id!, r.problem);
    },
  }),
  page("/admin/safety/flags", (rc) => flags(rc)),
  actions("/admin/safety/flags", {
    report: async (rc) => {
      const [type, subtype] = (rc.form.kind ?? "").split(":");
      unwrap(rc, await rc.api.post(`/api/v1/admin/safety/flags/${enc(rc.form.id ?? "")}/review`, { decision: "report", type, subtype: subtype || null }));
      return back(rc, "/admin/safety/flags", { ok: "done" });
    },
    dismiss: async (rc) => {
      unwrap(rc, await rc.api.post(`/api/v1/admin/safety/flags/${enc(rc.form.id ?? "")}/review`, { decision: "dismiss" }));
      return back(rc, "/admin/safety/flags", { ok: "done" });
    },
  }),
  page("/admin/safety/csea", (rc) => cseaList(rc)),
  page("/admin/safety/csea/:id", (rc, p) => cseaCase(rc, p.id!)),
  actions("/admin/safety/csea/:id", {
    protect: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/csea/${enc(p.id!)}/protect`, {}));
      return r.ok ? back(rc, `/admin/safety/csea/${p.id}`, { ok: "action_applied" }) : cseaCase(rc, p.id!, r.problem);
    },
    submission: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/csea/${enc(p.id!)}/submission`, { nca_reference: rc.form.nca_reference ?? "", submitted_at: utcInput(rc.form.submitted_at) }));
      return r.ok ? back(rc, `/admin/safety/csea/${p.id}`, { ok: "saved" }) : cseaCase(rc, p.id!, r.problem);
    },
    priority: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/csea/${enc(p.id!)}/priority`, { level: Number(rc.form.level ?? 1), reason: rc.form.reason ?? "" }));
      return r.ok ? back(rc, `/admin/safety/csea/${p.id}`, { ok: "saved" }) : cseaCase(rc, p.id!, r.problem);
    },
    supplementary: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/csea/${enc(p.id!)}/supplementary`, { nca_reference: rc.form.nca_reference ?? "", note: rc.form.note || undefined }));
      return r.ok ? back(rc, `/admin/safety/csea/${p.id}`, { ok: "saved" }) : cseaCase(rc, p.id!, r.problem);
    },
    elsewhere: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/csea/${enc(p.id!)}/reported-elsewhere`, { body: rc.form.body ?? "", reference: rc.form.reference ?? "" }));
      return r.ok ? back(rc, `/admin/safety/csea/${p.id}`, { ok: "saved" }) : cseaCase(rc, p.id!, r.problem);
    },
    nca_request: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/csea/${enc(p.id!)}/nca-requests`, { summary: rc.form.summary ?? "", received_at: utcInput(rc.form.received_at) }));
      return r.ok ? back(rc, `/admin/safety/csea/${p.id}`, { ok: "saved" }) : cseaCase(rc, p.id!, r.problem);
    },
    respond: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/csea/${enc(p.id!)}/nca-requests/${enc(rc.form.request_id ?? "")}/respond`, { note: rc.form.reason ?? "" }));
      return r.ok ? back(rc, `/admin/safety/csea/${p.id}`, { ok: "saved" }) : cseaCase(rc, p.id!, r.problem);
    },
    close: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/safety/csea/${enc(p.id!)}/close`, { note: rc.form.reason ?? "", outcome: rc.form.outcome === "not_csea" ? "not_csea" : undefined }));
      return r.ok ? back(rc, "/admin/safety/csea", { ok: "done" }) : cseaCase(rc, p.id!, r.problem);
    },
  }),
];

