import type { Problem } from "../api.ts";
import { fieldErrors } from "../api.ts";
import { action, attempt, back, page, redirect, type PageRoute } from "../app.tsx";
import { href, safeReturn, signedIn, surfaceHref, type RequestContext } from "../context.ts";
import { AuthLayout, Captcha, Check, Field, Hidden, LinkButton, ProblemAlert, Submit, fmtDate } from "../ui.tsx";
import { LegalAccept, SocialButtons, acceptedDocs, captchaValue, providerLabel, signupDocuments } from "./common.tsx";

interface SignedIn {
  status: "signed_in";
  user: { needs_username: boolean; state: string };
}
interface MfaRequired {
  status: "mfa_required";
  mfa_token: string;
  methods: string[];
}
type AuthResult = SignedIn | MfaRequired | { status: "signup_required"; signup_token: string; email: string } | { status: "choose_account"; choice_token: string; accounts: { id: string; username: string | null; created_at: string }[]; can_create: boolean; email?: string };

function afterAuth(rc: RequestContext, r: AuthResult, returnTo: string | null | undefined) {
  if (r.status === "mfa_required") return mfaPage(rc, { token: r.mfa_token, methods: r.methods, returnTo: returnTo ?? null });
  if (r.status === "signup_required") return redirect(rc, href(rc, "/signup/complete", { token: r.signup_token, email: r.email, return: returnTo ?? undefined }));
  if (r.status === "choose_account") return choosePage(rc, r, returnTo ?? null);
  const target = r.user.needs_username ? href(rc, "/welcome/username", { return: returnTo ?? undefined }) : safeReturn(rc, returnTo);
  return redirect(rc, target);
}

async function loginPage(rc: RequestContext, opts: { problem?: Problem | null; identifier?: string; magicSent?: string } = {}) {
  const f = await rc.features();
  const ret = rc.query.get("return") ?? rc.form.return ?? null;
  if (opts.magicSent) {
    return (
      <AuthLayout rc={rc} title={rc.t("login.magic_sent_title")}>
        <p class="lede">{rc.t("login.magic_sent", { email: opts.magicSent })}</p>
        <LinkButton href={href(rc, "/login", { return: ret ?? undefined })} kind="secondary" block>
          {rc.t("app.back")}
        </LinkButton>
      </AuthLayout>
    );
  }
  const errs = fieldErrors(opts.problem);
  return (
    <AuthLayout rc={rc} title={rc.t("login.title")} lede={rc.t("login.lede", { product: rc.cfg.branding.product_name })}>
      <ProblemAlert rc={rc} problem={opts.problem} />
      <form method="post" action={href(rc, f.auth.password ? "/login" : "/login/magic")} class="stack">
        <Hidden name="return" value={ret} />
        {f.auth.password ? (
          <>
            <Field name="identifier" label={rc.t("login.identifier")} autocomplete="username" value={opts.identifier} required autofocus error={errs.identifier} />
            <div class="stack-sm">
              <Field name="password" label={rc.t("login.password")} type="password" autocomplete="current-password" error={errs.password} />
              <a href={href(rc, "/forgot-password")} class="hint">
                {rc.t("login.forgot")}
              </a>
            </div>
          </>
        ) : (
          <Field name="email" label={rc.t("signup.email")} type="email" autocomplete="email" value={opts.identifier} required autofocus />
        )}
        <Captcha rc={rc} problem={opts.problem} />
        {f.auth.password ? <Submit block>{rc.t("login.submit")}</Submit> : null}
        {f.auth.magic_link ? (
          <button type="submit" class={f.auth.password ? "btn secondary block" : "btn block"} formaction={href(rc, "/login/magic")} formnovalidate name="from_identifier" value="1">
            {rc.t("login.magic")}
          </button>
        ) : null}
      </form>
      {f.auth.passkeys || f.auth.social.length ? <div class="divider">{rc.t("login.or")}</div> : null}
      <div class="stack-sm">
        {f.auth.passkeys ? (
          <LinkButton href={href(rc, "/login/passkey", { return: ret ?? undefined })} kind="secondary" block>
            {rc.t("login.passkey")}
          </LinkButton>
        ) : null}
        <SocialButtons rc={rc} providers={f.auth.social} returnTo={ret && ret.startsWith("/") ? ret : null} />
      </div>
      <p class="auth-foot">
        {rc.t("login.no_account")} <a href={href(rc, "/signup", { return: ret ?? undefined })}>{rc.t("app.sign_up")}</a>
      </p>
    </AuthLayout>
  );
}

