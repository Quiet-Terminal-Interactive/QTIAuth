#!/bin/sh
set -eu
apk add --no-cache curl >/dev/null 2>&1 || true
OUT=/var/lib/geoip/country.mmdb

fetch() {
  tmp=$(mktemp -d)
  if [ "${GEOIP_SOURCE:-dbip_lite}" = "maxmind" ]; then
    [ -n "${MAXMIND_LICENSE_KEY:-}" ] || { echo "MAXMIND_LICENSE_KEY is not set"; return 1; }
    curl -fsSL "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-Country&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz" -o "$tmp/db.tgz"
    tar -xzf "$tmp/db.tgz" -C "$tmp"
    find "$tmp" -name '*.mmdb' -exec mv {} "$OUT.new" \;
  else
    month=$(date -u +%Y-%m)
    curl -fsSL "https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz" -o "$tmp/db.gz" \
      || curl -fsSL "https://download.db-ip.com/free/dbip-country-lite-$(date -u -d "@$(($(date +%s) - 2678400))" +%Y-%m).mmdb.gz" -o "$tmp/db.gz"
    gunzip -c "$tmp/db.gz" > "$OUT.new"
  fi
  mv "$OUT.new" "$OUT"
  rm -rf "$tmp"
  echo "GeoIP database updated at $(date -u)"
}

while true; do
  fetch || echo "GeoIP update failed; keeping the existing database"
  sleep 604800
done
