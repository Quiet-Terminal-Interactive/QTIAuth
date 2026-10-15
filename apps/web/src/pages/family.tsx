import type { Problem } from "../api.ts";
import { actions, attempt, back, page, redirect, unwrap, type PageRoute } from "../app.tsx";
import { href, isGuardian, signedIn, type RequestContext } from "../context.ts";
import { ActionForm, Alert, AuthLayout, Card, Check, Empty, Field, LinkButton, PageHead, ProblemAlert, StateBadge, Submit, fmtDate, fmtRelative, stateLabel } from "../ui.tsx";
import { shell } from "./common.tsx";

interface ChildOverview {
  id: string;
  username: string | null;
  display_name: string;
  state: string;
  age_band: string | null;
  controls: Record<string, boolean | number | null>;
  controls_optional: boolean;
  guardians: { id: string; email: string; display_name: string | null; status: string }[];
  pending_requests: { id: string; type: string; data: Record<string, unknown>; created_at: string }[];
  pending_legal?: { id: string; version: string; title: string; summary: string | null }[];
}

const CONTROL_KEYS = ["approve_third_party_apps", "online_play", "in_game_chat", "user_generated_content", "purchases", "leaderboards", "public_profile", "username_changes_require_approval"] as const;

async function consentPage(rc: RequestContext, o: { problem?: Problem | null; done?: "approved" | "declined" } = {}) {
  const token = rc.query.get("token") ?? rc.form.token ?? "";
  if (o.done) {
    return (
      <AuthLayout rc={rc} title={rc.t("family.consent_title")}>
        <Alert kind={o.done === "approved" ? "success" : "info"}>{o.done === "approved" ? rc.t("family.consent_done") : rc.t("family.consent_declined")}</Alert>
        {o.done === "approved" ? (
          <LinkButton href={href(rc, "/family")} block>
            {rc.t("family.title")}
          </LinkButton>
        ) : null}
      </AuthLayout>
    );
  }
  const r = await rc.api.post<{ child: { display_name: string; email: string | null }; documents: { id: string; version: string; title: string; summary: string | null; requires_acceptance: boolean }[] }>("/api/v1/family/consent/lookup", { token });
  if (!r.ok) {
    return (
      <AuthLayout rc={rc} title={rc.t("family.consent_title")}>
        <ProblemAlert rc={rc} problem={r.problem} />
      </AuthLayout>
    );
  }
  const action = href(rc, "/family/consent");
  return (
    <AuthLayout rc={rc} title={rc.t("family.consent_title")} lede={`${r.data.child.display_name}${r.data.child.email ? ` (${r.data.child.email})` : ""}`} wide>
      <ProblemAlert rc={rc} problem={o.problem} />
      <Card>
        <ul>
          {r.data.documents.map((d) => (
            <li>
              <a href={href(rc, `/legal/${d.id}/${d.version}`)} target="_blank" rel="noopener">
                {d.title}
              </a>
              {d.summary ? <span class="muted"> · {d.summary}</span> : null}
            </li>
          ))}
          <li>
            <a href={href(rc, "/legal/children-summary")} target="_blank" rel="noopener">
              {rc.t("app.privacy")}
            </a>
          </li>
        </ul>
      </Card>
      <ActionForm action={action} name="approve" fields={{ token }}>
        {r.data.documents.filter((d) => d.requires_acceptance).map((d) => (
          <input type="hidden" name="doc" value={`${d.id}@${d.version}`} />
        ))}
        <Field name="guardian_dob" label={rc.t("family.consent_dob")} type="date" required hint={rc.t("family.consent_dob_hint")} />
        <Field name="display_name" label={rc.t("profile.username")} autocomplete="name" />
        <Check name="agree" label={rc.t("signup.accept", { documents: r.data.documents.map((d) => d.title).join(", ") })} />
        <Submit block>{rc.t("family.consent_approve")}</Submit>
      </ActionForm>
      <ActionForm action={action} name="decline" fields={{ token }} confirm={rc.t("app.confirm")}>
        <Submit kind="danger-ghost" block>
          {rc.t("family.consent_decline")}
        </Submit>
      </ActionForm>
    </AuthLayout>
  );
}

