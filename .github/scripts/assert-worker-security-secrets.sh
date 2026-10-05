#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <environment> [extra wrangler args...]" >&2
  exit 64
fi

environment="$1"
shift

case "$environment" in
  production)
    # Production currently has Apple IAP and Alipay enabled, so their server
    # credentials are mandatory. The retired leaderboard/transfer-statistics
    # subsystem is intentionally absent from this list.
    required=(
      JWT_SIGNING_SECRET
      ADMIN_EMAILS
      ALIPAY_PRIVATE_KEY
      AUTH_PROVIDER_BRIDGE_SECRET
      APPLE_ISSUER_ID
      APPLE_KEY_ID
      APPLE_PRIVATE_KEY
      APPLE_BUNDLE_ID
      FIREBASE_PROJECT_ID
    )
    ;;
  development)
    # Development must preserve identity/session integrity. External payment,
    # Apple and standalone SMS providers may intentionally be absent.
    required=(
      JWT_SIGNING_SECRET
      ADMIN_EMAILS
    )
    ;;
  *)
    echo "Unsupported Worker environment for security preflight: $environment" >&2
    exit 64
    ;;
esac

secret_json="$(mktemp)"
trap 'rm -f "$secret_json"' EXIT

npx --yes wrangler@latest secret list --env "$environment" --format json "$@" > "$secret_json"

python3 - "$secret_json" "$environment" "${required[@]}" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
environment = sys.argv[2]
required = sys.argv[3:]
try:
    rows = json.loads(path.read_text(encoding="utf-8"))
except Exception as exc:
    raise SystemExit(f"Unable to parse Wrangler secret list for {environment}: {exc}")

names = {
    str(row.get("name", "")).strip()
    for row in rows
    if isinstance(row, dict) and str(row.get("name", "")).strip()
}
missing = [name for name in required if name not in names]
if missing:
    print(
        f"Worker security preflight failed for {environment}; missing remote secrets: "
        + ", ".join(missing),
        file=sys.stderr,
    )
    print(
        "Configure them with `wrangler secret put <NAME> --env " + environment + "` before deployment.",
        file=sys.stderr,
    )
    raise SystemExit(1)

print(f"Worker security preflight passed for {environment}: {len(required)} required secrets are configured.")
PY
