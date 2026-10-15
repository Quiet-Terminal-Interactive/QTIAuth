import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { identityService } from "../../services/identity/src/service.ts";
import { oidcService } from "../../services/oidc/src/service.ts";
import { safetyService } from "../../services/safety/src/service.ts";
import { gamesService } from "../../services/games/src/service.ts";
import { freePort, signupAndVerify, staffClient, startStack, waitUntil, type Client, type Stack } from "./harness.ts";

let stack: Stack;
let admin: Client;
let steam: Server;
let serverSecret: string;
const SLUG = "space-game";
const STEAM_ID = "76561198000000001";
const GOOD_TICKET = "AABBCCDDEEFF00112233";
const PLAYER_SCOPES = "openid profile offline_access games achievements game_stats achievements.write game_stats.write";

async function form(path: string, params: Record<string, string>): Promise<{ status: number; body: any }> {
  const r = await fetch(stack.origin + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
  return { status: r.status, body: await r.json() };
}

async function playerToken(user: Client, slug = SLUG): Promise<string> {
  const start = await form("/api/oauth/device/code", { client_id: `game:${slug}`, scope: PLAYER_SCOPES });
  expect(start.status).toBe(200);
  const ok = await user.post(`/api/v1/oauth/device/${start.body.user_code}/decision`, { approve: true });
  expect(ok.status).toBe(200);
  const t = await form("/api/oauth/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.body.device_code, client_id: `game:${slug}` });
  expect(t.status).toBe(200);
  return t.body.access_token;
}

async function serverToken(scope = "games.server safety.intake"): Promise<string> {
  const t = await form("/api/oauth/token", { grant_type: "client_credentials", client_id: `game:${SLUG}:server`, client_secret: serverSecret, scope });
  expect(t.status).toBe(200);
  return t.body.access_token;
}

function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

beforeAll(async () => {
  const steamPort = await freePort();
  steam = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    res.setHeader("content-type", "application/json");
    if (url.searchParams.get("key") !== "test-publisher-key") return res.writeHead(403).end("{}");
    if (url.pathname === "/ISteamUserAuth/AuthenticateUserTicket/v1/") {
      if (url.searchParams.get("ticket") !== GOOD_TICKET || url.searchParams.get("identity") !== "qtiauth") return res.end(JSON.stringify({ response: { error: { errorcode: 101, errordesc: "Invalid ticket" } } }));
      return res.end(JSON.stringify({ response: { params: { result: "OK", steamid: STEAM_ID, ownersteamid: STEAM_ID, vacbanned: false, publisherbanned: false } } }));
    }
    if (url.pathname === "/ISteamUser/CheckAppOwnership/v4/") return res.end(JSON.stringify({ appownership: { ownsapp: true, ownersteamid: STEAM_ID, result: "OK" } }));
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => steam.listen(steamPort, "127.0.0.1", () => r()));
  stack = await startStack([identityService, oidcService, safetyService, gamesService], {
    features: { games: { steam: { enabled: true, publisher_key: "test-publisher-key", web_api_host: `http://127.0.0.1:${steamPort}`, apps: [{ app_id: 480, game_slug: SLUG }] } } },
  });
  admin = (await staffClient(stack, "gameadmin@example.com", ["admin"])).client;
});

afterAll(async () => {
  await stack?.stop();
  steam?.close();
});

describe("catalog", () => {
  it("creates a game with clients, products and definitions", async () => {
    const created = await admin.post("/api/v1/admin/games", { slug: SLUG, name: "Space Game", description: "Pew pew" });
    expect(created.status).toBe(200);
    expect(created.body.client_id).toBe(`game:${SLUG}`);
    expect(created.body.server_secret).toBeTruthy();
    serverSecret = created.body.server_secret;
    expect((await admin.post("/api/v1/admin/games", { slug: "owned", name: "Nope" })).body.code).toBe("SLUG_TAKEN");

    expect((await stack.client().get(`/api/v1/games/${SLUG}`)).status).toBe(404);
    await admin.patch(`/api/v1/admin/games/${SLUG}`, { status: "released" });
    expect((await stack.client().get(`/api/v1/games/${SLUG}`)).status).toBe(200);

    expect((await admin.post(`/api/v1/admin/games/${SLUG}/products`, { sku: "space-game-dlc1", name: "Moon Pack", kind: "dlc" })).status).toBe(200);
    await admin.post(`/api/v1/admin/games/${SLUG}/stats`, { key: "score", name: "Score", aggregation: "max", authority: "game" });
    await admin.post(`/api/v1/admin/games/${SLUG}/stats`, { key: "kills", name: "Kills", aggregation: "sum", authority: "player", max_delta: 100 });
    const badLb = await admin.post(`/api/v1/admin/games/${SLUG}/leaderboards`, { key: "kills", name: "Kills", stat_key: "kills" });
    expect(badLb.body.code).toBe("LEADERBOARD_NEEDS_GAME_AUTHORITY");
    expect((await admin.post(`/api/v1/admin/games/${SLUG}/leaderboards`, { key: "high", name: "High scores", stat_key: "score", reset_period: "weekly" })).status).toBe(200);
    await admin.post(`/api/v1/admin/games/${SLUG}/achievements`, { key: "first_win", name: "First win", points: 10 });
    await admin.post(`/api/v1/admin/games/${SLUG}/achievements`, { key: "secret", name: "Secret ending", description: "You found it", hidden: true });
    await admin.post(`/api/v1/admin/games/${SLUG}/achievements`, { key: "collector", name: "Collector", progress_target: 10 });

    const pub = await stack.client().get(`/api/v1/games/${SLUG}`);
    expect(pub.body.achievements.find((a: { key: string }) => a.key === "secret").name).toBe("Hidden achievement");
    expect(pub.body.leaderboards[0].current_period).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe("keys and entitlements", () => {
  it("generates, exports and redeems keys", async () => {
    const batch = await admin.post(`/api/v1/admin/games/${SLUG}/key-batches`, { sku: SLUG, count: 3, label: "press" });
    expect(batch.status).toBe(200);
    const csv = await fetch(`${stack.origin}/api/v1/admin/games/key-batches/${batch.body.id}/export`, { headers: { cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const codes = (await csv.text()).trim().split("\n").slice(1).map((l) => l.split(",")[0]!);
    expect(codes).toHaveLength(3);
    expect(codes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const player = await signupAndVerify(stack, "pilot@example.com", { username: "pilot_one" });
    expect((await player.get(`/api/v1/games/${SLUG}/owned`)).body.owned).toBe(false);
    expect((await player.post("/api/v1/games/keys/redeem", { code: "AAAAA-BBBBB-CCCCC" })).body.code).toBe("KEY_INVALID");
    const ok = await player.post("/api/v1/games/keys/redeem", { code: codes[0]!.toLowerCase().replace(/-/g, " ") });
    expect(ok.status).toBe(200);
    expect(ok.body.product.kind).toBe("base");
    expect((await player.post("/api/v1/games/keys/redeem", { code: codes[0] })).body.code).toBe("KEY_ALREADY_REDEEMED");
    const thief = await signupAndVerify(stack, "thief@example.com");
    expect((await thief.post("/api/v1/games/keys/redeem", { code: codes[0] })).body.code).toBe("KEY_INVALID");
    const owned = await player.get(`/api/v1/games/${SLUG}/owned`);
    expect(owned.body).toMatchObject({ owned: true, base: true, products: [SLUG] });

    await admin.post(`/api/v1/admin/games/key-batches/${batch.body.id}/revoke`, { revoke_entitlements: true, reason: "Leaked on a forum" });
    expect((await player.get(`/api/v1/games/${SLUG}/owned`)).body.owned).toBe(false);
    expect((await thief.post("/api/v1/games/keys/redeem", { code: codes[1] })).body.code).toBe("KEY_REVOKED");
  });

  it("grants through the external API with a scoped service credential", async () => {
    const user = await signupAndVerify(stack, "buyer@example.com");
    const userId = (await user.get("/api/v1/me")).body.id;
    const svc = await serverToken();
    const denied = await fetch(`${stack.origin}/api/v1/games/entitlements`, { method: "POST", headers: bearer(svc, { "content-type": "application/json" }), body: JSON.stringify({ user_id: userId, sku: "space-game-dlc1" }) });
    expect(denied.status).toBe(403);
    expect((await admin.put(`/api/v1/admin/oidc/clients/game:${SLUG}:server/scopes`, { scopes: ["games.server", "safety.intake", "games.entitlements.write"], reason: "Storefront integration" })).status).toBe(200);
    const svc2 = await serverToken("games.entitlements.write");
    const grant = async () => fetch(`${stack.origin}/api/v1/games/entitlements`, { method: "POST", headers: bearer(svc2, { "content-type": "application/json" }), body: JSON.stringify({ user_id: userId, sku: "space-game-dlc1", external_ref: "order-1" }) });
    const g1 = await (await grant()).json();
    expect(g1.created).toBe(true);
    expect((await (await grant()).json()).created).toBe(false);
    expect((await user.get(`/api/v1/games/${SLUG}/owned`)).body.products).toEqual(["space-game-dlc1"]);
  });
});

describe("player data", () => {
  let adultToken: string;
  let adult: Client;

  it("unlocks achievements only with the game's own player token", async () => {
    adult = await signupAndVerify(stack, "ace@example.com", { username: "ace_pilot" });
    adultToken = await playerToken(adult);
    expect(decodeJwt(adultToken).gid).toBeTruthy();
    expect((await adult.post(`/api/v1/games/${SLUG}/achievements/first_win/unlock`)).status).toBe(401);
    const u = await adult.post(`/api/v1/games/${SLUG}/achievements/first_win/unlock`, {}, bearer(adultToken));
    expect(u.body.status).toBe("unlocked");
    await adult.post(`/api/v1/games/${SLUG}/achievements/secret/unlock`, {}, bearer(adultToken));
    expect((await adult.post(`/api/v1/games/${SLUG}/achievements/collector/progress`, { progress: 4 }, bearer(adultToken))).body.status).toBe("progress");
    expect((await adult.post(`/api/v1/games/${SLUG}/achievements/collector/progress`, { progress: 2 }, bearer(adultToken))).body.progress).toBe(4);
    expect((await adult.post(`/api/v1/games/${SLUG}/achievements/collector/progress`, { progress: 15 }, bearer(adultToken))).body.status).toBe("unlocked");
    const mine = await adult.get(`/api/v1/games/${SLUG}/achievements`);
    expect(mine.body.items.find((a: { key: string }) => a.key === "secret").name).toBe("Secret ending");
    expect(mine.body.completion_percent).toBe(100);
  });

  it("keeps game-authority stats behind the server credential and hides teens on leaderboards", async () => {
    const kills = await adult.post(`/api/v1/games/${SLUG}/stats`, { updates: [{ key: "kills", value: 5 }] }, bearer(adultToken));
    expect(kills.body.items[0].value).toBe(5);
    expect((await adult.post(`/api/v1/games/${SLUG}/stats`, { updates: [{ key: "kills", value: 500 }] }, bearer(adultToken))).body.code).toBe("STAT_DELTA_TOO_LARGE");
    const cheat = await adult.post(`/api/v1/games/${SLUG}/stats`, { updates: [{ key: "score", value: 999999 }] }, bearer(adultToken));
    expect(cheat.body.code).toBe("STAT_REQUIRES_GAME_AUTHORITY");

    const server = await serverToken();
    const serverOnly = await adult.post(`/api/v1/games/${SLUG}/stats`, { updates: [{ key: "score", value: 1 }] }, bearer(server));
    expect(serverOnly.status).toBe(401);
    const authoritative = await adult.post(`/api/v1/games/${SLUG}/stats`, { updates: [{ key: "score", value: 100 }] }, bearer(server, { "x-qtiauth-player-token": adultToken }));
    expect(authoritative.status).toBe(200);

    const teenDob = `${new Date().getUTCFullYear() - 15}-01-01`;
    const teen = await signupAndVerify(stack, "teen@example.com", { dob: teenDob, username: "young_pilot" });
    const teenToken = await playerToken(teen);
    await teen.post(`/api/v1/games/${SLUG}/stats`, { updates: [{ key: "score", value: 250 }] }, bearer(server, { "x-qtiauth-player-token": teenToken }));

    const board = await stack.client().get(`/api/v1/games/${SLUG}/leaderboards/high`);
    expect(board.body.total).toBe(2);
    expect(board.body.items[0]).toMatchObject({ rank: 1, score: 250, hidden: true, username: "Hidden player", user_id: null });
    expect(board.body.items[1]).toMatchObject({ rank: 2, score: 100, hidden: false, username: "ace_pilot" });
    const teenView = await teen.get(`/api/v1/games/${SLUG}/leaderboards/high`);
    expect(teenView.body.me).toMatchObject({ rank: 1, is_me: true, username: "young_pilot" });

    expect((await teen.put("/api/v1/games/leaderboards/visibility", { visible: true })).body.visible).toBe(true);
    expect((await stack.client().get(`/api/v1/games/${SLUG}/leaderboards/high`)).body.items[0].username).toBe("young_pilot");
    expect((await adult.put("/api/v1/games/leaderboards/visibility", { visible: false })).body.visible).toBe(false);
    expect((await stack.client().get(`/api/v1/games/${SLUG}/leaderboards/high`)).body.items[1].hidden).toBe(true);

    const teenId = (await teen.get("/api/v1/me")).body.id;
    expect((await admin.post(`/api/v1/admin/games/${SLUG}/leaderboards/high/remove`, { user_id: teenId, reason: "Impossible score" })).status).toBe(200);
    expect((await stack.client().get(`/api/v1/games/${SLUG}/leaderboards/high`)).body.total).toBe(1);
  });

  it("tracks playtime and stores custom data", async () => {
    const s = await adult.post(`/api/v1/games/${SLUG}/playtime/sessions`, {}, bearer(adultToken));
    expect(s.body.remaining_minutes).toBeNull();
    const db = stack.services.get("games")!.ctx.db;
    await db.updateTable("playtime_sessions").set({ last_heartbeat_at: new Date(Date.now() - 120_000) }).where("id", "=", s.body.session_id).execute();
    await adult.post(`/api/v1/games/${SLUG}/playtime/sessions/${s.body.session_id}/heartbeat`, {}, bearer(adultToken));
    const end = await adult.post(`/api/v1/games/${SLUG}/playtime/sessions/${s.body.session_id}/end`, {}, bearer(adultToken));
    expect(end.body.seconds).toBeGreaterThanOrEqual(119);
    const summary = await stack.bus.request<{ games: { slug: string; playtime_minutes: number }[] }>("games.activity_summary", { user_id: (await adult.get("/api/v1/me")).body.id, since: new Date(Date.now() - 86_400_000).toISOString() });
    expect(summary.games[0]).toMatchObject({ slug: SLUG, playtime_minutes: 2 });
    await adult.put(`/api/v1/games/${SLUG}/data`, { data: { loadout: ["laser"] } }, bearer(adultToken));
    expect((await adult.get(`/api/v1/games/${SLUG}/data`, bearer(adultToken))).body.data.loadout).toEqual(["laser"]);
    expect((await adult.get(`/api/v1/games/${SLUG}/saves`, bearer(adultToken))).body.code).toBe("CLOUD_SAVES_DISABLED");
  });
});

describe("licensing", () => {
  it("issues, verifies and revokes offline leases", async () => {
    const user = await signupAndVerify(stack, "offline@example.com");
    const userId = (await user.get("/api/v1/me")).body.id;
    expect((await user.post(`/api/v1/games/${SLUG}/license`, {})).body.code).toBe("NOT_OWNED");
    await admin.post("/api/v1/admin/games/entitlements", { user_id: userId, sku: SLUG, reason: "Competition prize" });
    const lease = await user.post(`/api/v1/games/${SLUG}/license`, {});
    expect(lease.status).toBe(200);
    expect(lease.body.products).toEqual([SLUG]);
    const keys = await stack.client().get("/api/.well-known/qtiauth-license-keys.json");
    expect(keys.body.keys[0].kty).toBe("OKP");
    const v = await stack.client().post("/api/v1/games/licensing/verify", { lease: lease.body.lease });
    expect(v.body).toMatchObject({ valid: true, user_id: userId, game: SLUG });
    await admin.post("/api/v1/admin/games/licensing/revoke", { user_id: userId, slug: SLUG, reason: "Chargeback" });
    expect((await stack.client().post("/api/v1/games/licensing/verify", { lease: lease.body.lease })).body).toMatchObject({ valid: false, reason: "revoked" });
    const rev = await stack.client().get("/api/v1/games/licensing/revocations?since=0");
    expect((decodeJwt(rev.body.token).revoked as { jti: string }[]).some((r) => r.jti === lease.body.jti)).toBe(true);
  });
});

describe("steam", () => {
  it("authenticates tickets, links in game and syncs ownership", async () => {
    const bad = await stack.client().post("/api/v1/games/steam/authenticate", { app_id: 480, ticket: "00112233445566778899" });
    expect(bad.body.code).toBe("STEAM_TICKET_INVALID");
    const unlinked = await stack.client().post("/api/v1/games/steam/authenticate", { app_id: 480, ticket: GOOD_TICKET });
    expect(unlinked.body).toMatchObject({ valid: true, steam_id: STEAM_ID, user_id: null, family_shared: false });
    expect(unlinked.body.device_code.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/);

    const gamer = await signupAndVerify(stack, "steamer@example.com");
    const token = await playerToken(gamer);
    const link = await gamer.post("/api/v1/games/steam/link", { app_id: 480, ticket: GOOD_TICKET }, bearer(token));
    expect(link.body).toMatchObject({ status: "linked", ownership: { granted: 1 } });
    const owned = await gamer.get(`/api/v1/games/${SLUG}/owned`);
    expect(owned.body.entitlements[0].source).toBe("steam");

    const signedIn = await stack.client().post("/api/v1/games/steam/authenticate", { app_id: 480, ticket: GOOD_TICKET, issue_tokens: true });
    expect(signedIn.body.user_id).toBe((await gamer.get("/api/v1/me")).body.id);
    expect(signedIn.body.entitled).toBe(true);
    expect(signedIn.body.tokens.access_token).toBeTruthy();
  });
});

describe("moderation", () => {
  it("queues content removal requests for the game server", async () => {
    const user = await signupAndVerify(stack, "griefer@example.com");
    const userId = (await user.get("/api/v1/me")).body.id;
    const gameId = (await stack.client().get(`/api/v1/games/${SLUG}`)).body.id;
    const r = await admin.post("/api/v1/admin/safety/actions", { user_id: userId, action_type: "remove_content", rule: "conduct.hate", game_id: gameId, content: { id: "chat-42", type: "chat_message" } });
    expect(r.status).toBe(200);
    const server = await serverToken();
    await waitUntil(async () => (await stack.client().get("/api/v1/games/server/removal-requests", bearer(server))).body.items?.length === 1);
    const list = await stack.client().get("/api/v1/games/server/removal-requests", bearer(server));
    expect(list.body.items[0].content.id).toBe("chat-42");
    await stack.client().post(`/api/v1/games/server/removal-requests/${list.body.items[0].id}/ack`, {}, bearer(server));
    expect((await stack.client().get("/api/v1/games/server/removal-requests", bearer(server))).body.items).toHaveLength(0);
  });

  it("asks the game to preserve a reported user's data and seals the response as evidence", async () => {
    const user = await signupAndVerify(stack, "preserve@example.com");
    const userId = (await user.get("/api/v1/me")).body.id;
    const server = await serverToken();
    const upload = { uploaded_at: "2026-05-01T10:00:00Z", ip: "2001:db8::7", port: 51234, hash: { algorithm: "sha256", value: "0123456789abcdef" } };
    const r = await stack.client().post("/api/v1/safety/intake/reports", { type: "csea", subtype: "grooming", reported_user_id: userId, content: { id: "img-9", type: "image", upload }, snapshot: { note: "test" } }, bearer(server));
    expect(r.status).toBe(200);
    const pending = await stack.client().get("/api/v1/safety/intake/preservation-requests", bearer(server));
    const req = pending.body.items.find((i: { user_id: string }) => i.user_id === userId);
    expect(req.content).toEqual({ id: "img-9", type: "image" });
    expect(new Date(req.window_end).getTime() - new Date(req.window_start).getTime()).toBeGreaterThanOrEqual(14 * 86_400_000);
    const done = await stack.client().post(`/api/v1/safety/intake/preservation-requests/${req.id}`, { messages: [{ at: "2026-04-30T09:00:00Z", text: "x" }], connections: [{ user_id: "someone" }] }, bearer(server));
    expect(done.status).toBe(200);
    expect((await stack.client().post(`/api/v1/safety/intake/preservation-requests/${req.id}`, {}, bearer(server))).body.code).toBe("REQUEST_NOT_PENDING");
    const evidence = await stack.services.get("safety")!.ctx.db.selectFrom("evidence").select(["kind", "ciphertext"]).where("user_id", "=", userId).execute();
    expect(evidence.map((e) => e.kind).sort()).toEqual(["case_opened", "preservation"]);
    expect(evidence.every((e) => !e.ciphertext.includes("2026-04-30"))).toBe(true);
  });
});