function mfaPage(rc: RequestContext, o: { token: string; methods: string[]; returnTo: string | null; mode?: string; problem?: Problem | null; passkeyOptions?: unknown; challengeId?: string }) {
  const mode = o.mode ?? (o.methods.includes("totp") ? "totp" : o.methods.includes("passkey") ? "passkey" : "recovery_code");
  const other = o.methods.filter((m) => m !== mode);
  const switchLabel: Record<string, string> = { totp: rc.t("mfa.use_totp"), passkey: rc.t("mfa.use_passkey"), recovery_code: rc.t("mfa.use_recovery") };
  return (
    <AuthLayout rc={rc} title={rc.t("mfa.title")} lede={mode === "passkey" ? rc.t("mfa.passkey_lede") : mode === "recovery_code" ? rc.t("mfa.recovery_lede") : rc.t("mfa.lede")}>
      <ProblemAlert rc={rc} problem={o.problem} />
      {mode === "passkey" && o.passkeyOptions ? (
        <form method="post" action={href(rc, "/auth/mfa")} class="stack" data-passkey="get" data-autostart data-unsupported={rc.t("app.passkey_unsupported")} data-cancelled={rc.t("app.passkey_cancelled")}>
          <Hidden name="mfa_token" value={o.token} />
          <Hidden name="methods" value={o.methods.join(",")} />
          <Hidden name="method" value="passkey" />
          <Hidden name="challenge_id" value={o.challengeId} />
          <Hidden name="return" value={o.returnTo} />
          <input type="hidden" name="response" value="" />
          <script type="application/json" data-passkey-options>
            {JSON.stringify(o.passkeyOptions)}
          </script>
          <p class="hint" data-passkey-status aria-live="polite" />
          <Submit block>{rc.t("login.passkey")}</Submit>
        </form>
      ) : (
        <form method="post" action={href(rc, "/auth/mfa")} class="stack">
          <Hidden name="mfa_token" value={o.token} />
          <Hidden name="methods" value={o.methods.join(",")} />
          <Hidden name="method" value={mode} />
          <Hidden name="return" value={o.returnTo} />
          {mode === "totp" ? (
            <Field name="code" label={rc.t("mfa.code")} inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,8}" class="code-input" required autofocus />
          ) : (
            <Field name="code" label={rc.t("mfa.recovery_code")} autocomplete="one-time-code" class="code-input" required autofocus />
          )}
          <Captcha rc={rc} problem={o.problem} />
          <Submit block>{rc.t("mfa.submit")}</Submit>
        </form>
      )}
      {other.length ? (
        <div class="stack-sm">
          {other.map((m) => (
            <form method="post" action={href(rc, "/auth/mfa/switch")}>
              <Hidden name="mfa_token" value={o.token} />
              <Hidden name="methods" value={o.methods.join(",")} />
              <Hidden name="mode" value={m} />
              <Hidden name="return" value={o.returnTo} />
              <Submit kind="ghost" block>
                {switchLabel[m] ?? m}
              </Submit>
            </form>
          ))}
        </div>
      ) : null}
    </AuthLayout>
  );
}

function choosePage(rc: RequestContext, r: { choice_token: string; accounts: { id: string; username: string | null; created_at: string }[]; can_create: boolean; email?: string }, returnTo: string | null) {
  return (
    <AuthLayout rc={rc} title={rc.t("choose.title")} lede={rc.t("choose.lede", { email: r.email ?? "" })}>
      <div class="stack-sm">
        {r.accounts.map((a) => (
          <form method="post" action={href(rc, "/auth/choose")}>
            <Hidden name="choice_token" value={r.choice_token} />
            <Hidden name="user_id" value={a.id} />
            <Hidden name="return" value={returnTo} />
            <Submit kind="secondary" block>
              {a.username ?? rc.t("choose.created", { date: fmtDate(rc, a.created_at) })}
            </Submit>
          </form>
        ))}
        {r.can_create ? (
          <form method="post" action={href(rc, "/auth/choose")}>
            <Hidden name="choice_token" value={r.choice_token} />
            <Hidden name="user_id" value="new" />
            <Submit kind="ghost" block>
              {rc.t("choose.new")}
            </Submit>
          </form>
        ) : null}
      </div>
    </AuthLayout>
  );
}

