import { raw } from "hono/html";
import type { Problem } from "../api.ts";
import { fieldErrors } from "../api.ts";
import { actions, attempt, back, page, redirect, unwrap, type PageRoute } from "../app.tsx";
import { href, requirePermission, type RequestContext } from "../context.ts";
import { staffSide } from "../nav.ts";
import { ActionForm, Alert, Badge, Card, Check, Empty, Field, LinkButton, PageHead, Pager, ProblemAlert, Select, SidebarLayout, StateBadge, Submit, TextArea, fmtDate, fmtDateTime, fmtDuration, fmtRelative, stateLabel } from "../ui.tsx";
import { shell } from "./common.tsx";

interface UserSummary {
  id: string;
  username: string | null;
  email: string | null;
}

interface StaffTicket {
  id: string;
  number: number;
  subject: string;
  category_label: string;
  status: string;
  priority: string;
  updated_at: string;
  created_at: string;
  requester: (UserSummary & { guest_email?: string }) | { guest_email: string | null } | null;
  assignee: UserSummary | null;
}

function who(u: unknown): string {
  const x = u as { username?: string | null; email?: string | null; guest_email?: string | null } | null;
  return x?.username ?? x?.email ?? x?.guest_email ?? "–";
}

async function staffShell(rc: RequestContext, active: string, title: string, body: unknown) {
  return shell(
    rc,
    { title, active: "staff" },
    <SidebarLayout rc={rc} items={staffSide(rc)} active={active}>
      {body as never}
    </SidebarLayout>,
  );
}

const STATUSES = ["open", "waiting_on_user", "on_hold", "closed"];
const PRIORITIES = ["low", "normal", "high", "urgent"];

