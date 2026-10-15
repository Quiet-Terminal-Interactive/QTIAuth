import type { Child } from "hono/jsx";
import type { Problem } from "../api.ts";
import { actions, attempt, back, page, redirect, unwrap, type PageRoute } from "../app.tsx";
import { can, href, requirePermission, requireUser, type RequestContext } from "../context.ts";
import { adminSide, hasAdmin } from "../nav.ts";
import { ActionForm, Alert, Badge, Card, Check, Empty, Field, LinkButton, PageHead, Pager, ProblemAlert, Select, SidebarLayout, StateBadge, Submit, TextArea, fmtDate, fmtDateTime, fmtRelative, stateLabel } from "../ui.tsx";
import { shell } from "./common.tsx";

export async function adminShell(rc: RequestContext, active: string, title: string, body: Child) {
  const f = await rc.features();
  return shell(
    rc,
    { title, active: "admin" },
    <SidebarLayout rc={rc} items={adminSide(rc, f)} active={active}>
      {body}
    </SidebarLayout>,
  );
}

export function ReasonForm(p: { rc: RequestContext; action: string; name: string; label: string; kind?: "primary" | "secondary" | "danger" | "danger-ghost"; fields?: Record<string, string>; children?: Child; confirm?: boolean }) {
  return (
    <ActionForm action={p.action} name={p.name} fields={p.fields} confirm={p.confirm ? p.rc.t("app.confirm") : undefined}>
      {p.children}
      <Field name="reason" label={p.rc.t("admin.reason")} required minlength={3} hint={p.rc.t("admin.reason_hint")} />
      <div>
        <Submit kind={p.kind ?? "secondary"}>{p.label}</Submit>
      </div>
    </ActionForm>
  );
}

function enc(v: string): string {
  return encodeURIComponent(v);
}

