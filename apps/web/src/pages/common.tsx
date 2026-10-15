import type { Child } from "hono/jsx";
import { href, surfaceHref, type Features, type Me, type RequestContext } from "../context.ts";
import { accountNav, supportNav } from "../nav.ts";
import { AppShell, Check } from "../ui.tsx";

export interface LegalDoc {
  id: string;
  title: string;
  current_version: string | null;
  requires_acceptance: boolean;
}

export async function shell(rc: RequestContext, opts: { title: string; active?: string; banner?: Child }, children: Child) {
  const [features, me] = await Promise.all([rc.features(), rc.me()]);
  const nav = rc.surface.name === "support" ? supportNav(rc, features) : accountNav(rc, features);
  const banner = opts.banner ?? stateBanner(rc, me);
  return (
    <AppShell rc={rc} title={opts.title} nav={nav} active={opts.active} me={me} banner={banner}>
      {children}
    </AppShell>
  );
}

function stateBanner(rc: RequestContext, me: Me | null) {
  if (!me) return null;
  if (me.state === "pending_deletion" && me.deletion_due_at) {
    return (
      <div class="banner">
        <div class="banner-inner">
          <strong>{rc.t("gate.deletion_title")}</strong>
          <a href={surfaceHref(rc, "account", "/settings/privacy")}>{rc.t("privacy.title")}</a>
        </div>
      </div>
    );
  }
  return null;
}

export async function features(rc: RequestContext): Promise<Features> {
  return rc.features();
}

export async function signupDocuments(rc: RequestContext): Promise<LegalDoc[]> {
  const f = await rc.features();
  const r = await rc.api.get<{ items: LegalDoc[] }>("/api/v1/legal");
  if (!r.ok) return [];
  return r.data.items.filter((d) => f.legal.required_at_signup.includes(d.id) && d.current_version);
}

export function LegalAccept({ rc, docs, checked }: { rc: RequestContext; docs: LegalDoc[]; checked?: boolean }) {
  if (!docs.length) return null;
  const links = docs.map((d, i) => (
    <>
      {i > 0 ? (i === docs.length - 1 ? " and " : ", ") : ""}
      <a href={href(rc, `/legal/${d.id}`)} target="_blank" rel="noopener">
        {d.title}
      </a>
    </>
  ));
  return (
    <Check
      name="accept_legal"
      checked={checked}
      label={
        <>
          {rc.t("signup.accept_prefix")}
          {links}.
        </>
      }
    />
  );
}

export function acceptedDocs(rc: RequestContext, docs: LegalDoc[]): { id: string; version: string }[] {
  return rc.form.accept_legal ? docs.map((d) => ({ id: d.id, version: d.current_version! })) : [];
}

export function captchaValue(rc: RequestContext): string | undefined {
  return rc.form.captcha || rc.form["h-captcha-response"] || rc.form["cf-turnstile-response"] || rc.form["frc-captcha-solution"] || undefined;
}

const PROVIDER_LABELS: Record<string, string> = { google: "Google", github: "GitHub", discord: "Discord", steam: "Steam" };

export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id.replace(/^oidc:/, "").replace(/[_-]/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function SocialButtons({ rc, providers, returnTo, intent = "login" }: { rc: RequestContext; providers: string[]; returnTo?: string | null; intent?: "login" | "connect" }) {
  if (!providers.length) return null;
  return (
    <div class="stack-sm">
      {providers.map((p) => {
        const params = new URLSearchParams({ intent });
        if (returnTo) params.set("return_to", returnTo);
        return (
          <a class="btn secondary block btn-provider" href={`${rc.surface.apiPath}/v1/auth/social/${encodeURIComponent(p)}/start?${params.toString()}`}>
            <span class="dot" aria-hidden="true">
              {providerLabel(p).slice(0, 1)}
            </span>
            {rc.t("login.with", { provider: providerLabel(p) })}
          </a>
        );
      })}
    </div>
  );
}

export function ageFromDob(dob: string): number | null {
  const d = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}
