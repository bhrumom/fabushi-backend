#!/usr/bin/env bash
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo "actions_only" >&2; exit 64; }
: "${EXPECTED_SHA:?}"
: "${RUNNER_TEMP:?}"
test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"
test "$(git status --porcelain)" = ""

evidence_dir="${1:-evidence}"
mkdir -p "$evidence_dir"
root="/tmp/fdn-g15-gateway-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-1}"
user="fdng15gateway"
log="$evidence_dir/gateway.log"
pid=""
uid_value=""
vault_key=""

cleanup() {
  set +e
  [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  if [[ -n "$uid_value" ]]; then
    sudo iptables -D OUTPUT -m owner --uid-owner "$uid_value" '!' -d 127.0.0.0/8 -m comment --comment fdn-g15-gateway -j REJECT 2>/dev/null || true
    sudo ip6tables -D OUTPUT -m owner --uid-owner "$uid_value" '!' -d ::1/128 -m comment --comment fdn-g15-gateway -j REJECT 2>/dev/null || true
  fi
  id "$user" >/dev/null 2>&1 && sudo userdel "$user" >/dev/null 2>&1 || true
  rm -rf "$root"
}
trap cleanup EXIT

rm -rf "$root"
mkdir -p "$root/home/.fabushi"
chmod 0755 "$root"
chmod 0700 "$root/home" "$root/home/.fabushi"
if ! id "$user" >/dev/null 2>&1; then sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$user"; fi
uid_value="$(id -u "$user")"
sudo chown -R "$user":"$user" "$root/home"
vault_key="$(python3 - <<'PY'
import base64, os
print(base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("="))
PY
)"
sudo iptables -I OUTPUT 1 -m owner --uid-owner "$uid_value" '!' -d 127.0.0.0/8 -m comment --comment fdn-g15-gateway -j REJECT
sudo ip6tables -I OUTPUT 1 -m owner --uid-owner "$uid_value" '!' -d ::1/128 -m comment --comment fdn-g15-gateway -j REJECT

sudo -u "$user" env -i \
  PATH=/usr/bin:/bin \
  HOME="$root/home" \
  PORT=8870 \
  FABUSHI_REMOTE_MCP_HOST=127.0.0.1 \
  FABUSHI_REMOTE_MCP_PUBLIC_ORIGIN=http://127.0.0.1:8870 \
  FABUSHI_REMOTE_MCP_STATE_PATH="$root/home/.fabushi/remote-mcp-state.json" \
  FABUSHI_REMOTE_MCP_AUDIT_PATH="$root/home/.fabushi/remote-mcp-audit.jsonl" \
  FABUSHI_CORE_SERVICE_STATE_REQUIRED=1 \
  FABUSHI_OFFICIAL_MCP_SERVICE_VAULT_KEY="$vault_key" \
  FABUSHI_FDN_AUTHENTICATED_REVERSE_WS_FALLBACK=1 \
  /usr/bin/node official-device-mcp/bin/fabushi-remote-mcp.js >"$log" 2>&1 &
pid="$!"

ready=0
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:8870/.well-known/oauth-authorization-server >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "$pid" 2>/dev/null || { cat "$log" >&2; exit 1; }
  sleep 1
done
test "$ready" -eq 1
sleep 20

hz="$(getconf CLK_TCK)"
start_ticks="$(awk '{print $14+$15}' "/proc/$pid/stat")"
start_ns="$(date +%s%N)"
max_rss_kib=0
max_log=0
max_state=0
min_avail=9223372036854775807
total=0
for _ in $(seq 1 60); do
  sleep 5
  kill -0 "$pid"
  rss="$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status")"
  log_bytes="$(stat -c %s "$log")"
  state_bytes="$(du -sb "$root/home/.fabushi" | awk '{print $1}')"
  read -r fs_total fs_avail < <(df -B1 --output=size,avail "$root" | tail -n1)
  (( rss > max_rss_kib )) && max_rss_kib="$rss"
  (( log_bytes > max_log )) && max_log="$log_bytes"
  (( state_bytes > max_state )) && max_state="$state_bytes"
  (( fs_avail < min_avail )) && min_avail="$fs_avail"
  total="$fs_total"
