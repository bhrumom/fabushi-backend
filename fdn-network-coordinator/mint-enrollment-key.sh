#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

cell_id="${FABUSHI_FDN_CELL_ID:-}"
ttl_seconds="${FABUSHI_FDN_ENROLLMENT_TTL_SECONDS:-}"

if [[ ! "$cell_id" =~ ^cell-[A-Za-z0-9_-]{16,96}$ ]]; then
  echo "FABUSHI_FDN_CELL_ID must be a Core-derived opaque cell identifier" >&2
  exit 2
fi
if [[ ! "$ttl_seconds" =~ ^[0-9]+$ ]] || (( ttl_seconds < 15 || ttl_seconds > 300 )); then
  echo "FABUSHI_FDN_ENROLLMENT_TTL_SECONDS must be between 15 and 300" >&2
  exit 2
fi

list_user_json() {
  docker compose exec -T headscale     headscale users list --name "$cell_id" --output json
}

parse_exact_user_id() {
  CELL_ID="$cell_id" node --input-type=module -e '
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.users) ? parsed.users : [];
      const matches = rows.filter((row) => row && row.name === process.env.CELL_ID);
      if (matches.length !== 1) process.exit(3);
      const value = matches[0].id;
      const id = typeof value === "string" ? value : Number.isSafeInteger(value) ? String(value) : "";
      if (!/^[1-9][0-9]*$/.test(id)) process.exit(4);
      process.stdout.write(id);
    });
  '
}

resolve_user_id() {
  local listing user_id
  listing="$(list_user_json)"
  if user_id="$(printf '%s' "$listing" | parse_exact_user_id 2>/dev/null)"; then
    printf '%s' "$user_id"
    return 0
  fi

  # Creating an already-created user may race with another enrollment request.
  # Ignore only the create command's status, then require the authoritative
  # exact-name list to resolve exactly one user.
  docker compose exec -T headscale     headscale users create "$cell_id" >/dev/null 2>&1 || true

  listing="$(list_user_json)"
  printf '%s' "$listing" | parse_exact_user_id
}

user_id="$(resolve_user_id)"
key="$(
  docker compose exec -T headscale     headscale preauthkeys create       --user "$user_id"       --expiration "${ttl_seconds}s"
)"
key="${key//$'\r'/}"
key="${key//$'\n'/}"

if [[ -z "$key" || "${#key}" -gt 512 || "$key" =~ [[:space:]] ]]; then
  echo "Headscale returned an invalid preauth key" >&2
  exit 1
fi

# The key is the only stdout payload. Callers must treat stdout as secret data.
printf '%s' "$key"
