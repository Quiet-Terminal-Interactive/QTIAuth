---
title: HTTP API
description: Conventions, authentication modes, errors, pagination, rate limits and OpenAPI.
order: 1
---

# HTTP API

## Where it lives

- The core API (`/api/v1/me`, `/api/v1/auth/*`, `/api/v1/legal`, `/api/v1/meta/*`) is mounted on every surface under that surface's API path, e.g. `https://id.example.com/api/v1/me` or `https://id.example.com/support/api/v1/me`.
- Module APIs (OIDC, games, safety, support, admin) are mounted only on the surface that owns them, plus the `api` surface.
- OAuth endpoints and `/.well-known/*` live at the root of the `api` surface.

OpenAPI 3.1: `GET <surface api path>/v1/openapi.json` returns the merged document for every service that's running, with each route's authentication, scopes, permissions and rate-limit policy (`x-qtiauth-policy`).

Feature discovery: `GET /api/v1/meta/features` lists enabled modules, sign-in methods, surfaces (origins, base paths, which surface pairs are same-site), CAPTCHA settings and branding. Clients should read this rather than assume what exists.

## Authentication

Each route accepts only the credential types it declares:

| Caller                                    | Credential                                  | Header                                             |
| ----------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| The first-party web app                   | Session cookie (`HttpOnly`, `SameSite=Lax`) | Cookie                                             |
| Third-party apps and game clients         | OAuth access token (JWT)                    | `Authorization: Bearer`                            |
| Game servers and backends                 | Client-credentials access token             | `Authorization: Bearer`                            |
| Game server acting for a signed-in player | Server token and the player's token         | `Authorization: Bearer` + `X-QTIAuth-Player-Token` |

Sending the wrong kind of credential returns `401 WRONG_CREDENTIAL_TYPE`. Session tokens are never accepted as bearer tokens, and access tokens never work on session routes.

State-changing requests with a session cookie must come from one of the surfaces' origins (`Origin` is checked).

## Errors

Errors are RFC 9457 problem documents (`application/problem+json`) with a stable `code`:

```json
{ "type": "https://qtiauth.qtidocs.dev/problems/step-up-required", "title": "Forbidden", "status": 403, "code": "STEP_UP_REQUIRED" }
```

User-facing text is the client's job: map `code` to your own messages. `422 VALIDATION_FAILED` includes `errors: [{ path, message, code }]`.

Codes clients commonly handle:

| Code                                  | Meaning                                            | What to do                                        |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| `UNAUTHENTICATED`                     | No valid credential                                | Sign in                                           |
| `STEP_UP_REQUIRED`                    | The action needs a recent second factor            | Send the user through step-up, then retry         |
| `REAUTHENTICATION_REQUIRED`           | Session security dropped the session's trust       | Re-authenticate                                   |
| `LEGAL_ACCEPTANCE_REQUIRED`           | Updated terms must be accepted                     | Show the documents from `GET /api/v1/me/legal`    |
| `PARENTAL_CONSENT_PENDING`            | A child account is waiting for its guardian        |                                                   |
| `MFA_ENROLMENT_REQUIRED`              | A staff account must turn on two-step verification |                                                   |
| `ACCOUNT_LOCKED` / `ACCOUNT_BANNED`   | Restricted account                                 | Only appeals, support and data-rights routes work |
| `INSUFFICIENT_SCOPE`                  | The token lacks a scope (named in `scope`)         | Request it                                        |
| `RATE_LIMITED`                        | Too many requests                                  | Wait `Retry-After` seconds                        |
| `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED` | A CAPTCHA must be solved                           | See below                                         |

## Rate limits

Every route is rate-limited by named policies (see `rate_limits` in config). Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`, and `429` adds `Retry-After`.

## CAPTCHA

Sensitive routes (signup, password sign-in, magic links, password reset, guest tickets, key redemption) ask for a CAPTCHA only after rate or failure thresholds are hit. The `403 CAPTCHA_REQUIRED` response includes `captcha.provider`, and for ALTCHA a `challenge`. Solve it and retry with the solution in the `captcha` body field or the `X-QTIAuth-Captcha` header. `GET /api/v1/meta/captcha/challenge` returns a fresh challenge.

## Pagination and timestamps

Lists that can grow return `{ items, next_cursor }`. Pass `?cursor=<next_cursor>` for the next page. `next_cursor` is `null` on the last page. Timestamps are RFC 3339 UTC strings.
