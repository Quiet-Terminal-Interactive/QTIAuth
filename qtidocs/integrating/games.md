---
title: Games
description: Player sign-in, achievements, stats and leaderboards, playtime, licensing, cloud saves, Steam and safety reports.
order: 3
---

# Integrating games

Needs the `games` and `oidc` profiles. Paths below are relative to the API base of the api surface. With everything on one host under `/api`, `/api/v1/games/...` is `https://id.example.com/api/v1/games/...`.

## Setting up a game

Staff create the game under Admin -> Games. That creates:

- a base product whose SKU is the game's slug (add DLC, editions and betas as further products),
- a player client `game:<slug>`, a public OAuth client your game uses to sign players in,
- a server client `game:<slug>:server`, a confidential client for your game server. Its secret is shown once. Rotate it from the game's admin page.

Then define achievements, stats and leaderboards on the same page.

## Two trust levels

| Trust  | Written with                                                   | Used for                                                                              |
| ------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Player | The player's own access token for your game's client           | Achievements, progress, `authority: player` stats, custom data, playtime, cloud saves |
| Game   | Your server's client-credentials token plus the player's token | `authority: game` stats and the leaderboards built on them                            |

Player-trust data is trust-based by design, as on Steam or Epic: a determined player can fake it, and it only fools themselves. Nothing of value may ever be granted from player-trust data no entitlements, keys, DLC, cosmetics, prizes or public recognition beyond the player's own profile. Events carry `trust: player | game` so external integrations can tell the difference.

### What game authority does and doesn't protect against

The server credential proves a score came through your game server That stops anyone scripting fake submissions straight at the API. It doesn't prove the score is legitimate If your server relays whatever its clients report, memory editing and modified clients still work. Leaderboards are only as trustworthy as your server's own validation: server-side simulation, replay checks, sanity bounds. That part is your responsibility.

A game without its own server can't write `authority: game` stats, because a server key shipped inside a game client can be extracted. Such games either use trust-based leaderboards (set `require_game_authority: false` for the game) or have none.

## Signing players in

Use the player client `game:<slug>` with either:

- Device flow (recommended for consoles and launchers): `POST /oauth/device/code` with `client_id=game:<slug>`, show the code, poll `/oauth/token`. See [integrating apps](/integrating/apps).
- Authorization code + PKCE with a loopback redirect (`http://127.0.0.1:<port>/callback`). Set the allowed redirect URIs on the game's admin page.
- Steam tickets, described below.

Request these scopes: `openid profile offline_access games achievements game_stats achievements.write game_stats.write`, plus `parental_controls` and `restrictions` if you enforce them. The `*.write` scopes can only be granted to your game's own clients, so another app a player has authorised can't write to your game.

## Ownership

```
GET /api/v1/games/<slug>/owned          (player token, scope games)
-> { owned, base, products: ["my-game", "my-game-dlc1"], entitlements: [...] }
```

Players redeem product keys on the account site, or in-game with `POST /api/v1/games/keys/redeem {"code": "XXXXX-XXXXX-XXXXX"}`. Repeated failures trigger a CAPTCHA.

## Achievements

```
POST /api/v1/games/<slug>/achievements/<key>/unlock                       (player token, achievements.write)
POST /api/v1/games/<slug>/achievements/<key>/progress {"progress": 42}   (progress only moves forward)
GET  /api/v1/games/<slug>/achievements                                   (scope achievements)
```

Progress achievements unlock automatically at their `progress_target`. Hidden achievements keep their name and description hidden until unlocked. Unlocks revoked by staff for cheating stay revoked.

## Stats and leaderboards

```
POST /api/v1/games/<slug>/stats {"updates": [{"key": "kills", "value": 3}]}
GET  /api/v1/games/<slug>/stats/me
GET  /api/v1/games/<slug>/leaderboards/<key>?period=&limit=25&offset=0     (no auth needed)
```

