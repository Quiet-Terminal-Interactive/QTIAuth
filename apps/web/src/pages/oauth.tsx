import { raw } from "hono/html";
import type { Problem } from "../api.ts";
import { actions, attempt, page, redirect, render, unwrap, type PageRoute } from "../app.tsx";
import { currentUrl, href, requireUser, type RequestContext } from "../context.ts";
import { ActionForm, Alert, AuthLayout, Badge, Document, Field, ProblemAlert, Submit, stateLabel } from "../ui.tsx";

interface AuthorizationRequest {
  id: string;
  status: string;
  client: { name: string; homepage_url: string | null; logo_url: string | null; verified: boolean; first_party: boolean };
  scopes: { scope: string; description: string; consent_text: string }[];
  new_scopes: string[];
  unverified: boolean;
  skip_consent: boolean;
  requires_guardian: boolean;
  reauth_required: boolean;
  prompt: string | null;
  redirect_origin: string;
}

function redirectingPage(rc: RequestContext, app: string, to: string) {
  rc.cspHosts.push(new URL(to).origin);
  return render(
    rc,
    <Document rc={rc} title={rc.t("consent.redirecting", { app })} head={raw(`<meta http-equiv="refresh" content="0;url=${to.replace(/"/g, "&quot;")}">`)}>
      <div class="auth-wrap">
        <div class="auth-card">
          <p class="lede">{rc.t("consent.redirecting", { app })}</p>
          <a class="btn block" href={to}>
            {rc.t("app.continue")}
          </a>
        </div>
      </div>
    </Document>,
  );
}

async function consentPage(rc: RequestContext, problem?: Problem | null) {
  const id = rc.query.get("request") ?? rc.form.request ?? "";
  if (!rc.claims.sub) {
    if ((rc.query.get("prompt") ?? "").includes("none")) {
      const r = await rc.api.post<{ redirect_to: string }>(`/api/v1/oauth/requests/${encodeURIComponent(id)}/cancel`, { error: "login_required" });
      if (r.ok) return redirectingPage(rc, "", r.data.redirect_to);
    }
    return redirect(rc, href(rc, "/login", { return: currentUrl(rc) }));
  }
  requireUser(rc);
  const ar = unwrap(rc, await rc.api.get<AuthorizationRequest>(`/api/v1/oauth/requests/${encodeURIComponent(id)}`));
  if (ar.reauth_required && !rc.form._action) return redirect(rc, href(rc, "/auth/reauth", { return: currentUrl(rc) }));
  if (ar.skip_consent && !problem && rc.method === "GET") {
    const r = unwrap(rc, await rc.api.post<{ redirect_to?: string; status?: string }>(`/api/v1/oauth/requests/${encodeURIComponent(id)}/decision`, { approve: true }));
    if (r.redirect_to) return redirectingPage(rc, ar.client.name, r.redirect_to);
  }
  const action = href(rc, "/oauth/consent");
  return (
    <AuthLayout rc={rc} title={rc.t("consent.title", { app: ar.client.name })}>
      <ProblemAlert rc={rc} problem={problem} />
      <div class="row">
        {ar.client.logo_url ? <img class="game-icon" src={ar.client.logo_url} alt="" width="56" height="56" /> : <span class="game-icon">{ar.client.name.slice(0, 1)}</span>}
        <div>
          <strong>{ar.client.name}</strong> {ar.client.verified ? <Badge color="blue">{stateLabel(rc, "verified")}</Badge> : null}
          {ar.client.homepage_url ? (
            <div>
              <a href={ar.client.homepage_url} rel="noopener nofollow" target="_blank">
                {new URL(ar.client.homepage_url).host}
              </a>
            </div>
          ) : null}
        </div>
      </div>
      {ar.unverified ? <Alert kind="warning">{rc.t("consent.unverified", { product: rc.cfg.branding.product_name })}</Alert> : null}
      {ar.requires_guardian ? <Alert kind="info">{rc.t("consent.guardian")}</Alert> : null}
      <div>
        <p>{rc.t("consent.will")}</p>
        <ul>
          {ar.scopes.map((s) => (
            <li>{s.consent_text}</li>
          ))}
        </ul>
        <p class="hint">{ar.redirect_origin}</p>
      </div>
      <div class="grid-2">
        <ActionForm action={action} name="deny" fields={{ request: id }}>
          <Submit kind="secondary" block>
            {rc.t("consent.deny")}
          </Submit>
        </ActionForm>
        <ActionForm action={action} name="allow" fields={{ request: id }}>
          <Submit block>{rc.t("consent.allow")}</Submit>
        </ActionForm>
      </div>
    </AuthLayout>
  );
}

