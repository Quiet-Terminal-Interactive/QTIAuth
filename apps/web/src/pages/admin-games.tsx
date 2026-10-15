import type { Problem } from "../api.ts";
import { actions, attempt, back, page, redirect, render, unwrap, type PageRoute } from "../app.tsx";
import { can, href, requirePermission, type RequestContext } from "../context.ts";
import { ActionForm, Alert, Badge, Card, Check, Empty, Field, LinkButton, PageHead, ProblemAlert, Select, StateBadge, Submit, TextArea, fmtDate, stateLabel } from "../ui.tsx";
import { ReasonForm, adminShell } from "./admin.tsx";

interface AdminGame {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  icon_url: string | null;
  settings: Record<string, unknown>;
  require_game_authority?: boolean;
  client_id: string | null;
  server_client_id: string | null;
  products?: { id: string; sku: string; name: string; kind: string; retired_at: string | null }[];
  achievements?: { id: string; key: string; name: string; points: number; hidden: boolean; progress_target: number | null; rarity_percent: number | null }[];
  stats?: { id: string; key: string; name: string; type: string; aggregation: string; authority: string; max_delta: number | null }[];
  leaderboards?: { id: string; key: string; name: string; sort: string; reset_period: string; stat_key?: string }[];
}

const STATUSES = ["draft", "hidden", "early_access", "released", "archived"];

function enc(v: string): string {
  return encodeURIComponent(v);
}

async function gamesList(rc: RequestContext, o: { problem?: Problem | null } = {}) {
  requirePermission(rc, "games.catalog.edit");
  const r = unwrap(rc, await rc.api.get<{ items: AdminGame[] }>("/api/v1/admin/games"));
  return adminShell(
    rc,
    "games",
    rc.t("nav.admin_games"),
    <>
      <PageHead title={rc.t("nav.admin_games")} />
      <ProblemAlert rc={rc} problem={o.problem} />
      {r.items.length ? (
        <div class="card flush">
          <div class="list">
            {r.items.map((g) => (
              <a class="item link-card" href={href(rc, `/admin/games/${g.slug}`)}>
                <div>
                  <strong>{g.name}</strong>
                  <div class="meta mono">{g.slug}</div>
                </div>
                <StateBadge rc={rc} state={g.status} />
              </a>
            ))}
          </div>
        </div>
      ) : (
        <Card>
          <Empty title={rc.t("app.none")} />
        </Card>
      )}
      <Card title={<h3>{rc.t("ui.new_game")}</h3>}>
        <ActionForm action={href(rc, "/admin/games")} name="create">
          <div class="grid-2">
            <Field name="name" label={rc.t("security.passkey_name")} required />
            <Field name="slug" label={rc.t("ui.slug")} required pattern="[a-z0-9]+(-[a-z0-9]+)*" />
          </div>
          <TextArea name="description" label={rc.t("ui.description")} rows={3} />
          <div>
            <Submit>{rc.t("app.save")}</Submit>
          </div>
        </ActionForm>
      </Card>
    </>,
  );
}

function SecretNotice({ rc, secret, clientId }: { rc: RequestContext; secret: string; clientId: string }) {
  return (
    <Alert kind="warning" title={rc.t("developer.secret_once")}>
      <dl class="kv">
        <dt>client_id</dt>
        <dd class="mono">{clientId}</dd>
        <dt>client_secret</dt>
        <dd class="mono secret">{secret}</dd>
      </dl>
    </Alert>
  );
}

