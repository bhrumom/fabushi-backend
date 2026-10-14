#!/usr/bin/env bash
set -euo pipefail
umask 077

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "$name is required" >&2
    exit 64
  fi
}

for name in   FABUSHI_PLATFORM_CORE_URL   FDN_NETWORK_AUTHORITY_TOKEN   FABUSHI_FDN_CELL_ID   FABUSHI_FDN_INGRESS_USER_ID   FABUSHI_FDN_CONTROLLER_WORKER_URL   FABUSHI_FDN_INGRESS_STATE_FILE
do
  require_env "$name"
done

case "$FABUSHI_FDN_CONTROLLER_WORKER_URL" in
  http://127.0.0.1:[0-9]*|http://127.0.0.1:[0-9]*/)
    ;;
  *)
    echo "controller worker URL must use exact 127.0.0.1 loopback HTTP origin" >&2
    exit 64
    ;;
esac

case "$FABUSHI_FDN_INGRESS_STATE_FILE" in
  /var/lib/fabushi-fdn/*)
    ;;
  *)
    echo "ingress state file must remain under /var/lib/fabushi-fdn" >&2
    exit 64
    ;;
esac

exec /usr/bin/node ./official-device-mcp-ingress-binder.mjs
