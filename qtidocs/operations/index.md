---
title: Operations
description: The qtiauth CLI, upgrades and migrations, backups and restore, retention and scaling.
order: 4
---

# Operations

## The `qtiauth` CLI

Every service image includes the CLI. Run it through the service whose data it touches:

```sh
docker compose run --rm <service> qtiauth <command>
```

| Command                                      | Run in                           | Does                                                                                  |
| -------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| `config check`                               | any                              | Validates `qtiauth.yaml`, the cron schedule and every email template                  |
| `config schema [out.json]`                   | any                              | Writes the configuration JSON Schema                                                  |
| `migrate status` / `migrate up`              | each service, or `--service all` | Shows or applies database migrations                                                  |
| `admin create --email <addr> [--role admin]` | identity                         | One-time signup link for a staff account                                              |
| `audit verify`                               | identity                         | Checks the audit log's hash chain for tampering                                       |
| `lists update [--ldnoobw <commit>]`          | identity                         | Refreshes the text-filter word lists                                                  |
| `lists audit`                                | identity                         | Prints dictionary words that contain a block-list entry (review after updating lists) |
| `user export <id> [--out file.zip]`          | identity                         | Full data export for one user                                                         |
| `user delete <id> --yes`                     | identity                         | Deletes a user immediately, skipping the grace period                                 |
| `keys rotate`                                | oidc, games                      | Rotates the OIDC or licensing signing key now                                         |
| `steam sync`                                 | games                            | Runs the Steam ownership sync now                                                     |
| `backup run` / `backup list`                 | backup                           | Takes a backup now, or lists backups                                                  |
| `backup verify <id>`                         | backup                           | Restores into a scratch database and checks it, without touching live data            |
| `backup restore <id> --yes`                  | backup                           | Restores onto the live stack (see below)                                              |

`qtiauth help` lists everything available in an image.

## Upgrades and migrations

Each service owns the migrations for its own database schema and applies them when it starts, holding a lock so replicas don't race. Upgrading one service's image migrates only that service.

```sh
docker compose pull            # or rebuild
docker compose up -d
```

Migrations are expand-only within a release: the previous version of a service keeps working against the new schema, so you can roll replicas one at a time. If you prefer to apply migrations by hand, set `migrations.auto_apply: false`. A service with pending migrations then refuses to start and logs the exact command to run:

```sh
docker compose run --rm identity qtiauth migrate up
```

## Backups

With the `backup` profile, `backup.run` (02:30 UTC by default) dumps every schema with `pg_dump` and writes:

- one encrypted dump per schema,
- an encrypted manifest of object-storage keys (copying the objects themselves is your storage provider's job),
- a plain `manifest.json` with sizes and checksums (no personal data).

Backups go to the `backups` volume, or to S3 with `backups.destination.type: s3`. They're pruned after `backups.retention` (35 days by default). Backups can only be read by restoring them onto a stack with the same `BACKUP_ENCRYPTION_KEY`.

**Test your backups.** `backup verify <id>` restores every schema into a throwaway database and reports table and migration counts. It never touches live data.

### Restoring

```sh
docker compose run --rm backup qtiauth backup list
docker compose run --rm backup qtiauth backup restore <id> --yes
```

Restore:

1. puts the stack into maintenance mode (the gateway returns `503` except for health checks),
2. decrypts and restores every schema,
3. runs migrations for the service versions you're running now,
4. replays the deletion ledger: any account deleted since the backup was taken is erased again, including its stored objects,
5. revokes every restored session, since they may have been revoked after the backup,
6. clears caches and leaves maintenance mode.

If a step fails, the stack stays in maintenance mode. Fix the problem and run the restore again.

### The deletion ledger

When an account's erasure completes, its ID and deletion time are written to the backup destination, not the main database. Because the ledger is always newer than any backup, a restore can never bring a deleted account back. Ledger entries are kept for the backup retention period plus `deletion_ledger.extra_retention`.

## Retention

The daily `retention.sweep` in every service deletes data past the periods in `retention` (sessions, security events, tokens, delivery logs, audit log, closed tickets, resolved reports). Staff with `system.retention` can trigger it from **Admin -> Health**.

## Scaling

Every application service is stateless apart from Postgres, Valkey and NATS, so you can run replicas:

```yaml
services:
  identity:
    deploy: { replicas: 3 }
```

The gateway discovers instances over the bus and load-balances across them. Scheduled jobs run on exactly one replica. Valkey holds no source of truth: wiping it signs nobody out.

## Maintenance mode

Restores set it automatically. To set it by hand:

```sh
docker compose exec valkey valkey-cli set qtiauth:maintenance manual
docker compose exec valkey valkey-cli del qtiauth:maintenance
```

## Health

- `GET /healthz` and `/readyz` on the gateway (no authentication).
- `GET /api/v1/meta/health` gives overall status. Staff with `system.health.read` get per-service detail and configuration warnings (no GeoIP database, no storage, staff without two-step verification, cross-site surfaces, and so on).
- Admin -> Health shows the same in the web app.
