#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-ai.ombhrum.com}"
PROXIED="${PROXIED:-true}"

if [[ -z "${CF_API_TOKEN:-}" || -z "${CF_ZONE_ID:-}" || -z "${AI_ORIGIN_IP:-}" ]]; then
  echo "Set CF_API_TOKEN, CF_ZONE_ID, and AI_ORIGIN_IP." >&2
  exit 1
fi

api="https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records"
auth_headers=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")

record_json="$(curl -fsS "${auth_headers[@]}" "${api}?type=A&name=${DOMAIN}")"
record_id="$(node -e 'const data=JSON.parse(process.argv[1]); console.log(data.result?.[0]?.id || "")' "$record_json")"
payload="$(node -e 'console.log(JSON.stringify({type:"A",name:process.argv[1],content:process.argv[2],ttl:1,proxied:process.argv[3] === "true"}))' "$DOMAIN" "$AI_ORIGIN_IP" "$PROXIED")"

if [[ -n "$record_id" ]]; then
  curl -fsS -X PUT "${auth_headers[@]}" -d "$payload" "${api}/${record_id}"
else
  curl -fsS -X POST "${auth_headers[@]}" -d "$payload" "$api"
fi

echo
echo "Upserted ${DOMAIN} -> ${AI_ORIGIN_IP} proxied=${PROXIED}; no Worker route was created."
