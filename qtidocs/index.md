---
title: QTIAuth
description: Self-hosted accounts platform with sign-in, an OAuth/OIDC provider, safety and moderation, support, and game services.
---

# QTIAuth

QTIAuth is a self-hosted, brand-neutral accounts platform. It covers:

- Sign-in: password, magic link, passkeys, TOTP, social and upstream OIDC.
- Accounts: sessions shared across surfaces and domains, age bands and parental consent.
- Integration: an OAuth 2.1 / OIDC provider for other apps.
- Safety and support: moderation including the CSEA/NCA workflow, support tickets and a knowledge base.
- Game services: entitlements, keys, achievements, stats, leaderboards, playtime, cloud saves, licensing and Steam.

## Where to start

| Guide                                                   | For                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Getting started](/getting-started)                     | Installing a stack, first admin, choosing profiles, hosts and TLS                                             |
| [Configuration](/configuration)                         | `qtiauth.yaml`, secrets, feature flags, surfaces, validation                                                  |
| [Theming and localisation](/theming)                    | Colours, fonts, logo, custom CSS, email templates, legal documents, adding a language                         |
| [Operations](/operations)                               | The `qtiauth` CLI, upgrades and migrations, backups and restore, retention, scaling                           |
| [Observability and alerting](/operations/observability) | Metrics, dashboards, alert rules, Alertmanager channels, logs, traces                                         |
| [HTTP API](/integrating/api)                            | Conventions, authentication modes, errors, pagination, rate limits, OpenAPI                                   |
| [Apps (OAuth/OIDC)](/integrating/apps)                  | Registering clients, sign-in flows, scopes, tokens, back-channel logout                                       |
| [Games](/integrating/games)                             | Player sign-in, achievements, stats and leaderboards, playtime, licensing, cloud saves, Steam, safety reports |
| [Staff guide](/staff-guide)                             | Admin, moderation and CSEA cases, appeals, support tickets, the knowledge base, games admin                   |
| [Architecture](/architecture)                           | How the services, gateway, sessions and bus fit together                                                      |

The full design and its rationale are in `SPEC.md` at the root of the repository. To report a security issue, see `SECURITY.md`.