async function signupPage(rc: RequestContext, o: { problem?: Problem | null; sent?: string } = {}) {
  const f = await rc.features();
  const ret = rc.query.get("return") ?? rc.form.return ?? null;
  const bootstrap = rc.query.get("bootstrap") ?? rc.form.bootstrap_token ?? null;
  if (o.sent) {
    return (
      <AuthLayout rc={rc} title={rc.t("signup.check_email_title")}>
        <p class="lede">{rc.t("signup.check_email", { email: o.sent })}</p>
        <form method="post" action={href(rc, "/signup/resend")}>
          <Hidden name="email" value={o.sent} />
          <Submit kind="secondary" block>
            {rc.t("signup.resend")}
          </Submit>
        </form>
      </AuthLayout>
    );
  }
  const docs = await signupDocuments(rc);
  const errs = fieldErrors(o.problem);
  const v = rc.form;
  const method = v.method ?? (f.auth.password ? "password" : "magic");
  return (
    <AuthLayout rc={rc} title={rc.t("signup.title")} lede={bootstrap ? rc.t("signup.bootstrap") : rc.t("signup.lede", { product: rc.cfg.branding.product_name })} wide>
      <ProblemAlert rc={rc} problem={o.problem} />
      {f.auth.password && f.auth.magic_link && !bootstrap ? (
        <div class="tabs" role="tablist">
          <a href={href(rc, "/signup", { return: ret ?? undefined })} aria-current={method === "password" ? "page" : undefined}>
            {rc.t("signup.method_password")}
          </a>
          <a href={href(rc, "/signup", { method: "magic", return: ret ?? undefined })} aria-current={method === "magic" || rc.query.get("method") === "magic" ? "page" : undefined}>
            {rc.t("signup.method_magic")}
          </a>
        </div>
      ) : null}
      {(rc.query.get("method") === "magic" || method === "magic") && f.auth.magic_link && !bootstrap ? (
        <form method="post" action={href(rc, "/login/magic")} class="stack">
          <Hidden name="return" value={ret} />
          <Field name="email" label={rc.t("signup.email")} type="email" autocomplete="email" required value={v.email} autofocus />
          <p class="hint">{rc.t("signup.dob_hint")}</p>
          <Captcha rc={rc} problem={o.problem} />
          <Submit block>{rc.t("app.continue")}</Submit>
        </form>
      ) : (
        <form method="post" action={href(rc, "/signup")} class="stack">
          <Hidden name="return" value={ret} />
          <Hidden name="bootstrap_token" value={bootstrap} />
          <Field name="email" label={rc.t("signup.email")} type="email" autocomplete="email" required value={v.email ?? rc.query.get("email")} readonly={Boolean(bootstrap)} error={errs.email} />
          <Field name="password" label={rc.t("signup.password")} type="password" autocomplete="new-password" required minlength={f.auth.password_policy.min_length} maxlength={f.auth.password_policy.max_length} hint={rc.t("signup.password_hint", { min: f.auth.password_policy.min_length })} error={errs.password} />
          <div class="grid-2">
            <Field name="dob" label={rc.t("signup.dob")} type="date" required value={v.dob} hint={rc.t("signup.dob_hint")} error={errs.dob} />
            <Field name="username" label={`${rc.t("signup.username")} (${rc.t("app.optional").toLowerCase()})`} autocomplete="username" value={v.username} maxlength={f.usernames.max_length} hint={rc.t("signup.username_hint", { min: f.usernames.min_length, max: f.usernames.max_length })} error={errs.username} />
          </div>
          {bootstrap ? null : (
            <Field name="guardian_email" label={`${rc.t("signup.guardian_email")} (${rc.t("app.optional").toLowerCase()})`} type="email" value={v.guardian_email} hint={rc.t("signup.guardian_hint", { age: f.age.consent_age })} error={errs.guardian_email} />
          )}
          <LegalAccept rc={rc} docs={docs} checked={Boolean(v.accept_legal)} />
          <Captcha rc={rc} problem={o.problem} />
          <Submit block>{rc.t("signup.submit")}</Submit>
        </form>
      )}
      <p class="auth-foot">
        {rc.t("signup.have_account")} <a href={href(rc, "/login", { return: ret ?? undefined })}>{rc.t("app.sign_in")}</a>
      </p>
    </AuthLayout>
  );
}

