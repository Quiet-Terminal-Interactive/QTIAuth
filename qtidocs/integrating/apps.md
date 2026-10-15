---
title: Apps (OAuth/OIDC)
description: Registering clients, sign-in flows, scopes, tokens and back-channel logout.
order: 2
---

# Integrating apps (OAuth 2.1 / OpenID Connect)

Needs the `oidc` profile. Any standards-compliant OIDC client library works.

Discovery: `https://<api host><api base>/.well-known/openid-configuration`. For example, with everything on one host under `/api`: `https://id.example.com/api/.well-known/openid-configuration`.

| Endpoint                      | Path (relative to the api surface root) |
| ----------------------------- | --------------------------------------- |
| Authorization                 | `/oauth/authorize`                      |
| Token                         | `/oauth/token`                          |
| UserInfo                      | `/oauth/userinfo`                       |
| Revocation                    | `/oauth/revoke`                         |
| Introspection                 | `/oauth/introspect`                     |
| Pushed authorization requests | `/oauth/par`                            |
| Device authorization          | `/oauth/device/code`                    |
| Signing keys                  | `/.well-known/jwks.json`                |

## Registering a client

Signed-in users register clients in the Developer portal (`/developer` on the account site), up to `features.oidc.developer_portal.max_clients_per_user`:

- Confidential clients (server-side apps) get a secret, shown once. Regenerating it needs step-up.
- Public clients (mobile, desktop, single-page apps) have no secret and rely on PKCE.
- Redirect URIs must match exactly. Native apps may use loopback URIs (`http://127.0.0.1/callback`) on any port.

New clients work immediately. Until staff verify them, the consent screen shows an "Unverified app" notice. Names containing the product name are refused for unverified clients. First-party clients declared in `oidc.first_party_clients` skip consent entirely.

## Sign-in: authorization code + PKCE

PKCE with `S256` is required for every client.

```
GET /oauth/authorize?response_type=code&client_id=…&redirect_uri=…
    &scope=openid profile email&state=…&nonce=…
    &code_challenge=…&code_challenge_method=S256
```

The user signs in if needed and sees the consent screen. They're asked again only when you request new scopes. Exchange the code:

```
POST /oauth/token
grant_type=authorization_code&code=…&redirect_uri=…&code_verifier=…&client_id=…
```

Confidential clients authenticate with `client_secret_basic` or `client_secret_post`. You receive an access token (a JWT with `aud` set to the API resource), an ID token (`ES256` by default) and, with `offline_access`, a refresh token.

`prompt=none` returns `login_required` when the user isn't signed in. `prompt=login` and `max_age` force re-authentication.

## Refresh tokens

Refresh tokens rotate on every use. Presenting an already-used refresh token revokes the whole token family (reuse detection), so store only the newest one. Refresh tokens tied to a browser session end when that session ends, except `offline_access` tokens, which survive until the account is locked, banned or deleted.

## Devices without a browser (consoles, CLIs, TVs)

```
POST /oauth/device/code          client_id=…&scope=openid profile offline_access
-> { device_code, user_code, verification_uri, verification_uri_complete, interval, expires_in }
```

Show `user_code` and `verification_uri` (the account site's `/device` page), then poll:

```
POST /oauth/token  grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…&client_id=…
```

Respect `interval`. Polling faster returns `slow_down`.

## Machine-to-machine

```
POST /oauth/token  grant_type=client_credentials&scope=…   (with client authentication)
```

Service scopes such as `games.entitlements.write` can't be self-assigned. Staff grant them under Admin -> OAuth clients.

## Scopes and claims

| Scope                                 | Releases                                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `openid`                              | `sub`                                                                                                          |
| `profile`                             | `preferred_username`, `username_updated_at`                                                                    |
| `email`                               | `email`, `email_verified`                                                                                      |
| `offline_access`                      | A long-lived refresh token                                                                                     |
| `age`                                 | `age_band` (`under_13`, `13_to_15`, `16_to_17`, `adult`) and `age_assurance_strength`. Never the date of birth |
| `parental_controls`                   | The guardian's controls for child accounts                                                                     |
| `restrictions`                        | Active moderation restrictions (e.g. `chat`, `ugc`)                                                            |
| `games`, `achievements`, `game_stats` | Read access to the player's games data                                                                         |

Deployments can add their own scopes in `oidc.scopes`.

Child accounts: when a child's guardian has "approve third-party apps" switched on, consenting to your app sends a request to the guardian instead. The authorization completes only once they approve. Design your UI to handle a user who doesn't come back straight away.

## Verifying access tokens on your own API

Access tokens are JWTs. Verify them locally against `/.well-known/jwks.json`, checking `iss`, `aud`, `exp` and the scopes you need. For immediate revocation checks, call `/oauth/introspect`.

## Back-channel logout

Register a `backchannel_logout_uri` on your client. When a session ends anywhere (sign-out on any surface, revocation, lock, ban or deletion), QTIAuth POSTs a signed `logout_token` (`iss`, `aud`, `sub`, `sid`, `events`, `jti`) to every client that received tokens during that session. Deliveries are retried and listed on the client's page in the developer portal.

QTIAuth doesn't yet offer RP-initiated logout (an `end_session_endpoint`). To sign a user out of QTIAuth itself, send them to the account site's sign-out.