async function queue(rc: RequestContext) {
  requirePermission(rc, "support.tickets.staff");
  const q = Object.fromEntries(["status", "category", "priority", "assignee", "q", "cursor"].map((k) => [k, rc.query.get(k) ?? undefined])) as Record<string, string | undefined>;
  const r = unwrap(rc, await rc.api.get<{ items: StaffTicket[]; next_cursor: string | null }>("/api/v1/admin/support/tickets", q));
  const cats = await rc.api.get<{ categories: { id: string; label: string }[] }>("/api/v1/support/categories");
  return staffShell(
    rc,
    "tickets",
    rc.t("staff.queue"),
    <>
      <PageHead title={rc.t("staff.queue")} />
      <form method="get" action={href(rc, "/staff/tickets")} class="row">
        <input type="search" name="q" value={q.q ?? ""} placeholder={`${rc.t("app.search")} / #1234`} class="grow" />
        <select name="status" aria-label={rc.t("staff.status")}>
          {["active", ...STATUSES, "all"].map((s) => (
            <option value={s} selected={(q.status ?? "active") === s}>
              {stateLabel(rc, s)}
            </option>
          ))}
        </select>
        <select name="category" aria-label={rc.t("support.category")}>
          <option value="">{rc.t("app.all")}</option>
          {(cats.ok ? cats.data.categories : []).map((c) => (
            <option value={c.id} selected={q.category === c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select name="assignee" aria-label={rc.t("staff.assignee")}>
          <option value="">{rc.t("app.all")}</option>
          <option value="me" selected={q.assignee === "me"}>{rc.t("ui.assigned_me")}</option>
          <option value="none" selected={q.assignee === "none"}>{rc.t("ui.unassigned")}</option>
        </select>
        <button class="btn secondary" type="submit">
          {rc.t("app.search")}
        </button>
      </form>
      {r.items.length ? (
        <div class="card flush">
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{rc.t("support.subject")}</th>
                  <th>{rc.t("staff.requester")}</th>
                  <th>{rc.t("staff.status")}</th>
                  <th>{rc.t("staff.priority")}</th>
                  <th>{rc.t("staff.assignee")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {r.items.map((t) => (
                  <tr>
                    <td class="mono">{t.number}</td>
                    <td>
                      <a class="row-link" href={href(rc, `/staff/tickets/${t.number}`)}>
                        {t.subject}
                      </a>
                      <div class="hint">{t.category_label}</div>
                    </td>
                    <td>{who(t.requester)}</td>
                    <td>
                      <StateBadge rc={rc} state={t.status} />
                    </td>
                    <td>
                      <StateBadge rc={rc} state={t.priority} />
                    </td>
                    <td>{t.assignee ? who(t.assignee) : "–"}</td>
                    <td class="muted">{fmtRelative(rc, t.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <Card>
          <Empty title={rc.t("app.none")} />
        </Card>
      )}
      <Pager rc={rc} next={r.next_cursor} path={href(rc, "/staff/tickets")} query={{ ...q, cursor: undefined }} />
    </>,
  );
}

interface StaffThread extends StaffTicket {
  messages: { id: string; author_type: string; author: UserSummary | null; body: string; internal: boolean; created_at: string; attachments: { id: string; filename: string; is_image: boolean; size: number }[] }[];
  other_tickets: { number: number; subject: string; status: string }[];
  suggested_articles: { slug: string; title: string }[];
  macros: { id: string; title: string; body: string }[];
  rating: number | null;
  rating_comment: string | null;
  category: string;
}

async function ticketDetail(rc: RequestContext, number: string, o: { problem?: Problem | null; draft?: string } = {}) {
  requirePermission(rc, "support.tickets.staff");
  const t = unwrap(rc, await rc.api.get<StaffThread>(`/api/v1/admin/support/tickets/${encodeURIComponent(number)}`));
  const cats = await rc.api.get<{ categories: { id: string; label: string }[] }>("/api/v1/support/categories");
  const action = href(rc, `/staff/tickets/${number}`);
  return staffShell(
    rc,
    "tickets",
    `#${t.number}`,
    <>
      <PageHead title={t.subject} lede={`#${t.number} · ${t.category_label} · ${who(t.requester)}`} crumbs={[{ href: href(rc, "/staff/tickets"), label: rc.t("staff.queue") }]} actions={<StateBadge rc={rc} state={t.status} />} />
      <ProblemAlert rc={rc} problem={o.problem} />
      <div class="thread">
        {t.messages.map((m) =>
          m.author_type === "system" ? (
            <div class="msg system">{m.body}</div>
          ) : (
            <div class={m.internal ? "msg internal" : m.author_type === "staff" ? "msg staff" : "msg"}>
              <div class="msg-head">
                <strong>
                  {m.author_type === "staff" ? who(m.author) : m.author_type === "guest" ? who(t.requester) : who(m.author)} {m.internal ? <Badge color="yellow">{stateLabel(rc, "internal")}</Badge> : null}
                </strong>
                <span>{fmtDateTime(rc, m.created_at)}</span>
              </div>
              <div class="msg-body">{m.body}</div>
              {m.attachments.length ? (
                <ul>
                  {m.attachments.map((a) => (
                    <li>
                      <a href={href(rc, `/staff/tickets/${t.number}/attachments/${a.id}`)}>{a.filename}</a> {a.is_image ? null : <Badge color="orange">{rc.t("staff.non_image")}</Badge>}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ),
        )}
      </div>
      <Card>
        {t.macros.length ? (
          <ActionForm action={action} name="macro" class="row">
            <select name="macro" aria-label={rc.t("staff.macro")} class="grow">
              {t.macros.map((m) => (
                <option value={m.id}>{m.title}</option>
              ))}
            </select>
            <Submit kind="secondary" small>
              {rc.t("staff.macro")}
            </Submit>
          </ActionForm>
        ) : null}
        <ActionForm action={action} name="reply">
          <TextArea name="body" label={rc.t("support.reply")} rows={7} required value={o.draft ?? ""} />
          <Check name="internal" label={rc.t("staff.internal")} />
          <div class="row">
            <select name="status" aria-label={rc.t("staff.status")}>
              <option value="">→ {rc.t("staff.status")}</option>
              {STATUSES.map((s) => (
                <option value={s}>{stateLabel(rc, s)}</option>
              ))}
            </select>
            <Submit>{rc.t("support.send")}</Submit>
          </div>
        </ActionForm>
      </Card>
      <div class="grid-2">
        <Card title={<h3>{rc.t("app.edit")}</h3>}>
          <ActionForm action={action} name="update">
            <Select name="status" label={rc.t("staff.status")} value={t.status} options={STATUSES.map((s) => ({ value: s, label: stateLabel(rc, s) }))} />
            <Select name="priority" label={rc.t("staff.priority")} value={t.priority} options={PRIORITIES.map((s) => ({ value: s, label: stateLabel(rc, s) }))} />
            <Select name="category" label={rc.t("support.category")} value={t.category} options={(cats.ok ? cats.data.categories : []).map((c) => ({ value: c.id, label: c.label }))} />
            <Check name="assign_me" label={rc.t("staff.assign_me")} checked={false} />
            <Submit kind="secondary">{rc.t("app.save")}</Submit>
          </ActionForm>
        </Card>
        <div class="stack">
          {t.suggested_articles.length ? (
            <Card title={<h3>{rc.t("support.related")}</h3>}>
              <ul>
                {t.suggested_articles.map((a) => (
                  <li>
                    <a href={href(rc, `/kb/${a.slug}`)} target="_blank" rel="noopener">
                      {a.title}
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {t.other_tickets.length ? (
            <Card title={<h3>{rc.t("nav.tickets")}</h3>}>
              <ul>
                {t.other_tickets.map((o2) => (
                  <li>
                    <a href={href(rc, `/staff/tickets/${o2.number}`)}>#{o2.number}</a> {o2.subject} <StateBadge rc={rc} state={o2.status} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {t.rating ? (
            <Card>
              {"★".repeat(t.rating)} {t.rating_comment ?? ""}
            </Card>
          ) : null}
        </div>
      </div>
    </>,
  );
}

async function macros(rc: RequestContext, problem?: Problem | null) {
  requirePermission(rc, "support.tickets.staff");
  const r = unwrap(rc, await rc.api.get<{ items: { id: string; title: string; body: string; source: string }[] }>("/api/v1/admin/support/macros"));
  const action = href(rc, "/staff/macros");
  return staffShell(
    rc,
    "macros",
    rc.t("nav.staff_macros"),
    <>
      <PageHead title={rc.t("nav.staff_macros")} />
      <ProblemAlert rc={rc} problem={problem} />
      {r.items.map((m) => (
        <Card title={<h3>{m.title}</h3>} actions={m.source === "custom" ? <ActionForm action={action} name="delete" class="inline-form" fields={{ id: m.id }} confirm={rc.t("app.confirm")}><Submit kind="danger-ghost" small>{rc.t("app.delete")}</Submit></ActionForm> : <Badge>{stateLabel(rc, "config")}</Badge>}>
          <div class="msg-body">{m.body}</div>
        </Card>
      ))}
      <Card title={<h3>{rc.t("app.edit")}</h3>}>
        <ActionForm action={action} name="create">
          <Field name="title" label={rc.t("ui.title")} required maxlength={120} />
          <TextArea name="body" label={rc.t("support.message")} required rows={5} />
          <div>
            <Submit>{rc.t("app.save")}</Submit>
          </div>
        </ActionForm>
      </Card>
    </>,
  );
}

async function metrics(rc: RequestContext) {
  requirePermission(rc, "support.tickets.staff");
  const days = Number(rc.query.get("days") ?? 30);
  const r = unwrap(
    rc,
    await rc.api.get<{
      per_agent: { agent: UserSummary | null; tickets: number; closed: number; median_first_response_s: number | null; median_resolution_s: number | null; csat_avg: number | null; ratings: number }[];
      per_category: { key: string; tickets: number; closed: number; median_first_response_s: number | null; median_resolution_s: number | null; csat_avg: number | null }[];
      csat_distribution: Record<string, number>;
    }>("/api/v1/admin/support/metrics", { days }),
  );
  const Row = (p: { name: string; x: { tickets: number; closed: number; median_first_response_s: number | null; median_resolution_s: number | null; csat_avg: number | null } }) => (
    <tr>
      <td>{p.name}</td>
      <td class="num">{p.x.tickets}</td>
      <td class="num">{p.x.closed}</td>
      <td class="num">{fmtDuration(p.x.median_first_response_s)}</td>
      <td class="num">{fmtDuration(p.x.median_resolution_s)}</td>
      <td class="num">{p.x.csat_avg === null ? "–" : p.x.csat_avg.toFixed(2)}</td>
    </tr>
  );
  const head = (
    <thead>
      <tr>
        <th />
        <th class="num">{rc.t("ui.tickets")}</th>
        <th class="num">{rc.t("ui.closed")}</th>
        <th class="num">{rc.t("ui.first_response")}</th>
        <th class="num">{rc.t("ui.resolution")}</th>
        <th class="num">{rc.t("ui.csat")}</th>
      </tr>
    </thead>
  );
  return staffShell(
    rc,
    "metrics",
    rc.t("nav.staff_metrics"),
    <>
      <PageHead title={rc.t("nav.staff_metrics")} lede={rc.t("ui.last_days", { days })} />
      <div class="grid-3">
        {[1, 2, 3, 4, 5].map((n) => (
          <div class="tile">
            <div class="label">{"★".repeat(n)}</div>
            <div class="value">{r.csat_distribution[String(n)] ?? 0}</div>
          </div>
        ))}
      </div>
      <Card title={<h3>{rc.t("staff.assignee")}</h3>}>
        <div class="table-wrap">
          <table class="table">
            {head}
            <tbody>
              {r.per_agent.map((a) => (
                <Row name={a.agent ? who(a.agent) : rc.t("ui.unassigned")} x={a} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title={<h3>{rc.t("support.category")}</h3>}>
        <div class="table-wrap">
          <table class="table">
            {head}
            <tbody>
              {r.per_category.map((c) => (
                <Row name={c.key} x={c} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>,
  );
}

interface KbArticle {
  id: string;
  slug: string;
  title: string;
  status: string;
  tags: string[];
  category_id: string | null;
  body?: string;
  html?: string;
  views?: number;
  helpful?: { yes: number; no: number };
  updated_at: string;
}

async function kbList(rc: RequestContext) {
  requirePermission(rc, "support.kb.edit");
  const [r, cats] = await Promise.all([rc.api.get<{ items: KbArticle[] }>("/api/v1/admin/support/kb/articles"), rc.api.get<{ items: { id: string; name: string; slug: string; article_count: number }[] }>("/api/v1/support/kb/categories")]);
  const list = unwrap(rc, r);
  return staffShell(
    rc,
    "kb",
    rc.t("nav.staff_kb"),
    <>
      <PageHead title={rc.t("nav.staff_kb")} actions={<LinkButton href={href(rc, "/staff/kb/new")}>{rc.t("app.edit")}</LinkButton>} />
      <div class="card flush">
        <div class="table-wrap">
          <table class="table">
            <tbody>
              {list.items.map((a) => (
                <tr>
                  <td>
                    <a class="row-link" href={href(rc, `/staff/kb/${a.id}`)}>
                      {a.title}
                    </a>
                    <div class="hint mono">/{a.slug}</div>
                  </td>
                  <td>
                    <StateBadge rc={rc} state={a.status} />
                  </td>
                  <td class="num">{a.views ?? 0}</td>
                  <td class="num">
                    👍 {a.helpful?.yes ?? 0} · 👎 {a.helpful?.no ?? 0}
                  </td>
                  <td class="muted">{fmtDate(rc, a.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Card title={<h3>{rc.t("support.categories")}</h3>}>
        <div class="list">
          {(cats.ok ? cats.data.items : []).map((c) => (
            <div class="item">
              <span>
                {c.name} <span class="hint">({c.article_count})</span>
              </span>
              <ActionForm action={href(rc, "/staff/kb")} name="delete_category" class="inline-form" fields={{ id: c.id }} confirm={rc.t("app.confirm")}>
                <Submit kind="danger-ghost" small>
                  {rc.t("app.delete")}
                </Submit>
              </ActionForm>
            </div>
          ))}
        </div>
        <ActionForm action={href(rc, "/staff/kb")} name="create_category" class="row">
          <div class="grow">
            <Field name="name" label={rc.t("security.passkey_name")} required />
          </div>
          <div class="grow">
            <Field name="description" label={rc.t("ui.description")} />
          </div>
          <Submit kind="secondary">{rc.t("app.save")}</Submit>
        </ActionForm>
      </Card>
    </>,
  );
}

async function kbEdit(rc: RequestContext, id: string | null, o: { problem?: Problem | null; warning?: string | null; diff?: { diff: { op: string; line: string }[]; revision: { id: string; created_at: string } } } = {}) {
  requirePermission(rc, "support.kb.edit");
  const a = id ? unwrap(rc, await rc.api.get<KbArticle>(`/api/v1/admin/support/kb/articles/${encodeURIComponent(id)}`)) : null;
  const revisions = id ? await rc.api.get<{ items: { id: string; title: string; note: string | null; created_at: string }[] }>(`/api/v1/admin/support/kb/articles/${encodeURIComponent(id)}/revisions`) : null;
  const cats = await rc.api.get<{ items: { id: string; name: string }[] }>("/api/v1/support/kb/categories");
  const v = (k: string, d?: string | null) => (o.problem ? rc.form[k] : (d ?? undefined));
  const errs = fieldErrors(o.problem);
  const action = href(rc, id ? `/staff/kb/${id}` : "/staff/kb/new");
  return staffShell(
    rc,
    "kb",
    a?.title ?? rc.t("nav.staff_kb"),
    <>
      <PageHead title={a?.title ?? rc.t("nav.staff_kb")} crumbs={[{ href: href(rc, "/staff/kb"), label: rc.t("nav.staff_kb") }]} actions={a ? <LinkButton href={href(rc, `/kb/${a.slug}`)} kind="secondary">{rc.t("app.view")}</LinkButton> : null} />
      <ProblemAlert rc={rc} problem={o.problem} />
      {o.warning ? <Alert kind="warning">{o.warning}</Alert> : null}
      <Card>
        <ActionForm action={action} name="save">
          <div class="grid-2">
            <Field name="title" label={rc.t("ui.title")} required maxlength={200} value={v("title", a?.title)} error={errs.title} />
            <Field name="slug" label={rc.t("ui.slug")} value={v("slug", a?.slug)} pattern="[a-z0-9]+(-[a-z0-9]+)*" error={errs.slug} />
          </div>
          <div class="grid-2">
            <Select name="category_id" label={rc.t("support.category")} value={v("category_id", a?.category_id)} placeholder="–" options={(cats.ok ? cats.data.items : []).map((c) => ({ value: c.id, label: c.name }))} />
            <Field name="tags" label={rc.t("ui.tags")} value={v("tags", a?.tags.join(", "))} hint={rc.t("ui.comma_separated")} />
          </div>
          <TextArea name="body" label={rc.t("ui.markdown")} rows={18} value={v("body", a?.body)} error={errs.body} />
          <Field name="note" label={rc.t("ui.revision_note")} />
          <div class="row">
            <Select name="status" label={rc.t("staff.status")} value={v("status", a?.status ?? "draft")} options={[{ value: "draft", label: "draft" }, { value: "published", label: "published" }]} />
            <Submit>{rc.t("app.save")}</Submit>
          </div>
        </ActionForm>
      </Card>
      {a?.html ? (
        <Card title={<h3>{rc.t("app.view")}</h3>}>
          <div class="prose">{raw(a.html)}</div>
        </Card>
      ) : null}
      {o.diff ? (
        <Card title={<h3>{fmtDateTime(rc, o.diff.revision.created_at)}</h3>}>
          <div class="diff">
            {o.diff.diff.map((d) => (
              <div class={d.op === "+" ? "add" : d.op === "-" ? "del" : undefined}>{`${d.op} ${d.line}`}</div>
            ))}
          </div>
        </Card>
      ) : null}
      {revisions && revisions.ok && revisions.data.items.length ? (
        <Card title={<h3>{rc.t("ui.revisions")}</h3>}>
          <div class="list">
            {revisions.data.items.map((r) => (
              <div class="item">
                <div>
                  <strong>{fmtDateTime(rc, r.created_at)}</strong>
                  <div class="meta">{r.note ?? r.title}</div>
                </div>
                <div class="row">
                  <ActionForm action={action} name="diff" class="inline-form" fields={{ rev: r.id }}>
                    <Submit kind="secondary" small>
                      {rc.t("ui.diff")}
                    </Submit>
                  </ActionForm>
                  <ActionForm action={action} name="restore" class="inline-form" fields={{ rev: r.id }} confirm={rc.t("app.confirm")}>
                    <Submit kind="secondary" small>
                      {rc.t("ui.restore")}
                    </Submit>
                  </ActionForm>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {a ? (
        <Card class="danger">
          <ActionForm action={action} name="delete" class="row" confirm={rc.t("app.confirm")}>
            <Submit kind="danger">{rc.t("app.delete")}</Submit>
          </ActionForm>
        </Card>
      ) : null}
    </>,
  );
}

function articleBody(rc: RequestContext) {
  return {
    title: (rc.form.title ?? "").trim(),
    slug: rc.form.slug?.trim() || undefined,
    category_id: rc.form.category_id || null,
    body: rc.form.body ?? "",
    tags: (rc.form.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    status: rc.form.status === "published" ? "published" : "draft",
    note: rc.form.note?.trim() || undefined,
  };
}

export const staffRoutes: PageRoute[] = [
  page("/staff", (rc) => redirect(rc, href(rc, "/staff/tickets"))),
  page("/staff/tickets", (rc) => queue(rc)),
  page("/staff/tickets/:number/attachments/:aid", async (rc, p) => {
    requirePermission(rc, "support.tickets.staff");
    const r = unwrap(rc, await rc.api.get<{ url: string }>(`/api/v1/admin/support/tickets/${encodeURIComponent(p.number!)}/attachments/${encodeURIComponent(p.aid!)}`));
    return redirect(rc, r.url);
  }),
  page("/staff/tickets/:number", (rc, p) => ticketDetail(rc, p.number!)),
  actions("/staff/tickets/:number", {
    macro: async (rc, p) => {
      const t = unwrap(rc, await rc.api.get<StaffThread>(`/api/v1/admin/support/tickets/${encodeURIComponent(p.number!)}`));
      return ticketDetail(rc, p.number!, { draft: t.macros.find((m) => m.id === rc.form.macro)?.body ?? "" });
    },
    reply: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/support/tickets/${encodeURIComponent(p.number!)}/replies`, { body: rc.form.body ?? "", internal: Boolean(rc.form.internal), status: rc.form.status || undefined }));
      return r.ok ? back(rc, `/staff/tickets/${p.number}`, { ok: "ticket_replied" }) : ticketDetail(rc, p.number!, { problem: r.problem, draft: rc.form.body });
    },
    update: async (rc, p) => {
      const r = attempt(rc, await rc.api.patch(`/api/v1/admin/support/tickets/${encodeURIComponent(p.number!)}`, { status: rc.form.status, priority: rc.form.priority, category: rc.form.category, ...(rc.form.assign_me ? { assignee_id: "me" } : {}) }));
      return r.ok ? back(rc, `/staff/tickets/${p.number}`, { ok: "saved" }) : ticketDetail(rc, p.number!, { problem: r.problem });
    },
  }),
  page("/staff/macros", (rc) => macros(rc)),
  actions("/staff/macros", {
    create: async (rc) => {
      const r = attempt(rc, await rc.api.post("/api/v1/admin/support/macros", { title: rc.form.title ?? "", body: rc.form.body ?? "" }));
      return r.ok ? back(rc, "/staff/macros", { ok: "created" }) : macros(rc, r.problem);
    },
    delete: async (rc) => {
      unwrap(rc, await rc.api.delete(`/api/v1/admin/support/macros/${encodeURIComponent(rc.form.id ?? "")}`));
      return back(rc, "/staff/macros", { ok: "deleted" });
    },
  }),
  page("/staff/metrics", (rc) => metrics(rc)),
  page("/staff/kb", (rc) => kbList(rc)),
  actions("/staff/kb", {
    create_category: async (rc) => {
      unwrap(rc, await rc.api.post("/api/v1/admin/support/kb/categories", { name: rc.form.name ?? "", description: rc.form.description ?? "" }));
      return back(rc, "/staff/kb", { ok: "created" });
    },
    delete_category: async (rc) => {
      unwrap(rc, await rc.api.delete(`/api/v1/admin/support/kb/categories/${encodeURIComponent(rc.form.id ?? "")}`));
      return back(rc, "/staff/kb", { ok: "deleted" });
    },
  }),
  page("/staff/kb/new", (rc) => kbEdit(rc, null)),
  actions("/staff/kb/new", {
    save: async (rc) => {
      const r = attempt(rc, await rc.api.post<{ id: string; warning: string | null }>("/api/v1/admin/support/kb/articles", articleBody(rc)));
      return r.ok ? redirect(rc, href(rc, `/staff/kb/${r.data.id}`, { ok: "created" })) : kbEdit(rc, null, { problem: r.problem });
    },
  }),
  page("/staff/kb/:id", (rc, p) => kbEdit(rc, p.id!)),
  actions("/staff/kb/:id", {
    save: async (rc, p) => {
      const r = attempt(rc, await rc.api.put<{ warning: string | null }>(`/api/v1/admin/support/kb/articles/${encodeURIComponent(p.id!)}`, articleBody(rc)));
      if (!r.ok) return kbEdit(rc, p.id!, { problem: r.problem });
      return r.data.warning ? kbEdit(rc, p.id!, { warning: r.data.warning }) : back(rc, `/staff/kb/${p.id}`, { ok: "saved" });
    },
    diff: async (rc, p) => {
      const d = unwrap(rc, await rc.api.get<{ diff: { op: string; line: string }[]; revision: { id: string; created_at: string } }>(`/api/v1/admin/support/kb/articles/${encodeURIComponent(p.id!)}/revisions/${encodeURIComponent(rc.form.rev ?? "")}/diff`));
      return kbEdit(rc, p.id!, { diff: d });
    },
    restore: async (rc, p) => {
      unwrap(rc, await rc.api.post(`/api/v1/admin/support/kb/articles/${encodeURIComponent(p.id!)}/revisions/${encodeURIComponent(rc.form.rev ?? "")}/restore`, {}));
      return back(rc, `/staff/kb/${p.id}`, { ok: "saved" });
    },
    delete: async (rc, p) => {
      unwrap(rc, await rc.api.delete(`/api/v1/admin/support/kb/articles/${encodeURIComponent(p.id!)}`));
      return back(rc, "/staff/kb", { ok: "deleted" });
    },
  }),
];
