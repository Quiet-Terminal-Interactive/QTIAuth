import type { Child, PropsWithChildren } from "hono/jsx";
import { raw } from "hono/html";
import type { Problem } from "./api.ts";
import { errorMessage } from "./i18n/index.ts";
import { gravatarUrl, href, initials, surfaceHref, type Me, type RequestContext } from "./context.ts";
import type { NavItem } from "./nav.ts";

export function fmtDate(rc: RequestContext, iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }): string {
  if (!iso) return rc.t("app.never");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(rc.locale, { timeZone: "UTC", ...opts }).format(d);
}

export function fmtDateTime(rc: RequestContext, iso: string | null | undefined): string {
  return fmtDate(rc, iso, { dateStyle: "medium", timeStyle: "short" });
}

export function fmtRelative(rc: RequestContext, iso: string | null | undefined): string {
  if (!iso) return rc.t("app.never");
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(rc.locale, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, secs] of units) if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  return rtf.format(Math.round(diff), "second");
}

export function fmtNumber(rc: RequestContext, n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : new Intl.NumberFormat(rc.locale).format(n);
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "–";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.round((s % 86_400) / 3600)}h`;
}

export function Document(props: PropsWithChildren<{ rc: RequestContext; title: string; bodyClass?: string; head?: Child }>) {
  const { rc } = props;
  const product = rc.cfg.branding.product_name;
  const assets = (p: string) => href(rc, p);
  return (
    <>
      {raw("<!doctype html>")}
      <html lang={rc.locale}>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content={rc.cfg.branding.colors.scheme} />
          <meta name="theme-color" content={rc.cfg.branding.colors.background} />
          <meta name="referrer" content="strict-origin-when-cross-origin" />
          <title>{props.title === product ? product : `${props.title} · ${product}`}</title>
          <link rel="icon" href={assets("/branding/favicon")} />
          <link rel="stylesheet" href={`${assets("/assets/theme.css")}?v=${rc.themeVersion}`} />
          <script nonce={rc.nonce} src={`${assets("/assets/app.js")}?v=${rc.themeVersion}`} defer />
          {props.head}
        </head>
        <body class={props.bodyClass}>{props.children}</body>
      </html>
    </>
  );
}

function Brand({ rc, home }: { rc: RequestContext; home: string }) {
  return (
    <a class="brand" href={home}>
      <img src={href(rc, "/branding/logo")} alt="" width="30" height="30" />
      <span>{rc.cfg.branding.product_name}</span>
    </a>
  );
}

function Footer({ rc }: { rc: RequestContext }) {
  const year = new Date().getUTCFullYear();
  return (
    <footer class="footer">
      <div class="footer-inner">
        <span>{rc.t("app.footer_rights", { year, company: rc.cfg.branding.company_name })}</span>
        <nav aria-label={rc.t("app.legal")}>
          <a href={surfaceHref(rc, "account", "/legal/terms")}>{rc.t("app.terms")}</a>
          <a href={surfaceHref(rc, "account", "/legal/privacy")}>{rc.t("app.privacy")}</a>
          <a href={surfaceHref(rc, "support", "/")}>{rc.t("app.help")}</a>
          {rc.cfg.branding.footer_links.map((l) => (
            <a href={l.href} rel="noopener">
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}

export function AppShell(props: PropsWithChildren<{ rc: RequestContext; title: string; nav: NavItem[]; active?: string; me?: Me | null; home?: string; banner?: Child }>) {
  const { rc, me } = props;
  const name = me?.username ?? me?.email ?? null;
  const avatarUrl = gravatarUrl(me?.email);
  const home = props.home ?? href(rc, "/");
  return (
    <Document rc={rc} title={props.title}>
      <a class="skip" href="#main">
        {rc.t("app.skip")}
      </a>
      <header class="topbar">
        <div class="topbar-inner">
          <Brand rc={rc} home={home} />
          <nav class="nav" aria-label={rc.t("app.main_nav")}>
            {props.nav.map((n) => (
              <a href={n.href} aria-current={n.key === props.active ? "page" : undefined}>
                {n.label}
              </a>
            ))}
          </nav>
          {rc.claims.sub || rc.claims.gid ? (
            <details class="menu">
              <summary aria-label={rc.t("app.account")}>
                {avatarUrl ? (
                  <img class="avatar" src={avatarUrl} alt="" width={30} height={30} aria-hidden="true" />
                ) : (
                  <span class="avatar" aria-hidden="true">
                    {initials(name)}
                  </span>
                )}
              </summary>
              <div class="menu-panel">
                {name ? <div class="menu-head">{rc.t("app.signed_in_as", { name })}</div> : null}
                {rc.claims.sub ? <a href={surfaceHref(rc, "account", "/settings/profile")}>{rc.t("app.settings")}</a> : null}
                <a href={surfaceHref(rc, "support", "/")}>{rc.t("app.help")}</a>
                <form method="post" action={href(rc, "/logout")}>
                  <button type="submit">{rc.t("app.sign_out")}</button>
                </form>
              </div>
            </details>
          ) : (
            <a class="btn sm" href={surfaceHref(rc, "account", "/login", { return: rc.surface.name === "account" ? undefined : rc.origin + rc.fullPath })}>
              {rc.t("app.sign_in")}
            </a>
          )}
        </div>
      </header>
      {props.banner}
      <main id="main">
        <Flash rc={rc} />
        {props.children}
      </main>
      <Footer rc={rc} />
    </Document>
  );
}

export function AuthLayout(props: PropsWithChildren<{ rc: RequestContext; title: string; lede?: Child; wide?: boolean }>) {
  const { rc } = props;
  return (
    <Document rc={rc} title={props.title}>
      <div class="auth-wrap">
        <div class={props.wide ? "auth-card wide" : "auth-card"}>
          <div class="auth-logo">
            <a href={surfaceHref(rc, "account", "/")}>
              <img src={href(rc, "/branding/logo")} alt={rc.cfg.branding.product_name} height="44" />
            </a>
          </div>
          <h1>{props.title}</h1>
          {props.lede ? <p class="lede">{props.lede}</p> : null}
          <div class="stack">
            <Flash rc={rc} />
            {props.children}
          </div>
        </div>
      </div>
      <Footer rc={rc} />
    </Document>
  );
}

export function SidebarLayout(props: PropsWithChildren<{ rc: RequestContext; items: { label?: string; href?: string; key?: string; text?: string }[]; active: string }>) {
  return (
    <div class="with-sidebar">
      <nav class="sidebar" aria-label={props.rc.t("app.section_nav")}>
        {props.items.map((i) =>
          i.href ? (
            <a href={i.href} aria-current={i.key === props.active ? "page" : undefined}>
              {i.text}
            </a>
          ) : (
            <div class="label">{i.label}</div>
          ),
        )}
      </nav>
      <div class="stack-lg">{props.children}</div>
    </div>
  );
}

export function PageHead(props: { title: string; lede?: Child; crumbs?: { href: string; label: string }[]; actions?: Child }) {
  return (
    <div>
      {props.crumbs?.length ? (
        <div class="crumbs">
          {props.crumbs.map((c, i) => (
            <>
              {i > 0 ? " / " : ""}
              <a href={c.href}>{c.label}</a>
            </>
          ))}
        </div>
      ) : null}
      <div class="page-head">
        <div>
          <h1>{props.title}</h1>
          {props.lede ? <p>{props.lede}</p> : null}
        </div>
        {props.actions ? <div class="row">{props.actions}</div> : null}
      </div>
    </div>
  );
}

export function Flash({ rc }: { rc: RequestContext }) {
  const ok = rc.query.get("ok");
  const err = rc.query.get("err");
  if (!ok && !err) return null;
  const text = ok ? rc.t(`flash.${ok}`) : errorMessage(rc.t, err ?? undefined);
  if (ok && text === `flash.${ok}`) return null;
  return (
    <div class={ok ? "alert success" : "alert danger"} role="status">
      {text}
    </div>
  );
}

export function ProblemAlert({ rc, problem }: { rc: RequestContext; problem?: Problem | null }) {
  if (!problem) return null;
  const msg = errorMessage(rc.t, problem.code, typeof problem.detail === "string" ? problem.detail : undefined);
  const extraHref = typeof problem.delete_account_url === "string" ? problem.delete_account_url : null;
  return (
    <div class="alert danger" role="alert">
      <span>{msg}</span>
      {extraHref ? (
        <a href={extraHref}>{rc.t("privacy.delete")}</a>
      ) : null}
      {problem.code === "RATE_LIMITED" && typeof problem.retry_after === "number" ? <small>{rc.t("app.retry_in", { seconds: problem.retry_after })}</small> : null}
    </div>
  );
}

export function Alert(props: PropsWithChildren<{ kind?: "info" | "success" | "warning" | "danger"; title?: string }>) {
  return (
    <div class={`alert ${props.kind ?? "info"}`}>
      {props.title ? <strong>{props.title}</strong> : null}
      <div>{props.children}</div>
    </div>
  );
}

export function Badge(props: PropsWithChildren<{ color?: "neutral" | "blue" | "green" | "yellow" | "red" | "purple" | "orange" }>) {
  return <span class={`badge ${props.color ?? "neutral"}`}>{props.children}</span>;
}

export function Card(props: PropsWithChildren<{ title?: Child; actions?: Child; class?: string; id?: string }>) {
  return (
    <section class={`card ${props.class ?? ""}`} id={props.id}>
      {props.title || props.actions ? (
        <div class="card-head">
          {typeof props.title === "string" ? <h2>{props.title}</h2> : props.title}
          {props.actions ? <div class="row">{props.actions}</div> : null}
        </div>
      ) : null}
      {props.children}
    </section>
  );
}

export interface FieldProps {
  name: string;
  label: string;
  type?: string;
  value?: string | null;
  error?: string;
  hint?: Child;
  required?: boolean;
  autocomplete?: string;
  placeholder?: string;
  inputmode?: "none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url";
  pattern?: string;
  min?: string | number;
  max?: string | number;
  maxlength?: number;
  minlength?: number;
  autofocus?: boolean;
  class?: string;
  readonly?: boolean;
}

function FieldHint(p: { id?: string; error?: string; hint?: Child }) {
  if (!p.hint && !p.error) return null;
  return (
    <span id={p.id} class={p.error ? "field-error" : "hint"}>
      {p.error ?? p.hint}
    </span>
  );
}

export function Field(p: FieldProps) {
  const id = `f-${p.name}`;
  return (
    <div class="field">
      <label for={id}>{p.label}</label>
      <input
        id={id}
        name={p.name}
        type={p.type ?? "text"}
        value={p.value ?? undefined}
        required={p.required}
        autocomplete={p.autocomplete}
        placeholder={p.placeholder}
        inputmode={p.inputmode}
        pattern={p.pattern}
        min={p.min}
        max={p.max}
        maxlength={p.maxlength}
        minlength={p.minlength}
        autofocus={p.autofocus}
        readonly={p.readonly}
        class={p.class}
        aria-invalid={p.error ? "true" : undefined}
        aria-describedby={p.hint || p.error ? `${id}-desc` : undefined}
      />
      <FieldHint id={`${id}-desc`} error={p.error} hint={p.hint} />
    </div>
  );
}

export function TextArea(p: { name: string; label: string; value?: string | null; error?: string; hint?: Child; required?: boolean; rows?: number; maxlength?: number; placeholder?: string }) {
  const id = `f-${p.name}`;
  return (
    <div class="field">
      <label for={id}>{p.label}</label>
      <textarea id={id} name={p.name} required={p.required} rows={p.rows ?? 6} maxlength={p.maxlength} placeholder={p.placeholder} aria-invalid={p.error ? "true" : undefined}>
        {p.value ?? ""}
      </textarea>
      <FieldHint error={p.error} hint={p.hint} />
    </div>
  );
}

export function Select(p: { name: string; label: string; options: { value: string; label: string }[]; value?: string | null; error?: string; hint?: Child; required?: boolean; placeholder?: string }) {
  const id = `f-${p.name}`;
  return (
    <div class="field">
      <label for={id}>{p.label}</label>
      <select id={id} name={p.name} required={p.required} aria-invalid={p.error ? "true" : undefined}>
        {p.placeholder ? <option value="">{p.placeholder}</option> : null}
        {p.options.map((o) => (
          <option value={o.value} selected={o.value === p.value}>
            {o.label}
          </option>
        ))}
      </select>
      <FieldHint error={p.error} hint={p.hint} />
    </div>
  );
}

export function Check(p: { name: string; label: Child; checked?: boolean; hint?: Child; value?: string }) {
  return (
    <label class="check">
      <input type="checkbox" name={p.name} value={p.value ?? "on"} checked={p.checked} />
      <span>
        {p.label}
        {p.hint ? <span class="hint">{p.hint}</span> : null}
      </span>
    </label>
  );
}

export function Hidden({ name, value }: { name: string; value: string | null | undefined }) {
  return value === null || value === undefined ? null : <input type="hidden" name={name} value={value} />;
}

export function Submit(p: PropsWithChildren<{ kind?: "primary" | "secondary" | "danger" | "ghost" | "danger-ghost"; block?: boolean; small?: boolean; name?: string; value?: string; confirm?: string }>) {
  const cls = ["btn", p.kind && p.kind !== "primary" ? p.kind : "", p.block ? "block" : "", p.small ? "sm" : ""].filter(Boolean).join(" ");
  return (
    <button type="submit" class={cls} name={p.name} value={p.value} data-confirm={p.confirm}>
      {p.children}
    </button>
  );
}

export function ActionForm(p: PropsWithChildren<{ action: string; name: string; class?: string; confirm?: string; fields?: Record<string, string | null | undefined>; passkey?: "create" | "get"; autostart?: boolean; rc?: RequestContext }>) {
  return (
    <form
      method="post"
      action={p.action}
      class={p.class ?? "stack"}
      data-confirm={p.confirm}
      data-passkey={p.passkey}
      data-autostart={p.autostart ? "" : undefined}
      data-unsupported={p.passkey && p.rc ? p.rc.t("app.passkey_unsupported") : undefined}
      data-cancelled={p.passkey && p.rc ? p.rc.t("app.passkey_cancelled") : undefined}
    >
      <input type="hidden" name="_action" value={p.name} />
      {Object.entries(p.fields ?? {}).map(([k, v]) => (v === null || v === undefined ? null : <input type="hidden" name={k} value={v} />))}
      {p.children}
    </form>
  );
}

export function PostButton(p: PropsWithChildren<{ action: string; kind?: "primary" | "secondary" | "danger" | "ghost" | "danger-ghost"; small?: boolean; confirm?: string; fields?: Record<string, string> }>) {
  return (
    <form method="post" action={p.action} class="inline-form" data-confirm={p.confirm}>
      {Object.entries(p.fields ?? {}).map(([k, v]) => (
        <input type="hidden" name={k} value={v} />
      ))}
      <Submit kind={p.kind ?? "secondary"} small={p.small ?? true}>
        {p.children}
      </Submit>
    </form>
  );
}

export function LinkButton(p: PropsWithChildren<{ href: string; kind?: "primary" | "secondary" | "ghost"; small?: boolean; block?: boolean }>) {
  const cls = ["btn", p.kind && p.kind !== "primary" ? p.kind : "", p.small ? "sm" : "", p.block ? "block" : ""].filter(Boolean).join(" ");
  return (
    <a class={cls} href={p.href}>
      {p.children}
    </a>
  );
}

export function Empty(p: PropsWithChildren<{ title: string; action?: Child }>) {
  return (
    <div class="empty">
      <h3>{p.title}</h3>
      {p.children ? <p>{p.children}</p> : null}
      {p.action}
    </div>
  );
}

export function Captcha({ rc, problem }: { rc: RequestContext; problem?: Problem | null }) {
  if (!problem || (problem.code !== "CAPTCHA_REQUIRED" && problem.code !== "CAPTCHA_FAILED")) return null;
  const info = (problem.captcha ?? {}) as { provider?: string; site_key?: string | null };
  const challenge = problem.challenge as Record<string, unknown> | undefined;
  if (info.provider === "altcha" && challenge) {
    return (
      <div class="captcha" data-altcha={JSON.stringify(challenge)} data-done={rc.t("app.captcha_done")}>
        <span class="spinner" aria-hidden="true" />
        <span data-label>{rc.t("app.captcha_working")}</span>
        <input type="hidden" name="captcha" value="" />
        <noscript>{rc.t("app.captcha_needs_js")}</noscript>
      </div>
    );
  }
  if (info.provider === "turnstile" && info.site_key) {
    rc.cspHosts.push("https://challenges.cloudflare.com");
    return (
      <>
        <div class="cf-turnstile" data-sitekey={info.site_key} data-response-field-name="captcha" />
        <script nonce={rc.nonce} src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer />
      </>
    );
  }
  if (info.provider === "hcaptcha" && info.site_key) {
    rc.cspHosts.push("https://hcaptcha.com", "https://*.hcaptcha.com");
    return (
      <>
        <div class="h-captcha" data-sitekey={info.site_key} />
        <script nonce={rc.nonce} src="https://js.hcaptcha.com/1/api.js" async defer />
      </>
    );
  }
  if (info.provider === "friendly_captcha" && info.site_key) {
    rc.cspHosts.push("https://*.frcapi.com");
    return (
      <>
        <div class="frc-captcha" data-sitekey={info.site_key} data-solution-field-name="captcha" />
        <script nonce={rc.nonce} type="module" src="https://cdn.jsdelivr.net/npm/friendly-challenge@0.9.18/widget.module.min.js" async defer />
      </>
    );
  }
  return null;
}

export function Pager({ rc, next, path, query }: { rc: RequestContext; next: string | null | undefined; path: string; query?: Record<string, string | undefined> }) {
  if (!next) return null;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v) params.set(k, v);
  params.set("cursor", next);
  return (
    <div class="row end">
      <a class="btn secondary sm" href={`${path}?${params.toString()}`}>
        {rc.t("app.next")} →
      </a>
    </div>
  );
}

export function stateLabel(rc: RequestContext, state: string | null | undefined): string {
  if (!state) return "";
  const key = `state.${state}`;
  const t = rc.t(key);
  return t === key ? state.replace(/_/g, " ") : t;
}

const STATE_BADGE_COLOR: Record<string, "green" | "yellow" | "red" | "blue" | "neutral" | "purple" | "orange"> = {
  active: "green",
  open: "blue",
  in_review: "purple",
  waiting_on_user: "yellow",
  on_hold: "neutral",
  closed: "neutral",
  resolved: "green",
  actioned: "green",
  dismissed: "neutral",
  pending: "yellow",
  pending_approval: "yellow",
  pending_email_verification: "yellow",
  pending_parental_consent: "yellow",
  locked: "orange",
  banned: "red",
  pending_deletion: "red",
  deleted: "neutral",
  lifted: "neutral",
  expired: "neutral",
  completed: "green",
  upheld: "orange",
  submitted: "blue",
  released: "green",
  early_access: "purple",
  draft: "neutral",
  hidden: "neutral",
  archived: "neutral",
  published: "green",
  critical: "red",
  high: "orange",
  urgent: "red",
  normal: "blue",
  low: "neutral",
};

export function StateBadge({ rc, state }: { rc: RequestContext; state: string }) {
  return <Badge color={STATE_BADGE_COLOR[state] ?? "neutral"}>{stateLabel(rc, state)}</Badge>;
}

export function Json({ value }: { value: unknown }) {
  return <pre class="diff json">{JSON.stringify(value, null, 2)}</pre>;
}