async function health(rc: RequestContext) {
  requireUser(rc);
  if (!hasAdmin(rc)) throw new (await import("../context.ts")).ProblemSignal({ status: 403, code: "PERMISSION_DENIED" });
  const h = unwrap(
    rc,
    await rc.api.get<{
      status: string;
      maintenance?: boolean;
      services?: Record<string, { running: boolean; instances?: number; version?: string; ready?: boolean }>;
      warnings?: { code: string; severity: string; message: string }[];
      bus?: { stream: string; consumer: string; pending: number; ack_pending: number }[] | null;
      geoip?: string;
    }>("/api/v1/meta/health"),
  );
  const staff = can(rc, "system.health.read") ? await rc.api.get<{ items: { id: string; username: string | null; email: string | null }[] }>("/api/v1/admin/staff-without-2fa") : null;
  const dot = (ok: boolean | undefined, running: boolean) => <span class={`status-dot ${!running ? "" : ok ? "ok" : "bad"}`} aria-hidden="true" />;
  return adminShell(
    rc,
    "health",
    rc.t("admin.health"),
    <>
      <PageHead title={rc.t("admin.health")} actions={<StateBadge rc={rc} state={h.status === "ok" ? "active" : h.status === "maintenance" ? "locked" : "pending"} />} />
      {h.services ? (
        <div class="grid-3">
          {Object.entries(h.services).map(([name, s]) => (
            <div class="tile">
              <div class="row">
                {dot(s.ready, s.running)}
                <strong>{name}</strong>
              </div>
              <div class="label">{s.running ? `${s.instances ?? 0} × ${s.version ?? ""}` : rc.t("ui.not_running")}</div>
            </div>
          ))}
        </div>
      ) : (
        <Alert kind="info">{rc.t("error.PERMISSION_DENIED")}</Alert>
      )}
      {h.warnings?.length ? (
        <Card title={<h3>{rc.t("ui.warnings")}</h3>}>
          <div class="stack-sm">
            {h.warnings.map((w) => (
              <div class={`alert ${w.severity === "error" ? "danger" : w.severity === "warning" ? "warning" : "info"}`}>
                <strong>{w.code}</strong>
                <span>{w.message}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {staff && staff.ok && staff.data.items.length ? (
        <Card title={<h3>{rc.t("ui.staff_without_two_step_verification")}</h3>}>
          <ul>
            {staff.data.items.map((u) => (
              <li>
                <a href={href(rc, `/admin/users/${u.id}`)}>{u.username ?? u.email}</a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {h.bus?.length ? (
        <Card title={<h3>{rc.t("ui.bus_consumers")}</h3>}>
          <div class="table-wrap">
            <table class="table">
              <tbody>
                {h.bus.map((b) => (
                  <tr>
                    <td class="mono">{b.consumer}</td>
                    <td class="muted">{b.stream}</td>
                    <td class="num">{b.pending}</td>
                    <td class="num">{b.ack_pending}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      {can(rc, "system.retention") ? (
        <Card title={<h3>{rc.t("ui.retention")}</h3>}>
          <ReasonForm rc={rc} action={href(rc, "/admin")} name="retention" label={rc.t("ui.run_retention_sweep_now")} />
        </Card>
      ) : null}
    </>,
  );
}

interface AdminUser {
  id: string;
  username: string | null;
  email: string | null;
  state: string;
  age_band: string | null;
  created_at: string;
}

async function users(rc: RequestContext) {
  requirePermission(rc, "users.read");
  const q = Object.fromEntries(["q", "state", "age_band", "role", "cursor"].map((k) => [k, rc.query.get(k) ?? undefined])) as Record<string, string | undefined>;
  const r = unwrap(rc, await rc.api.get<{ items: AdminUser[]; next_cursor: string | null }>("/api/v1/admin/users", q));
  return adminShell(
    rc,
    "users",
    rc.t("admin.users"),
    <>
      <PageHead title={rc.t("admin.users")} />
      <form method="get" action={href(rc, "/admin/users")} class="row">
        <input type="search" name="q" value={q.q ?? ""} placeholder={rc.t("admin.user_search")} class="grow" />
        <select name="state" aria-label={rc.t("ui.state")}>
          <option value="">{rc.t("app.all")}</option>
          {["active", "pending_email_verification", "pending_parental_consent", "locked", "banned", "pending_deletion", "deleted"].map((s) => (
            <option value={s} selected={q.state === s}>
              {stateLabel(rc, s)}
            </option>
          ))}
        </select>
        <select name="age_band" aria-label={rc.t("ui.age_band")}>
          <option value="">{rc.t("app.all")}</option>
          {["under_13", "13_to_15", "16_to_17", "adult"].map((s) => (
            <option value={s} selected={q.age_band === s}>
              {stateLabel(rc, s)}
            </option>
          ))}
        </select>
        <button class="btn secondary">{rc.t("app.search")}</button>
      </form>
      <div class="card flush">
        <div class="table-wrap">
          <table class="table">
            <tbody>
              {r.items.map((u) => (
                <tr>
                  <td>
                    <a class="row-link" href={href(rc, `/admin/users/${u.id}`)}>
                      {u.username ?? "—"}
                    </a>
                    <div class="hint">{u.email}</div>
                  </td>
                  <td>
                    <StateBadge rc={rc} state={u.state} />
                  </td>
                  <td class="muted">{stateLabel(rc, u.age_band)}</td>
                  <td class="muted">{fmtDate(rc, u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.items.length ? null : <Empty title={rc.t("app.none")} />}
      </div>
      <Pager rc={rc} next={r.next_cursor} path={href(rc, "/admin/users")} query={{ ...q, cursor: undefined }} />
    </>,
  );
}

interface UserDetail {
  profile: AdminUser & { dob: string | null; locked_until: string | null; lock_reason: string | null; ban_reason: string | null; restrictions: { name: string; until: string | null }[]; last_sign_in_at: string | null; last_sign_in_method: string | null; deletion_due_at: string | null; force_username_reset: boolean };
  sign_in_methods: { identities: { type: string; email: string | null }[]; passkeys: { name: string }[] };
  roles: string[];
  sessions: { id: string; device: string | null; country: string | null; last_active_at: string; auth_method: string }[];
  security_events: { type: string; ip: string | null; country: string | null; created_at: string }[];
  username_history: { username: string; claimed_at: string }[];
  guardians: { email: string; status: string }[];
  moderation: { actions?: { label: string; status: string; created_at: string }[]; reports_against?: unknown[] } | null;
  entitlements: { items?: { product_name: string; game_name: string; source: string; revoked_at: string | null }[] } | null;
  tickets: { items?: { number: number; subject: string; status: string }[] } | null;
}

async function userDetail(rc: RequestContext, id: string, problem?: Problem | null) {
  requirePermission(rc, "users.read");
  const u = unwrap(rc, await rc.api.get<UserDetail>(`/api/v1/admin/users/${enc(id)}`));
  const roles = can(rc, "roles.manage") ? await rc.api.get<{ items: { name: string }[] }>("/api/v1/admin/roles") : null;
  const action = href(rc, `/admin/users/${id}`);
  const p = u.profile;
  return adminShell(
    rc,
    "users",
    p.username ?? p.email ?? id,
    <>
      <PageHead title={p.username ?? p.email ?? id} lede={<span class="mono">{id}</span>} crumbs={[{ href: href(rc, "/admin/users"), label: rc.t("admin.users") }]} actions={<StateBadge rc={rc} state={p.state} />} />
      <ProblemAlert rc={rc} problem={problem} />
      <div class="grid-2">
        <Card title={<h3>{rc.t("profile.title")}</h3>}>
          <dl class="kv">
            <dt>{rc.t("profile.email")}</dt>
            <dd>{p.email}</dd>
            <dt>{rc.t("ui.dob")}</dt>
            <dd>{p.dob ?? "–"}</dd>
            <dt>{rc.t("ui.age_band")}</dt>
            <dd>{stateLabel(rc, p.age_band)}</dd>
            <dt>{rc.t("ui.created")}</dt>
            <dd>{fmtDateTime(rc, p.created_at)}</dd>
            <dt>{rc.t("ui.last_sign_in")}</dt>
            <dd>
              {fmtRelative(rc, p.last_sign_in_at)} {p.last_sign_in_method ? `(${p.last_sign_in_method})` : ""}
            </dd>
            <dt>{rc.t("nav.admin_roles")}</dt>
            <dd>{u.roles.length ? u.roles.map((r) => <Badge color="purple">{r}</Badge>) : "–"}</dd>
            <dt>{rc.t("ui.sign_in")}</dt>
            <dd>{[...u.sign_in_methods.identities.map((i) => i.type), ...u.sign_in_methods.passkeys.map(() => "passkey")].join(", ")}</dd>
            {p.restrictions.length ? (
              <>
                <dt>{rc.t("ui.restrictions")}</dt>
                <dd>{p.restrictions.map((r) => r.name).join(", ")}</dd>
              </>
            ) : null}
            {p.lock_reason ? (
              <>
                <dt>{rc.t("ui.lock")}</dt>
                <dd>
                  {p.lock_reason} {p.locked_until ? `→ ${fmtDateTime(rc, p.locked_until)}` : ""}
                </dd>
              </>
            ) : null}
            {p.ban_reason ? (
              <>
                <dt>{rc.t("ui.ban")}</dt>
                <dd>{p.ban_reason}</dd>
              </>
            ) : null}
          </dl>
        </Card>
        <Card title={<h3>{rc.t("ui.actions")}</h3>}>
          <div class="stack">
            {can(rc, "users.ban") ? (
              p.state === "banned" ? (
                <ReasonForm rc={rc} action={action} name="unban" label={rc.t("ui.unban")} />
              ) : (
                <ReasonForm rc={rc} action={action} name="ban" label={rc.t("ui.ban")} kind="danger" confirm />
              )
            ) : null}
            {can(rc, "users.lock") ? (
              p.state === "locked" ? (
                <ReasonForm rc={rc} action={action} name="unlock" label={rc.t("ui.unlock")} />
              ) : p.state !== "banned" ? (
                <ReasonForm rc={rc} action={action} name="lock" label={rc.t("ui.lock")} kind="danger-ghost">
                  <Field name="until" label={rc.t("ui.until")} type="datetime-local" />
                </ReasonForm>
              ) : null
            ) : null}
            {can(rc, "users.sessions") ? <ReasonForm rc={rc} action={action} name="revoke_sessions" label={rc.t("sessions.revoke_all")} /> : null}
            {can(rc, "users.force_username_reset") ? <ReasonForm rc={rc} action={action} name="force_username_reset" label={rc.t("ui.force_username_reset")} /> : null}
            {can(rc, "users.edit_dob") ? (
              <ReasonForm rc={rc} action={action} name="dob" label={rc.t("ui.change_date_of_birth")}>
                <Field name="dob" label={rc.t("ui.dob")} type="date" required />
              </ReasonForm>
            ) : null}
            {roles && roles.ok ? (
              <ReasonForm rc={rc} action={action} name="roles" label={rc.t("ui.save_roles")}>
                <div class="grid-2">
                  {roles.data.items.map((r) => (
                    <Check name={`role_${r.name}`} label={r.name} checked={u.roles.includes(r.name)} />
                  ))}
                </div>
              </ReasonForm>
            ) : null}
          </div>
        </Card>
      </div>
      <Card title={<h3>{rc.t("nav.sessions")}</h3>}>
        <div class="table-wrap">
          <table class="table">
            <tbody>
              {u.sessions.map((s) => (
                <tr>
                  <td>{s.device}</td>
                  <td>{s.country}</td>
                  <td>{s.auth_method}</td>
                  <td class="muted">{fmtRelative(rc, s.last_active_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div class="grid-2">
        <Card title={<h3>{rc.t("security.events")}</h3>}>
          <div class="table-wrap">
            <table class="table">
              <tbody>
                {u.security_events.slice(0, 30).map((e) => (
                  <tr>
                    <td>{e.type}</td>
                    <td class="mono">{e.ip ?? ""}</td>
                    <td>{e.country ?? ""}</td>
                    <td class="muted">{fmtDateTime(rc, e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <div class="stack">
          {u.moderation?.actions?.length ? (
            <Card title={<h3>{rc.t("nav.admin_safety")}</h3>}>
              <ul>
                {u.moderation.actions.map((a) => (
                  <li>
                    {a.label} <StateBadge rc={rc} state={a.status} /> <span class="muted">{fmtDate(rc, a.created_at)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {u.entitlements?.items?.length ? (
            <Card title={<h3>{rc.t("nav.admin_entitlements")}</h3>}>
              <ul>
                {u.entitlements.items.map((e) => (
                  <li>
                    {e.game_name} · {e.product_name} <Badge>{e.source}</Badge> {e.revoked_at ? <Badge color="red">{stateLabel(rc, "revoked")}</Badge> : null}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {u.tickets?.items?.length ? (
            <Card title={<h3>{rc.t("nav.tickets")}</h3>}>
              <ul>
                {u.tickets.items.map((t) => (
                  <li>
                    #{t.number} {t.subject} <StateBadge rc={rc} state={t.status} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          {u.guardians.length ? (
            <Card title={<h3>{rc.t("nav.family")}</h3>}>
              <ul>
                {u.guardians.map((g) => (
                  <li>
                    {g.email} <StateBadge rc={rc} state={g.status} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </>,
  );
}

function userAction(path: string, body: (rc: RequestContext) => Record<string, unknown>, method: "POST" | "PATCH" | "PUT" = "POST") {
  return async (rc: RequestContext, p: Record<string, string>) => {
    const r = attempt(rc, await rc.api.request(method, `/api/v1/admin/users/${enc(p.id!)}${path}`, { reason: rc.form.reason ?? "", ...body(rc) }));
    return r.ok ? back(rc, `/admin/users/${p.id}`, { ok: "action_applied" }) : userDetail(rc, p.id!, r.problem);
  };
}

async function rolesPage(rc: RequestContext, problem?: Problem | null) {
  requirePermission(rc, "roles.manage");
  const r = unwrap(rc, await rc.api.get<{ items: { name: string; description: string; permissions: string[]; builtin: boolean }[]; known_permissions: string[] }>("/api/v1/admin/roles"));
  const action = href(rc, "/admin/roles");
  return adminShell(
    rc,
    "roles",
    rc.t("nav.admin_roles"),
    <>
      <PageHead title={rc.t("nav.admin_roles")} />
      <ProblemAlert rc={rc} problem={problem} />
      {r.items.map((role) => (
        <Card title={<h3>{role.name} {role.builtin ? <Badge>{stateLabel(rc, "built_in")}</Badge> : null}</h3>}>
          <ReasonForm rc={rc} action={action} name="save" label={rc.t("app.save")} fields={{ name: role.name }}>
            <Field name="description" label={rc.t("ui.description")} value={role.description} />
            <TextArea name="permissions" label={rc.t("ui.permissions")} rows={4} value={role.permissions.join("\n")} hint={rc.t("ui.one_per_line_wildcards_like_games_work_e")} />
          </ReasonForm>
          {role.builtin ? null : (
            <details>
              <summary>{rc.t("app.delete")}</summary>
              <ReasonForm rc={rc} action={action} name="delete" label={rc.t("app.delete")} kind="danger" fields={{ name: role.name }} confirm />
            </details>
          )}
        </Card>
      ))}
      <Card title={<h3>{rc.t("ui.new_role")}</h3>}>
        <ReasonForm rc={rc} action={action} name="save" label={rc.t("app.save")}>
          <Field name="name" label={rc.t("security.passkey_name")} required pattern="[a-z0-9_]+" />
          <Field name="description" label={rc.t("ui.description")} />
          <TextArea name="permissions" label={rc.t("ui.permissions")} rows={4} />
        </ReasonForm>
        <details>
          <summary>{rc.t("ui.known_permissions")}</summary>
          <p class="mono">{r.known_permissions.join(", ")}</p>
        </details>
      </Card>
    </>,
  );
}

async function audit(rc: RequestContext) {
  requirePermission(rc, "audit.read");
  const q = Object.fromEntries(["actor", "action", "target", "service", "cursor"].map((k) => [k, rc.query.get(k) ?? undefined])) as Record<string, string | undefined>;
  const r = unwrap(rc, await rc.api.get<{ items: { id: number; occurred_at: string; service: string; actor_type: string; actor_id: string; action: string; target_type: string | null; target_id: string | null; reason: string | null }[]; next_cursor: string | null }>("/api/v1/admin/audit", q));
  return adminShell(
    rc,
    "audit",
    rc.t("nav.admin_audit"),
    <>
      <PageHead title={rc.t("nav.admin_audit")} />
      <form method="get" action={href(rc, "/admin/audit")} class="row">
        <input name="action" placeholder={rc.t("ui.action_e_g_safety")} value={q.action ?? ""} />
        <input name="actor" placeholder={rc.t("ui.actor_id")} value={q.actor ?? ""} />
        <input name="target" placeholder={rc.t("ui.target_id")} value={q.target ?? ""} />
        <button class="btn secondary">{rc.t("app.search")}</button>
      </form>
      <div class="card flush">
        <div class="table-wrap">
          <table class="table">
            <tbody>
              {r.items.map((e) => (
                <tr>
                  <td class="muted">{fmtDateTime(rc, e.occurred_at)}</td>
                  <td class="mono">{e.action}</td>
                  <td>
                    {e.actor_type}:{e.actor_id.slice(0, 8)}
                  </td>
                  <td>{e.target_type ? `${e.target_type}:${(e.target_id ?? "").slice(0, 12)}` : ""}</td>
                  <td>{e.reason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Pager rc={rc} next={r.next_cursor} path={href(rc, "/admin/audit")} query={{ ...q, cursor: undefined }} />
    </>,
  );
}

async function textFilter(rc: RequestContext, o: { problem?: Problem | null; test?: { action: string; rule: string; matched: string | null; normalized: string } } = {}) {
  requirePermission(rc, "text_filter.manage");
  const [decisions, entries] = await Promise.all([
    rc.api.get<{ items: { input_raw: string | null; normalized: string; action: string; rule: string; matched: string | null; context: string; created_at: string }[]; stats: Record<string, number> }>("/api/v1/admin/text-filter/decisions", { limit: 50 }),
    rc.api.get<{ items: { id: string; list: string; word: string; note: string | null }[] }>("/api/v1/admin/text-filter/entries"),
  ]);
  const action = href(rc, "/admin/text-filter");
  return adminShell(
    rc,
    "filter",
    rc.t("nav.admin_filter"),
    <>
      <PageHead title={rc.t("nav.admin_filter")} />
      <ProblemAlert rc={rc} problem={o.problem} />
      <Card title={<h3>{rc.t("ui.test")}</h3>}>
        <ActionForm action={action} name="test" class="row">
          <div class="grow">
            <Field name="text" label={rc.t("ui.text")} required value={rc.form.text} />
          </div>
          <Submit kind="secondary">{rc.t("ui.test")}</Submit>
        </ActionForm>
        {o.test ? (
          <Alert kind={o.test.action === "block" ? "danger" : "success"}>
            {o.test.action} · {o.test.rule} · {o.test.matched ?? "–"} · <code>{o.test.normalized}</code>
          </Alert>
        ) : null}
      </Card>
      <Card title={<h3>{rc.t("ui.custom_entries")}</h3>}>
        <div class="list">
          {(entries.ok ? entries.data.items : []).map((e) => (
            <div class="item">
              <span>
                <Badge color={e.list === "block" ? "red" : "green"}>{e.list}</Badge> <code>{e.word}</code> <span class="muted">{e.note ?? ""}</span>
              </span>
              <ActionForm action={action} name="remove" class="inline-form" fields={{ id: e.id }}>
                <Submit kind="danger-ghost" small>
                  {rc.t("app.remove")}
                </Submit>
              </ActionForm>
            </div>
          ))}
        </div>
        <ActionForm action={action} name="add" class="row">
          <Select name="list" label={rc.t("ui.list")} options={[{ value: "block", label: "block" }, { value: "allow", label: "allow" }]} />
          <div class="grow">
            <Field name="word" label={rc.t("ui.word")} required />
          </div>
          <div class="grow">
            <Field name="note" label={rc.t("ui.note")} />
          </div>
          <Submit kind="secondary">{rc.t("ui.add")}</Submit>
        </ActionForm>
      </Card>
      <Card title={<h3>{rc.t("ui.recent_decisions")}</h3>}>
        <div class="table-wrap">
          <table class="table">
            <tbody>
              {(decisions.ok ? decisions.data.items : []).map((d) => (
                <tr>
                  <td>
                    <Badge color={d.action === "block" ? "red" : "green"}>{d.action}</Badge>
                  </td>
                  <td class="mono">{d.input_raw ?? d.normalized}</td>
                  <td>{d.rule}</td>
                  <td>{d.matched ?? ""}</td>
                  <td class="muted">{d.context}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>,
  );
}

interface Endpoint {
  id: string;
  url: string;
  description: string;
  events: string[];
  format: string;
  enabled: boolean;
  disabled_reason: string | null;
  consecutive_failures: number;
  seeded: boolean;
}

async function webhooks(rc: RequestContext, o: { problem?: Problem | null; secret?: string } = {}) {
  requirePermission(rc, "webhooks.manage");
  const r = unwrap(rc, await rc.api.get<{ items: Endpoint[]; available_events: string[] }>("/api/v1/admin/webhooks"));
  const action = href(rc, "/admin/webhooks");
  return adminShell(
    rc,
    "webhooks",
    rc.t("nav.admin_webhooks"),
    <>
      <PageHead title={rc.t("nav.admin_webhooks")} />
      <ProblemAlert rc={rc} problem={o.problem} />
      {o.secret ? (
        <Alert kind="warning" title={rc.t("developer.secret_once")}>
          <code class="secret">{o.secret}</code>
        </Alert>
      ) : null}
      {r.items.map((e) => (
        <Card title={<h3 class="mono">{e.url}</h3>} actions={<>{e.enabled ? <Badge color="green">{stateLabel(rc, "enabled")}</Badge> : <Badge color="red">{stateLabel(rc, "disabled")}</Badge>} <Badge>{e.format}</Badge></>}>
          <p class="muted">{e.description}</p>
          <p class="mono hint">{e.events.join(", ")}</p>
          {e.disabled_reason ? <Alert kind="warning">{e.disabled_reason}</Alert> : null}
          <div class="row">
            <LinkButton href={href(rc, `/admin/webhooks/${e.id}`)} kind="secondary" small>
              {rc.t("ui.deliveries")}
            </LinkButton>
            <ActionForm action={action} name="test" class="inline-form" fields={{ id: e.id }}>
              <Submit kind="secondary" small>
                {rc.t("ui.send_test")}
              </Submit>
            </ActionForm>
            <ActionForm action={action} name="toggle" class="inline-form" fields={{ id: e.id, enabled: e.enabled ? "0" : "1" }}>
              <Submit kind="secondary" small>
                {e.enabled ? rc.t("ui.disable") : rc.t("ui.enable")}
              </Submit>
            </ActionForm>
            <ActionForm action={action} name="rotate" class="inline-form" fields={{ id: e.id }} confirm={rc.t("app.confirm")}>
              <Submit kind="secondary" small>
                {rc.t("ui.rotate_secret")}
              </Submit>
            </ActionForm>
            {e.seeded ? null : (
              <ActionForm action={action} name="delete" class="inline-form" fields={{ id: e.id }} confirm={rc.t("app.confirm")}>
                <Submit kind="danger-ghost" small>
                  {rc.t("app.delete")}
                </Submit>
              </ActionForm>
            )}
          </div>
        </Card>
      ))}
      <Card title={<h3>{rc.t("ui.new_endpoint")}</h3>}>
        <ActionForm action={action} name="create">
          <div class="grid-2">
            <Field name="url" label={rc.t("ui.url")} type="url" required />
            <Select name="format" label={rc.t("ui.format")} options={["standard", "discord", "slack"].map((f) => ({ value: f, label: stateLabel(rc, f) }))} />
          </div>
          <Field name="description" label={rc.t("ui.description")} />
          <fieldset>
            <legend>{rc.t("ui.events")}</legend>
            <div class="grid-2">
              {r.available_events.map((ev) => (
                <Check name={`ev_${ev}`} label={<code>{ev}</code>} />
              ))}
            </div>
          </fieldset>
          <div>
            <Submit>{rc.t("app.save")}</Submit>
          </div>
        </ActionForm>
      </Card>
    </>,
  );
}

async function webhookDeliveries(rc: RequestContext, id: string) {
  requirePermission(rc, "webhooks.manage");
  const r = unwrap(rc, await rc.api.get<{ items: { id: string; event_type: string; status: string; attempts: number; last_status_code: number | null; created_at: string }[]; next_cursor: string | null }>(`/api/v1/admin/webhooks/${enc(id)}/deliveries`, { cursor: rc.query.get("cursor") ?? undefined }));
  return adminShell(
    rc,
    "webhooks",
    rc.t("nav.admin_webhooks"),
    <>
      <PageHead title={rc.t("ui.deliveries")} crumbs={[{ href: href(rc, "/admin/webhooks"), label: rc.t("nav.admin_webhooks") }]} />
      <div class="card flush">
        <div class="table-wrap">
          <table class="table">
            <tbody>
              {r.items.map((d) => (
                <tr>
                  <td class="mono">{d.event_type}</td>
                  <td>
                    <StateBadge rc={rc} state={d.status} />
                  </td>
                  <td class="num">{d.last_status_code ?? ""}</td>
                  <td class="num">{d.attempts}</td>
                  <td class="muted">{fmtDateTime(rc, d.created_at)}</td>
                  <td>
                    <ActionForm action={href(rc, `/admin/webhooks/${id}`)} name="replay" class="inline-form" fields={{ delivery: d.id }}>
                      <Submit kind="secondary" small>
                        {rc.t("ui.replay")}
                      </Submit>
                    </ActionForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Pager rc={rc} next={r.next_cursor} path={href(rc, `/admin/webhooks/${id}`)} />
    </>,
  );
}

async function emailPage(rc: RequestContext, problem?: Problem | null) {
  requirePermission(rc, "webhooks.manage");
  const email = rc.query.get("email") ?? undefined;
  const r = unwrap(rc, await rc.api.get<{ items: { id: string; template: string; to_email: string | null; status: string; provider: string; attempts: number; last_error: string | null; created_at: string }[] }>("/api/v1/admin/email/deliveries", { email, limit: 100 }));
  const sup = email ? await rc.api.get<{ suppressed: boolean; reason?: string }>("/api/v1/admin/email/suppressions", { email }) : null;
  return adminShell(
    rc,
    "email",
    rc.t("nav.admin_email"),
    <>
      <PageHead title={rc.t("nav.admin_email")} />
      <ProblemAlert rc={rc} problem={problem} />
      <form method="get" action={href(rc, "/admin/email")} class="row">
        <input type="search" name="email" value={email ?? ""} placeholder="someone@example.com" class="grow" />
        <button class="btn secondary">{rc.t("app.search")}</button>
      </form>
      {sup && sup.ok && sup.data.suppressed ? (
        <Card>
          <Alert kind="warning">Suppressed: {sup.data.reason ?? ""}</Alert>
          <ReasonForm rc={rc} action={href(rc, "/admin/email")} name="unsuppress" label={rc.t("ui.remove_suppression")} fields={{ email: email! }} />
        </Card>
      ) : null}
      <div class="card flush">
        <div class="table-wrap">
          <table class="table">
            <tbody>
              {r.items.map((d) => (
                <tr>
                  <td class="mono">{d.template}</td>
                  <td>{d.to_email ?? ""}</td>
                  <td>
                    <StateBadge rc={rc} state={d.status === "sent" ? "completed" : d.status} />
                  </td>
                  <td class="muted">{d.provider}</td>
                  <td class="muted">{fmtDateTime(rc, d.created_at)}</td>
                  <td class="hint">{d.last_error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>,
  );
}

async function oidcClients(rc: RequestContext, problem?: Problem | null) {
  requireUser(rc);
  const r = unwrap(rc, await rc.api.get<{ items: { client_id: string; name: string; kind: string; verified: boolean; suspended: boolean; suspended_reason: string | null; owner_user_id: string | null; scopes: string[]; created_at: string }[] }>("/api/v1/admin/oidc/clients", { q: rc.query.get("q") ?? undefined, limit: 100 }));
  const action = href(rc, "/admin/oidc/clients");
  return adminShell(
    rc,
    "clients",
    rc.t("nav.admin_clients"),
    <>
      <PageHead title={rc.t("nav.admin_clients")} />
      <ProblemAlert rc={rc} problem={problem} />
      <form method="get" action={action} class="row">
        <input type="search" name="q" value={rc.query.get("q") ?? ""} class="grow" />
        <button class="btn secondary">{rc.t("app.search")}</button>
      </form>
      {r.items.map((c) => (
        <Card title={<h3>{c.name}</h3>} actions={<>{c.suspended ? <Badge color="red">{stateLabel(rc, "suspended")}</Badge> : null} {c.verified ? <Badge color="blue">{stateLabel(rc, "verified")}</Badge> : null} <Badge>{c.kind}</Badge></>}>
          <p class="mono hint">{c.client_id}</p>
          <p class="hint">{c.scopes.join(" ")}</p>
          <details>
            <summary>{rc.t("app.edit")}</summary>
            <div class="stack">
              {can(rc, "oidc.clients.suspend") ? (
                <ReasonForm rc={rc} action={action} name={c.suspended ? "unsuspend" : "suspend"} label={c.suspended ? rc.t("ui.unsuspend") : rc.t("ui.suspend")} kind={c.suspended ? "secondary" : "danger"} fields={{ id: c.client_id }} />
              ) : null}
              {can(rc, "oidc.clients.verify") ? (
                <>
                  <ReasonForm rc={rc} action={action} name="verify" label={c.verified ? rc.t("ui.remove_verification") : rc.t("ui.verify")} fields={{ id: c.client_id, verified: c.verified ? "0" : "1" }} />
                  <ReasonForm rc={rc} action={action} name="scopes" label={rc.t("ui.save_scopes")} fields={{ id: c.client_id }}>
                    <Field name="scopes" label={rc.t("developer.scopes")} value={c.scopes.join(" ")} />
                  </ReasonForm>
                </>
              ) : null}
            </div>
          </details>
        </Card>
      ))}
    </>,
  );
}

export const adminRoutes: PageRoute[] = [
  page("/admin", (rc) => health(rc)),
  actions("/admin", {
    retention: async (rc) => {
      unwrap(rc, await rc.api.post("/api/v1/admin/retention/sweep", { reason: rc.form.reason ?? "" }));
      return back(rc, "/admin", { ok: "done" });
    },
  }),
  page("/admin/users", (rc) => users(rc)),
  page("/admin/users/:id", (rc, p) => userDetail(rc, p.id!)),
  actions("/admin/users/:id", {
    ban: userAction("/ban", () => ({})),
    unban: userAction("/unban", () => ({})),
    lock: userAction("/lock", (rc) => (rc.form.until ? { until: new Date(rc.form.until).toISOString() } : {})),
    unlock: userAction("/unlock", () => ({})),
    revoke_sessions: userAction("/revoke-sessions", () => ({})),
    force_username_reset: userAction("/force-username-reset", () => ({})),
    dob: userAction("/dob", (rc) => ({ dob: rc.form.dob ?? "" }), "PATCH"),
    roles: userAction(
      "/roles",
      (rc) => ({
        roles: Object.keys(rc.form)
          .filter((k) => k.startsWith("role_"))
          .map((k) => k.slice(5)),
      }),
      "PUT",
    ),
  }),
  page("/admin/roles", (rc) => rolesPage(rc)),
  actions("/admin/roles", {
    save: async (rc) => {
      const perms = (rc.form.permissions ?? "")
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const r = attempt(rc, await rc.api.put(`/api/v1/admin/roles/${enc(rc.form.name ?? "")}`, { description: rc.form.description ?? "", permissions: perms, reason: rc.form.reason ?? "" }));
      return r.ok ? back(rc, "/admin/roles", { ok: "saved" }) : rolesPage(rc, r.problem);
    },
    delete: async (rc) => {
      const r = attempt(rc, await rc.api.delete(`/api/v1/admin/roles/${enc(rc.form.name ?? "")}`, { reason: rc.form.reason ?? "" }));
      return r.ok ? back(rc, "/admin/roles", { ok: "deleted" }) : rolesPage(rc, r.problem);
    },
  }),
  page("/admin/audit", (rc) => audit(rc)),
  page("/admin/text-filter", (rc) => textFilter(rc)),
  actions("/admin/text-filter", {
    test: async (rc) => {
      const r = attempt(rc, await rc.api.post<{ action: string; rule: string; matched: string | null; normalized: string }>("/api/v1/admin/text-filter/test", { text: rc.form.text ?? "" }));
      return r.ok ? textFilter(rc, { test: r.data }) : textFilter(rc, { problem: r.problem });
    },
    add: async (rc) => {
      const r = attempt(rc, await rc.api.post("/api/v1/admin/text-filter/entries", { list: rc.form.list ?? "block", word: rc.form.word ?? "", note: rc.form.note || undefined }));
      return r.ok ? back(rc, "/admin/text-filter", { ok: "saved" }) : textFilter(rc, { problem: r.problem });
    },
    remove: async (rc) => {
      unwrap(rc, await rc.api.delete(`/api/v1/admin/text-filter/entries/${enc(rc.form.id ?? "")}`));
      return back(rc, "/admin/text-filter", { ok: "deleted" });
    },
  }),
  page("/admin/webhooks", (rc) => webhooks(rc)),
  actions("/admin/webhooks", {
    create: async (rc) => {
      const events = Object.keys(rc.form)
        .filter((k) => k.startsWith("ev_"))
        .map((k) => k.slice(3));
      const r = attempt(rc, await rc.api.post<{ secret?: string }>("/api/v1/admin/webhooks", { url: rc.form.url ?? "", description: rc.form.description ?? "", events, format: rc.form.format ?? "standard" }));
      return r.ok ? webhooks(rc, { secret: r.data.secret }) : webhooks(rc, { problem: r.problem });
    },
    test: async (rc) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/webhooks/${enc(rc.form.id ?? "")}/test`, {}));
      return r.ok ? back(rc, "/admin/webhooks", { ok: "done" }) : webhooks(rc, { problem: r.problem });
    },
    toggle: async (rc) => {
      unwrap(rc, await rc.api.patch(`/api/v1/admin/webhooks/${enc(rc.form.id ?? "")}`, { enabled: rc.form.enabled === "1" }));
      return back(rc, "/admin/webhooks", { ok: "saved" });
    },
    rotate: async (rc) => {
      const r = attempt(rc, await rc.api.post<{ secret: string }>(`/api/v1/admin/webhooks/${enc(rc.form.id ?? "")}/rotate-secret`, {}));
      return r.ok ? webhooks(rc, { secret: r.data.secret }) : webhooks(rc, { problem: r.problem });
    },
    delete: async (rc) => {
      unwrap(rc, await rc.api.delete(`/api/v1/admin/webhooks/${enc(rc.form.id ?? "")}`));
      return back(rc, "/admin/webhooks", { ok: "deleted" });
    },
  }),
  page("/admin/webhooks/:id", (rc, p) => webhookDeliveries(rc, p.id!)),
  actions("/admin/webhooks/:id", {
    replay: async (rc, p) => {
      unwrap(rc, await rc.api.post(`/api/v1/admin/webhooks/deliveries/${enc(rc.form.delivery ?? "")}/replay`, {}));
      return back(rc, `/admin/webhooks/${p.id}`, { ok: "done" });
    },
  }),
  page("/admin/email", (rc) => emailPage(rc)),
  actions("/admin/email", {
    unsuppress: async (rc) => {
      const r = attempt(rc, await rc.api.delete("/api/v1/admin/email/suppressions", { email: rc.form.email ?? "", reason: rc.form.reason ?? "" }));
      return r.ok ? redirect(rc, href(rc, "/admin/email", { email: rc.form.email, ok: "done" })) : emailPage(rc, r.problem);
    },
  }),
  page("/admin/oidc/clients", (rc) => oidcClients(rc)),
  actions("/admin/oidc/clients", {
    suspend: async (rc) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/oidc/clients/${enc(rc.form.id ?? "")}/suspend`, { reason: rc.form.reason ?? "" }));
      return r.ok ? back(rc, "/admin/oidc/clients", { ok: "done" }) : oidcClients(rc, r.problem);
    },
    unsuspend: async (rc) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/oidc/clients/${enc(rc.form.id ?? "")}/unsuspend`, { reason: rc.form.reason ?? "" }));
      return r.ok ? back(rc, "/admin/oidc/clients", { ok: "done" }) : oidcClients(rc, r.problem);
    },
    verify: async (rc) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/oidc/clients/${enc(rc.form.id ?? "")}/verification`, { verified: rc.form.verified === "1", reason: rc.form.reason ?? "" }));
      return r.ok ? back(rc, "/admin/oidc/clients", { ok: "done" }) : oidcClients(rc, r.problem);
    },
    scopes: async (rc) => {
      const r = attempt(rc, await rc.api.put(`/api/v1/admin/oidc/clients/${enc(rc.form.id ?? "")}/scopes`, { scopes: (rc.form.scopes ?? "").split(/\s+/).filter(Boolean), reason: rc.form.reason ?? "" }));
      return r.ok ? back(rc, "/admin/oidc/clients", { ok: "done" }) : oidcClients(rc, r.problem);
    },
  }),
];