- Player stats: send the player's token.
- Game stats: send your server's token in `Authorization: Bearer` and the player's token in `X-QTIAuth-Player-Token`. Both must belong to the same game, or the request is rejected (`PLAYER_TOKEN_GAME_MISMATCH`). A player token on its own gets `STAT_REQUIRES_GAME_AUTHORITY`.
- Values aggregate per the stat definition (`sum`: send deltas; `max`, `min`, `latest`: send observations). `max_delta` rejects implausible jumps with `STAT_DELTA_TOO_LARGE`.
- Leaderboards reset `daily`, `weekly`, `monthly`, per `season:<id>`, or `never`. Past periods are kept and can be read with `?period=`.
- Players under 18 are hidden by default and appear as "Hidden player" while still counting in the ranking. They or their guardian can opt in.

Free-form per-player JSON (up to 64 KB): `GET` and `PUT /api/v1/games/<slug>/data`.

## Playtime and parental controls

```
POST /api/v1/games/<slug>/playtime/sessions                 -> { session_id, heartbeat_interval_s, remaining_minutes }
POST /api/v1/games/<slug>/playtime/sessions/<id>/heartbeat  -> { played_today_minutes, remaining_minutes }
POST /api/v1/games/<slug>/playtime/sessions/<id>/end
GET  /api/v1/games/<slug>/playtime/remaining                -> { limit_minutes, remaining_minutes, online_play }
```

Send a heartbeat every `heartbeat_interval_s`. Gaps longer than `games.playtime_heartbeat_max_gap` aren't counted. Your game enforces the controls: read the `parental_controls` claim (`online_play`, `in_game_chat`, `user_generated_content`, `purchases`, `daily_playtime_minutes`) and the `restrictions` claim (e.g. `chat`, `ugc`), and stop play when `remaining_minutes` reaches 0.

## Offline licensing

```
POST /api/v1/games/<slug>/license {"device_id": "…", "device_name": "Steam Deck"}   (player token or session)
-> { lease, jti, expires_at, products }
```

The lease is an EdDSA-signed JWT (`typ: qtiauth-license+jwt`) containing `sub` (user), `game`, `gid`, `products` (every owned SKU for the game), `jti`, `exp`, and `dev` when device binding is on.

- Offline: verify the signature against `/.well-known/qtiauth-license-keys.json` (bundle a copy and refresh it when online), then check `exp`, `aud` (`game:<slug>`) and `products`. With device binding, `dev` is `sha256("device:" + <game id> + ":" + <device_id>)` in hex.
- Online: `POST /api/v1/games/licensing/verify {"lease": "…"}` (no credentials) returns `valid` and a `reason` (`expired`, `revoked`, `invalid_signature`).
- Occasionally online servers: `GET /api/v1/games/licensing/revocations?since=<unix seconds>` returns a signed token listing revoked `jti`s that haven't expired yet.

Lease length is per game (default 20 days). Device-bound games limit concurrent devices (default 3), and players remove devices on the account site.

## Cloud saves

Needs object storage. Writing uses the player token (scope `game_stats.write`):

```
GET    /api/v1/games/<slug>/saves                                   -> slots and quota
POST   /api/v1/games/<slug>/saves/<slot>/uploads {"size": n, "sha256": "…", "base_version": 3}
         -> { upload_id, upload: { url, method: "PUT", headers } }   PUT the bytes to url
POST   /api/v1/games/<slug>/saves/<slot>/uploads/<upload_id>/commit -> { version }
GET    /api/v1/games/<slug>/saves/<slot>[?version=n]                -> short-lived download url
GET    /api/v1/games/<slug>/saves/<slot>/versions
DELETE /api/v1/games/<slug>/saves/<slot>
```

`base_version` is the version your client last saw (0 for a new slot). If another device committed in between, you get `409 SAVE_CONFLICT` with `current_version`, and your client decides how to merge. The last N versions are kept.

## Steam

Configure apps under `features.games.steam.apps` (each mapping a Steam `app_id` to a game slug, with the `ticket_identity` you pass to `GetAuthTicketForWebApi`).

