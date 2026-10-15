#!/bin/bash
set -euo pipefail

create_service() {
  local name="$1" password="$2"
  if [ -z "$password" ]; then
    echo "Missing password for database role $name" >&2
    exit 1
  fi
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v role="$name" -v pass="$password" <<'SQL'
create role :"role" login password :'pass';
create schema if not exists :"role" authorization :"role";
alter role :"role" set search_path = :"role", public;
revoke all on schema public from :"role";
SQL
}

create_service identity "${IDENTITY_DB_PASSWORD:-}"
create_service notify "${NOTIFIER_DB_PASSWORD:-}"
create_service oidc "${OIDC_DB_PASSWORD:-}"
create_service safety "${SAFETY_DB_PASSWORD:-}"
create_service support "${SUPPORT_DB_PASSWORD:-}"
create_service games "${GAMES_DB_PASSWORD:-}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
create role qtiauth_audit nologin;
revoke create on schema public from public;
SQL
