import { raw } from "hono/html";
import type { Problem } from "../api.ts";
import { fieldErrors } from "../api.ts";
import { actions, attempt, back, page, redirect, unwrap, type PageRoute } from "../app.tsx";
import { href, requireUser, signedIn, surfaceHref, type RequestContext } from "../context.ts";
import { ActionForm, Alert, Captcha, Card, Empty, Field, LinkButton, PageHead, ProblemAlert, Select, StateBadge, Submit, TextArea, fmtDate, fmtDateTime, fmtRelative } from "../ui.tsx";
import { captchaValue, shell } from "./common.tsx";

interface Categories {
  tickets: boolean;
  guest_tickets: boolean;
  attachments: { max_bytes: number; max_per_message: number; allowed_types: string[] } | null;
  categories: { id: string; label: string; guest_allowed: boolean; appeal: boolean }[];
}

interface Ticket {
  id: string;
  number: number;
  category: string;
  category_label: string;
  subject: string;
  status: string;
  priority: string;
  appeal_id: string | null;
  rating: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  is_image: boolean;
}

interface Thread extends Ticket {
  messages: { id: string; author_type: string; body: string; internal: boolean; created_at: string; attachments: Attachment[] }[];
  can_rate: boolean;
}

interface ArticleSummary {
  id: string;
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  excerpt?: string;
}

function apiPath(rc: RequestContext, p: string): string {
  return `${rc.surface.apiPath}${p.replace(/^\/api/, "")}`;
}

function SearchBox({ rc, q }: { rc: RequestContext; q?: string | null }) {
  return (
    <form method="get" action={href(rc, "/search")} class="search-box" role="search">
      <input type="search" name="q" value={q ?? ""} placeholder={rc.t("support.search_placeholder")} aria-label={rc.t("app.search")} />
      <button type="submit" class="btn">
        {rc.t("app.search")}
      </button>
    </form>
  );
}

function ArticleList({ rc, items }: { rc: RequestContext; items: ArticleSummary[] }) {
  return (
    <div class="list">
      {items.map((a) => (
        <a class="item link-card" href={href(rc, `/kb/${a.slug}`)}>
          <div>
            <strong>{a.title}</strong>
            <div class="meta">{a.excerpt ?? a.summary}</div>
          </div>
        </a>
      ))}
    </div>
  );
}

