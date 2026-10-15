---
title: Architecture
description: How the services, gateway, sessions and bus fit together.
order: 7
---

# Architecture

```
 browsers / games / game servers
              │
         ┌────▼────┐   surfaces, sessions, route policy, rate limits, CORS, CAPTCHA,
         │ gateway │   security headers, internal identity tokens
         └────┬────┘
   HTTP  ┌────┴─────────┬──────────┬──────────┬─────────┬────────┐
     identity        oidc      safety    support    games      web (SSR)
         │              │          │          │         │
 ════════╧══════════════╧══════════╧══════════╧═════════╧═══ NATS JetStream
         │                         │                         (events + request/reply)
     notifier                 scheduler                 backup
 Postgres (one schema and role per service) · Valkey · object storage
```

## Services

| Service   | Owns                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gateway   | The only public entry point. Maps hosts to surfaces, resolves sessions, enforces each route's declared policy, rate limits, CAPTCHA, CORS and security headers   |
| identity  | Accounts, every sign-in method, sessions, age and parental consent, legal acceptance, usernames, the text filter, roles, the audit log, data export and deletion |
| notifier  | Email (provider abstraction, templates, delivery log, suppressions) and outbound webhooks                                                                        |
| scheduler | Publishes cron ticks. Each job runs on exactly one replica of the service that owns it                                                                           |
| web       | Server-rendered pages for the account and support surfaces                                                                                                       |
| oidc      | OAuth 2.1 / OpenID Connect provider and developer portal                                                                                                         |
| safety    | Reports, moderation, appeals, CSEA cases and legal holds                                                                                                         |
| support   | Tickets and the knowledge base                                                                                                                                   |
| games     | Catalogue, entitlements, keys, achievements, stats, leaderboards, playtime, cloud saves, licensing, Steam                                                        |
| backup    | Scheduled encrypted backups                                                                                                                                      |

## How a request flows

1. The gateway matches the host and path to a surface and a route from the live route table. Services publish their routes, policies and permissions when they start, so a disabled service's routes don't exist.
2. It authenticates the caller according to the route's policy: a session cookie, an OAuth access token, a client-credentials token, or a game server token plus a player token.
3. It applies rate limits, CAPTCHA, account-state, legal and parental gates, permissions and step-up.
4. It forwards the request with a 60-second signed internal identity token describing the caller. Services verify that token and never read cookies or bearer tokens themselves.

The web app is just another upstream. It renders pages and calls the same APIs back through the gateway's internal port, on the user's behalf.

## Sessions across surfaces and domains

A user has one server-side session. Each host the user visits gets its own cookie (a binding) pointing at that session. When a surface without a binding needs a session, it redirects to the account surface, which issues a single-use code bound to the target origin. That surface exchanges the code for its own cookie. This works across different registrable domains because every step is a top-level navigation. Signing out or revoking anywhere ends the session everywhere.

Session tokens are random 256-bit values stored hashed. They aren't JWTs, so revocation is immediate.

## Data and events

- Each service has its own Postgres schema and login role with no access to other schemas. Services share data by asking over the bus or by keeping a local copy fed by events.
- State changes and their events are written in one transaction (a transactional outbox), then relayed to JetStream. Consumers are idempotent.
- Deleting an account emits `identity.user.deleted`. Every service erases or anonymises its data and reports back. When all have, the deletion is recorded in the ledger at the backup destination.

## Keys

Each purpose has its own key, generated by its owning service, stored wrapped by `KEY_ENCRYPTION_KEY`, and rotated automatically:

| Purpose                                  | Owner   | Published at                             |
| ---------------------------------------- | ------- | ---------------------------------------- |
| Internal identity tokens                 | gateway | internal only                            |
| OIDC ID, access and logout tokens        | oidc    | `/.well-known/jwks.json`                 |
| Game licence leases and revocation lists | games   | `/.well-known/qtiauth-license-keys.json` |
