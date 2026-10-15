import { raw } from "hono/html";
import type { Problem } from "../api.ts";
import { fieldErrors } from "../api.ts";
import { actions, attempt, page, redirect, unwrap, type PageRoute } from "../app.tsx";
import { href, requireUser, safeReturn, surfaceHref, type RequestContext } from "../context.ts";
import { ActionForm, Alert, AuthLayout, Card, Check, Field, LinkButton, PageHead, ProblemAlert, StateBadge, Submit, fmtDate } from "../ui.tsx";
import { shell } from "./common.tsx";

async function usernamePage(rc: RequestContext, problem?: Problem | null) {
  requireUser(rc, { username: true });
  const f = await rc.features();
  return (
    <AuthLayout rc={rc} title={rc.t("gate.username_title")} lede={rc.t("gate.username_lede")}>
      <ProblemAlert rc={rc} problem={problem} />
      <ActionForm action={href(rc, "/welcome/username")} name="set" fields={{ return: rc.query.get("return") ?? rc.form.return }}>
        <Field name="username" label={rc.t("profile.username")} required autofocus minlength={f.usernames.min_length} maxlength={f.usernames.max_length} hint={rc.t("signup.username_hint", { min: f.usernames.min_length, max: f.usernames.max_length })} error={fieldErrors(problem).username} value={rc.form.username} />
        <Submit block>{rc.t("app.continue")}</Submit>
      </ActionForm>
      {rc.claims.force_username_reset ? null : (
        <LinkButton href={safeReturn(rc, rc.query.get("return"))} kind="ghost" block>
          {rc.t("app.cancel")}
        </LinkButton>
      )}
    </AuthLayout>
  );
}

interface PendingDoc {
  id: string;
  version: string;
  title: string;
  summary: string | null;
}

async function legalAcceptPage(rc: RequestContext, problem?: Problem | null) {
  requireUser(rc, { legal: true });
  const r = unwrap(rc, await rc.api.get<{ pending: PendingDoc[]; guardian_accepts: boolean }>("/api/v1/me/legal"));
  if (!r.pending.length) return redirect(rc, safeReturn(rc, rc.query.get("return")));
  return (
    <AuthLayout rc={rc} title={rc.t("gate.legal_title")} lede={rc.t("gate.legal_lede")} wide>
      <ProblemAlert rc={rc} problem={problem} />
      {r.pending.map((d) => (
        <Card>
          <h3>{d.title}</h3>
          {d.summary ? <p class="muted">{d.summary}</p> : null}
          <a href={href(rc, `/legal/${d.id}/${d.version}`)} target="_blank" rel="noopener">
            {rc.t("gate.legal_view", { title: d.title })}
          </a>
        </Card>
      ))}
      {r.guardian_accepts ? (
        <Alert kind="info">{rc.t("error.GUARDIAN_APPROVAL_REQUIRED")}</Alert>
      ) : (
        <ActionForm action={href(rc, "/legal/accept")} name="accept" fields={{ return: rc.query.get("return") ?? rc.form.return }}>
          {r.pending.map((d) => (
            <input type="hidden" name="doc" value={`${d.id}@${d.version}`} />
          ))}
          <Check name="agree" label={rc.t("signup.accept", { documents: r.pending.map((d) => d.title).join(", ") })} />
          <Submit block>{rc.t("gate.legal_accept")}</Submit>
        </ActionForm>
      )}
      <form method="post" action={href(rc, "/logout")}>
        <Submit kind="ghost" block>
          {rc.t("app.sign_out")}
        </Submit>
      </form>
    </AuthLayout>
  );
}

async function waitingPage(rc: RequestContext, problem?: Problem | null) {
  requireUser(rc, { consent: true });
  if (rc.claims.state !== "pending_parental_consent") return redirect(rc, href(rc, "/"));
  const r = unwrap(rc, await rc.api.get<{ guardians: { email: string; status: string }[]; guardian_email_changes_left: number }>("/api/v1/me/parental"));
  const pending = r.guardians.find((g) => g.status === "pending");
  const action = href(rc, "/waiting");
  return (
    <AuthLayout rc={rc} title={rc.t("gate.consent_title")} lede={rc.t("gate.consent_lede", { email: pending?.email ?? "" })}>
      <ProblemAlert rc={rc} problem={problem} />
      <ActionForm action={action} name="resend">
        <Submit kind="secondary" block>
          {rc.t("gate.consent_resend")}
        </Submit>
      </ActionForm>
      {r.guardian_email_changes_left > 0 ? (
        <ActionForm action={action} name="change">
          <Field name="email" label={rc.t("gate.consent_change")} type="email" required hint={rc.t("gate.consent_changes_left", { n: r.guardian_email_changes_left })} />
          <Submit kind="secondary" block>
            {rc.t("app.save")}
          </Submit>
        </ActionForm>
      ) : null}
      <form method="post" action={href(rc, "/logout")}>
        <Submit kind="ghost" block>
          {rc.t("app.sign_out")}
        </Submit>
      </form>
    </AuthLayout>
  );
}

