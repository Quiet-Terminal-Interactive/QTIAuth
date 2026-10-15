import type { Problem } from "../api.ts";
import { actions, attempt, back, page, unwrap, type PageRoute } from "../app.tsx";
import { href, requireUser, type RequestContext } from "../context.ts";
import { ActionForm, Alert, Badge, Captcha, Card, Empty, Field, PageHead, ProblemAlert, SidebarLayout, StateBadge, Submit, fmtDate, fmtNumber, fmtRelative, stateLabel } from "../ui.tsx";
import { settingsSide } from "../nav.ts";
import { captchaValue, shell } from "./common.tsx";

interface OwnedGame {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  icon_url: string | null;
  entitlements: { sku: string; product_name: string; kind: string; source: string; expires_at: string | null }[];
}

function GameIcon({ g }: { g: { name: string; icon_url: string | null } }) {
  return g.icon_url ? <img class="game-icon" src={g.icon_url} alt="" width="72" height="72" /> : <span class="game-icon">{g.name.slice(0, 1)}</span>;
}

async function library(rc: RequestContext, o: { problem?: Problem | null; redeemed?: string } = {}) {
  requireUser(rc);
  const owned = unwrap(rc, await rc.api.get<{ items: OwnedGame[] }>("/api/v1/games/owned"));
  const f = await rc.features();
  return shell(
    rc,
    { title: rc.t("games.title"), active: "games" },
    <div class="stack-lg">
      <PageHead title={rc.t("games.title")} lede={rc.t("games.lede")} />
      {f.features.games?.keys ? (
        <Card title={rc.t("games.redeem")}>
          <ProblemAlert rc={rc} problem={o.problem} />
          {o.redeemed ? <Alert kind="success">{rc.t("games.redeemed", { product: o.redeemed })}</Alert> : null}
          <ActionForm action={href(rc, "/games")} name="redeem" class="row">
            <div class="grow">
              <Field name="code" label={rc.t("games.redeem_code")} placeholder="XXXXX-XXXXX-XXXXX" autocomplete="off" class="mono" required value={o.problem ? rc.form.code : undefined} />
            </div>
            <Submit>{rc.t("games.redeem_submit")}</Submit>
            <Captcha rc={rc} problem={o.problem} />
          </ActionForm>
        </Card>
      ) : null}
      {owned.items.length ? (
        <div class="grid-2">
          {owned.items.map((g) => (
            <a class="card link-card" href={href(rc, `/games/${g.slug}`)}>
              <div class="row">
                <GameIcon g={g} />
                <div class="grow">
                  <h3>{g.name}</h3>
                  <div class="row">
                    {g.entitlements.map((e) => (
                      <Badge color={e.kind === "base" ? "green" : "purple"}>{e.product_name}</Badge>
                    ))}
                  </div>
                </div>
              </div>
            </a>
          ))}
        </div>
      ) : (
        <div class="card">
          <Empty title={rc.t("games.none")} />
        </div>
      )}
    </div>,
  );
}

interface GameDetail {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: string;
  icon_url: string | null;
  leaderboards: { key: string; name: string; reset_period: string; current_period: string }[];
}