async function helpHome(rc: RequestContext) {
  const f = await rc.features();
  const kb = f.features.support?.kb;
  const [cats, articles] = kb
    ? await Promise.all([rc.api.get<{ items: { id: string; slug: string; name: string; description: string; icon: string | null; article_count: number }[] }>("/api/v1/support/kb/categories"), rc.api.get<{ items: ArticleSummary[] }>("/api/v1/support/kb/articles", { limit: 12 })])
    : [null, null];
  return shell(
    rc,
    { title: rc.t("support.home_title"), active: "help" },
    <div class="stack-lg">
      <section class="hero">
        <h1>{rc.t("support.home_title")}</h1>
        {kb ? <SearchBox rc={rc} /> : null}
      </section>
      {cats && cats.ok && cats.data.items.length ? (
        <section class="stack">
          <h2>{rc.t("support.categories")}</h2>
          <div class="grid-3">
            {cats.data.items.map((c) => (
              <a class="card link-card" href={href(rc, `/kb/category/${c.slug}`)}>
                <h3>{c.name}</h3>
                <p class="muted">{c.description}</p>
                <span class="hint">{c.article_count}</span>
              </a>
            ))}
          </div>
        </section>
      ) : null}
      {articles && articles.ok && articles.data.items.length ? (
        <Card title={rc.t("support.popular")}>
          <ArticleList rc={rc} items={articles.data.items} />
        </Card>
      ) : null}
      {f.features.support?.tickets ? (
        <Card title={rc.t("support.contact")}>
          <p class="muted">{rc.t("support.contact_lede")}</p>
          <div class="row">
            <LinkButton href={signedIn(rc) ? href(rc, "/tickets/new") : surfaceHref(rc, "account", "/auth/bind", { target: rc.surface.name, origin: rc.origin, return: href(rc, "/tickets/new") })}>{rc.t("support.new_ticket")}</LinkButton>
            {f.features.support.guest_tickets && !signedIn(rc) ? (
              <LinkButton href={href(rc, "/guest")} kind="secondary">
                {rc.t("support.guest_title")}
              </LinkButton>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>,
  );
}

async function searchPage(rc: RequestContext) {
  const q = (rc.query.get("q") ?? "").trim();
  const r = q ? await rc.api.get<{ items: ArticleSummary[] }>("/api/v1/support/kb/search", { q }) : null;
  return shell(
    rc,
    { title: rc.t("app.search"), active: "help" },
    <div class="stack-lg">
      <PageHead title={rc.t("app.search")} crumbs={[{ href: href(rc, "/"), label: rc.t("nav.help") }]} />
      <SearchBox rc={rc} q={q} />
      {r && r.ok ? r.data.items.length ? <div class="card flush"><ArticleList rc={rc} items={r.data.items} /></div> : <Card><Empty title={rc.t("support.search_none", { q })} /></Card> : null}
    </div>,
  );
}

async function categoryPage(rc: RequestContext, slug: string) {
  const cats = unwrap(rc, await rc.api.get<{ items: { slug: string; name: string; description: string }[] }>("/api/v1/support/kb/categories"));
  const cat = cats.items.find((c) => c.slug === slug);
  if (!cat) return redirect(rc, href(rc, "/"));
  const r = unwrap(rc, await rc.api.get<{ items: ArticleSummary[] }>("/api/v1/support/kb/articles", { category: slug, limit: 100 }));
  return shell(
    rc,
    { title: cat.name, active: "help" },
    <div class="stack-lg">
      <PageHead title={cat.name} lede={cat.description} crumbs={[{ href: href(rc, "/"), label: rc.t("nav.help") }]} />
      {r.items.length ? <div class="card flush"><ArticleList rc={rc} items={r.items} /></div> : <Card><Empty title={rc.t("app.none")} /></Card>}
    </div>,
  );
}

async function articlePage(rc: RequestContext, slug: string, thanks = false) {
  const a = unwrap(rc, await rc.api.get<ArticleSummary & { html: string; updated_at: string; category: { slug: string; name: string } | null; related: { slug: string; title: string }[] }>(`/api/v1/support/kb/articles/${encodeURIComponent(slug)}`));
  const crumbs = [{ href: href(rc, "/"), label: rc.t("nav.help") }, ...(a.category ? [{ href: href(rc, `/kb/category/${a.category.slug}`), label: a.category.name }] : [])];
  return shell(
    rc,
    { title: a.title, active: "help" },
    <div class="stack-lg">
      <PageHead title={a.title} lede={fmtDate(rc, a.updated_at)} crumbs={crumbs} />
      <article class="card prose">{raw(a.html)}</article>
      <Card>
        {thanks ? (
          <p>{rc.t("support.helpful_thanks")}</p>
        ) : (
          <ActionForm action={rc.fullPath} name="feedback" class="row">
            <span>{rc.t("support.helpful")}</span>
            <Submit kind="secondary" small name="helpful" value="yes">
              {rc.t("support.helpful_yes")}
            </Submit>
            <Submit kind="secondary" small name="helpful" value="no">
              {rc.t("support.helpful_no")}
            </Submit>
          </ActionForm>
        )}
      </Card>
      {a.related.length ? (
        <Card title={rc.t("support.related")}>
          <ul>
            {a.related.map((r) => (
              <li>
                <a href={href(rc, `/kb/${r.slug}`)}>{r.title}</a>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>,
  );
}

async function myTickets(rc: RequestContext) {
  requireUser(rc, { restricted: true, legal: true });
  const r = unwrap(rc, await rc.api.get<{ items: Ticket[] }>("/api/v1/support/tickets"));
  return shell(
    rc,
    { title: rc.t("nav.tickets"), active: "tickets" },
    <div class="stack-lg">
      <PageHead title={rc.t("nav.tickets")} actions={<LinkButton href={href(rc, "/tickets/new")}>{rc.t("support.new_ticket")}</LinkButton>} />
      {r.items.length ? (
        <div class="card flush">
          <div class="table-wrap">
            <table class="table">
              <tbody>
                {r.items.map((t) => (
                  <tr>
                    <td class="mono">#{t.number}</td>
                    <td>
                      <a class="row-link" href={href(rc, `/tickets/${t.number}`)}>
                        {t.subject}
                      </a>
                      <div class="hint">{t.category_label}</div>
                    </td>
                    <td>
                      <StateBadge rc={rc} state={t.status} />
                    </td>
                    <td class="muted">{fmtRelative(rc, t.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <Card>
          <Empty title={rc.t("support.tickets_none")} />
        </Card>
      )}
    </div>,
  );
}

async function newTicket(rc: RequestContext, problem?: Problem | null) {
  requireUser(rc, { restricted: true, legal: true });
  const cats = unwrap(rc, await rc.api.get<Categories>("/api/v1/support/categories"));
  const restricted = rc.claims.state === "locked" || rc.claims.state === "banned";
  const errs = fieldErrors(problem);
  const options = cats.categories.filter((c) => !c.appeal).map((c) => ({ value: c.id, label: c.label }));
  return shell(
    rc,
    { title: rc.t("support.new_ticket"), active: "tickets" },
    <div class="stack-lg">
      <PageHead title={rc.t("support.new_ticket")} crumbs={[{ href: href(rc, "/tickets"), label: rc.t("nav.tickets") }]} />
      {cats.categories.some((c) => c.appeal) ? (
        <Alert kind={restricted ? "warning" : "info"}>
          <a href={surfaceHref(rc, "account", "/safety")}>{rc.t("safety.appeal_title")}</a>
        </Alert>
      ) : null}
      {restricted ? null : (
        <Card>
          <ProblemAlert rc={rc} problem={problem} />
          <ActionForm action={href(rc, "/tickets/new")} name="create">
            <Select name="category" label={rc.t("support.category")} options={options} value={rc.form.category} required placeholder="–" error={errs.category} />
            <div class="field">
              <label for="f-subject">{rc.t("support.subject")}</label>
              <input id="f-subject" name="subject" type="text" required maxlength={200} value={rc.form.subject ?? ""} data-suggest={apiPath(rc, "/api/v1/support/kb/suggest")} data-suggest-target="suggestions" data-suggest-base={rc.surface.basePath === "/" ? "" : rc.surface.basePath} />
              {errs.subject ? <span class="field-error">{errs.subject}</span> : null}
            </div>
            <div id="suggestions" class="alert info" hidden data-title={rc.t("support.suggest")} />
            <TextArea name="body" label={rc.t("support.message")} required rows={8} maxlength={20000} value={rc.form.body} error={errs.body} />
            <div>
              <Submit>{rc.t("support.send")}</Submit>
            </div>
          </ActionForm>
        </Card>
      )}
    </div>,
  );
}

function Message({ rc, m, number, guest }: { rc: RequestContext; m: Thread["messages"][number]; number: number; guest?: string }) {
  if (m.author_type === "system") return <div class="msg system">{m.body}</div>;
  const staff = m.author_type === "staff";
  return (
    <div class={staff ? "msg staff" : "msg"}>
      <div class="msg-head">
        <strong>{staff ? rc.t("support.from_staff") : rc.t("support.from_you")}</strong>
        <span>{fmtDateTime(rc, m.created_at)}</span>
      </div>
      <div class="msg-body">{m.body}</div>
      {m.attachments.length && !guest ? (
        <ul>
          {m.attachments.map((a) => (
            <li>
              <a href={href(rc, `/tickets/${number}/attachments/${a.id}`)}>{a.filename}</a> <span class="hint">{Math.ceil(a.size / 1024)} KB</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function UploadInput({ rc, start, extra }: { rc: RequestContext; start: string; extra?: Record<string, string> }) {
  if (rc.cfg.storage.public_endpoint ?? rc.cfg.storage.endpoint) rc.cspHosts.push(new URL(rc.cfg.storage.public_endpoint ?? rc.cfg.storage.endpoint!).origin);
  return (
    <div class="field js-only">
      <label for="f-files">{rc.t("ui.attachments")}</label>
      <input id="f-files" type="file" multiple data-upload={start} data-upload-list="upload-list" data-upload-extra={JSON.stringify(extra ?? {})} />
      <ul id="upload-list" class="hint" />
    </div>
  );
}

async function threadPage(rc: RequestContext, number: string, problem?: Problem | null) {
  requireUser(rc, { restricted: true, legal: true });
  const [t, cats] = await Promise.all([rc.api.get<Thread>(`/api/v1/support/tickets/${encodeURIComponent(number)}`), rc.api.get<Categories>("/api/v1/support/categories")]);
  const ticket = unwrap(rc, t);
  const action = href(rc, `/tickets/${number}`);
  return shell(
    rc,
    { title: `#${ticket.number} ${ticket.subject}`, active: "tickets" },
    <div class="stack-lg">
      <PageHead title={ticket.subject} lede={`#${ticket.number} · ${ticket.category_label}`} crumbs={[{ href: href(rc, "/tickets"), label: rc.t("nav.tickets") }]} actions={<StateBadge rc={rc} state={ticket.status} />} />
      <ProblemAlert rc={rc} problem={problem} />
      <div class="thread">
        {ticket.messages.map((m) => (
          <Message rc={rc} m={m} number={ticket.number} />
        ))}
      </div>
      {ticket.status !== "closed" ? (
        <Card>
          <ActionForm action={action} name="reply">
            <TextArea name="body" label={rc.t("support.reply")} required rows={5} maxlength={20000} />
            {cats.ok && cats.data.attachments ? <UploadInput rc={rc} start={apiPath(rc, `/api/v1/support/tickets/${ticket.number}/attachments`)} /> : null}
            <div class="row between">
              <Submit>{rc.t("support.send")}</Submit>
            </div>
          </ActionForm>
          <hr />
          <ActionForm action={action} name="close" class="row" confirm={rc.t("app.confirm")}>
            <Submit kind="ghost" small>
              {rc.t("support.close")}
            </Submit>
          </ActionForm>
        </Card>
      ) : (
        <Card>
          {ticket.can_rate ? (
            <ActionForm action={action} name="rate" class="row">
              <span>{rc.t("support.rate")}</span>
              {[1, 2, 3, 4, 5].map((n) => (
                <Submit kind="secondary" small name="rating" value={String(n)}>
                  {"★".repeat(n)}
                </Submit>
              ))}
            </ActionForm>
          ) : ticket.rating ? (
            <p class="muted">{rc.t("support.rate_thanks")}</p>
          ) : null}
          {ticket.appeal_id ? null : (
            <ActionForm action={action} name="reopen" class="row">
              <Submit kind="secondary" small>
                {rc.t("support.reopen")}
              </Submit>
            </ActionForm>
          )}
        </Card>
      )}
    </div>,
  );
}

async function guestStart(rc: RequestContext, o: { problem?: Problem | null; email?: string } = {}) {
  const cats = unwrap(rc, await rc.api.get<Categories>("/api/v1/support/categories"));
  const options = cats.categories.filter((c) => c.guest_allowed && !c.appeal).map((c) => ({ value: c.id, label: c.label }));
  const errs = fieldErrors(o.problem);
  return shell(
    rc,
    { title: rc.t("support.guest_title"), active: "help" },
    <div class="stack-lg">
      <PageHead title={rc.t("support.guest_title")} lede={rc.t("support.guest_lede")} crumbs={[{ href: href(rc, "/"), label: rc.t("nav.help") }]} />
      <Card>
        <ProblemAlert rc={rc} problem={o.problem} />
        {o.email ? (
          <ActionForm action={href(rc, "/guest")} name="create" fields={{ email: o.email }}>
            <Alert kind="info">{rc.t("support.guest_code_sent", { email: o.email })}</Alert>
            <Field name="code" label={rc.t("support.guest_code")} inputmode="numeric" pattern="[0-9]{6}" class="code-input" required autofocus />
            <Select name="category" label={rc.t("support.category")} options={options} value={rc.form.category} required placeholder="–" />
            <Field name="subject" label={rc.t("support.subject")} required maxlength={200} value={rc.form.subject} error={errs.subject} />
            <TextArea name="body" label={rc.t("support.message")} required rows={8} value={rc.form.body} error={errs.body} />
            <Captcha rc={rc} problem={o.problem} />
            <div>
              <Submit>{rc.t("support.send")}</Submit>
            </div>
          </ActionForm>
        ) : (
          <ActionForm action={href(rc, "/guest")} name="start">
            <Field name="email" label={rc.t("signup.email")} type="email" required autofocus value={rc.form.email} />
            <Captcha rc={rc} problem={o.problem} />
            <div>
              <Submit>{rc.t("app.continue")}</Submit>
            </div>
          </ActionForm>
        )}
      </Card>
    </div>,
  );
}

async function guestThread(rc: RequestContext, number: string, problem?: Problem | null) {
  const token = rc.query.get("token") ?? rc.form.token ?? "";
  const t = unwrap(rc, await rc.api.get<Thread>(`/api/v1/support/guest/tickets/${encodeURIComponent(number)}`, { token }));
  return shell(
    rc,
    { title: `#${t.number} ${t.subject}`, active: "help" },
    <div class="stack-lg">
      <PageHead title={t.subject} lede={`#${t.number} · ${t.category_label}`} actions={<StateBadge rc={rc} state={t.status} />} />
      <ProblemAlert rc={rc} problem={problem} />
      <div class="thread">
        {t.messages.map((m) => (
          <Message rc={rc} m={m} number={t.number} guest={token} />
        ))}
      </div>
      {t.status !== "closed" ? (
        <Card>
          <ActionForm action={href(rc, `/guest/tickets/${number}`)} name="reply" fields={{ token }}>
            <TextArea name="body" label={rc.t("support.reply")} required rows={5} />
            <div>
              <Submit>{rc.t("support.send")}</Submit>
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </div>,
  );
}

export const supportPublicRoutes: PageRoute[] = [
  page("/", (rc) => helpHome(rc)),
  page("/search", (rc) => searchPage(rc)),
  page("/kb/category/:slug", (rc, p) => categoryPage(rc, p.slug!)),
  page("/kb/:slug", (rc, p) => articlePage(rc, p.slug!, rc.query.get("ok") === "done")),
  actions("/kb/:slug", {
    feedback: async (rc, p) => {
      await rc.api.post(`/api/v1/support/kb/articles/${encodeURIComponent(p.slug!)}/feedback`, { helpful: rc.form.helpful === "yes" });
      return back(rc, `/kb/${p.slug}`, { ok: "done" });
    },
  }),
  page("/tickets", (rc) => myTickets(rc)),
  page("/tickets/new", (rc) => newTicket(rc)),
  actions("/tickets/new", {
    create: async (rc) => {
      const r = attempt(rc, await rc.api.post<Ticket>("/api/v1/support/tickets", { category: rc.form.category ?? "", subject: (rc.form.subject ?? "").trim(), body: (rc.form.body ?? "").trim() }));
      return r.ok ? back(rc, `/tickets/${r.data.number}`, { ok: "ticket_created" }) : newTicket(rc, r.problem);
    },
  }),
  page("/tickets/:number/attachments/:aid", async (rc, p) => {
    requireUser(rc, { restricted: true, legal: true });
    const r = unwrap(rc, await rc.api.get<{ url: string }>(`/api/v1/support/tickets/${encodeURIComponent(p.number!)}/attachments/${encodeURIComponent(p.aid!)}`));
    return redirect(rc, r.url);
  }),
  page("/tickets/:number", (rc, p) => threadPage(rc, p.number!)),
  actions("/tickets/:number", {
    reply: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/support/tickets/${encodeURIComponent(p.number!)}/replies`, { body: (rc.form.body ?? "").trim(), attachment_ids: rc.formAll.attachment_ids ?? [] }));
      return r.ok ? back(rc, `/tickets/${p.number}`, { ok: "ticket_replied" }) : threadPage(rc, p.number!, r.problem);
    },
    close: async (rc, p) => {
      unwrap(rc, await rc.api.post(`/api/v1/support/tickets/${encodeURIComponent(p.number!)}/close`, {}));
      return back(rc, `/tickets/${p.number}`, { ok: "ticket_closed" });
    },
    reopen: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/support/tickets/${encodeURIComponent(p.number!)}/reopen`, {}));
      return r.ok ? back(rc, `/tickets/${p.number}`, { ok: "ticket_reopened" }) : threadPage(rc, p.number!, r.problem);
    },
    rate: async (rc, p) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/support/tickets/${encodeURIComponent(p.number!)}/rating`, { rating: Number(rc.form.rating ?? 0) }));
      return r.ok ? back(rc, `/tickets/${p.number}`) : threadPage(rc, p.number!, r.problem);
    },
  }),
  page("/guest", (rc) => guestStart(rc)),
  actions("/guest", {
    start: async (rc) => {
      const email = (rc.form.email ?? "").trim();
      const r = await rc.api.post("/api/v1/support/guest/start", { email, captcha: captchaValue(rc) });
      return r.ok ? guestStart(rc, { email }) : guestStart(rc, { problem: r.problem });
    },
    create: async (rc) => {
      const email = rc.form.email ?? "";
      const r = await rc.api.post<{ number: number }>("/api/v1/support/guest/tickets", { email, code: (rc.form.code ?? "").trim(), category: rc.form.category ?? "", subject: (rc.form.subject ?? "").trim(), body: (rc.form.body ?? "").trim(), captcha: captchaValue(rc) });
      if (!r.ok) return guestStart(rc, { problem: r.problem, email });
      return shell(
        rc,
        { title: rc.t("support.guest_title"), active: "help" },
        <Card>
          <Alert kind="success">{rc.t("support.guest_created", { number: r.data.number })}</Alert>
        </Card>,
      );
    },
  }),
  page("/guest/tickets/:number", (rc, p) => guestThread(rc, p.number!)),
  actions("/guest/tickets/:number", {
    reply: async (rc, p) => {
      const token = rc.form.token ?? "";
      const r = await rc.api.post(`/api/v1/support/guest/tickets/${encodeURIComponent(p.number!)}/replies`, { token, body: (rc.form.body ?? "").trim() });
      return r.ok ? redirect(rc, href(rc, `/guest/tickets/${p.number}`, { token, ok: "ticket_replied" })) : guestThread(rc, p.number!, r.problem);
    },
  }),
];
