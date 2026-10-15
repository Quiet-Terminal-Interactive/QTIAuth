#!/bin/sh
set -eu
dir=/tmp/prometheus-secrets
mkdir -p "$dir"
printf '%s' "${GATEWAY_METRICS_TOKEN:?set GATEWAY_METRICS_TOKEN in .env}" > "$dir/gateway-metrics-token"
chmod 600 "$dir/gateway-metrics-token"
exec prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.retention.time=30d --web.enable-remote-write-receiver "$@"