```
POST /api/v1/games/steam/authenticate {"app_id": 480, "ticket": "<hex>", "issue_tokens": true}
```

Call it with your server credential, or without credentials (rate-limited per app). The response includes `steam_id`, `family_shared`, `vac_banned`, `publisher_banned`, `user_id` (if linked) and `entitled`. If the Steam account isn't linked, it includes a `device_code` so the player can link right away. If it's linked and `issue_tokens` is set, it includes a full token set, so players sign in without a browser.

After a device-flow sign-in, link Steam from inside the game with `POST /api/v1/games/steam/link {"app_id", "ticket"}` (player token). Linked players' ownership is synced on link and nightly, and granted as a base-product entitlement with source `steam`.

## Safety: reports and content removal

Games with chat or user-generated content are user-to-user services under the Online Safety Act and must let players report.

```
POST /api/v1/safety/reports               (player token)  {"type", "subtype", "reported_user_id", "content": {"id", "type"}, "snapshot": {...}, "description"}
POST /api/v1/safety/intake/reports        (server token, scope safety.intake)   same body, plus optional reporter_user_id
POST /api/v1/safety/intake/flags          (server token)  {"classifier", "score": 0.93, "type", "user_id", "content", "snapshot"}
GET  /api/v1/safety/taxonomy              report types and subtypes for your report UI
```

Include a snapshot of the reported content: moderators can't see it otherwise. Flags at or above `safety.flag_auto_report_threshold` open a report automatically.

For uploaded content, add what you know about the upload to `content.upload`. Reports of child sexual abuse material to the NCA must include these details where available:

```json
"content": {
  "id": "img-9", "type": "image", "url": "https://game.example/posts/9",
  "upload": {
    "uploaded_at": "2026-05-01T10:00:00Z",
    "ip": "2001:db8::7", "port": 51234, "ip_at": "2026-05-01T10:00:00Z",
    "exif": { "...": "..." },
    "hash": { "algorithm": "sha256", "value": "…" },
    "platform": "Windows"
  }
}
```

Record the client's source port with its IP. Behind carrier-grade NAT, the IP alone can match thousands of subscribers.

### Preservation requests

When a serious report involves one of your players, you may be asked to preserve their data:

```
GET  /api/v1/safety/intake/preservation-requests       (server token, scope safety.intake)
-> { items: [{ id, user_id, content: { id, type }, window_start, window_end }] }
POST /api/v1/safety/intake/preservation-requests/<id>  {"files": [], "messages": [], "comments": [], "connections": [], "geolocation": [], "other": {}}
```

Send everything you hold for that user between `window_start` and `window_end`: files they uploaded, created, shared or received, with their metadata; chat logs and public and private messages; public comments; location data; and connections or attempted connections with other accounts. Send empty arrays for anything you don't hold. Bodies may be up to 10 MB. The data is encrypted into the evidence store under legal hold. Poll at least daily. Requests carry IDs only and never say why the data is needed.

When moderators remove content, poll and acknowledge:

```
GET  /api/v1/games/server/removal-requests          (server token, scope games.server)
POST /api/v1/games/server/removal-requests/<id>/ack
```

## Entitlements from your store

External payment systems, storefronts or membership integrations grant and revoke with a client-credentials token that staff have given the `games.entitlements.write` scope:

```
POST /api/v1/games/entitlements        {"user_id", "sku", "external_ref": "order-123", "expires_at": null}
POST /api/v1/games/entitlements/revoke {"user_id", "sku", "reason"}
```

Grants are idempotent per source. Revoking through this API only removes the API grant: a player who also owns the product through a key or Steam keeps it.

## Webhooks

Subscribe to `games.entitlement.granted` and `games.entitlement.revoked` (and others) under Admin -> Webhooks Payloads follow [Standard Webhooks](https://www.standardwebhooks.com/) signing and contain IDs only, never content.
