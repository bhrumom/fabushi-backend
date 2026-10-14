#!/usr/bin/env bash
set -euo pipefail

server_url="${FABUSHI_FDN_HEADSCALE_SERVER_URL:-}"
if [[ ! "$server_url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  echo "FABUSHI_FDN_HEADSCALE_SERVER_URL must be an HTTPS origin without path/query" >&2
  exit 2
fi
mkdir -p runtime
sed "s|__FDN_SERVER_URL__|$server_url|g" config.yaml.template > runtime/config.yaml
install -m 600 policy.hujson runtime/policy.hujson
chmod 600 runtime/config.yaml