async function gameDetail(rc: RequestContext, slug: string, o: { problem?: Problem | null; secret?: { secret: string; client_id: string } } = {}) {
  requirePermission(rc, "games.catalog.edit");
  const g = unwrap(rc, await rc.api.get<AdminGame>(`/api/v1/admin/games/${enc(slug)}`));
  const batches = can(rc, "games.keys.manage") ? await rc.api.get<{ items: { id: string; label: string; sku: string; count: number; redeemed: number; created_at: string; exported_at: string | null; revoked_at: string | null }[] }>(`/api/v1/admin/games/${enc(slug)}/key-batches`) : null;
  const path = href(rc, `/admin/games/${slug}`);
  const s = g.settings as { lease_duration_ms?: number | null; device_binding?: boolean; max_devices?: number | null; cloud_slots?: number | null; require_game_authority?: boolean | null; redirect_uris?: string[] };
  return adminShell(
    rc,
    "games",
    g.name,
    <>
      <PageHead title={g.name} lede={<span class="mono">{g.slug}</span>} crumbs={[{ href: href(rc, "/admin/games"), label: rc.t("nav.admin_games") }]} actions={<StateBadge rc={rc} state={g.status} />} />
      <ProblemAlert rc={rc} problem={o.problem} />
      {o.secret ? <SecretNotice rc={rc} secret={o.secret.secret} clientId={o.secret.client_id} /> : null}
      <div class="grid-2">
        <Card title={<h3>{rc.t("safety.description")}</h3>}>
          <ActionForm action={path} name="update">
            <Field name="name" label={rc.t("security.passkey_name")} value={g.name} required />
            <TextArea name="description" label={rc.t("ui.description")} rows={3} value={g.description} />
            <Select name="status" label={rc.t("staff.status")} value={g.status} options={STATUSES.map((x) => ({ value: x, label: stateLabel(rc, x) }))} />
            <Field name="icon_url" label={rc.t("ui.icon_url")} type="url" value={g.icon_url ?? undefined} />
            <TextArea name="redirect_uris" label={rc.t("ui.player_client_redirect_uris")} rows={2} value={(s.redirect_uris ?? []).join("\n")} />
            <div class="grid-2">
              <Field name="lease_duration" label={rc.t("ui.lease_duration_e_g_20d")} value={s.lease_duration_ms ? `${Math.round(s.lease_duration_ms / 86_400_000)}d` : ""} />
              <Field name="max_devices" label={rc.t("ui.max_devices")} type="number" min={1} value={s.max_devices ? String(s.max_devices) : ""} />
            </div>
            <Check name="device_binding" label={rc.t("ui.bind_leases_to_devices")} checked={Boolean(s.device_binding)} />
            <Select name="require_game_authority" label={rc.t("ui.leaderboards_need_game_authority")} value={s.require_game_authority === null || s.require_game_authority === undefined ? "" : String(s.require_game_authority)} options={[{ value: "", label: rc.t("ui.default_value", { value: g.require_game_authority ? rc.t("app.yes") : rc.t("app.no") }) }, { value: "true", label: rc.t("app.yes") }, { value: "false", label: rc.t("app.no") }]} />
            <div>
              <Submit>{rc.t("app.save")}</Submit>
            </div>
          </ActionForm>
        </Card>
        <div class="stack">
          <Card title={<h3>{rc.t("ui.clients")}</h3>}>
            <dl class="kv">
              <dt>{rc.t("ui.player")}</dt>
              <dd class="mono">{g.client_id ?? "–"}</dd>
              <dt>{rc.t("ui.server")}</dt>
              <dd class="mono">{g.server_client_id ?? "–"}</dd>
            </dl>
            {g.server_client_id ? (
              <ActionForm action={path} name="rotate" class="row" confirm={rc.t("app.confirm")}>
                <Submit kind="secondary" small>
                  {rc.t("ui.rotate_server_secret")}
                </Submit>
              </ActionForm>
            ) : null}
          </Card>
          <Card title={<h3>{rc.t("ui.products")}</h3>}>
            <div class="list">
              {(g.products ?? []).map((p) => (
                <div class="item">
                  <span>
                    {p.name} <Badge>{p.kind}</Badge> {p.retired_at ? <Badge color="red">{stateLabel(rc, "retired")}</Badge> : null}
                  </span>
                  <span class="mono hint">{p.sku}</span>
                </div>
              ))}
            </div>
            <ActionForm action={path} name="product" class="row">
              <Field name="sku" label={rc.t("ui.sku")} required pattern="[a-z0-9]+(-[a-z0-9]+)*" />
              <Field name="name" label={rc.t("security.passkey_name")} required />
              <Select name="kind" label={rc.t("ui.kind")} options={["dlc", "edition", "beta_access", "soundtrack", "other"].map((k) => ({ value: k, label: stateLabel(rc, k) }))} />
              <Submit kind="secondary">{rc.t("ui.add")}</Submit>
            </ActionForm>
          </Card>
        </div>
      </div>
      <Card title={<h3>{rc.t("games.achievements")}</h3>}>
        <div class="table-wrap">
          <table class="table">
            <tbody>
              {(g.achievements ?? []).map((a) => (
                <tr>
                  <td class="mono">{a.key}</td>
                  <td>
                    {a.name} {a.hidden ? <Badge>{stateLabel(rc, "hidden")}</Badge> : null}
                  </td>
                  <td class="num">{a.points}</td>
                  <td class="num">{a.progress_target ?? ""}</td>
                  <td class="num">{a.rarity_percent ?? ""}</td>
                  <td>
                    <ActionForm action={path} name="delete_achievement" class="inline-form" fields={{ id: a.id }} confirm={rc.t("app.confirm")}>
                      <Submit kind="danger-ghost" small>
                        {rc.t("app.delete")}
                      </Submit>
                    </ActionForm>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ActionForm action={path} name="achievement">
          <div class="grid-3">
            <Field name="key" label={rc.t("ui.key")} required />
            <Field name="name" label={rc.t("security.passkey_name")} required />
            <Field name="points" label={rc.t("ui.points")} type="number" value="10" />
            <Field name="progress_target" label={rc.t("ui.progress_target")} type="number" min={1} />
          </div>
          <Field name="description" label={rc.t("ui.description")} />
          <Check name="hidden" label={rc.t("ui.hidden_until_unlocked")} />
          <div>
            <Submit kind="secondary">{rc.t("ui.add_achievement")}</Submit>
          </div>
        </ActionForm>
      </Card>
      <div class="grid-2">
        <Card title={<h3>{rc.t("games.stats")}</h3>}>
          <div class="list">
            {(g.stats ?? []).map((st) => (
              <div class="item">
                <span>
                  <code>{st.key}</code> {st.name}
                </span>
                <span>
                  <Badge>{st.aggregation}</Badge> <Badge color={st.authority === "game" ? "purple" : "neutral"}>{st.authority}</Badge>
                </span>
              </div>
            ))}
          </div>
          <ActionForm action={path} name="stat">
            <div class="grid-2">
              <Field name="key" label={rc.t("ui.key")} required />
              <Field name="name" label={rc.t("security.passkey_name")} required />
              <Select name="type" label={rc.t("ui.type")} options={["int", "float", "duration"].map((x) => ({ value: x, label: stateLabel(rc, x) }))} />
              <Select name="aggregation" label={rc.t("ui.aggregation")} options={["sum", "max", "min", "latest"].map((x) => ({ value: x, label: stateLabel(rc, x) }))} />
              <Select name="authority" label={rc.t("ui.authority")} options={[{ value: "player", label: rc.t("ui.authority_player") }, { value: "game", label: rc.t("ui.authority_game") }]} />
              <Field name="max_delta" label={rc.t("ui.max_delta")} type="number" />
            </div>
            <div>
              <Submit kind="secondary">{rc.t("ui.add_stat")}</Submit>
            </div>
          </ActionForm>
        </Card>
        <Card title={<h3>{rc.t("games.leaderboards")}</h3>}>
          <div class="list">
            {(g.leaderboards ?? []).map((l) => (
              <div class="item">
                <span>
                  <code>{l.key}</code> {l.name}
                </span>
                <span class="meta">
                  {l.stat_key} · {l.sort} · {l.reset_period}
                </span>
              </div>
            ))}
          </div>
          <ActionForm action={path} name="leaderboard">
            <div class="grid-2">
              <Field name="key" label={rc.t("ui.key")} required />
              <Field name="name" label={rc.t("security.passkey_name")} required />
              <Select name="stat_key" label={rc.t("ui.stat")} options={(g.stats ?? []).map((st) => ({ value: st.key, label: `${st.key} (${st.authority})` }))} />
              <Select name="sort" label={rc.t("ui.sort")} options={[{ value: "desc", label: rc.t("ui.sort_desc") }, { value: "asc", label: rc.t("ui.sort_asc") }]} />
              <Field name="reset_period" label={rc.t("ui.reset")} value="never" hint={rc.t("ui.never_daily_weekly_monthly_or_season_id")} />
            </div>
            <div>
              <Submit kind="secondary">{rc.t("ui.add_leaderboard")}</Submit>
            </div>
          </ActionForm>
        </Card>
      </div>
      {batches && batches.ok ? (
        <Card title={<h3>{rc.t("ui.key_batches")}</h3>}>
          <div class="table-wrap">
            <table class="table">
              <tbody>
                {batches.data.items.map((b) => (
                  <tr>
                    <td>{b.label}</td>
                    <td class="mono">{b.sku}</td>
                    <td class="num">
                      {b.redeemed}/{b.count}
                    </td>
                    <td class="muted">{fmtDate(rc, b.created_at)}</td>
                    <td>
                      {b.revoked_at ? (
                        <Badge color="red">{stateLabel(rc, "revoked")}</Badge>
                      ) : (
                        <div class="row">
                          <LinkButton href={href(rc, `/admin/games/batches/${b.id}/export`)} kind="secondary" small>
                            {rc.t("ui.csv")}
                          </LinkButton>
                          <details>
                            <summary>{rc.t("ui.revoke")}</summary>
                            <ReasonForm rc={rc} action={path} name="revoke_batch" label={rc.t("ui.revoke_batch")} kind="danger" fields={{ id: b.id }}>
                              <Check name="revoke_entitlements" label={rc.t("ui.also_revoke_entitlements_granted_from_it")} />
                            </ReasonForm>
                          </details>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ActionForm action={path} name="batch" class="row">
            <Select name="sku" label={rc.t("ui.product")} options={(g.products ?? []).map((p) => ({ value: p.sku, label: p.name }))} />
            <Field name="count" label={rc.t("ui.count")} type="number" min={1} value="10" required />
            <Field name="label" label={rc.t("ui.label")} required placeholder="press" />
            <Submit kind="secondary">{rc.t("ui.generate")}</Submit>
          </ActionForm>
        </Card>
      ) : null}
    </>,
  );
}

async function entitlements(rc: RequestContext, problem?: Problem | null) {
  requirePermission(rc, "games.entitlements.grant");
  const userId = rc.query.get("user_id") ?? rc.form.user_id ?? "";
  const r = userId ? await rc.api.get<{ items: { id: string; game_slug: string; game_name: string; product_name: string; sku: string; source: string; granted_at: string; expires_at: string | null; revoked_at: string | null; revoke_reason: string | null }[] }>("/api/v1/admin/games/entitlements", { user_id: userId }) : null;
  const path = href(rc, "/admin/games/entitlements");
  return adminShell(
    rc,
    "entitlements",
    rc.t("nav.admin_entitlements"),
    <>
      <PageHead title={rc.t("nav.admin_entitlements")} />
      <ProblemAlert rc={rc} problem={problem ?? (r && !r.ok ? r.problem : null)} />
      <form method="get" action={path} class="row">
        <input name="user_id" value={userId} placeholder={rc.t("safety.user_id")} class="grow mono" />
        <button class="btn secondary">{rc.t("app.search")}</button>
      </form>
      {r && r.ok ? (
        <>
          <div class="card flush">
            <div class="list">
              {r.data.items.map((e) => (
                <div class="item">
                  <div>
                    <strong>{e.game_name}</strong> · {e.product_name} <Badge>{e.source}</Badge> {e.revoked_at ? <Badge color="red">{stateLabel(rc, "revoked")}</Badge> : null}
                    <div class="meta">
                      {fmtDate(rc, e.granted_at)}
                      {e.expires_at ? ` → ${fmtDate(rc, e.expires_at)}` : ""}
                      {e.revoke_reason ? ` · ${e.revoke_reason}` : ""}
                    </div>
                  </div>
                  {e.revoked_at ? null : (
                    <details>
                      <summary>{rc.t("ui.revoke")}</summary>
                      <ReasonForm rc={rc} action={path} name="revoke" label={rc.t("ui.revoke")} kind="danger" fields={{ id: e.id, user_id: userId }} />
                    </details>
                  )}
                </div>
              ))}
            </div>
            {r.data.items.length ? null : <Empty title={rc.t("app.none")} />}
          </div>
          <Card title={<h3>{rc.t("ui.grant")}</h3>}>
            <ReasonForm rc={rc} action={path} name="grant" label={rc.t("ui.grant")} fields={{ user_id: userId }}>
              <div class="grid-2">
                <Field name="sku" label={rc.t("ui.sku")} required />
                <Field name="expires_at" label={rc.t("ui.expires")} type="datetime-local" />
              </div>
            </ReasonForm>
          </Card>
          <div class="grid-2">
            {can(rc, "games.licensing.manage") ? (
              <Card title={<h3>{rc.t("ui.revoke_licence_leases")}</h3>}>
                <ReasonForm rc={rc} action={path} name="leases" label={rc.t("ui.revoke_leases")} kind="danger-ghost" fields={{ user_id: userId }}>
                  <Field name="slug" label={rc.t("ui.game_slug_empty_for_all")} />
                </ReasonForm>
              </Card>
            ) : null}
            {can(rc, "games.achievements.moderate") || can(rc, "games.leaderboards.moderate") ? (
              <Card title={<h3>{rc.t("ui.cheating")}</h3>}>
                <div class="stack">
                  {can(rc, "games.achievements.moderate") ? (
                    <ReasonForm rc={rc} action={path} name="revoke_achievement" label={rc.t("ui.revoke_achievement")} fields={{ user_id: userId }}>
                      <div class="grid-2">
                        <Field name="slug" label={rc.t("ui.game_slug")} required />
                        <Field name="key" label={rc.t("ui.achievement_key")} required />
                      </div>
                    </ReasonForm>
                  ) : null}
                  {can(rc, "games.leaderboards.moderate") ? (
                    <ReasonForm rc={rc} action={path} name="remove_entry" label={rc.t("ui.remove_leaderboard_entry")} fields={{ user_id: userId }}>
                      <div class="grid-2">
                        <Field name="slug" label={rc.t("ui.game_slug")} required />
                        <Field name="key" label={rc.t("ui.leaderboard_key")} required />
                      </div>
                    </ReasonForm>
                  ) : null}
                </div>
              </Card>
            ) : null}
          </div>
        </>
      ) : null}
    </>,
  );
}

function settingsBody(rc: RequestContext) {
  const ra = rc.form.require_game_authority;
  return {
    name: rc.form.name?.trim() || undefined,
    description: rc.form.description ?? undefined,
    status: rc.form.status || undefined,
    icon_url: rc.form.icon_url?.trim() || null,
    settings: {
      lease_duration: rc.form.lease_duration?.trim() || null,
      max_devices: rc.form.max_devices ? Number(rc.form.max_devices) : null,
      device_binding: Boolean(rc.form.device_binding),
      require_game_authority: ra === "true" ? true : ra === "false" ? false : null,
      redirect_uris: (rc.form.redirect_uris ?? "")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean),
    },
  };
}

function gameAction(fn: (rc: RequestContext, slug: string) => Promise<{ ok: boolean; problem?: Problem }>) {
  return async (rc: RequestContext, p: Record<string, string>) => {
    const r = await fn(rc, p.slug!);
    return r.ok ? back(rc, `/admin/games/${p.slug}`, { ok: "saved" }) : gameDetail(rc, p.slug!, { problem: r.problem });
  };
}

export const adminGamesRoutes: PageRoute[] = [
  page("/admin/games", (rc) => gamesList(rc)),
  actions("/admin/games", {
    create: async (rc) => {
      const r = attempt(rc, await rc.api.post<{ slug: string; server_secret: string | null; server_client_id: string | null }>("/api/v1/admin/games", { slug: (rc.form.slug ?? "").trim(), name: (rc.form.name ?? "").trim(), description: rc.form.description ?? "" }));
      if (!r.ok) return gamesList(rc, { problem: r.problem });
      return r.data.server_secret ? gameDetail(rc, r.data.slug, { secret: { secret: r.data.server_secret, client_id: r.data.server_client_id ?? "" } }) : redirect(rc, href(rc, `/admin/games/${r.data.slug}`));
    },
  }),
  page("/admin/games/entitlements", (rc) => entitlements(rc)),
  actions("/admin/games/entitlements", {
    grant: async (rc) => {
      const r = attempt(rc, await rc.api.post("/api/v1/admin/games/entitlements", { user_id: rc.form.user_id ?? "", sku: rc.form.sku ?? "", expires_at: rc.form.expires_at ? new Date(rc.form.expires_at).toISOString() : null, reason: rc.form.reason ?? "" }));
      return r.ok ? redirect(rc, href(rc, "/admin/games/entitlements", { user_id: rc.form.user_id, ok: "saved" })) : entitlements(rc, r.problem);
    },
    revoke: async (rc) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/games/entitlements/${enc(rc.form.id ?? "")}/revoke`, { reason: rc.form.reason ?? "" }));
      return r.ok ? redirect(rc, href(rc, "/admin/games/entitlements", { user_id: rc.form.user_id, ok: "done" })) : entitlements(rc, r.problem);
    },
    leases: async (rc) => {
      const r = attempt(rc, await rc.api.post("/api/v1/admin/games/licensing/revoke", { user_id: rc.form.user_id ?? "", slug: rc.form.slug?.trim() || undefined, reason: rc.form.reason ?? "" }));
      return r.ok ? redirect(rc, href(rc, "/admin/games/entitlements", { user_id: rc.form.user_id, ok: "done" })) : entitlements(rc, r.problem);
    },
    revoke_achievement: async (rc) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/games/${enc(rc.form.slug ?? "")}/achievements/${enc(rc.form.key ?? "")}/revoke`, { user_id: rc.form.user_id ?? "", reason: rc.form.reason ?? "" }));
      return r.ok ? redirect(rc, href(rc, "/admin/games/entitlements", { user_id: rc.form.user_id, ok: "done" })) : entitlements(rc, r.problem);
    },
    remove_entry: async (rc) => {
      const r = attempt(rc, await rc.api.post(`/api/v1/admin/games/${enc(rc.form.slug ?? "")}/leaderboards/${enc(rc.form.key ?? "")}/remove`, { user_id: rc.form.user_id ?? "", reason: rc.form.reason ?? "" }));
      return r.ok ? redirect(rc, href(rc, "/admin/games/entitlements", { user_id: rc.form.user_id, ok: "done" })) : entitlements(rc, r.problem);
    },
  }),
  page("/admin/games/batches/:id/export", async (rc, p) => {
    requirePermission(rc, "games.keys.manage");
    const r = await rc.api.request<string>("GET", `/api/v1/admin/games/key-batches/${enc(p.id!)}/export`, undefined, { raw: true });
    const a = attempt(rc, r);
    if (!a.ok) return render(rc, <Alert kind="danger">{a.problem.code}</Alert>, a.problem.status);
    return new Response(a.data, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": r.headers.get("content-disposition") ?? "attachment", "cache-control": "no-store" } });
  }),
  page("/admin/games/:slug", (rc, p) => gameDetail(rc, p.slug!)),
  actions("/admin/games/:slug", {
    update: gameAction(async (rc, slug) => attempt(rc, await rc.api.patch(`/api/v1/admin/games/${enc(slug)}`, settingsBody(rc)))),
    product: gameAction(async (rc, slug) => attempt(rc, await rc.api.post(`/api/v1/admin/games/${enc(slug)}/products`, { sku: rc.form.sku ?? "", name: rc.form.name ?? "", kind: rc.form.kind ?? "dlc" }))),
    achievement: gameAction(async (rc, slug) =>
      attempt(rc, await rc.api.post(`/api/v1/admin/games/${enc(slug)}/achievements`, { key: rc.form.key ?? "", name: rc.form.name ?? "", description: rc.form.description ?? "", points: Number(rc.form.points ?? 10), hidden: Boolean(rc.form.hidden), progress_target: rc.form.progress_target ? Number(rc.form.progress_target) : null })),
    ),
    delete_achievement: gameAction(async (rc, slug) => attempt(rc, await rc.api.delete(`/api/v1/admin/games/${enc(slug)}/achievements/${enc(rc.form.id ?? "")}`))),
    stat: gameAction(async (rc, slug) =>
      attempt(rc, await rc.api.post(`/api/v1/admin/games/${enc(slug)}/stats`, { key: rc.form.key ?? "", name: rc.form.name ?? "", type: rc.form.type ?? "int", aggregation: rc.form.aggregation ?? "sum", authority: rc.form.authority ?? "player", max_delta: rc.form.max_delta ? Number(rc.form.max_delta) : null })),
    ),
    leaderboard: gameAction(async (rc, slug) => attempt(rc, await rc.api.post(`/api/v1/admin/games/${enc(slug)}/leaderboards`, { key: rc.form.key ?? "", name: rc.form.name ?? "", stat_key: rc.form.stat_key ?? "", sort: rc.form.sort ?? "desc", reset_period: rc.form.reset_period || "never" }))),
    batch: gameAction(async (rc, slug) => attempt(rc, await rc.api.post(`/api/v1/admin/games/${enc(slug)}/key-batches`, { sku: rc.form.sku ?? "", count: Number(rc.form.count ?? 0), label: rc.form.label ?? "" }))),
    revoke_batch: gameAction(async (rc) => attempt(rc, await rc.api.post(`/api/v1/admin/games/key-batches/${enc(rc.form.id ?? "")}/revoke`, { revoke_entitlements: Boolean(rc.form.revoke_entitlements), reason: rc.form.reason ?? "" }))),
    rotate: async (rc, p) => {
      const r = attempt(rc, await rc.api.post<{ server_client_id: string; server_secret: string }>(`/api/v1/admin/games/${enc(p.slug!)}/server-secret`, {}));
      return r.ok ? gameDetail(rc, p.slug!, { secret: { secret: r.data.server_secret, client_id: r.data.server_client_id } }) : gameDetail(rc, p.slug!, { problem: r.problem });
    },
  }),
];
