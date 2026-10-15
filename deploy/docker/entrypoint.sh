#!/bin/sh
set -eu

if [ "${1:-}" = "qtiauth" ]; then
  shift
  exec node /app/packages/cli/src/main.ts "$@"
fi
if [ $# -gt 0 ]; then
  exec "$@"
fi

case "${QTIAUTH_SERVICE:-}" in
  web) exec node /app/apps/web/dist/main.js ;;
  gateway | identity | notifier | scheduler | oidc | safety | support | games | backup) exec node "/app/services/${QTIAUTH_SERVICE}/src/main.ts" ;;
  *)
    echo "Set QTIAUTH_SERVICE to one of: gateway identity notifier scheduler web oidc safety support games backup" >&2
    exit 64
    ;;
esac
