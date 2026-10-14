#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

: "${FABUSHI_CORE_API_BASE_URL:?FABUSHI_CORE_API_BASE_URL is required}"
: "${FDN_NETWORK_AUTHORITY_TOKEN:?FDN_NETWORK_AUTHORITY_TOKEN is required}"
: "${FABUSHI_FDN_CELL_ID:?FABUSHI_FDN_CELL_ID is required}"

mkdir -p runtime
active_policy="$script_dir/runtime/policy.hujson"
candidate_name="policy.candidate.$$.hujson"
candidate_policy="$script_dir/runtime/$candidate_name"
cleanup() {
  rm -f "$candidate_policy"
}
trap cleanup EXIT

export FABUSHI_FDN_POLICY_PATH="$candidate_policy"
node ./project-core-policy.mjs

docker compose exec -T headscale   headscale policy check --file "/etc/headscale/fdn-runtime/$candidate_name"

chmod 600 "$candidate_policy"
mv -f "$candidate_policy" "$active_policy"
docker compose kill -s HUP headscale
trap - EXIT
