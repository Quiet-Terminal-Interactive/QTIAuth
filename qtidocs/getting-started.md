---
title: Getting started
description: Install a stack, create the first admin, choose profiles, and set up hosts and TLS.
order: 1
---

# Getting started

QTIAuth runs as one Docker Compose stack. The core services always run; everything else is a Compose profile you switch on.

## Requirements

- Docker with Compose v2 (Docker Engine 24+).
- A host with at least 2 vCPU and 4 GB RAM for the core plus a few profiles (8 GB with `observability`).
- A domain name if you want public HTTPS.

## 1. Secrets

```sh
cp .env.example .env
```

Fill in every value under *Encryption* and *Infrastructure*. Generate each one with `openssl rand -hex 32`. Keep `.env` out of version control and back it up somewhere safe: without `APP_ENCRYPTION_KEY`, `KEY_ENCRYPTION_KEY` and `BACKUP_ENCRYPTION_KEY` you can't read TOTP secrets, signing keys or backups.

| Variable                             | Used for                                                              |
| ------------------------------------ | --------------------------------------------------------------------- |
| `APP_ENCRYPTION_KEY`                 | TOTP secrets, CSEA evidence, product key codes, webhook secrets       |
| `KEY_ENCRYPTION_KEY`                 | Wraps every service's signing keys (internal tokens, OIDC, licensing) |
| `BACKUP_ENCRYPTION_KEY`              | Encrypts backups                                                      |
| `POSTGRES_PASSWORD`, `*_DB_PASSWORD` | Database superuser and one role per service                           |
| `NATS_PASSWORD`                      | The message bus                                                       |
| `ALTCHA_HMAC_KEY`                    | The built-in proof-of-work CAPTCHA                                    |

## 2. Configuration

Edit `config/qtiauth.yaml`. At minimum set:

- `branding`: product name, company name, support email, logo.
- `surfaces`: the hosts users reach the site on (see below).
- `email`: a real provider (`smtp`, `brevo`, `postmark`, `ses`, `resend`, `mailgun`). `console` only logs emails.
- `legal`: replace the sample documents in `config/legal/` with your own terms and privacy policy.

Check it before starting:

```sh
docker compose run --rm identity qtiauth config check
```

### Surfaces and hosts

The web app has three surfaces: account (sign-in, settings, admin), support (help centre and tickets) and api (OAuth endpoints and machine clients). Each can live on its own host, or share one host with different base paths:

```yaml
# One host
surfaces:
  account: { hosts: [id.example.com], base_path: / }
  support: { hosts: [id.example.com], base_path: /support }
  api:     { hosts: [id.example.com], base_path: /api }
```

```yaml
# Separate hosts (even on different registrable domains)
surfaces:
  account: { hosts: [account.example.com], base_path: / }
  support: { hosts: [help.example.com],    base_path: / }
  api:     { hosts: [auth.example.com],    base_path: / }
```

Sign-in happens on the account surface. Other surfaces pick up the same session automatically through a redirect, so users sign in once.

## 3. Choose profiles

| Profile         | Adds                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| *(none)*        | gateway, identity, notifier, scheduler, web, Postgres, Valkey, NATS                                                                                    |
| `oidc`          | OAuth 2.1 / OpenID Connect provider and developer portal                                                                                               |
| `safety`        | Reporting, moderation, appeals, CSEA workflow                                                                                                          |
| `support`       | Tickets and knowledge base                                                                                                                             |
| `games`         | Catalogue, entitlements, keys, achievements, stats, leaderboards, playtime, cloud saves, licensing, Steam                                              |
| `storage`       | Bundled S3-compatible object storage (SeaweedFS). Needed for attachments, KB images, cloud saves and large data exports, unless you use an external S3 |
| `geoip`         | Keeps a country database current for session security                                                                                                  |
| `edge`          | Caddy in front of the gateway with automatic HTTPS                                                                                                     |
| `backup`        | Scheduled encrypted backups                                                                                                                            |
| `observability` | Prometheus, Alertmanager, Grafana, Tempo, Loki                                                                                                         |

Turning on a feature in config whose service isn't running is reported at `/api/v1/meta/health` and on the admin health page.

```sh
docker compose --profile oidc --profile safety --profile support --profile games \
  --profile storage --profile backup --profile edge up -d
```

Every service applies its own database migrations when it starts.

## 4. HTTPS

Either:

- Use the `edge` profile. Set `QTIAUTH_HOSTS` in `.env` to every host in your surfaces (space-separated) and `ACME_EMAIL`. Caddy gets certificates automatically and forwards to the gateway.
- Or use your own reverse proxy. Forward to the gateway on `HTTP_PORT` (default 8080), and add the proxy's addresses to `network.trusted_proxies` so client IPs are read from `X-Forwarded-For`. Without that, the proxy's own address is used for rate limiting and session security. Also have the proxy send the client's source port in `X-Client-Port` (for Caddy: `header_up X-Client-Port {remote_port}`; for nginx: `proxy_set_header X-Client-Port $remote_port;`). CSEA reports to the NCA need the port as well as the IP.

Keep `cookies.secure: true` in production.

## 5. First administrator

There are no default credentials. Create a one-time signup link:

```sh
docker compose run --rm identity qtiauth admin create --email you@example.com
```

Open the link, choose a password, then turn on two-step verification. Staff accounts can't do anything else until they do.

## 6. Next steps

- Add more staff and roles under Admin -> Users and Admin -> Roles. See the [staff guide](/staff-guide).
- Set up alert delivery: see [observability](/operations/observability).
- Schedule and test backups: see [operations](/operations).
- Register OAuth clients or games: see [integrating apps](/integrating/apps) and [integrating games](/integrating/games).