async function completePage(rc: RequestContext, problem?: Problem | null) {
  const f = await rc.features();
  const docs = await signupDocuments(rc);
  const token = rc.query.get("token") ?? rc.form.signup_token ?? "";
  const needsEmail = (rc.query.get("needs_email") ?? rc.form.needs_email) === "true";
  const provider = rc.query.get("provider") ?? rc.form.provider ?? null;
  const v = rc.form;
  const errs = fieldErrors(problem);
  return (
    <AuthLayout rc={rc} title={rc.t("signup.complete_title")} lede={provider ? rc.t("login.with", { provider: providerLabel(provider) }) : rc.t("signup.complete_lede")} wide>
      <ProblemAlert rc={rc} problem={problem} />
      <form method="post" action={href(rc, "/signup/complete")} class="stack">
        <Hidden name="signup_token" value={token} />
        <Hidden name="needs_email" value={needsEmail ? "true" : "false"} />
        <Hidden name="provider" value={provider} />
        <Hidden name="return" value={rc.query.get("return") ?? v.return} />
        {needsEmail ? <Field name="email" label={rc.t("signup.email")} type="email" required value={v.email ?? rc.query.get("email")} error={errs.email} /> : null}
        <div class="grid-2">
          <Field name="dob" label={rc.t("signup.dob")} type="date" required value={v.dob} hint={rc.t("signup.dob_hint")} error={errs.dob} />
          <Field name="username" label={`${rc.t("signup.username")} (${rc.t("app.optional").toLowerCase()})`} value={v.username} hint={rc.t("signup.username_hint", { min: f.usernames.min_length, max: f.usernames.max_length })} error={errs.username} />
        </div>
        <Field name="guardian_email" label={`${rc.t("signup.guardian_email")} (${rc.t("app.optional").toLowerCase()})`} type="email" value={v.guardian_email} hint={rc.t("signup.guardian_hint", { age: f.age.consent_age })} />
        <LegalAccept rc={rc} docs={docs} checked={Boolean(v.accept_legal)} />
        <Submit block>{rc.t("signup.submit")}</Submit>
      </form>
    </AuthLayout>
  );
}

function confirmTokenPage(rc: RequestContext, o: { title: string; lede: string; action: string; submit: string; problem?: Problem | null }) {
  const token = rc.query.get("token") ?? rc.form.token ?? "";
  return (
    <AuthLayout rc={rc} title={o.title} lede={o.lede}>
      <ProblemAlert rc={rc} problem={o.problem} />
      {token ? (
        <form method="post" action={href(rc, o.action)} class="stack">
          <Hidden name="token" value={token} />
          <Hidden name="return" value={rc.query.get("return") ?? rc.form.return} />
          <Submit block>{o.submit}</Submit>
        </form>
      ) : (
        <p class="lede">{rc.t("error.INVALID_OR_EXPIRED_TOKEN")}</p>
      )}
    </AuthLayout>
  );
}

function resetPage(rc: RequestContext, problem?: Problem | null) {
  const token = rc.query.get("token") ?? rc.form.token ?? "";
  return (
    <AuthLayout rc={rc} title={rc.t("reset.title")}>
      <ProblemAlert rc={rc} problem={problem} />
      <form method="post" action={href(rc, "/reset-password")} class="stack">
        <Hidden name="token" value={token} />
        <Field name="password" label={rc.t("reset.password")} type="password" autocomplete="new-password" required autofocus error={fieldErrors(problem).password} />
        <Check name="keep_other_sessions" label={rc.t("reset.keep")} hint={rc.t("reset.keep_hint")} />
        <Submit block>{rc.t("reset.submit")}</Submit>
      </form>
    </AuthLayout>
  );
}

