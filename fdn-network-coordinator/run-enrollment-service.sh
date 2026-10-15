#!/usr/bin/env bash
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_root="${FABUSHI_FDN_STATE_ROOT:-/var/lib/fabushi-fdn}"
enrollment_state="${FABUSHI_FDN_ENROLLMENT_STATE_PATH:-$state_root/enrollment-state.json}"

require_secret() {
  local name="$1"
  local value="${!name:-}"
  if [ "${#value}" -lt 48 ]; then
    echo "$name is missing or too short" >&2
    exit 64
  fi
}

require_secret FDN_NETWORK_AUTHORITY_TOKEN
require_secret FABUSHI_FDN_ENROLLMENT_BROKER_TOKEN
# AES-256 uses32 decoded bytes (44 canonical base64 characters), not a48-char token.
node --input-type=module -e '
  const raw = process.env.FABUSHI_FDN_ENROLLMENT_STATE_KEY_B64 || "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) {
    console.error("FABUSHI_FDN_ENROLLMENT_STATE_KEY_B64 must be canonical base64 for32 bytes");
    process.exit(64);
  }
'


case "${FABUSHI_PLATFORM_CORE_URL:-}" in
  https://*) ;;
  http://127.0.0.1:*|http://127.0.0.1) ;;
  *) echo "FABUSHI_PLATFORM_CORE_URL must use HTTPS or loopback HTTP" >&2; exit 64 ;;
esac

case "${FABUSHI_FDN_ENROLLMENT_LISTEN_HOST:-127.0.0.1}" in
  127.0.0.1|::1) ;;
  *) echo "enrollment service must remain loopback-only" >&2; exit 64 ;;
esac

case "${DOCKER_HOST:-}" in
  unix:///run/user/*/docker.sock) ;;
  *)
    echo "DOCKER_HOST must point at a dedicated rootless Docker unix socket; rootful /var/run/docker.sock is forbidden" >&2
    exit 64
    ;;
esac

case "$state_root" in
  /var/lib/fabushi-fdn|/var/lib/fabushi-fdn/*) ;;
  *) echo "FABUSHI_FDN_STATE_ROOT must remain under /var/lib/fabushi-fdn" >&2; exit 64 ;;
esac
case "$enrollment_state" in
  "$state_root"/*) ;;
  *) echo "FABUSHI_FDN_ENROLLMENT_STATE_PATH must remain under FABUSHI_FDN_STATE_ROOT" >&2; exit 64 ;;
esac

mkdir -p "$state_root"
chmod 700 "$state_root"

export FABUSHI_FDN_ENROLLMENT_STATE_PATH="$enrollment_state"
export FABUSHI_FDN_ENROLLMENT_LISTEN_HOST="${FABUSHI_FDN_ENROLLMENT_LISTEN_HOST:-127.0.0.1}"

docker compose -f "$here/docker-compose.yml" config --quiet
docker compose -f "$here/docker-compose.yml" exec -T headscale headscale health >/dev/null

exec /usr/bin/node "$here/enrollment-service.mjs"