done
end_ns="$(date +%s%N)"
end_ticks="$(awk '{print $14+$15}' "/proc/$pid/stat")"
elapsed_ns=$((end_ns-start_ns))
ticks=$((end_ticks-start_ticks))
blocked=$(( $(sudo iptables -nvx -L OUTPUT | awk '/fdn-g15-gateway/ {s+=$1} END{print s+0}') + $(sudo ip6tables -nvx -L OUTPUT | awk '/fdn-g15-gateway/ {s+=$1} END{print s+0}') ))
reserve=$((1024*1024*1024))
five=$(((total+19)/20))
(( five > reserve )) && reserve="$five"

export SHA="$EXPECTED_SHA" ELAPSED="$elapsed_ns" TICKS="$ticks" HZ="$hz"
export RSS="$((max_rss_kib*1024))" LOG="$max_log" STATE="$max_state" AVAIL="$min_avail" TOTAL="$total" RESERVE="$reserve" BLOCKED="$blocked"
python3 - "$evidence_dir/fdn-g15-gateway-resource-privacy.json" <<'PY'
import json,os,sys
elapsed=int(os.environ["ELAPSED"])/1e9
cpu=(int(os.environ["TICKS"])/int(os.environ["HZ"]))/elapsed*100
r={
 "backendSha":os.environ["SHA"],
 "environment":"github-hosted-ubuntu-24.04",
 "runtime":{"entrypoint":"official-device-mcp/bin/fabushi-remote-mcp.js","transport":"authenticated-reverse-websocket production fallback","steadyStateSeconds":round(elapsed,3)},
 "budgets":{
   "rssBytes":{"maxObserved":int(os.environ["RSS"]),"limit":150*1024*1024},
   "cpuSingleCorePercent":{"fiveMinuteAverage":round(cpu,6),"limitExclusive":1.0},
   "ownedStateBytes":{"maxObserved":int(os.environ["STATE"]),"limit":20*1024*1024},
   "logBytes":{"maxObserved":int(os.environ["LOG"]),"limit":20*1024*1024},
   "diskReserveBytes":{"filesystemTotal":int(os.environ["TOTAL"]),"minimumAvailableObserved":int(os.environ["AVAIL"]),"requiredReserve":int(os.environ["RESERVE"])}
 },
 "egress":{"approvedOrigins":["loopback only during idle production-startup acceptance"],"unexpectedGatewayOwnedPacketsRejected":int(os.environ["BLOCKED"])}
}
r["budgets"]["rssBytes"]["pass"]=r["budgets"]["rssBytes"]["maxObserved"]<r["budgets"]["rssBytes"]["limit"]
r["budgets"]["cpuSingleCorePercent"]["pass"]=cpu<1.0
r["budgets"]["ownedStateBytes"]["pass"]=r["budgets"]["ownedStateBytes"]["maxObserved"]<=r["budgets"]["ownedStateBytes"]["limit"]
r["budgets"]["logBytes"]["pass"]=r["budgets"]["logBytes"]["maxObserved"]<=r["budgets"]["logBytes"]["limit"]
r["budgets"]["diskReserveBytes"]["pass"]=r["budgets"]["diskReserveBytes"]["minimumAvailableObserved"]>=r["budgets"]["diskReserveBytes"]["requiredReserve"]
r["egress"]["pass"]=r["egress"]["unexpectedGatewayOwnedPacketsRejected"]==0
r["status"]="PASS" if all(v["pass"] for v in r["budgets"].values()) and r["egress"]["pass"] else "FAIL"
open(sys.argv[1],"w").write(json.dumps(r,indent=2,sort_keys=True))
print(json.dumps(r,sort_keys=True))
raise SystemExit(0 if r["status"]=="PASS" else 1)
PY

if grep -R -aF -- "$vault_key" "$evidence_dir" "$root/home/.fabushi" >/dev/null 2>&1; then
  echo "vault key leaked" >&2; exit 1
fi
if grep -R -aE 'Authorization:[[:space:]]*Bearer|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' "$evidence_dir" >/dev/null 2>&1; then
  echo "secret-like material in evidence" >&2; exit 1
fi
sha256sum "$evidence_dir/fdn-g15-gateway-resource-privacy.json" "$log" > "$evidence_dir/SHA256SUMS"