async function stepUpPage(rc: RequestContext, o: { problem?: Problem | null; mode?: string; sent?: boolean; reauth?: boolean } = {}) {
  const ret = rc.query.get("return") ?? rc.form.return ?? null;
  const r = await rc.api.post<{ methods: string[] }>("/api/v1/auth/step-up/options", {});
  const methods = r.ok ? r.data.methods : [];
  const mode = o.mode && methods.includes(o.mode) ? o.mode : (methods[0] ?? "password");
  let passkey: { challenge_id: string; options: unknown } | null = null;
  if (mode === "passkey") {
    const p = await rc.api.post<{ challenge_id: string; options: unknown }>("/api/v1/auth/step-up/options", { method: "passkey" });
    if (p.ok) passkey = p.data;
  }
  const action = href(rc, o.reauth ? "/auth/reauth" : "/auth/step-up");
  const label: Record<string, string> = { passkey: rc.t("stepup.passkey"), totp: rc.t("stepup.totp"), recovery_code: rc.t("stepup.recovery"), password: rc.t("stepup.password"), magic_link: rc.t("stepup.magic") };
  return (
    <AuthLayout rc={rc} title={rc.t("stepup.title")} lede={o.reauth ? rc.t("stepup.reauth_lede") : rc.t("stepup.lede")}>
      <ProblemAlert rc={rc} problem={o.problem ?? (r.ok ? null : r.problem)} />
      {o.sent ? <div class="alert info">{rc.t("stepup.magic_sent")}</div> : null}
      {mode === "passkey" && passkey ? (
        <form method="post" action={action} class="stack" data-passkey="get" data-autostart data-unsupported={rc.t("app.passkey_unsupported")} data-cancelled={rc.t("app.passkey_cancelled")}>
          <Hidden name="method" value="passkey" />
          <Hidden name="challenge_id" value={passkey.challenge_id} />
          <Hidden name="return" value={ret} />
          <input type="hidden" name="response" value="" />
          <script type="application/json" data-passkey-options>
            {JSON.stringify(passkey.options)}
          </script>
          <p class="hint" data-passkey-status aria-live="polite" />
          <Submit block>{rc.t("stepup.passkey")}</Submit>
        </form>
      ) : mode === "magic_link" ? (
        <form method="post" action={action} class="stack">
          <Hidden name="method" value="magic_link" />
          <Hidden name="send" value="1" />
          <Hidden name="return" value={ret} />
          <Submit block>{rc.t("stepup.magic")}</Submit>
        </form>
      ) : (
        <form method="post" action={action} class="stack">
          <Hidden name="method" value={mode} />
          <Hidden name="return" value={ret} />
          {mode === "password" ? <Field name="password" label={rc.t("stepup.password")} type="password" autocomplete="current-password" required autofocus /> : null}
          {mode === "totp" ? <Field name="code" label={rc.t("stepup.totp")} inputmode="numeric" autocomplete="one-time-code" class="code-input" required autofocus /> : null}
          {mode === "recovery_code" ? <Field name="code" label={rc.t("stepup.recovery")} class="code-input" required autofocus /> : null}
          <Submit block>{rc.t("stepup.submit")}</Submit>
        </form>
      )}
      {methods.length > 1 ? (
        <div class="row">
          {methods
            .filter((m) => m !== mode)
            .map((m) => (
              <a class="btn ghost sm" href={href(rc, o.reauth ? "/auth/reauth" : "/auth/step-up", { mode: m, return: ret ?? undefined })}>
                {label[m] ?? m}
              </a>
            ))}
        </div>
      ) : null}
    </AuthLayout>
  );
}

async function stepUpSubmit(rc: RequestContext, reauth: boolean) {
  const ret = rc.form.return ?? null;
  const method = rc.form.method ?? "password";
  if (method === "magic_link" && rc.form.send) {
    const r = attempt(rc, await rc.api.post("/api/v1/auth/step-up/options", { method: "magic_link" }));
    return stepUpPage(rc, { mode: "magic_link", sent: r.ok, problem: r.ok ? null : r.problem, reauth });
  }
  let response: Record<string, unknown> | undefined;
  if (rc.form.response) {
    try {
      response = JSON.parse(rc.form.response) as Record<string, unknown>;
    } catch {
      response = undefined;
    }
  }
  const r = await rc.api.post("/api/v1/auth/step-up/verify", { method, password: rc.form.password || undefined, code: rc.form.code?.replace(/\s/g, "") || undefined, challenge_id: rc.form.challenge_id || undefined, response });
  if (!r.ok) return stepUpPage(rc, { problem: r.problem, mode: method, reauth });
  return redirect(rc, safeReturn(rc, ret === rc.fullPath ? "/" : ret));
}