async function gamePage(rc: RequestContext, slug: string) {
  requireUser(rc);
  const enc = encodeURIComponent(slug);
  const g = unwrap(rc, await rc.api.get<GameDetail>(`/api/v1/games/${enc}`));
  const [owned, ach, stats] = await Promise.all([
    rc.api.get<{ owned: boolean; entitlements: { product_name: string; kind: string; source: string; granted_at: string; expires_at: string | null }[] }>(`/api/v1/games/${enc}/owned`),
    rc.api.get<{ items: { key: string; name: string; description: string; points: number; unlocked: boolean; unlocked_at: string | null; progress: number; progress_target: number | null; rarity_percent: number | null; hidden: boolean }[]; completion_percent: number; points: number; total_points: number }>(`/api/v1/games/${enc}/achievements`),
    rc.api.get<{ items: { key: string; name: string; value: number; type: string }[] }>(`/api/v1/games/${enc}/stats/me`),
  ]);
  const boardKey = rc.query.get("board") ?? g.leaderboards[0]?.key;
  const board = boardKey ? await rc.api.get<{ leaderboard: { name: string; period: string }; total: number; items: { rank: number; score: number; username: string | null; hidden: boolean; is_me: boolean }[]; me: { rank: number; score: number } | null }>(`/api/v1/games/${enc}/leaderboards/${encodeURIComponent(boardKey)}`, { limit: 25 }) : null;
  return shell(
    rc,
    { title: g.name, active: "games" },
    <div class="stack-lg">
      <div class="crumbs">
        <a href={href(rc, "/games")}>{rc.t("games.title")}</a>
      </div>
      <div class="game-hero">
        <GameIcon g={g} />
        <div>
          <h1>{g.name}</h1>
          <p class="muted">{g.description}</p>
          <StateBadge rc={rc} state={g.status} />
        </div>
      </div>
      {owned.ok && owned.data.entitlements.length ? (
        <Card title={rc.t("games.owned")}>
          <div class="list">
            {owned.data.entitlements.map((e) => (
              <div class="item">
                <strong>{e.product_name}</strong>
                <span class="meta">
                  {stateLabel(rc, e.source)} · {fmtDate(rc, e.granted_at)}
                  {e.expires_at ? ` → ${fmtDate(rc, e.expires_at)}` : ""}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {ach.ok && ach.data.items.length ? (
        <Card title={rc.t("games.achievements")} actions={<span class="muted">{rc.t("games.achievements_progress", { done: ach.data.items.filter((a) => a.unlocked).length, total: ach.data.items.length })}</span>}>
          <div class="progress" role="progressbar" aria-valuenow={ach.data.completion_percent} aria-valuemin={0} aria-valuemax={100}>
            <span class={`w-${Math.round(ach.data.completion_percent / 5) * 5}`} />
          </div>
          <div class="grid-2">
            {ach.data.items.map((a) => (
              <div class={a.unlocked ? "ach" : "ach locked"}>
                <div class="icon" aria-hidden="true">
                  {a.unlocked ? "★" : "☆"}
                </div>
                <div class="grow">
                  <strong>{a.name}</strong>
                  <div class="meta">{a.description}</div>
                  <div class="meta">
                    {a.points} pts{a.rarity_percent !== null ? ` · ${a.rarity_percent}%` : ""}
                    {a.unlocked_at ? ` · ${fmtRelative(rc, a.unlocked_at)}` : a.progress_target ? ` · ${a.progress}/${a.progress_target}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {stats.ok && stats.data.items.length ? (
        <Card title={rc.t("games.stats")}>
          <div class="grid-3">
            {stats.data.items.map((s) => (
              <div class="tile">
                <div class="label">{s.name}</div>
                <div class="value">{fmtNumber(rc, s.value)}</div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
      {board && board.ok ? (
        <Card title={rc.t("games.leaderboards")} actions={<a href={href(rc, "/settings/profile")}>{rc.t("games.visibility")}</a>}>
          {g.leaderboards.length > 1 ? (
            <div class="tabs">
              {g.leaderboards.map((l) => (
                <a href={href(rc, `/games/${slug}`, { board: l.key })} aria-current={l.key === boardKey ? "page" : undefined}>
                  {l.name}
                </a>
              ))}
            </div>
          ) : null}
          <p class="muted">{board.data.leaderboard.period}</p>
          <div class="table-wrap">
            <table class="table">
              <tbody>
                {board.data.items.map((e) => (
                  <tr class={e.is_me ? "me-row" : undefined}>
                    <td class={e.rank <= 3 ? "rank top" : "rank"}>#{e.rank}</td>
                    <td>{e.is_me ? rc.t("games.you") : e.hidden ? rc.t("games.hidden_player") : e.username}</td>
                    <td class="num">{fmtNumber(rc, e.score)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {board.data.me && !board.data.items.some((e) => e.is_me) ? (
            <p>
              {rc.t("games.you")}: #{board.data.me.rank} · {fmtNumber(rc, board.data.me.score)}
            </p>
          ) : null}
        </Card>
      ) : null}
    </div>,
  );
}

async function devices(rc: RequestContext) {
  requireUser(rc);
  const r = unwrap(rc, await rc.api.get<{ items: { device_hash: string; name: string | null; slug: string; game_name: string; last_seen_at: string }[] }>("/api/v1/games/devices"));
  const f = await rc.features();
  return shell(
    rc,
    { title: rc.t("games.devices"), active: "settings" },
    <SidebarLayout rc={rc} items={settingsSide(rc, f)} active="devices">
      <PageHead title={rc.t("games.devices")} lede={rc.t("games.devices_lede")} />
      {r.items.length ? (
        <div class="card flush">
          <div class="list">
            {r.items.map((d) => (
              <div class="item">
                <div>
                  <strong>{d.name ?? d.device_hash.slice(0, 10)}</strong>
                  <div class="meta">
                    {d.game_name} · {fmtRelative(rc, d.last_seen_at)}
                  </div>
                </div>
                <ActionForm action={href(rc, "/games/devices")} name="remove" class="inline-form" fields={{ slug: d.slug, hash: d.device_hash }} confirm={rc.t("app.confirm")}>
                  <Submit kind="danger-ghost" small>
                    {rc.t("games.device_remove")}
                  </Submit>
                </ActionForm>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div class="card">
          <Empty title={rc.t("app.none")} />
        </div>
      )}
    </SidebarLayout>,
  );
}

export const gameRoutes: PageRoute[] = [
  page("/games", (rc) => library(rc)),
  actions("/games", {
    redeem: async (rc) => {
      const r = attempt(rc, await rc.api.post<{ product: { name: string } }>("/api/v1/games/keys/redeem", { code: rc.form.code ?? "", captcha: captchaValue(rc) }));
      return r.ok ? library(rc, { redeemed: r.data.product.name }) : library(rc, { problem: r.problem });
    },
  }),
  page("/games/devices", (rc) => devices(rc)),
  actions("/games/devices", {
    remove: async (rc) => {
      unwrap(rc, await rc.api.delete(`/api/v1/games/devices/${encodeURIComponent(rc.form.slug ?? "")}/${encodeURIComponent(rc.form.hash ?? "")}`));
      return back(rc, "/games/devices", { ok: "device_removed" });
    },
  }),
  page("/games/:slug", (rc, p) => gamePage(rc, p.slug!)),
];
