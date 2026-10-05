#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <database-binding> <environment> [extra wrangler args...]" >&2
  exit 64
fi

binding="$1"
environment="$2"
shift 2

# The account DB migration is the first mutating step in both staging and
# production deployment. Refuse to mutate or deploy if the Worker would boot
# without the security configuration required by the hardened authentication,
# payment, and administrator boundaries.
if [ "$binding" = "DB" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  bash "$script_dir/assert-worker-security-secrets.sh" "$environment" "$@"
fi

max_attempts="${WRANGLER_D1_MAX_ATTEMPTS:-4}"
delay_seconds="${WRANGLER_D1_RETRY_DELAY_SECONDS:-15}"
log_file="$(mktemp)"
trap 'rm -f "$log_file"' EXIT

is_transient_failure() {
  local path="$1"
  python3 - "$path" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text(encoding='utf-8', errors='ignore')
patterns = (
    r'Upstream service unavailable.*code: 7009',
    r'consider throttling your request speed.*code: 971',
    r'\bECONNRESET\b',
    r'\bETIMEDOUT\b',
    r'network socket disconnected',
    r'error sending request',
)
raise SystemExit(0 if any(re.search(pattern, text, re.IGNORECASE) for pattern in patterns) else 1)
PY
}

attempt=1
while true; do
  echo "Running D1 migrations for binding '$binding' in env '$environment' (attempt $attempt/$max_attempts)"

  set +e
  npx --yes wrangler@latest d1 migrations apply "$binding" --env "$environment" --remote "$@" 2>&1 | tee "$log_file"
  status=${PIPESTATUS[0]}
  set -e

  if [ "$status" -eq 0 ]; then
    echo "D1 migrations applied successfully."
    exit 0
  fi

  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "D1 migrations failed after $attempt attempts." >&2
    exit "$status"
  fi

  if ! is_transient_failure "$log_file"; then
    echo "D1 migrations failed with a non-retryable error; stopping after attempt $attempt." >&2
    exit "$status"
  fi

  echo "Detected transient Cloudflare D1 failure. Retrying in ${delay_seconds}s..." >&2
  sleep "$delay_seconds"
  attempt=$((attempt + 1))
  delay_seconds=$((delay_seconds * 2))
done
