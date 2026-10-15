---
title: Observability and alerting
description: Metrics, dashboards, alert rules, Alertmanager channels, logs and traces.
order: 1
---

# Observability and alerting

The `observability` profile runs Prometheus, Alertmanager, Grafana, Tempo (traces), Loki (logs) and Alloy (log shipping), all pre-wired.

```sh
docker compose --profile observability up -d
```

Grafana listens on `127.0.0.1:3001` (change it with `GRAFANA_PORT`). Sign in as `admin` with `GRAFANA_ADMIN_PASSWORD`. Prometheus and Alertmanager are only reachable inside the stack. Use `docker compose exec` or put them behind your own authenticated proxy.

## Metrics

Every service exposes Prometheus metrics on its internal port (`/metrics`), and the gateway on port 8081. Labels never carry user IDs, emails, IPs or other unbounded values. The catalogue covers HTTP, auth, sessions, accounts, the text filter, rate limiting, the bus (including consumer lag and outbox age), email and webhooks, OIDC, safety, support, games, cron jobs, migrations and backups.

## Dashboards

The QTIAuth folder in Grafana has: Stack overview, Gateway, Auth and sessions, Bus, Notifier, OIDC, Safety, Support, Games, Infra.

## Alert rules

Prometheus evaluates `deploy/observability/prometheus/alerts.yml`:

| Alert                      | Fires when                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------- |
| HighErrorRate              | Over 5% of requests return 5xx for 5 minutes                                          |
| AuthFailureSpike           | Sign-in failures run three times above the 6-hour norm (possible credential stuffing) |
| OutboxBacklogOld           | Events have waited in a service's outbox for over 5 minutes                           |
| ConsumerLag                | A bus consumer has over 1,000 messages waiting                                        |
| WebhookEndpointDisabled    | A webhook endpoint was auto-disabled                                                  |
| SafetySlaBreaches          | Reports breached their moderation SLA                                                 |
| CseaSubmissionOverdue      | A CSEA case is past its NCA submission target (`safety.nca_deadlines`)                |
| NcaRequestOverdue          | An NCA request is past the seven-day legal deadline                                   |
| BackupFailed / BackupStale | A backup failed, or none succeeded in two days                                        |
| KeyRotationOverdue         | A signing key is older than its rotation period                                       |
| SchedulerStalled           | No cron tick for 10 minutes                                                           |
| RateLimiterFailingOpen     | Valkey errors are affecting rate limits                                               |
| ServiceDown                | A service stopped answering scrapes                                                   |

Edit the file to tune thresholds or add rules. Prometheus picks up changes when it restarts.

## Alert delivery (Alertmanager)

Alertmanager's config is generated from `.env` at startup, so channel secrets never sit in a committed file. Set any combination:

| Channel       | Variables                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Email         | `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM`, `ALERT_SMTP_HOST` (`host:port`), `ALERT_SMTP_USER`, `ALERT_SMTP_PASSWORD`           |
| Discord       | `ALERT_DISCORD_WEBHOOK_URL`                                                                                               |
| Slack         | `ALERT_SLACK_WEBHOOK_URL`, optional `ALERT_SLACK_CHANNEL`                                                                 |
| Anything else | `ALERT_WEBHOOK_URL`: receives Alertmanager's standard webhook JSON (PagerDuty, Opsgenie, ntfy bridges, your own endpoint) |

Alerts are grouped by alert name and service. Warnings repeat every 4 hours (`ALERT_REPEAT_INTERVAL`), critical alerts every hour (`ALERT_CRITICAL_REPEAT_INTERVAL`). A critical alert suppresses the warning of the same name. Resolved notifications are sent too.

After changing these variables:

```sh
docker compose --profile observability up -d --force-recreate alertmanager
```

To check delivery, fire a test alert:

```sh
docker compose exec alertmanager amtool alert add TestAlert severity=warning service=gateway \
  --annotation=summary="Test alert" --alertmanager.url=http://localhost:9093
```

With no channel configured, alerts still appear in Grafana (Alerting -> Alert rules, Alertmanager data source) and in the Alertmanager UI.

Alert delivery is separate from the platform's own staff notifications. The notifier still emails staff about new tickets, high-priority reports and CSEA cases, and posts events to webhooks configured under Admin -> Webhooks.

## Logs

Services log structured JSON to stdout with `service`, `level`, `trace_id` and `request_id`, and a hashed user ID where relevant. Tokens, passwords, codes, Steam tickets, report content and email bodies are never logged. Alloy ships container logs to Loki. In Grafana, query with `{service="identity"} | json`, and follow a `trace_id` straight to its trace in Tempo.

## Traces

Set `observability.otlp_endpoint: http://tempo:4318` in `qtiauth.yaml`. Traces follow a request from the gateway through services and across the bus. `observability.trace_sample_ratio` controls sampling.
