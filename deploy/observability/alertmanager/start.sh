#!/bin/sh
set -eu
dir=/tmp/alertmanager
mkdir -p "$dir"
cfg="$dir/alertmanager.yml"
secret() { printf '%s' "$2" > "$dir/$1"; chmod 600 "$dir/$1"; }

{
  echo "route:"
  echo "  receiver: default"
  echo "  group_by: [alertname, service]"
  echo "  group_wait: 30s"
  echo "  group_interval: 5m"
  echo "  repeat_interval: ${ALERT_REPEAT_INTERVAL:-4h}"
  echo "  routes:"
  echo "    - matchers: ['severity=\"critical\"']"
  echo "      receiver: default"
  echo "      repeat_interval: ${ALERT_CRITICAL_REPEAT_INTERVAL:-1h}"
  echo "inhibit_rules:"
  echo "  - source_matchers: ['severity=\"critical\"']"
  echo "    target_matchers: ['severity=\"warning\"']"
  echo "    equal: [alertname]"
  echo "receivers:"
  echo "  - name: default"
  if [ -n "${ALERT_EMAIL_TO:-}" ]; then
    echo "    email_configs:"
    echo "      - to: '${ALERT_EMAIL_TO}'"
    echo "        from: '${ALERT_EMAIL_FROM:-alerts@localhost}'"
    echo "        smarthost: '${ALERT_SMTP_HOST:-localhost:587}'"
    echo "        send_resolved: true"
    if [ -n "${ALERT_SMTP_USER:-}" ]; then
      secret smtp_password "${ALERT_SMTP_PASSWORD:-}"
      echo "        auth_username: '${ALERT_SMTP_USER}'"
      echo "        auth_password_file: $dir/smtp_password"
    fi
  fi
  if [ -n "${ALERT_DISCORD_WEBHOOK_URL:-}" ]; then
    secret discord_url "$ALERT_DISCORD_WEBHOOK_URL"
    echo "    discord_configs:"
    echo "      - webhook_url_file: $dir/discord_url"
    echo "        send_resolved: true"
  fi
  if [ -n "${ALERT_SLACK_WEBHOOK_URL:-}" ]; then
    secret slack_url "$ALERT_SLACK_WEBHOOK_URL"
    echo "    slack_configs:"
    echo "      - api_url_file: $dir/slack_url"
    [ -n "${ALERT_SLACK_CHANNEL:-}" ] && echo "        channel: '${ALERT_SLACK_CHANNEL}'"
    echo "        send_resolved: true"
    echo "        title: '{{ .Status | toUpper }}: {{ .CommonAnnotations.summary }}'"
  fi
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    secret webhook_url "$ALERT_WEBHOOK_URL"
    echo "    webhook_configs:"
    echo "      - url_file: $dir/webhook_url"
    echo "        send_resolved: true"
  fi
} > "$cfg"

amtool check-config "$cfg" >/dev/null
exec alertmanager --config.file="$cfg" --storage.path=/alertmanager --web.listen-address=:9093 "$@"
