---
title: Configuration
description: qtiauth.yaml, secrets, feature flags, surfaces and validating your config.
order: 2
---

# Configuration

Everything that isn't a secret lives in `config/qtiauth.yaml`. Secrets live in `.env`. Every service reads the same file and refuses to start if it's invalid, printing the exact path of each problem.

```sh
docker compose run --rm identity qtiauth config check     # validate config, cron schedule and email templates
docker compose run --rm identity qtiauth config schema    # write the JSON Schema (for editor autocompletion)
```

## Conventions

- Secrets: write `"${env:NAME}"` to read an environment variable, `"${env:NAME:-fallback}"` for a default, or `"${file:/run/secrets/name}"` to read a Docker secret.
- Durations: `30s`, `15m`, `12h`, `7d`, `2w`, `1y`, or combinations like `1h30m`.
- Defaults: every key has a default. You only need to set what you change. Defaults are brand-neutral (`Example`, `example.com`, no reserved username prefixes).
- Paths: relative paths (logo, legal directory, word lists, custom CSS) are relative to the config directory.

## Sections

| Section            | What it controls                                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `branding`         | Product and company name, support email, logo, favicon, colours, fonts, custom CSS, locales, footer links. See [theming](/theming)                                                                                                                                                      |
| `surfaces`         | Hosts, ports and base paths for the account, support and api surfaces. `modules` overrides which modules each surface owns                                                                                                                                                              |
| `cookies`          | Session cookie name, `secure`, optional shared `domain`, `session_ttl`, `idle_timeout`                                                                                                                                                                                                  |
| `cors`             | Extra allowed origins for public (non-credentialed) API calls. Surface origins are added automatically                                                                                                                                                                                  |
| `network`          | `trusted_proxies` (CIDRs), `client_port_header` (the header your proxy puts the client's source port in, default `x-client-port`) and extra listen ports for the gateway                                                                                                                |
| `infrastructure`   | NATS, Valkey and gateway URLs, internal port, RPC timeout                                                                                                                                                                                                                               |
| `geoip`            | `dbip_lite`, `maxmind`, `header` (trust a proxy header) or `none`                                                                                                                                                                                                                       |
| `migrations`       | `auto_apply: false` makes services refuse to start with pending migrations                                                                                                                                                                                                              |
| `features`         | Switches for every sub-feature: auth methods, social providers, developer portal, device flow, PAR, back-channel logout, games features, support features, data export                                                                                                                  |
| `storage`          | S3-compatible object storage (`provider: s3`, endpoint, public endpoint for presigned URLs, bucket, keys)                                                                                                                                                                               |
| `captcha`          | `altcha` (self-hosted, default), `turnstile`, `hcaptcha`, `friendly_captcha` or `none`                                                                                                                                                                                                  |
| `email`            | Provider and credentials, sender identities per category (auth, security, support), retries                                                                                                                                                                                             |
| `accounts`         | Accounts per email, deletion grace period, link lifetimes, minimum signup age, email normalisation rules per domain                                                                                                                                                                     |
| `sessions`         | Maximum sessions per user                                                                                                                                                                                                                                                               |
| `password`         | Length limits, optional composition rules, breach check, Argon2 parameters, reset link lifetime                                                                                                                                                                                         |
| `security`         | Step-up window, which permissions require two-step verification, WebAuthn relying party                                                                                                                                                                                                 |
| `age`              | Age band boundaries and the pluggable age-assurance provider                                                                                                                                                                                                                            |
| `parental`         | Consent age, how long a pending child account waits, guardians per child, default controls                                                                                                                                                                                              |
| `session_security` | What happens on a country change (`challenge`, `block`, `notify`, `ignore`), new-device emails, signal weights                                                                                                                                                                          |
| `legal`            | Legal documents directory, which documents signup requires, public version history                                                                                                                                                                                                      |
| `usernames`        | Length, character set, change cooldown and yearly limit, reserved names and prefixes, release hold                                                                                                                                                                                      |
| `oidc`             | Issuer, token lifetimes, ID token algorithm, scopes and their consent text, first-party clients                                                                                                                                                                                         |
| `keys`             | Signing key rotation interval and overlap                                                                                                                                                                                                                                               |
| `roles`            | Built-in roles and their permissions (editable later in the admin UI)                                                                                                                                                                                                                   |
| `safety`           | Report taxonomy and SLAs, moderation action types, rules shown to users, two-person bans, accountable person, CSEA alert recipients, NCA submission targets by priority (`nca_deadlines`), and evidence and reference retention (statutory minimums of one and five years are enforced) |
| `support`          | Ticket categories, auto-close, guest code lifetime, attachment limits, canned replies                                                                                                                                                                                                   |
| `games`            | Lease duration, cloud-save quotas, key format                                                                                                                                                                                                                                           |
| `webhooks`         | Auto-disable threshold, private targets, retry window, endpoints seeded from config                                                                                                                                                                                                     |
| `rate_limits`      | Named policies (`per`, `limit`, `window`, `fail`, `captcha_after`) used by routes                                                                                                                                                                                                       |
| `retention`        | How long sessions, security events, delivery logs, audit log, closed tickets and resolved reports are kept                                                                                                                                                                              |
| `backups`          | Retention and destination (`volume` or `s3`)                                                                                                                                                                                                                                            |
| `schedule`         | Cron expressions (UTC) for every scheduled job. Set a job to `off` to disable it                                                                                                                                                                                                        |
| `observability`    | Log level, OTLP endpoint for traces, trace sampling                                                                                                                                                                                                                                     |

## Examples

Social sign-in with Google:

```yaml
features:
  auth:
    social:
      google: { enabled: true, client_id: "${env:GOOGLE_CLIENT_ID}", client_secret: "${env:GOOGLE_CLIENT_SECRET}" }
```

The provider's redirect URI is `https://<account host>/api/v1/auth/social/google/callback`.

Any OpenID Connect provider (Keycloak, Authentik, Entra, Apple):

```yaml
features:
  auth:
    social:
      generic_oidc:
        - id: company_sso
          name: "Company SSO"
          issuer: https://sso.example.com/realms/main
          client_id: "${env:SSO_CLIENT_ID}"
          client_secret: "${env:SSO_CLIENT_SECRET}"
```

Stricter rate limit on password sign-in:

```yaml
rate_limits:
  auth_password: { per: [ip, account], limit: 5, window: 15m, captcha_after: 3 }
```

A first-party app that skips the consent screen:

```yaml
oidc:
  first_party_clients:
    - client_id: launcher
      name: "Game Launcher"
      type: public
      redirect_uris: ["http://127.0.0.1/callback"]
      scopes: [openid, profile, email, offline_access, games]
```

## Changing configuration

Services read configuration at startup. After editing, restart the affected services:

```sh
docker compose up -d --force-recreate
```

Enabling a feature that needs a service that isn't running (for example `features.games.licensing` without the `games` profile) is reported on `/api/v1/meta/health` and the admin health page.