async function standingPage(rc: RequestContext) {
  requireUser(rc, { restricted: true, legal: true });
  const me = (await rc.me())!;
  const f = await rc.features();
  const acts = f.features.safety ? await rc.api.get<{ items: { id: string; label: string; effect: string; rule_title: string; rule_text: string; status: string; expires_at: string | null; created_at: string; can_appeal: boolean; appeal: { reference: string; status: string } | null }[] }>("/api/v1/safety/actions/mine") : null;
  const title = me.state === "banned" ? rc.t("gate.banned_title") : me.state === "locked" ? rc.t("gate.locked_title") : rc.t("safety.actions_title");
  return shell(
    rc,
    { title },
    <div class="stack-lg">
      <PageHead title={title} lede={me.state === "locked" && me.locked_until ? `${rc.t("gate.restricted_lede")} (${fmtDate(rc, me.locked_until, { dateStyle: "medium", timeStyle: "short" })})` : rc.t("gate.restricted_lede")} />
      {acts && acts.ok ? (
        acts.data.items.length ? (
          acts.data.items.map((a) => (
            <Card title={<h3>{a.label}</h3>} actions={<StateBadge rc={rc} state={a.status} />}>
              <p>
                <strong>{a.rule_title}.</strong> {a.rule_text}
              </p>
              <p class="muted">{fmtDate(rc, a.created_at)}{a.expires_at ? ` → ${fmtDate(rc, a.expires_at)}` : ""}</p>
              {a.appeal ? <p>{rc.t("safety.appeal_sent", { reference: a.appeal.reference })} <StateBadge rc={rc} state={a.appeal.status} /></p> : null}
              {a.can_appeal ? <LinkButton href={href(rc, `/safety/appeal/${a.id}`)}>{rc.t("safety.appeal")}</LinkButton> : null}
            </Card>
          ))
        ) : (
          <Card>{rc.t("safety.actions_none")}</Card>
        )
      ) : null}
      <div class="row">
        {f.features.support ? <LinkButton href={surfaceHref(rc, "support", "/tickets/new")} kind="secondary">{rc.t("support.contact")}</LinkButton> : null}
        <LinkButton href={href(rc, "/settings/privacy")} kind="secondary">
          {rc.t("privacy.title")}
        </LinkButton>
      </div>
    </div>,
  );
}

function tokenPage(rc: RequestContext, o: { title: string; lede?: string; path: string; problem?: Problem | null; done?: string }) {
  const token = rc.query.get("token") ?? rc.form.token ?? "";
  return (
    <AuthLayout rc={rc} title={o.title} lede={o.lede}>
      <ProblemAlert rc={rc} problem={o.problem} />
      {o.done ? (
        <>
          <Alert kind="success">{o.done}</Alert>
          <LinkButton href={href(rc, "/")} block>
            {rc.t("app.continue")}
          </LinkButton>
        </>
      ) : (
        <ActionForm action={href(rc, o.path)} name="confirm" fields={{ token }}>
          <Submit block>{rc.t("app.confirm")}</Submit>
        </ActionForm>
      )}
    </AuthLayout>
  );
}

interface LegalDocument {
  id: string;
  version: string;
  title: string;
  effective_at: string;
  summary: string | null;
  html: string;
}

async function legalDoc(rc: RequestContext, id: string, version?: string) {
  const r = unwrap(rc, await rc.api.get<LegalDocument>(version ? `/api/v1/legal/${encodeURIComponent(id)}/${encodeURIComponent(version)}` : `/api/v1/legal/${encodeURIComponent(id)}`));
  const f = await rc.features();
  const history = f.legal.public_history ? await rc.api.get<{ items: { version: string; effective_at: string; title: string }[] }>(`/api/v1/legal/${encodeURIComponent(id)}/versions`) : null;
  return shell(
    rc,
    { title: r.title },
    <div class="stack-lg">
      <PageHead title={r.title} lede={`${r.version} · ${fmtDate(rc, r.effective_at)}`} crumbs={[{ href: href(rc, "/legal"), label: rc.t("app.legal") }]} />
      <div class="card prose">{raw(r.html)}</div>
      {history && history.ok && history.data.items.length > 1 ? (
        <Card title={<h3>{rc.t("ui.versions")}</h3>}>
          <div class="list">
            {history.data.items.map((h) => (
              <a class="item" href={href(rc, `/legal/${id}/${h.version}`)}>
                <span>{h.version}</span>
                <span class="meta">{fmtDate(rc, h.effective_at)}</span>
              </a>
            ))}
          </div>
        </Card>
      ) : null}
    </div>,
  );
}

