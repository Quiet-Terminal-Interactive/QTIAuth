import type { Problem } from "../api.ts";
import { fieldErrors } from "../api.ts";
import { actions, attempt, back, page, unwrap, type PageRoute } from "../app.tsx";
import { href, requireUser, type RequestContext } from "../context.ts";
import { ActionForm, Alert, Badge, Card, Check, Empty, Field, LinkButton, PageHead, ProblemAlert, Select, StateBadge, Submit, TextArea, fmtDate, fmtDateTime, stateLabel } from "../ui.tsx";
import { shell } from "./common.tsx";

interface Client {
  client_id: string;
  name: string;
  description: string;
  type: "confidential" | "public";
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  grant_types: string[];
  scopes: string[];
  backchannel_logout_uri: string | null;
  require_par: boolean;
  homepage_url: string | null;
  logo_url: string | null;
  verified: boolean;
  suspended: boolean;
  created_at: string;
  backchannel_deliveries?: { id: string; status: string; reason: string; attempts: number; last_status: number | null; created_at: string }[];
}

const GRANTS = ["authorization_code", "refresh_token", "client_credentials", "urn:ietf:params:oauth:grant-type:device_code"];

function selfServiceScopes(rc: RequestContext): { id: string; description: string }[] {
  return Object.entries(rc.cfg.oidc.scopes)
    .filter(([, s]) => !s.hidden && !s.game_client_only && !s.service_only)
    .map(([id, s]) => ({ id, description: s.description }));
}