async function decide(rc: RequestContext, approve: boolean) {
  requireUser(rc);
  const id = rc.form.request ?? "";
  const ar = unwrap(rc, await rc.api.get<AuthorizationRequest>(`/api/v1/oauth/requests/${encodeURIComponent(id)}`));
  const r = attempt(rc, await rc.api.post<{ redirect_to?: string; status?: string }>(`/api/v1/oauth/requests/${encodeURIComponent(id)}/decision`, { approve }));
  if (!r.ok) return consentPage(rc, r.problem);
  if (r.data.redirect_to) return redirectingPage(rc, ar.client.name, r.data.redirect_to);
  return (
    <AuthLayout rc={rc} title={rc.t("consent.title", { app: ar.client.name })}>
      <Alert kind="info">{rc.t("consent.guardian")}</Alert>
    </AuthLayout>
  );
}

async function devicePage(rc: RequestContext, o: { problem?: Problem | null; lookup?: { user_code: string; client: { name: string }; scopes: { consent_text: string }[]; unverified: boolean }; done?: "approved" | "denied" | "awaiting" } = {}) {
  requireUser(rc);
  const action = href(rc, "/device");
  if (o.done) {
    return (
      <AuthLayout rc={rc} title={rc.t("device.title")}>
        <Alert kind={o.done === "denied" ? "info" : "success"}>{o.done === "approved" ? rc.t("device.done") : o.done === "denied" ? rc.t("device.denied") : rc.t("consent.guardian")}</Alert>
      </AuthLayout>
    );
  }
  const code = rc.query.get("user_code") ?? rc.form.user_code;
  let lookup = o.lookup;
  if (!lookup && code && !o.problem) {
    const r = attempt(rc, await rc.api.get<NonNullable<typeof o.lookup>>(`/api/v1/oauth/device/${encodeURIComponent(code)}`));
    if (r.ok) lookup = r.data;
    else o.problem = r.problem;
  }
  if (lookup) {
    return (
      <AuthLayout rc={rc} title={rc.t("device.title")} lede={rc.t("device.confirm", { app: lookup.client.name, code: lookup.user_code })}>
        {lookup.unverified ? <Alert kind="warning">{rc.t("consent.unverified", { product: rc.cfg.branding.product_name })}</Alert> : null}
        <ul>
          {lookup.scopes.map((s) => (
            <li>{s.consent_text}</li>
          ))}
        </ul>
        <div class="grid-2">
          <ActionForm action={action} name="deny" fields={{ user_code: lookup.user_code }}>
            <Submit kind="secondary" block>
              {rc.t("device.deny")}
            </Submit>
          </ActionForm>
          <ActionForm action={action} name="approve" fields={{ user_code: lookup.user_code }}>
            <Submit block>{rc.t("device.approve")}</Submit>
          </ActionForm>
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout rc={rc} title={rc.t("device.title")} lede={rc.t("device.lede")}>
      <ProblemAlert rc={rc} problem={o.problem} />
      <form method="get" action={action} class="stack">
        <Field name="user_code" label={rc.t("device.code")} class="code-input" autocomplete="off" placeholder="ABCD-EFGH" required autofocus />
        <Submit block>{rc.t("app.continue")}</Submit>
      </form>
    </AuthLayout>
  );
}

async function deviceDecide(rc: RequestContext, approve: boolean) {
  requireUser(rc);
  const r = await rc.api.request<{ status: string }>("POST", `/api/v1/oauth/device/${encodeURIComponent(rc.form.user_code ?? "")}/decision`, { approve });
  const a = attempt(rc, r);
  if (!a.ok) return devicePage(rc, { problem: a.problem });
  return devicePage(rc, { done: r.status === 202 ? "awaiting" : approve ? "approved" : "denied" });
}

export const oauthRoutes: PageRoute[] = [
  page("/oauth/consent", (rc) => consentPage(rc)),
  actions("/oauth/consent", { allow: (rc) => decide(rc, true), deny: (rc) => decide(rc, false) }),
  page("/device", (rc) => devicePage(rc)),
  actions("/device", { approve: (rc) => deviceDecide(rc, true), deny: (rc) => deviceDecide(rc, false) }),
];