export const gateRoutes: PageRoute[] = [
  page("/welcome/username", (rc) => usernamePage(rc)),
  actions("/welcome/username", {
    set: async (rc) => {
      const r = attempt(rc, await rc.api.put("/api/v1/me/username", { username: (rc.form.username ?? "").trim() }));
      return r.ok ? redirect(rc, safeReturn(rc, rc.form.return)) : usernamePage(rc, r.problem);
    },
  }),
  page("/legal/accept", (rc) => legalAcceptPage(rc)),
  actions("/legal/accept", {
    accept: async (rc) => {
      if (!rc.form.agree) return legalAcceptPage(rc, { status: 422, code: "LEGAL_NOT_ACCEPTED" });
      const docs = (rc.formAll.doc ?? []).map((d) => {
        const [id, version] = d.split("@");
        return { id: id!, version: version! };
      });
      const r = attempt(rc, await rc.api.post("/api/v1/me/legal/accept", { documents: docs }));
      return r.ok ? redirect(rc, safeReturn(rc, rc.form.return)) : legalAcceptPage(rc, r.problem);
    },
  }),
  page("/waiting", (rc) => waitingPage(rc)),
  actions("/waiting", {
    resend: async (rc) => {
      const r = attempt(rc, await rc.api.post("/api/v1/me/parental/resend", {}));
      return r.ok ? redirect(rc, href(rc, "/waiting", { ok: "consent_resent" })) : waitingPage(rc, r.problem);
    },
    change: async (rc) => {
      const r = attempt(rc, await rc.api.put("/api/v1/me/parental/guardian-email", { email: (rc.form.email ?? "").trim() }));
      return r.ok ? redirect(rc, href(rc, "/waiting", { ok: "consent_resent" })) : waitingPage(rc, r.problem);
    },
  }),
  page("/standing", (rc) => standingPage(rc)),
  page("/email/confirm", (rc) => tokenPage(rc, { title: rc.t("profile.email_change"), path: "/email/confirm" })),
  actions("/email/confirm", {
    confirm: async (rc) => {
      const r = attempt(rc, await rc.api.post("/api/v1/me/email/confirm", { token: rc.form.token ?? "" }));
      return tokenPage(rc, { title: rc.t("profile.email_change"), path: "/email/confirm", problem: r.ok ? null : r.problem, done: r.ok ? rc.t("flash.email_confirmed") : undefined });
    },
  }),
  page("/email/revert", (rc) => tokenPage(rc, { title: rc.t("profile.email_change"), path: "/email/revert" })),
  actions("/email/revert", {
    confirm: async (rc) => {
      const r = await rc.api.post("/api/v1/me/email/revert", { token: rc.form.token ?? "" });
      return tokenPage(rc, { title: rc.t("profile.email_change"), path: "/email/revert", problem: r.ok ? null : r.problem, done: r.ok ? rc.t("flash.email_reverted") : undefined });
    },
  }),
  page("/legal", async (rc) => {
    const r = unwrap(rc, await rc.api.get<{ items: { id: string; title: string; current_version: string | null; effective_at: string | null }[]; accountable_person: { name: string; role: string } }>("/api/v1/legal"));
    return shell(
      rc,
      { title: rc.t("app.legal") },
      <div class="stack-lg">
        <PageHead title={rc.t("app.legal")} />
        <div class="grid-2">
          {r.items.map((d) => (
            <a class="card link-card" href={href(rc, `/legal/${d.id}`)}>
              <h3>{d.title}</h3>
              <span class="muted">{d.current_version ?? ""}</span>
            </a>
          ))}
        </div>
        {r.accountable_person.name !== "Not configured" ? (
          <p class="muted">
            {r.accountable_person.name}, {r.accountable_person.role}
          </p>
        ) : null}
      </div>,
    );
  }),
  page("/legal/:id", (rc, p) => legalDoc(rc, p.id!)),
  page("/legal/:id/:version", (rc, p) => legalDoc(rc, p.id!, p.version!)),
];
