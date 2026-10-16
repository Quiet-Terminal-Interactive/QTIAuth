import qrcode from "qrcode-generator";
import { raw } from "hono/html";
import type { Problem } from "../api.ts";
import { fieldErrors } from "../api.ts";
import { actions, attempt, back, page, redirect, unwrap, type PageRoute } from "../app.tsx";
import { href, requireUser, type RequestContext } from "../context.ts";
import { settingsSide } from "../nav.ts";
import { ActionForm, Alert, Badge, Card, Check, Empty, Field, LinkButton, PageHead, ProblemAlert, Select, SidebarLayout, StateBadge, Submit, fmtDate, fmtDateTime, fmtRelative, stateLabel } from "../ui.tsx";
import { SocialButtons, providerLabel, shell } from "./common.tsx";

interface SignInMethods {
  count: number;
  magic_link: boolean;
  identities: { id: string; type: string; email: string | null; display_name: string | null; created_at: string; last_used_at: string | null }[];
  passkeys: { id: string; name: string; created_at: string; last_used_at: string | null; synced: boolean; device_type: string | null }[];
  providers: { id: string; name: string; connected: boolean }[];
  totp: boolean;
}

interface Session {
  id: string;
  device: string | null;
  country: string | null;
  auth_method: string;
  created_at: string;
  last_active_at: string;
  current: boolean;
  trust_level: string;
}

async function settings(rc: RequestContext, active: string, title: string, body: unknown) {
  const f = await rc.features();
  return shell(
    rc,
    { title, active: "settings" },
    <SidebarLayout rc={rc} items={settingsSide(rc, f)} active={active}>
      {body as never}
    </SidebarLayout>,
  );
}

function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

function CodesBlock({ rc, codes }: { rc: RequestContext; codes: string[] }) {
  return (
    <div class="stack">
      <Alert kind="warning">{rc.t("security.recovery_save")}</Alert>
      <div class="codes">
        {codes.map((c) => (
          <code>{c}</code>
        ))}
      </div>
      <div class="row">
        <button type="button" class="btn secondary sm" data-copy={codes.join("\n")} data-copied={rc.t("app.copied")}>
          {rc.t("app.copy")}
        </button>
      </div>
    </div>
  );
}

async function home(rc: RequestContext) {
  requireUser(rc);
  const f = await rc.features();
  const me = (await rc.me())!;
  const [sessions, games, apps] = await Promise.all([
    rc.api.get<{ items: Session[] }>("/api/v1/me/sessions"),
    f.features.games ? rc.api.get<{ items: { slug: string; name: string; icon_url: string | null }[] }>("/api/v1/games/owned") : Promise.resolve(null),
    f.modules.oidc ? rc.api.get<{ items: unknown[] }>("/api/v1/me/apps") : Promise.resolve(null),
  ]);
  const twoFactor = me.two_factor.totp || me.two_factor.passkeys > 0;
  const name = me.username ?? me.email?.split("@")[0] ?? "";
  return shell(
    rc,
    { title: rc.t("nav.overview"), active: "overview" },
    <div class="stack-lg">
      <PageHead title={rc.t("home.title", { name })} lede={rc.t("home.lede")} />
      {me.needs_username ? (
        <Alert kind="info">
          {rc.t("home.username_missing")} <a href={href(rc, "/welcome/username")}>{rc.t("profile.username_change")}</a>
        </Alert>
      ) : null}
      {me.restrictions.length ? (
        <Alert kind="warning" title={rc.t("safety.actions_title")}>
          {me.restrictions.map((r) => r.name).join(", ")} · <a href={href(rc, "/safety")}>{rc.t("app.view")}</a>
        </Alert>
      ) : null}
      <div class="grid-3">
        <a class="tile link-card" href={href(rc, "/settings/security")}>
          <div class="label">{rc.t("home.security")}</div>
          <div class="value">{twoFactor ? <Badge color="green">{rc.t("security.totp_on")}</Badge> : <Badge color="yellow">{rc.t("security.totp_off")}</Badge>}</div>
        </a>
        <a class="tile link-card" href={href(rc, "/settings/sessions")}>
          <div class="label">{rc.t("home.sessions")}</div>
          <div class="value">{sessions.ok ? sessions.data.items.length : "–"}</div>
        </a>
        {apps ? (
          <a class="tile link-card" href={href(rc, "/settings/apps")}>
            <div class="label">{rc.t("home.apps")}</div>
            <div class="value">{apps.ok ? apps.data.items.length : "–"}</div>
          </a>
        ) : null}
        {games ? (
          <a class="tile link-card" href={href(rc, "/games")}>
            <div class="label">{rc.t("home.games")}</div>
            <div class="value">{games.ok ? games.data.items.length : "–"}</div>
          </a>
        ) : null}
      </div>
      {games && games.ok ? (
        <Card title={rc.t("home.games")} actions={<LinkButton href={href(rc, "/games")} kind="secondary" small>{rc.t("home.redeem")}</LinkButton>}>
          {games.data.items.length ? (
            <div class="grid-3">
              {games.data.items.map((g) => (
                <a class="tile link-card row" href={href(rc, `/games/${g.slug}`)}>
                  {g.icon_url ? <img class="game-icon" src={g.icon_url} alt="" width="48" height="48" /> : <span class="game-icon">{g.name.slice(0, 1)}</span>}
                  <strong>{g.name}</strong>
                </a>
              ))}
            </div>
          ) : (
            <p class="muted">{rc.t("home.games_none")}</p>
          )}
        </Card>
      ) : null}
    </div>,
  );
}