function lines(v: string | undefined): string[] {
  return (v ?? "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function clientBody(rc: RequestContext) {
  return {
    name: (rc.form.name ?? "").trim(),
    description: (rc.form.description ?? "").trim(),
    type: rc.form.type === "public" ? "public" : "confidential",
    redirect_uris: lines(rc.form.redirect_uris),
    post_logout_redirect_uris: lines(rc.form.post_logout_redirect_uris),
    grant_types: GRANTS.filter((g) => rc.form[`grant_${g}`]),
    scopes: selfServiceScopes(rc)
      .map((s) => s.id)
      .filter((s) => rc.form[`scope_${s}`]),
    backchannel_logout_uri: rc.form.backchannel_logout_uri?.trim() || null,
    require_par: Boolean(rc.form.require_par),
    homepage_url: rc.form.homepage_url?.trim() || null,
    logo_url: rc.form.logo_url?.trim() || null,
  };
}

function ClientForm({ rc, c, problem, actionName, submit }: { rc: RequestContext; c?: Partial<Client>; problem?: Problem | null; actionName: string; submit: string }) {
  const errs = fieldErrors(problem);
  const v = (k: string, fallback?: string) => (problem ? rc.form[k] : fallback);
  const checked = (prefix: string, item: string, list: string[] | undefined) => (problem ? Boolean(rc.form[`${prefix}${item}`]) : (list ?? []).includes(item));
  return (
    <ActionForm action={rc.fullPath} name={actionName}>
      <ProblemAlert rc={rc} problem={problem} />
      <div class="grid-2">
        <Field name="name" label={rc.t("security.passkey_name")} required maxlength={60} value={v("name", c?.name)} error={errs.name} />
        <Select name="type" label={rc.t("developer.type")} value={v("type", c?.type ?? "confidential")} options={[{ value: "confidential", label: rc.t("developer.confidential") }, { value: "public", label: rc.t("developer.public") }]} />
      </div>
      <TextArea name="description" label={rc.t("ui.description")} rows={3} maxlength={500} value={v("description", c?.description)} />
      <TextArea name="redirect_uris" label={rc.t("developer.redirects")} rows={3} hint={rc.t("developer.redirects_hint")} value={v("redirect_uris", c?.redirect_uris?.join("\n"))} error={errs.redirect_uris} />
      <TextArea name="post_logout_redirect_uris" label={rc.t("ui.post_logout_redirect_uris")} rows={2} value={v("post_logout_redirect_uris", c?.post_logout_redirect_uris?.join("\n"))} />
      <fieldset>
        <legend>{rc.t("developer.scopes")}</legend>
        <div class="grid-2">
          {selfServiceScopes(rc).map((s) => (
            <Check name={`scope_${s.id}`} label={<code>{s.id}</code>} hint={s.description} checked={checked("scope_", s.id, c?.scopes ?? ["openid", "profile", "email"])} />
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>{rc.t("ui.grant_types")}</legend>
        <div class="grid-2">
          {GRANTS.map((g) => (
            <Check name={`grant_${g}`} label={<code>{g.replace("urn:ietf:params:oauth:grant-type:", "")}</code>} checked={checked("grant_", g, c?.grant_types ?? ["authorization_code", "refresh_token"])} />
          ))}
        </div>
      </fieldset>
      <div class="grid-2">
        <Field name="homepage_url" label={rc.t("ui.homepage_url")} type="url" value={v("homepage_url", c?.homepage_url ?? undefined)} />
        <Field name="logo_url" label={rc.t("ui.logo_url")} type="url" value={v("logo_url", c?.logo_url ?? undefined)} />
      </div>
      <Field name="backchannel_logout_uri" label={rc.t("ui.back_channel_logout_uri")} type="url" value={v("backchannel_logout_uri", c?.backchannel_logout_uri ?? undefined)} />
      <Check name="require_par" label={rc.t("ui.require_pushed_authorization_requests_pa")} checked={problem ? Boolean(rc.form.require_par) : Boolean(c?.require_par)} />
      <div>
        <Submit>{submit}</Submit>
      </div>
    </ActionForm>
  );
}

async function list(rc: RequestContext) {
  requireUser(rc);
  const r = unwrap(rc, await rc.api.get<{ items: Client[]; max_clients: number }>("/api/v1/developer/clients"));
  const discovery = `${rc.surfaces.api.url}/.well-known/openid-configuration`;
  return shell(
    rc,
    { title: rc.t("developer.title"), active: "developer" },
    <div class="stack-lg">
      <PageHead title={rc.t("developer.title")} lede={rc.t("developer.lede", { product: rc.cfg.branding.product_name })} actions={r.items.length < r.max_clients ? <LinkButton href={href(rc, "/developer/clients/new")}>{rc.t("developer.new")}</LinkButton> : null} />
      <Alert kind="info">
        {rc.t("ui.discovery")} <code>{discovery}</code>
      </Alert>
      {r.items.length ? (
        <div class="card flush">
          <div class="list">
            {r.items.map((c) => (
              <a class="item link-card" href={href(rc, `/developer/clients/${encodeURIComponent(c.client_id)}`)}>
                <div>
                  <strong>{c.name}</strong> {c.verified ? <Badge color="blue">{stateLabel(rc, "verified")}</Badge> : null} {c.suspended ? <Badge color="red">{stateLabel(rc, "suspended")}</Badge> : null}
                  <div class="meta mono">{c.client_id}</div>
                </div>
                <span class="meta">{fmtDate(rc, c.created_at)}</span>
              </a>
            ))}
          </div>
        </div>
      ) : (
        <div class="card">
          <Empty title={rc.t("developer.none")} />
        </div>
      )}
    </div>,
  );
}

async function newClient(rc: RequestContext, o: { problem?: Problem | null; created?: { client_id: string; client_secret: string | null } } = {}) {
  requireUser(rc);
  return shell(
    rc,
    { title: rc.t("developer.new"), active: "developer" },
    <div class="stack-lg">
      <PageHead title={rc.t("developer.new")} crumbs={[{ href: href(rc, "/developer"), label: rc.t("developer.title") }]} />
      {o.created ? (
        <Card>
          <dl class="kv">
            <dt>client_id</dt>
            <dd class="mono">{o.created.client_id}</dd>
            {o.created.client_secret ? (
              <>
                <dt>client_secret</dt>
                <dd class="mono secret">{o.created.client_secret}</dd>
              </>
            ) : null}
          </dl>
          {o.created.client_secret ? <Alert kind="warning">{rc.t("developer.secret_once")}</Alert> : null}
          <LinkButton href={href(rc, `/developer/clients/${encodeURIComponent(o.created.client_id)}`)}>{rc.t("app.continue")}</LinkButton>
        </Card>
      ) : (
        <Card>
          <ClientForm rc={rc} problem={o.problem} actionName="create" submit={rc.t("developer.new")} />
        </Card>
      )}
    </div>,
  );
}

async function clientPage(rc: RequestContext, id: string, o: { problem?: Problem | null; secret?: string } = {}) {
  requireUser(rc);
  const c = unwrap(rc, await rc.api.get<Client>(`/api/v1/developer/clients/${encodeURIComponent(id)}`));
  return shell(
    rc,
    { title: c.name, active: "developer" },
    <div class="stack-lg">
      <PageHead title={c.name} lede={<code>{c.client_id}</code>} crumbs={[{ href: href(rc, "/developer"), label: rc.t("developer.title") }]} actions={c.suspended ? <StateBadge rc={rc} state="banned" /> : c.verified ? <Badge color="blue">{stateLabel(rc, "verified")}</Badge> : <Badge>{stateLabel(rc, "unverified")}</Badge>} />
      {o.secret ? (
        <Alert kind="warning" title={rc.t("developer.secret_once")}>
          <code class="secret">{o.secret}</code>
        </Alert>
      ) : null}
      <Card>
        <ClientForm rc={rc} c={c} problem={o.problem} actionName="update" submit={rc.t("app.save")} />
      </Card>
      {c.type === "confidential" ? (
        <Card title={rc.t("developer.regenerate")}>
          <ActionForm action={rc.fullPath} name="secret" class="row" confirm={rc.t("app.confirm")}>
            <Submit kind="secondary">{rc.t("developer.regenerate")}</Submit>
          </ActionForm>
        </Card>
      ) : null}
      {c.backchannel_deliveries?.length ? (
        <Card title={rc.t("ui.backchannel_deliveries")}>
          <div class="table-wrap">
            <table class="table">
              <tbody>
                {c.backchannel_deliveries.map((d) => (
                  <tr>
                    <td>
                      <StateBadge rc={rc} state={d.status} />
                    </td>
                    <td>{d.reason}</td>
                    <td class="num">{d.last_status ?? ""}</td>
                    <td class="muted">{fmtDateTime(rc, d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
      <Card title={rc.t("app.delete")} class="danger">
        <ActionForm action={rc.fullPath} name="delete" class="row" confirm={rc.t("app.confirm")}>
          <Submit kind="danger">{rc.t("app.delete")}</Submit>
        </ActionForm>
      </Card>
    </div>,
  );
}

export const developerRoutes: PageRoute[] = [
  page("/developer", (rc) => list(rc)),
  page("/developer/clients/new", (rc) => newClient(rc)),
  actions("/developer/clients/new", {
    create: async (rc) => {
      const r = attempt(rc, await rc.api.post<{ client_id: string; client_secret: string | null }>("/api/v1/developer/clients", clientBody(rc)));
      return r.ok ? newClient(rc, { created: r.data }) : newClient(rc, { problem: r.problem });
    },
  }),
  page("/developer/clients/:id", (rc, p) => clientPage(rc, p.id!)),
  actions("/developer/clients/:id", {
    update: async (rc, p) => {
      const r = attempt(rc, await rc.api.patch(`/api/v1/developer/clients/${encodeURIComponent(p.id!)}`, clientBody(rc)));
      return r.ok ? back(rc, `/developer/clients/${encodeURIComponent(p.id!)}`, { ok: "saved" }) : clientPage(rc, p.id!, { problem: r.problem });
    },
    secret: async (rc, p) => {
      const r = attempt(rc, await rc.api.post<{ client_secret: string }>(`/api/v1/developer/clients/${encodeURIComponent(p.id!)}/secret`, {}));
      return r.ok ? clientPage(rc, p.id!, { secret: r.data.client_secret }) : clientPage(rc, p.id!, { problem: r.problem });
    },
    delete: async (rc, p) => {
      unwrap(rc, await rc.api.delete(`/api/v1/developer/clients/${encodeURIComponent(p.id!)}`));
      return back(rc, "/developer", { ok: "deleted" });
    },
  }),
];