async function accessPage(rc: RequestContext, o: { problem?: Problem | null; sent?: boolean } = {}) {
  const token = rc.query.get("token");
  if (token) {
    return (
      <AuthLayout rc={rc} title={rc.t("family.access_title")}>
        <ActionForm action={href(rc, "/family/access")} name="verify" fields={{ token }}>
          <Submit block>{rc.t("app.continue")}</Submit>
        </ActionForm>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout rc={rc} title={rc.t("family.access_title")} lede={rc.t("family.access_lede")}>
      <ProblemAlert rc={rc} problem={o.problem} />
      {o.sent ? (
        <Alert kind="success">{rc.t("family.access_sent")}</Alert>
      ) : (
        <ActionForm action={href(rc, "/family/access")} name="send">
          <Field name="email" label={rc.t("signup.email")} type="email" required autofocus />
          <Submit block>{rc.t("family.access_send")}</Submit>
        </ActionForm>
      )}
    </AuthLayout>
  );
}

async function dashboard(rc: RequestContext) {
  if (!isGuardian(rc) && !signedIn(rc)) return redirect(rc, href(rc, "/family/access"));
  const r = unwrap(rc, await rc.api.get<{ items: ChildOverview[] }>("/api/v1/family/children"));
  return shell(
    rc,
    { title: rc.t("family.title") },
    <div class="stack-lg">
      <PageHead title={rc.t("family.title")} />
      {r.items.length ? (
        <div class="grid-2">
          {r.items.map((c) => (
            <a class="card link-card" href={href(rc, `/family/children/${c.id}`)}>
              <div class="row between">
                <h3>{c.display_name}</h3>
                <StateBadge rc={rc} state={c.state} />
              </div>
              {c.pending_requests.length ? <Alert kind="warning">{`${rc.t("family.requests")}: ${c.pending_requests.length}`}</Alert> : <span class="muted">{stateLabel(rc, c.age_band)}</span>}
            </a>
          ))}
        </div>
      ) : (
        <div class="card">
          <Empty title={rc.t("family.children")} />
        </div>
      )}
    </div>,
  );
}

async function childPage(rc: RequestContext, childId: string, problem?: Problem | null) {
  if (!isGuardian(rc) && !signedIn(rc)) return redirect(rc, href(rc, "/family/access"));
  const base = `/api/v1/family/children/${encodeURIComponent(childId)}`;
  const child = unwrap(rc, await rc.api.get<ChildOverview>(base));
  const [sessions, activity] = await Promise.all([
    rc.api.get<{ items: { id: string; device: string | null; country: string | null; last_active_at: string }[] }>(`${base}/sessions`),
    rc.api.get<{ sign_ins: { at: string; device: string | null; country: string | null }[]; games: { name: string; playtime_minutes: number }[]; apps_connected: { name: string; connected_at: string }[] }>(`${base}/activity`),
  ]);
  const action = href(rc, `/family/children/${childId}`);
  return shell(
    rc,
    { title: child.display_name },
    <div class="stack-lg">
      <PageHead title={child.display_name} lede={stateLabel(rc, child.age_band)} crumbs={[{ href: href(rc, "/family"), label: rc.t("family.title") }]} actions={<StateBadge rc={rc} state={child.state} />} />
      <ProblemAlert rc={rc} problem={problem} />
      {child.pending_requests.length ? (
        <Card title={rc.t("family.requests")}>
          <div class="list">
            {child.pending_requests.map((req) => (
              <div class="item">
                <div>
                  <strong>{stateLabel(rc, req.type)}</strong>
                  <div class="meta">
                    {Object.entries(req.data)
                      .filter(([k]) => ["client_name", "username", "scopes"].includes(k))
                      .map(([, v]) => String(v))
                      .join(" · ")}
                  </div>
                </div>
                <div class="row">
                  <ActionForm action={action} name="decide" class="inline-form" fields={{ rid: req.id, approve: "0" }}>
                    <Submit kind="secondary" small>
                      {rc.t("family.decline")}
                    </Submit>
                  </ActionForm>
                  <ActionForm action={action} name="decide" class="inline-form" fields={{ rid: req.id, approve: "1" }}>
                    <Submit small>{rc.t("family.approve")}</Submit>
                  </ActionForm>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {child.pending_legal?.length ? (
        <Card title={rc.t("gate.legal_title")}>
          <ActionForm action={action} name="legal">
            {child.pending_legal.map((d) => (
              <>
                <input type="hidden" name="doc" value={`${d.id}@${d.version}`} />
                <a href={href(rc, `/legal/${d.id}/${d.version}`)} target="_blank" rel="noopener">
                  {d.title}
                </a>
              </>
            ))}
            <Submit>{rc.t("gate.legal_accept")}</Submit>
          </ActionForm>
        </Card>
      ) : null}
      <Card title={rc.t("family.controls")}>
        {child.controls_optional ? <p class="muted">{rc.t("app.optional")}</p> : null}
        <ActionForm action={action} name="controls">
          <div class="grid-2">
            {CONTROL_KEYS.map((k) => (
              <Check name={k} label={stateLabel(rc, k)} checked={Boolean(child.controls[k])} />
            ))}
          </div>
          <Field name="daily_playtime_minutes" label={rc.t("family.playtime_limit")} type="number" min={0} max={1440} value={child.controls.daily_playtime_minutes === null || child.controls.daily_playtime_minutes === undefined ? "" : String(child.controls.daily_playtime_minutes)} hint={rc.t("family.playtime_hint")} />
          <div>
            <Submit>{rc.t("app.save")}</Submit>
          </div>
        </ActionForm>
      </Card>
      <div class="grid-2">
        <Card title={rc.t("nav.sessions")}>
          {sessions.ok && sessions.data.items.length ? (
            <div class="list">
              {sessions.data.items.map((s) => (
                <div class="item">
                  <div>
                    <strong>{s.device ?? rc.t("app.unknown")}</strong>
                    <div class="meta">{[s.country, fmtRelative(rc, s.last_active_at)].filter(Boolean).join(" · ")}</div>
                  </div>
                  <ActionForm action={action} name="revoke" class="inline-form" fields={{ sid: s.id }}>
                    <Submit kind="secondary" small>
                      {rc.t("sessions.revoke")}
                    </Submit>
                  </ActionForm>
                </div>
              ))}
            </div>
          ) : (
            <p class="muted">{rc.t("app.none")}</p>
          )}
        </Card>
        <Card title={rc.t("family.activity")}>
          {activity.ok ? (
            <div class="stack-sm">
              <p>{rc.t("family.sign_ins", { n: activity.data.sign_ins.length })}</p>
              {activity.data.games.map((g) => (
                <p>
                  {g.name}: <strong>{g.playtime_minutes} min</strong>
                </p>
              ))}
              {activity.data.apps_connected.map((a) => (
                <p class="muted">
                  {a.name} · {fmtDate(rc, a.connected_at)}
                </p>
              ))}
            </div>
          ) : null}
        </Card>
      </div>
      <Card title={rc.t("privacy.title")}>
        <div class="row">
          <ActionForm action={action} name="export" class="inline-form">
            <Submit kind="secondary">{rc.t("privacy.export_request")}</Submit>
          </ActionForm>
          <ActionForm action={action} name="delete" class="inline-form" confirm={rc.t("privacy.delete_confirm")}>
            <Submit kind="danger-ghost">{rc.t("privacy.delete")}</Submit>
          </ActionForm>
        </div>
        <p class="hint">{child.guardians.map((g) => `${g.email} (${g.status})`).join(", ")}</p>
      </Card>
    </div>,
  );
}

function docsFrom(rc: RequestContext) {
  return (rc.formAll.doc ?? []).map((d) => {
    const [id, version] = d.split("@");
    return { id: id!, version: version! };
  });
}

export const familyRoutes: PageRoute[] = [
  page("/family", (rc) => dashboard(rc)),
  page("/family/consent", (rc) => consentPage(rc)),
  actions("/family/consent", {
    approve: async (rc) => {
      if (!rc.form.agree) return consentPage(rc, { problem: { status: 422, code: "LEGAL_NOT_ACCEPTED" } });
      const r = await rc.api.post("/api/v1/family/consent/approve", { token: rc.form.token ?? "", guardian_dob: rc.form.guardian_dob ?? "", display_name: rc.form.display_name?.trim() || undefined, accept_legal: docsFrom(rc) });
      return r.ok ? consentPage(rc, { done: "approved" }) : consentPage(rc, { problem: r.problem });
    },
    decline: async (rc) => {
      const r = await rc.api.post("/api/v1/family/consent/decline", { token: rc.form.token ?? "" });
      return r.ok ? consentPage(rc, { done: "declined" }) : consentPage(rc, { problem: r.problem });
    },
  }),
  page("/family/access", (rc) => accessPage(rc)),
  actions("/family/access", {
    send: async (rc) => {
      const r = await rc.api.post("/api/v1/family/access", { email: (rc.form.email ?? "").trim() });
      return accessPage(rc, r.ok ? { sent: true } : { problem: r.problem });
    },
    verify: async (rc) => {
      const r = await rc.api.post("/api/v1/family/access/verify", { token: rc.form.token ?? "" });
      return r.ok ? redirect(rc, href(rc, "/family")) : accessPage(rc, { problem: r.problem });
    },
  }),
  page("/family/children/:id", (rc, p) => childPage(rc, p.id!)),
  actions("/family/children/:id", {
    decide: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/family/children/${encodeURIComponent(p.id!)}/requests/${encodeURIComponent(rc.form.rid ?? "")}`, { approve: rc.form.approve === "1" }));
      return r.ok ? back(rc, `/family/children/${p.id}`, { ok: "done" }) : childPage(rc, p.id!, r.problem);
    },
    controls: async (rc, p) => {
      const body: Record<string, unknown> = Object.fromEntries(CONTROL_KEYS.map((k) => [k, Boolean(rc.form[k])]));
      body.daily_playtime_minutes = rc.form.daily_playtime_minutes ? Number(rc.form.daily_playtime_minutes) : null;
      const r = attempt(rc, await rc.api.patch(`/api/v1/family/children/${encodeURIComponent(p.id!)}/controls`, body));
      return r.ok ? back(rc, `/family/children/${p.id}`, { ok: "saved" }) : childPage(rc, p.id!, r.problem);
    },
    revoke: async (rc, p) => {
      const r = attempt(rc, await rc.api.delete(`/api/v1/family/children/${encodeURIComponent(p.id!)}/sessions/${encodeURIComponent(rc.form.sid ?? "")}`));
      return r.ok ? back(rc, `/family/children/${p.id}`, { ok: "session_revoked" }) : childPage(rc, p.id!, r.problem);
    },
    legal: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/family/children/${encodeURIComponent(p.id!)}/legal/accept`, { documents: docsFrom(rc) }));
      return r.ok ? back(rc, `/family/children/${p.id}`, { ok: "legal_accepted" }) : childPage(rc, p.id!, r.problem);
    },
    export: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/family/children/${encodeURIComponent(p.id!)}/export`, {}));
      return r.ok ? back(rc, `/family/children/${p.id}`, { ok: "export_requested" }) : childPage(rc, p.id!, r.problem);
    },
    delete: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/family/children/${encodeURIComponent(p.id!)}/delete`, { confirm: true }));
      return r.ok ? back(rc, "/family", { ok: "done" }) : childPage(rc, p.id!, r.problem);
    },
  }),
];