async function profile(rc: RequestContext, o: { problem?: Problem | null; emailSent?: string; pending?: boolean } = {}) {
  requireUser(rc);
  const me = (await rc.me())!;
  const f = await rc.features();
  const history = await rc.api.get<{ items: { username: string; claimed_at: string; released_at: string | null }[] }>("/api/v1/me/username/history");
  const errs = fieldErrors(o.problem);
  const days = Math.round(rc.cfg.usernames.change_cooldown / 86_400_000);
  const action = href(rc, "/settings/profile");
  return settings(
    rc,
    "profile",
    rc.t("profile.title"),
    <>
      <PageHead title={rc.t("profile.title")} />
      <ProblemAlert rc={rc} problem={o.problem} />
      <Card title={rc.t("profile.email")}>
        <div class="stack">
          <div class="row between">
            <span class="mono">{me.email}</span>
            {me.email_verified ? <Badge color="green">{stateLabel(rc, "verified")}</Badge> : <Badge color="yellow">{stateLabel(rc, "unverified")}</Badge>}
          </div>
          {o.emailSent ? <Alert kind="success">{rc.t("profile.email_sent", { email: o.emailSent })}</Alert> : null}
          <ActionForm action={action} name="email" class="row">
            <div class="grow">
              <Field name="new_email" label={rc.t("profile.email_new")} type="email" autocomplete="email" required error={errs.new_email} />
            </div>
            <Submit kind="secondary">{rc.t("profile.email_change")}</Submit>
          </ActionForm>
        </div>
      </Card>
      <Card title={rc.t("profile.username")}>
        <div class="stack">
          {o.pending ? <Alert kind="info">{rc.t("error.GUARDIAN_APPROVAL_REQUIRED")}</Alert> : null}
          <ActionForm action={action} name="username" class="row">
            <div class="grow">
              <Field name="username" label={rc.t("profile.username")} value={me.username} required minlength={f.usernames.min_length} maxlength={f.usernames.max_length} hint={rc.t("signup.username_hint", { min: f.usernames.min_length, max: f.usernames.max_length })} error={errs.username} />
            </div>
            <Submit kind="secondary">{rc.t("profile.username_change")}</Submit>
          </ActionForm>
          <p class="hint">{rc.t("profile.username_rules", { days, n: rc.cfg.usernames.yearly_limit })}</p>
          {history.ok && history.data.items.length > 1 ? (
            <details>
              <summary>{rc.t("profile.username_history")}</summary>
              <ul>
                {history.data.items.map((h) => (
                  <li>
                    <span class="mono">{h.username}</span> <span class="muted">{fmtDate(rc, h.claimed_at)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </Card>
      <Card title={rc.t("app.settings")}>
        <ActionForm action={action} name="prefs">
          {rc.cfg.branding.locales.length > 1 ? (
            <Select name="locale" label={rc.t("profile.locale")} value={me.locale ?? rc.cfg.branding.default_locale} options={rc.cfg.branding.locales.map((l) => ({ value: l, label: new Intl.DisplayNames([l], { type: "language" }).of(l) ?? l }))} />
          ) : null}
          <Check name="public_profile" label={rc.t("profile.public")} hint={rc.t("profile.public_hint")} checked={me.public_profile} />
          {f.features.games?.leaderboards ? <Check name="leaderboard_visible" label={rc.t("profile.leaderboards")} hint={rc.t("profile.leaderboards_hint")} checked={me.leaderboard_visible ?? me.age_band === "adult"} /> : null}
          <div>
            <Submit>{rc.t("app.save")}</Submit>
          </div>
        </ActionForm>
        <hr />
        <dl class="kv">
          <dt>{rc.t("profile.age_band")}</dt>
          <dd>{me.age_band ? stateLabel(rc, me.age_band) : rc.t("app.unknown")}</dd>
          <dt>{rc.t("profile.member_since")}</dt>
          <dd>{fmtDate(rc, me.created_at)}</dd>
        </dl>
      </Card>
    </>,
  );
}

async function security(rc: RequestContext, o: { problem?: Problem | null; totpSetup?: { secret: string; otpauth_uri: string }; codes?: string[] | null; passkeyOptions?: { challenge_id: string; options: unknown } } = {}) {
  requireUser(rc, { mfa: true });
  const me = (await rc.me())!;
  const f = await rc.features();
  const methods = unwrap(rc, await rc.api.get<SignInMethods>("/api/v1/me/sign-in-methods"));
  const events = await rc.api.get<{ items: { id: string; type: string; country: string | null; user_agent: string | null; created_at: string }[] }>("/api/v1/me/security-events", { limit: 10 });
  const hasPassword = methods.identities.some((i) => i.type === "password");
  const action = href(rc, "/settings/security");
  const errs = fieldErrors(o.problem);
  const social = methods.identities.filter((i) => i.type !== "password");
  return settings(
    rc,
    "security",
    rc.t("security.title"),
    <>
      <PageHead title={rc.t("security.title")} />
      {rc.query.get("enrol") || me.mfa_enrolment_required ? <Alert kind="warning" title={rc.t("gate.mfa_title")}>{rc.t("gate.mfa_lede")}</Alert> : null}
      <ProblemAlert rc={rc} problem={o.problem} />
      {o.codes ? (
        <Card title={rc.t("security.recovery")}>
          <CodesBlock rc={rc} codes={o.codes} />
        </Card>
      ) : null}

      {f.auth.password ? (
        <Card title={rc.t("security.password")}>
          <p class="muted">{hasPassword ? rc.t("security.password_set") : rc.t("security.password_none")}</p>
          <ActionForm action={action} name="password">
            <div class="grid-2">
              {hasPassword ? <Field name="current_password" label={rc.t("security.password_current")} type="password" autocomplete="current-password" error={errs.current_password} /> : null}
              <Field name="new_password" label={rc.t("security.password_new")} type="password" autocomplete="new-password" required minlength={f.auth.password_policy.min_length} error={errs.new_password} />
            </div>
            <div>
              <Submit kind="secondary">{hasPassword ? rc.t("security.password_change") : rc.t("security.password_add")}</Submit>
            </div>
          </ActionForm>
        </Card>
      ) : null}

      <Card title={rc.t("security.twofactor")}>
        <div class="stack">
          {f.auth.totp ? (
            <div class="stack">
              <div class="row between">
                <div>
                  <h3>{rc.t("security.totp")}</h3>
                  <span class="muted">{methods.totp ? rc.t("security.totp_on") : rc.t("security.totp_off")}</span>
                </div>
                {methods.totp ? (
                  <ActionForm action={action} name="totp_disable" class="inline-form" confirm={rc.t("app.confirm")}>
                    <Submit kind="danger-ghost" small>
                      {rc.t("security.totp_disable")}
                    </Submit>
                  </ActionForm>
                ) : o.totpSetup ? null : (
                  <ActionForm action={action} name="totp_setup" class="inline-form">
                    <Submit small>{rc.t("security.totp_setup")}</Submit>
                  </ActionForm>
                )}
              </div>
              {o.totpSetup ? (
                <div class="grid-2">
                  <div class="stack-sm">
                    <p>{rc.t("security.totp_scan")}</p>
                    <div class="qr">{raw(qrSvg(o.totpSetup.otpauth_uri))}</div>
                    <code class="secret">{o.totpSetup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
                  </div>
                  <ActionForm action={action} name="totp_confirm">
                    <Field name="code" label={rc.t("security.totp_confirm")} inputmode="numeric" autocomplete="one-time-code" class="code-input" required autofocus />
                    <Submit>{rc.t("app.confirm")}</Submit>
                  </ActionForm>
                </div>
              ) : null}
            </div>
          ) : null}
          {me.two_factor.totp || me.two_factor.passkeys ? (
            <>
              <hr />
              <div class="row between">
                <div>
                  <h3>{rc.t("security.recovery")}</h3>
                  <span class="muted">{rc.t("security.recovery_remaining", { n: me.two_factor.recovery_codes_remaining })}</span>
                </div>
                <ActionForm action={action} name="recovery" class="inline-form" confirm={rc.t("app.confirm")}>
                  <Submit kind="secondary" small>
                    {rc.t("security.recovery_regenerate")}
                  </Submit>
                </ActionForm>
              </div>
            </>
          ) : null}
        </div>
      </Card>

      {f.auth.passkeys ? (
        <Card
          title={rc.t("security.passkeys")}
          actions={
            o.passkeyOptions ? null : (
              <ActionForm action={action} name="passkey_options" class="inline-form">
                <Submit small>{rc.t("security.passkey_add")}</Submit>
              </ActionForm>
            )
          }
        >
          <p class="muted">{rc.t("security.passkeys_lede")}</p>
          {o.passkeyOptions ? (
            <ActionForm action={action} name="passkey_register" passkey="create" rc={rc} fields={{ challenge_id: o.passkeyOptions.challenge_id }}>
              <input type="hidden" name="response" value="" />
              <script type="application/json" data-passkey-options>
                {JSON.stringify(o.passkeyOptions.options)}
              </script>
              <Field name="name" label={rc.t("security.passkey_name")} value={rc.t("security.passkey_default_name")} maxlength={64} />
              <p class="hint" data-passkey-status aria-live="polite" />
              <div>
                <Submit>{rc.t("security.passkey_add")}</Submit>
              </div>
            </ActionForm>
          ) : null}
          {methods.passkeys.length ? (
            <div class="list">
              {methods.passkeys.map((p) => (
                <div class="item">
                  <div>
                    <strong>{p.name}</strong> {p.synced ? <Badge color="blue">{rc.t("security.passkey_synced")}</Badge> : null}
                    <div class="meta">{rc.t("security.passkey_last_used", { when: fmtRelative(rc, p.last_used_at) })}</div>
                  </div>
                  <ActionForm action={action} name="passkey_remove" class="inline-form" fields={{ id: p.id }} confirm={rc.t("app.confirm")}>
                    <Submit kind="danger-ghost" small>
                      {rc.t("app.remove")}
                    </Submit>
                  </ActionForm>
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card title={rc.t("security.methods")}>
        <p class="muted">{rc.t("security.methods_lede")}</p>
        <div class="list">
          {methods.magic_link ? (
            <div class="item">
              <strong>{rc.t("security.magic_link")}</strong>
              <span class="meta">{me.email}</span>
            </div>
          ) : null}
          {social.map((i) => (
            <div class="item">
              <div>
                <strong>{providerLabel(i.type)}</strong>
                <div class="meta">{i.display_name ?? i.email ?? ""}</div>
              </div>
              <ActionForm action={action} name="identity_remove" class="inline-form" fields={{ id: i.id }} confirm={rc.t("app.confirm")}>
                <Submit kind="danger-ghost" small>
                  {rc.t("app.remove")}
                </Submit>
              </ActionForm>
            </div>
          ))}
        </div>
        <div class="stack-sm">
          <SocialButtons rc={rc} providers={methods.providers.filter((p) => !p.connected).map((p) => p.id)} returnTo="/settings/security" intent="connect" />
        </div>
      </Card>

      {events.ok && events.data.items.length ? (
        <Card title={rc.t("security.events")}>
          <div class="table-wrap">
            <table class="table">
              <tbody>
                {events.data.items.map((e) => (
                  <tr>
                    <td>{e.type.replace(/[._]/g, " ")}</td>
                    <td class="muted">{e.country ?? ""}</td>
                    <td class="muted">{fmtDateTime(rc, e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </>,
  );
}

function onError(rc: RequestContext, r: { ok: boolean; problem?: Problem }, again: (p: Problem) => unknown, success: () => Response) {
  if (!r.ok) return again(r.problem!) as never;
  return success();
}

const securityActions = actions("/settings/security", {
  password: async (rc) => {
    const r = attempt(rc, await rc.api.post("/api/v1/me/password", { current_password: rc.form.current_password || undefined, new_password: rc.form.new_password ?? "" }));
    return onError(rc, r, (problem) => security(rc, { problem }), () => back(rc, "/settings/security", { ok: "password_changed" }));
  },
  totp_setup: async (rc) => {
    const r = attempt(rc, await rc.api.post<{ secret: string; otpauth_uri: string }>("/api/v1/me/totp/setup", {}));
    return r.ok ? security(rc, { totpSetup: r.data }) : security(rc, { problem: r.problem });
  },
  totp_confirm: async (rc) => {
    const r = attempt(rc, await rc.api.post<{ recovery_codes: string[] | null }>("/api/v1/me/totp/confirm", { code: (rc.form.code ?? "").replace(/\s/g, "") }));
    if (!r.ok) return security(rc, { problem: r.problem });
    return r.data.recovery_codes ? security(rc, { codes: r.data.recovery_codes }) : back(rc, "/settings/security", { ok: "totp_enabled" });
  },
  totp_disable: async (rc) => {
    const r = attempt(rc, await rc.api.delete("/api/v1/me/totp"));
    return onError(rc, r, (problem) => security(rc, { problem }), () => back(rc, "/settings/security", { ok: "totp_disabled" }));
  },
  recovery: async (rc) => {
    const r = attempt(rc, await rc.api.post<{ recovery_codes: string[] }>("/api/v1/me/recovery-codes", {}));
    return r.ok ? security(rc, { codes: r.data.recovery_codes }) : security(rc, { problem: r.problem });
  },
  passkey_options: async (rc) => {
    const r = attempt(rc, await rc.api.post<{ challenge_id: string; options: unknown }>("/api/v1/me/passkeys/options", {}));
    return r.ok ? security(rc, { passkeyOptions: r.data }) : security(rc, { problem: r.problem });
  },
  passkey_register: async (rc) => {
    let response: Record<string, unknown> = {};
    try {
      response = JSON.parse(rc.form.response || "{}") as Record<string, unknown>;
    } catch {
      response = {};
    }
    const r = attempt(rc, await rc.api.post("/api/v1/me/passkeys", { challenge_id: rc.form.challenge_id ?? "", response, name: rc.form.name?.trim() || rc.t("security.passkey_default_name") }));
    return onError(rc, r, (problem) => security(rc, { problem }), () => back(rc, "/settings/security", { ok: "passkey_added" }));
  },
  passkey_remove: async (rc) => {
    const r = attempt(rc, await rc.api.delete(`/api/v1/me/passkeys/${encodeURIComponent(rc.form.id ?? "")}`));
    return onError(rc, r, (problem) => security(rc, { problem }), () => back(rc, "/settings/security", { ok: "passkey_removed" }));
  },
  identity_remove: async (rc) => {
    const r = attempt(rc, await rc.api.delete(`/api/v1/me/identities/${encodeURIComponent(rc.form.id ?? "")}`));
    return onError(rc, r, (problem) => security(rc, { problem }), () => back(rc, "/settings/security", { ok: "method_removed" }));
  },
});

async function sessions(rc: RequestContext) {
  requireUser(rc);
  const list = unwrap(rc, await rc.api.get<{ items: Session[] }>("/api/v1/me/sessions"));
  const action = href(rc, "/settings/sessions");
  return settings(
    rc,
    "sessions",
    rc.t("sessions.title"),
    <>
      <PageHead
        title={rc.t("sessions.title")}
        lede={rc.t("sessions.lede")}
        actions={
          <>
            <ActionForm action={action} name="revoke_others" class="inline-form">
              <Submit kind="secondary" small>
                {rc.t("sessions.revoke_others")}
              </Submit>
            </ActionForm>
            <ActionForm action={action} name="revoke_all" class="inline-form" confirm={rc.t("app.confirm")}>
              <Submit kind="danger-ghost" small>
                {rc.t("sessions.revoke_all")}
              </Submit>
            </ActionForm>
          </>
        }
      />
      <div class="card flush">
        <div class="list">
          {list.items.map((s) => (
            <div class="item">
              <div>
                <strong>{s.device ?? rc.t("app.unknown")}</strong> {s.current ? <Badge color="green">{rc.t("app.current")}</Badge> : null}
                {s.trust_level !== "full" ? <Badge color="yellow">{s.trust_level}</Badge> : null}
                <div class="meta">
                  {[s.country, rc.t("sessions.via", { method: stateLabel(rc, s.auth_method) }), rc.t("sessions.last_active", { when: fmtRelative(rc, s.last_active_at) })].filter(Boolean).join(" · ")}
                </div>
              </div>
              {s.current ? null : (
                <ActionForm action={action} name="revoke" class="inline-form" fields={{ id: s.id }}>
                  <Submit kind="secondary" small>
                    {rc.t("sessions.revoke")}
                  </Submit>
                </ActionForm>
              )}
            </div>
          ))}
        </div>
      </div>
    </>,
  );
}

interface Category {
  id: string;
  label: string;
  description?: string;
  locked?: boolean;
  enabled: boolean;
}

async function notifications(rc: RequestContext) {
  requireUser(rc);
  const list = unwrap(rc, await rc.api.get<{ items: Category[] }>("/api/v1/me/notifications"));
  return settings(
    rc,
    "notifications",
    rc.t("notifications.title"),
    <>
      <PageHead title={rc.t("notifications.title")} lede={rc.t("notifications.lede")} />
      <Card>
        <ActionForm action={href(rc, "/settings/notifications")} name="save">
          <div class="list">
            {list.items.map((c) => (
              <div class="toggle-row">
                <div>
                  <strong>{c.label}</strong>
                  {c.description ? <div class="hint">{c.description}</div> : null}
                </div>
                {c.locked ? (
                  <Badge>{rc.t("notifications.locked")}</Badge>
                ) : (
                  <>
                    <input type="hidden" name="categories" value={c.id} />
                    <input type="checkbox" name={`cat_${c.id}`} checked={c.enabled} aria-label={c.label} />
                  </>
                )}
              </div>
            ))}
          </div>
          <div>
            <Submit>{rc.t("app.save")}</Submit>
          </div>
        </ActionForm>
      </Card>
    </>,
  );
}

async function apps(rc: RequestContext) {
  requireUser(rc);
  const list = unwrap(rc, await rc.api.get<{ items: { client_id: string; name: string; verified: boolean; scopes: { scope: string; consent_text: string }[]; granted_at: string; last_used_at: string | null }[] }>("/api/v1/me/apps"));
  return settings(
    rc,
    "apps",
    rc.t("apps.title"),
    <>
      <PageHead title={rc.t("apps.title")} lede={rc.t("apps.lede")} />
      {list.items.length ? (
        <div class="stack">
          {list.items.map((a) => (
            <Card
              title={
                <h3>
                  {a.name} {a.verified ? <Badge color="blue">{stateLabel(rc, "verified")}</Badge> : null}
                </h3>
              }
              actions={
                <ActionForm action={href(rc, "/settings/apps")} name="revoke" class="inline-form" fields={{ client_id: a.client_id }} confirm={rc.t("app.confirm")}>
                  <Submit kind="danger-ghost" small>
                    {rc.t("apps.revoke")}
                  </Submit>
                </ActionForm>
              }
            >
              <p class="muted">{rc.t("apps.since", { when: fmtDate(rc, a.granted_at) })}</p>
              <ul>
                {a.scopes.map((s) => (
                  <li>{s.consent_text}</li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      ) : (
        <div class="card">
          <Empty title={rc.t("apps.none")} />
        </div>
      )}
    </>,
  );
}

async function privacy(rc: RequestContext, problem?: Problem | null) {
  requireUser(rc, { legal: true, deletion: true, restricted: true });
  const me = (await rc.me())!;
  const f = await rc.features();
  const exports = f.features.data_export ? await rc.api.get<{ items: { id: string; status: string; requested_at: string; expires_at: string | null }[] }>("/api/v1/me/export") : null;
  const legal = await rc.api.get<{ accepted: { document_id: string; version: string; accepted_at: string }[] }>("/api/v1/me/legal");
  const days = Math.round(rc.cfg.accounts.deletion_grace / 86_400_000);
  const action = href(rc, "/settings/privacy");
  return settings(
    rc,
    "privacy",
    rc.t("privacy.title"),
    <>
      <PageHead title={rc.t("privacy.title")} />
      <ProblemAlert rc={rc} problem={problem} />
      {me.state === "pending_deletion" && me.deletion_due_at ? <Alert kind="danger" title={rc.t("gate.deletion_title")}>{fmtDate(rc, me.deletion_due_at)}</Alert> : null}
      {exports ? (
        <Card title={rc.t("privacy.export")}>
          <p class="muted">{rc.t("privacy.export_lede")}</p>
          {exports.ok && exports.data.items[0] ? (
            <p>
              {rc.t("privacy.export_status", { status: exports.data.items[0].status })} · {fmtDateTime(rc, exports.data.items[0].requested_at)}
            </p>
          ) : null}
          <ActionForm action={action} name="export" class="row">
            <Submit kind="secondary">{rc.t("privacy.export_request")}</Submit>
          </ActionForm>
        </Card>
      ) : null}
      {legal.ok && legal.data.accepted.length ? (
        <Card title={rc.t("privacy.legal")}>
          <div class="list">
            {legal.data.accepted.map((a) => (
              <div class="item">
                <a href={href(rc, `/legal/${a.document_id}/${a.version}`)}>
                  {a.document_id} · {a.version}
                </a>
                <span class="meta">{fmtDate(rc, a.accepted_at)}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {me.state !== "pending_deletion" ? (
        <Card title={rc.t("privacy.delete")} class="danger" id="delete">
          <p class="muted">{rc.t("privacy.delete_lede", { days })}</p>
          <ActionForm action={action} name="delete" class="row" confirm={rc.t("privacy.delete_confirm")}>
            <Submit kind="danger">{rc.t("privacy.delete_submit")}</Submit>
          </ActionForm>
        </Card>
      ) : null}
    </>,
  );
}

async function myFamily(rc: RequestContext, problem?: Problem | null) {
  requireUser(rc);
  const r = unwrap(
    rc,
    await rc.api.get<{
      guardians: { id: string; email: string; status: string; approved_at: string | null }[];
      controls: Record<string, unknown> | null;
      controls_optional: boolean;
      removal_request: { id: string; created_at: string } | null;
      can_remove_without_approval: boolean;
      can_request_removal: boolean;
    }>("/api/v1/me/parental"),
  );
  const action = href(rc, "/settings/family");
  return settings(
    rc,
    "family",
    rc.t("family.title"),
    <>
      <PageHead title={rc.t("family.title")} />
      <ProblemAlert rc={rc} problem={problem} />
      <Card title={rc.t("family.title")}>
        {r.guardians.length ? (
          <div class="list">
            {r.guardians.map((g) => (
              <div class="item">
                <span class="mono">{g.email}</span>
                <StateBadge rc={rc} state={g.status} />
              </div>
            ))}
          </div>
        ) : (
          <p class="muted">{rc.t("app.none")}</p>
        )}
        {r.guardians.length ? (
          <div class="row">
            {r.can_remove_without_approval ? (
              <ActionForm action={action} name="remove" class="inline-form" confirm={rc.t("app.confirm")}>
                <Submit kind="danger-ghost">{rc.t("app.remove")}</Submit>
              </ActionForm>
            ) : r.can_request_removal && !r.removal_request ? (
              <ActionForm action={action} name="request_removal" class="inline-form">
                <Submit kind="secondary">{rc.t("app.remove")}</Submit>
              </ActionForm>
            ) : r.removal_request ? (
              <Alert kind="info">{rc.t("error.GUARDIAN_APPROVAL_REQUIRED")}</Alert>
            ) : null}
          </div>
        ) : null}
      </Card>
      {r.controls ? (
        <Card title={rc.t("family.controls")}>
          <dl class="kv">
            {Object.entries(r.controls).map(([k, v]) => (
              <>
                <dt>{stateLabel(rc, k)}</dt>
                <dd>{v === null ? "–" : typeof v === "boolean" ? (v ? rc.t("app.yes") : rc.t("app.no")) : String(v)}</dd>
              </>
            ))}
          </dl>
        </Card>
      ) : null}
    </>,
  );
}

export const accountRoutes: PageRoute[] = [
  page("/", (rc) => home(rc)),
  page("/settings", (rc) => redirect(rc, href(rc, "/settings/profile"))),
  page("/settings/profile", (rc) => profile(rc)),
  actions("/settings/profile", {
    email: async (rc) => {
      const email = (rc.form.new_email ?? "").trim();
      const r = attempt(rc, await rc.api.post("/api/v1/me/email", { new_email: email }));
      return r.ok ? profile(rc, { emailSent: email }) : profile(rc, { problem: r.problem });
    },
    username: async (rc) => {
      const r = attempt(rc, await rc.api.put<{ status: string }>("/api/v1/me/username", { username: (rc.form.username ?? "").trim() }));
      if (!r.ok) return profile(rc, { problem: r.problem });
      return r.data.status === "pending_guardian_approval" ? profile(rc, { pending: true }) : back(rc, "/settings/profile", { ok: "username_changed" });
    },
    prefs: async (rc) => {
      const body: Record<string, unknown> = { public_profile: Boolean(rc.form.public_profile) };
      if (rc.form.locale) body.locale = rc.form.locale;
      if ((await rc.features()).features.games?.leaderboards) body.leaderboard_visible = Boolean(rc.form.leaderboard_visible);
      const r = attempt(rc, await rc.api.patch("/api/v1/me", body));
      return r.ok ? back(rc, "/settings/profile", { ok: "saved" }) : profile(rc, { problem: r.problem });
    },
  }),
  page("/settings/security", (rc) => security(rc)),
  securityActions,
  page("/settings/sessions", (rc) => sessions(rc)),
  actions("/settings/sessions", {
    revoke: async (rc) => {
      unwrap(rc, await rc.api.delete(`/api/v1/me/sessions/${encodeURIComponent(rc.form.id ?? "")}`));
      return back(rc, "/settings/sessions", { ok: "session_revoked" });
    },
    revoke_others: async (rc) => {
      unwrap(rc, await rc.api.post("/api/v1/me/sessions/revoke-others", {}));
      return back(rc, "/settings/sessions", { ok: "sessions_revoked" });
    },
    revoke_all: async (rc) => {
      unwrap(rc, await rc.api.post("/api/v1/me/sessions/revoke-all", {}));
      return redirect(rc, href(rc, "/login", { ok: "signed_out" }));
    },
  }),
  page("/settings/notifications", (rc) => notifications(rc)),
  actions("/settings/notifications", {
    save: async (rc) => {
      const current = unwrap(rc, await rc.api.get<{ items: Category[] }>("/api/v1/me/notifications"));
      for (const c of current.items.filter((x) => !x.locked)) {
        const want = Boolean(rc.form[`cat_${c.id}`]);
        if (want !== c.enabled) unwrap(rc, await rc.api.put("/api/v1/me/notifications", { category: c.id, enabled: want }));
      }
      return back(rc, "/settings/notifications", { ok: "saved" });
    },
  }),
  page("/settings/apps", (rc) => apps(rc)),
  actions("/settings/apps", {
    revoke: async (rc) => {
      unwrap(rc, await rc.api.delete(`/api/v1/me/apps/${encodeURIComponent(rc.form.client_id ?? "")}`));
      return back(rc, "/settings/apps", { ok: "app_revoked" });
    },
  }),
  page("/settings/privacy", (rc) => privacy(rc)),
  page("/settings/delete", (rc) => redirect(rc, `${href(rc, "/settings/privacy")}#delete`)),
  actions("/settings/privacy", {
    export: async (rc) => {
      const r = attempt(rc, await rc.api.post("/api/v1/me/export", {}));
      return r.ok ? back(rc, "/settings/privacy", { ok: "export_requested" }) : privacy(rc, r.problem);
    },
    delete: async (rc) => {
      const r = attempt(rc, await rc.api.post("/api/v1/me/delete", {}));
      return r.ok ? redirect(rc, href(rc, "/login", { ok: "signed_out" })) : privacy(rc, r.problem);
    },
  }),
  page("/settings/family", (rc) => myFamily(rc)),
  actions("/settings/family", {
    request_removal: async (rc) => {
      const r = attempt(rc, await rc.api.post("/api/v1/me/parental/removal-request", {}));
      return r.ok ? back(rc, "/settings/family", { ok: "done" }) : myFamily(rc, r.problem);
    },
    remove: async (rc) => {
      const r = attempt(rc, await rc.api.post("/api/v1/me/parental/remove", {}));
      return r.ok ? back(rc, "/settings/family", { ok: "done" }) : myFamily(rc, r.problem);
    },
  }),
  page("/settings/age", (rc) => redirect(rc, href(rc, "/settings/profile"))),
];

