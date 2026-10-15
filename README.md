# QTIAuth

Self-hosted, brand-neutral accounts platform: sign-in (password, magic link, passkeys, TOTP, social and upstream OIDC), sessions shared across surfaces and domains, age bands and parental consent, an OAuth 2.1 / OIDC provider, safety and moderation (including the CSEA/NCA workflow), support tickets and a knowledge base, and game services (entitlements, keys, achievements, stats, leaderboards, playtime, cloud saves, licensing, Steam).

Guides for operators, integrators and staff are available at https://qtiauth.qtidocs.dev

## Layout

| Path         | What                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/*` | Shared libraries: config, bus (NATS JetStream), db (Kysely + migrations), auth-context, service-kit, text-filter, markdown, `qtiauth` CLI |
| `services/*` | gateway, identity, notifier, scheduler, oidc, safety, support, games, backup                                                              |
| `apps/web`   | Server-rendered web app (Hono JSX) for the account and support surfaces                                                                   |
| `config/`    | `qtiauth.yaml`, legal documents, word lists, branding                                                                                     |
| `deploy/`    | Docker entrypoint, Postgres roles, NATS, Caddy, GeoIP updater, observability                                                              |

## Running it

```sh
cp .env.example .env              # fill in every secret (openssl rand -hex 32)
$EDITOR config/qtiauth.yaml       # surfaces/hosts, branding, email provider, features
docker compose up -d              # core: gateway, identity, notifier, scheduler, web
docker compose --profile oidc --profile games --profile support --profile safety up -d
docker compose run --rm identity qtiauth admin create --email you@example.com
```

Optional profiles: `oidc`, `safety`, `support`, `games`, `storage` (SeaweedFS, an S3-compatible store; any external S3 works too), `geoip`, `edge` (Caddy with automatic HTTPS), `backup`, `observability` (Prometheus, Alertmanager, Grafana, Tempo, Loki).

Each service applies its own migrations at startup. Run `qtiauth config check` to validate configuration without starting anything.

## Theming

The web app takes all its colours from `branding.colors` in `qtiauth.yaml`. The shipped default is a dark theme:

| Key                | Default   |                  |
| ------------------ | --------- | ---------------- |
| `background`       | `#222034` | Midnight Express |
| `primary` / `info` | `#5BB1EF` | Cornflower Blue  |
| `accent`           | `#BC6DE0` | Medium Orchid    |
| `success`          | `#80D35D` | Pastel Green     |
| `warning`          | `#F7DA47` | Energy Yellow    |
| `danger`           | `#DD5F5F` | Roman            |
| `highlight`        | `#FF954F` | Coral            |

Override any of them, along with `surface`, `surface_raised`, `border`, `text`, `text_muted`, `primary_text`, the `palette` used for badges, and `scheme: dark | light`. `font_family`, `heading_font_family` and `border_radius` are configurable too. `custom_css` takes inline CSS, or a path to a `.css` file in the config directory, which is appended after the theme. The logo and favicon come from `branding.logo` and `branding.favicon`. Email templates use the same colours.

## Development

Needs Node 22.18+, pnpm, and `nats-server` and `valkey-server` on `PATH` for integration tests (Postgres is embedded).

```sh
pnpm install
pnpm typecheck
pnpm test                 # unit + integration
pnpm lint:literals        # no deployment-specific literals in source
node apps/web/build.ts    # bundle the web app (done in the Docker build)
```

Security reports: see [SECURITY.md](SECURITY.md).