export const authRoutes: PageRoute[] = [
  page("/login", async (rc) => {
    if (signedIn(rc) && !rc.query.get("force")) return redirect(rc, safeReturn(rc, rc.query.get("return")));
    return loginPage(rc);
  }),
  action("/login", async (rc) => {
    const r = await rc.api.post<AuthResult>("/api/v1/auth/login", { identifier: rc.form.identifier ?? "", password: rc.form.password ?? "", captcha: captchaValue(rc) });
    if (!r.ok) return loginPage(rc, { problem: r.problem, identifier: rc.form.identifier });
    return afterAuth(rc, r.data, rc.form.return);
  }),
  action("/login/magic", async (rc) => {
    const email = (rc.form.email || (rc.form.from_identifier ? rc.form.identifier : "") || "").trim();
    if (!email.includes("@")) return loginPage(rc, { problem: { status: 422, code: "VALIDATION_FAILED", errors: [{ path: "identifier", message: rc.t("signup.email"), code: "invalid" }] }, identifier: rc.form.identifier });
    const ret = rc.form.return && rc.form.return.startsWith("/") ? rc.form.return : undefined;
    const r = await rc.api.post("/api/v1/auth/magic-link/start", { email, return_to: ret, captcha: captchaValue(rc) });
    if (!r.ok) return rc.form.from_identifier ? loginPage(rc, { problem: r.problem, identifier: email }) : signupPage(rc, { problem: r.problem });
    return loginPage(rc, { magicSent: email });
  }),
  page("/login/passkey", async (rc) => {
    const r = await rc.api.post<{ challenge_id: string; options: unknown }>("/api/v1/auth/passkey/options", {});
    if (!r.ok) return loginPage(rc, { problem: r.problem });
    return (
      <AuthLayout rc={rc} title={rc.t("login.passkey")}>
        <form method="post" action={href(rc, "/login/passkey")} class="stack" data-passkey="get" data-autostart data-unsupported={rc.t("app.passkey_unsupported")} data-cancelled={rc.t("app.passkey_cancelled")}>
          <Hidden name="challenge_id" value={r.data.challenge_id} />
          <Hidden name="return" value={rc.query.get("return")} />
          <input type="hidden" name="response" value="" />
          <script type="application/json" data-passkey-options>
            {JSON.stringify(r.data.options)}
          </script>
          <p class="hint" data-passkey-status aria-live="polite" />
          <Submit block>{rc.t("login.passkey")}</Submit>
        </form>
        <LinkButton href={href(rc, "/login", { return: rc.query.get("return") ?? undefined })} kind="ghost" block>
          {rc.t("app.back")}
        </LinkButton>
      </AuthLayout>
    );
  }),
  action("/login/passkey", async (rc) => {
    let response: Record<string, unknown> = {};
    try {
      response = JSON.parse(rc.form.response || "{}") as Record<string, unknown>;
    } catch {
      response = {};
    }
    const r = await rc.api.post<AuthResult>("/api/v1/auth/passkey/verify", { challenge_id: rc.form.challenge_id ?? "", response });
    if (!r.ok) return loginPage(rc, { problem: r.problem });
    return afterAuth(rc, r.data, rc.form.return);
  }),
  action("/auth/mfa", async (rc) => {
    const methods = (rc.form.methods ?? "").split(",").filter(Boolean);
    let response: Record<string, unknown> | undefined;
    if (rc.form.response) {
      try {
        response = JSON.parse(rc.form.response) as Record<string, unknown>;
      } catch {
        response = undefined;
      }
    }
    const r = await rc.api.post<AuthResult>("/api/v1/auth/mfa/verify", { mfa_token: rc.form.mfa_token ?? "", method: rc.form.method ?? "totp", code: rc.form.code?.replace(/\s/g, "") || undefined, challenge_id: rc.form.challenge_id || undefined, response, captcha: captchaValue(rc) });
    if (!r.ok) {
      if (r.problem.code === "INVALID_OR_EXPIRED_TOKEN") return loginPage(rc, { problem: r.problem });
      return mfaPage(rc, { token: rc.form.mfa_token ?? "", methods, returnTo: rc.form.return ?? null, mode: rc.form.method === "passkey" ? "totp" : rc.form.method, problem: r.problem });
    }
    return afterAuth(rc, r.data, rc.form.return);
  }),
  action("/auth/mfa/switch", async (rc) => {
    const methods = (rc.form.methods ?? "").split(",").filter(Boolean);
    const mode = rc.form.mode ?? "totp";
    if (mode === "passkey") {
      const r = await rc.api.post<{ challenge_id: string; options: unknown }>("/api/v1/auth/mfa/passkey-options", { mfa_token: rc.form.mfa_token ?? "" });
      if (r.ok) return mfaPage(rc, { token: rc.form.mfa_token ?? "", methods, returnTo: rc.form.return ?? null, mode, passkeyOptions: r.data.options, challengeId: r.data.challenge_id });
      return mfaPage(rc, { token: rc.form.mfa_token ?? "", methods, returnTo: rc.form.return ?? null, problem: r.problem });
    }
    return mfaPage(rc, { token: rc.form.mfa_token ?? "", methods, returnTo: rc.form.return ?? null, mode });
  }),
  action("/auth/choose", async (rc) => {
    const r = await rc.api.post<AuthResult>("/api/v1/auth/account-choice", { choice_token: rc.form.choice_token ?? "", user_id: rc.form.user_id ?? "" });
    if (!r.ok) return loginPage(rc, { problem: r.problem });
    return afterAuth(rc, r.data, rc.form.return);
  }),
  page("/signup", async (rc) => {
    if (signedIn(rc) && !rc.query.get("bootstrap")) return redirect(rc, href(rc, "/"));
    return signupPage(rc);
  }),
  action("/signup", async (rc) => {
    const docs = await signupDocuments(rc);
    const r = await rc.api.post<AuthResult | { status: "verification_sent" }>("/api/v1/auth/signup", {
      email: (rc.form.email ?? "").trim(),
      password: rc.form.password ?? "",
      dob: rc.form.dob ?? "",
      username: rc.form.username?.trim() || undefined,
      guardian_email: rc.form.guardian_email?.trim() || undefined,
      accept_legal: acceptedDocs(rc, docs),
      bootstrap_token: rc.form.bootstrap_token || undefined,
      captcha: captchaValue(rc),
    });
    if (!r.ok) return signupPage(rc, { problem: r.problem });
    if (r.data.status === "verification_sent") return signupPage(rc, { sent: (rc.form.email ?? "").trim() });
    return afterAuth(rc, r.data as AuthResult, rc.form.return);
  }),
  action("/signup/resend", async (rc) => {
    await rc.api.post("/api/v1/auth/verify-email/resend", { email: rc.form.email ?? "" });
    return signupPage(rc, { sent: rc.form.email ?? "" });
  }),
  page("/signup/complete", (rc) => completePage(rc)),
  action("/signup/complete", async (rc) => {
    const docs = await signupDocuments(rc);
    const r = await rc.api.post<AuthResult | { status: "verification_sent" }>("/api/v1/auth/signup/complete", {
      signup_token: rc.form.signup_token ?? "",
      dob: rc.form.dob ?? "",
      username: rc.form.username?.trim() || undefined,
      guardian_email: rc.form.guardian_email?.trim() || undefined,
      email: rc.form.email?.trim() || undefined,
      accept_legal: acceptedDocs(rc, docs),
    });
    if (!r.ok) return completePage(rc, r.problem);
    if (r.data.status === "verification_sent") return signupPage(rc, { sent: rc.form.email ?? "" });
    return afterAuth(rc, r.data as AuthResult, rc.form.return);
  }),
  page("/verify-email", (rc) => confirmTokenPage(rc, { title: rc.t("verify.title"), lede: rc.t("verify.lede"), action: "/verify-email", submit: rc.t("verify.submit") })),
  action("/verify-email", async (rc) => {
    const r = await rc.api.post<AuthResult>("/api/v1/auth/verify-email", { token: rc.form.token ?? "" });
    if (!r.ok) return confirmTokenPage(rc, { title: rc.t("verify.title"), lede: rc.t("verify.lede"), action: "/verify-email", submit: rc.t("verify.submit"), problem: r.problem });
    return afterAuth(rc, r.data, rc.form.return);
  }),
  page("/auth/magic", (rc) => confirmTokenPage(rc, { title: rc.t("magic.title"), lede: rc.t("magic.lede"), action: "/auth/magic", submit: rc.t("magic.submit") })),
  action("/auth/magic", async (rc) => {
    const r = await rc.api.post<AuthResult>("/api/v1/auth/magic-link/verify", { token: rc.form.token ?? "" });
    if (!r.ok) return confirmTokenPage(rc, { title: rc.t("magic.title"), lede: rc.t("magic.lede"), action: "/auth/magic", submit: rc.t("magic.submit"), problem: r.problem });
    return afterAuth(rc, r.data, rc.form.return);
  }),
  page("/forgot-password", (rc) => (
    <AuthLayout rc={rc} title={rc.t("forgot.title")} lede={rc.t("forgot.lede")}>
      <form method="post" action={href(rc, "/forgot-password")} class="stack">
        <Field name="email" label={rc.t("signup.email")} type="email" autocomplete="email" required autofocus />
        <Submit block>{rc.t("forgot.submit")}</Submit>
      </form>
      <LinkButton href={href(rc, "/login")} kind="ghost" block>
        {rc.t("app.back")}
      </LinkButton>
    </AuthLayout>
  )),
  action("/forgot-password", async (rc) => {
    const email = (rc.form.email ?? "").trim();
    const r = await rc.api.post("/api/v1/auth/password/forgot", { email, captcha: captchaValue(rc) });
    return (
      <AuthLayout rc={rc} title={rc.t("forgot.title")}>
        {r.ok ? <p class="lede">{rc.t("forgot.sent", { email })}</p> : <ProblemAlert rc={rc} problem={r.problem} />}
        {!r.ok ? (
          <form method="post" action={href(rc, "/forgot-password")} class="stack">
            <Field name="email" label={rc.t("signup.email")} type="email" value={email} required />
            <Captcha rc={rc} problem={r.problem} />
            <Submit block>{rc.t("forgot.submit")}</Submit>
          </form>
        ) : null}
        <LinkButton href={href(rc, "/login")} kind="secondary" block>
          {rc.t("app.sign_in")}
        </LinkButton>
      </AuthLayout>
    );
  }),
  page("/reset-password", (rc) => resetPage(rc)),
  action("/reset-password", async (rc) => {
    const r = await rc.api.post("/api/v1/auth/password/reset", { token: rc.form.token ?? "", password: rc.form.password ?? "", keep_other_sessions: Boolean(rc.form.keep_other_sessions) });
    if (!r.ok) return resetPage(rc, r.problem);
    return redirect(rc, href(rc, "/login", { ok: "password_changed" }));
  }),
  page("/auth/step-up", async (rc) => {
    if (!rc.claims.sub) return redirect(rc, href(rc, "/login", { return: rc.query.get("return") ?? undefined }));
    return stepUpPage(rc, { mode: rc.query.get("mode") ?? undefined });
  }),
  action("/auth/step-up", (rc) => stepUpSubmit(rc, false)),
  page("/auth/reauth", async (rc) => {
    if (!rc.claims.sub) return redirect(rc, href(rc, "/login", { return: rc.query.get("return") ?? undefined }));
    return stepUpPage(rc, { mode: rc.query.get("mode") ?? undefined, reauth: true });
  }),
  action("/auth/reauth", (rc) => stepUpSubmit(rc, true)),
  page("/auth/confirm", (rc) => confirmTokenPage(rc, { title: rc.t("stepup.title"), lede: rc.t("stepup.lede"), action: "/auth/confirm", submit: rc.t("stepup.confirm_link") })),
  action("/auth/confirm", async (rc) => {
    if (!rc.claims.sub) return redirect(rc, href(rc, "/login", { return: `${rc.fullPath}?token=${encodeURIComponent(rc.form.token ?? "")}` }));
    const r = await rc.api.post("/api/v1/auth/step-up/verify", { method: "magic_link", token: rc.form.token ?? "" });
    if (!r.ok) return confirmTokenPage(rc, { title: rc.t("stepup.title"), lede: rc.t("stepup.lede"), action: "/auth/confirm", submit: rc.t("stepup.confirm_link"), problem: r.problem });
    return back(rc, "/", { ok: "stepped_up" });
  }),
  page("/auth/social/result", async (rc) => {
    const status = rc.query.get("status");
    const error = rc.query.get("error");
    const ret = rc.query.get("return_to");
    if (status === "connected") return back(rc, "/settings/security", { ok: "saved" });
    if (status === "signed_in") return redirect(rc, safeReturn(rc, ret));
    if (status === "mfa_required" && rc.query.get("mfa_token")) {
      return mfaPage(rc, { token: rc.query.get("mfa_token")!, methods: ["totp", "passkey", "recovery_code"], returnTo: ret });
    }
    return loginPage(rc, { problem: { status: 400, code: error ?? "PROVIDER_ERROR" } });
  }),
];

export const sharedAuthRoutes: PageRoute[] = [
  action("/logout", async (rc) => {
    await rc.api.post("/api/v1/auth/logout", {});
    return redirect(rc, rc.surface.name === "account" ? surfaceHref(rc, "account", "/login") : href(rc, "/"));
  }),
  page("/signed-out", (rc) => {
    const ret = rc.query.get("return") ?? rc.fullPath;
    return (
      <AuthLayout rc={rc} title={rc.t("app.sign_in")}>
        <LinkButton href={surfaceHref(rc, "account", "/auth/bind", { target: rc.surface.name, origin: rc.origin, return: ret })} block>
          {rc.t("app.sign_in")}
        </LinkButton>
        <LinkButton href={href(rc, "/")} kind="ghost" block>
          {rc.t("app.back")}
        </LinkButton>
      </AuthLayout>
    );
  }),
];
