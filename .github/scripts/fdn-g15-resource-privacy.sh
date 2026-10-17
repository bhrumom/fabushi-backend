#!/usr/bin/env bash
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" ]]; then
  echo "fdn-g15-resource-privacy is GitHub Actions only" >&2
  exit 64
fi

: "${EXPECTED_SHA:?EXPECTED_SHA is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

actual_sha="$(git rev-parse HEAD)"
test "$actual_sha" = "$EXPECTED_SHA"
test "$(git status --porcelain)" = ""

evidence_dir="${1:-evidence}"
mkdir -p "$evidence_dir"
work_dir="$RUNNER_TEMP/fdn-g15-resource-privacy-${GITHUB_RUN_ID:-local}"
rm -rf "$work_dir"
mkdir -p "$work_dir/headscale-state" "$work_dir/worker-state" "$work_dir/home"
chmod 0700 "$work_dir/worker-state" "$work_dir/home"

container="fdn-g15-headscale-${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-1}"
worker_log="$evidence_dir/network-worker.log"
worker_binary="$RUNNER_TEMP/official-device-network-worker"
probe_user="fdng15"
worker_pid=""
sudo_pid=""
auth_key=""
uid_value=""

cleanup() {
  set +e
  if [[ -n "$worker_pid" ]]; then
    kill "$worker_pid" 2>/dev/null || true
  fi
  if [[ -n "$sudo_pid" ]]; then
    wait "$sudo_pid" 2>/dev/null || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [[ -n "$uid_value" ]]; then
    sudo iptables -D OUTPUT -m owner --uid-owner "$uid_value" '!' -d 127.0.0.0/8 -m comment --comment fdn-g15-worker -j REJECT 2>/dev/null || true
    sudo ip6tables -D OUTPUT -m owner --uid-owner "$uid_value" '!' -d ::1/128 -m comment --comment fdn-g15-worker -j REJECT 2>/dev/null || true
  fi
  if id "$probe_user" >/dev/null 2>&1; then
    sudo userdel "$probe_user" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

cat > "$work_dir/policy.hujson" <<'POLICY'
{
  "groups": {},
  "tagOwners": {},
  "hosts": {},
  "acls": []
}
POLICY

cat > "$work_dir/headscale.yaml" <<'YAML'
server_url: http://127.0.0.1:8080
listen_addr: 127.0.0.1:8080
metrics_listen_addr: ""
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: false
trusted_proxies: []
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: random
derp:
  server:
    enabled: false
    region_id: 901
    region_code: "fabushi-g15"
    region_name: "Fabushi G15 isolated Actions"
    verify_clients: true
    stun_listen_addr: "127.0.0.1:3478"
    private_key_path: /var/lib/headscale/derp_server_private.key
    automatically_add_embedded_derp_region: false
  urls: []
  paths: []
  auto_update_enabled: false
  update_frequency: 24h
disable_check_updates: true
node:
  expiry: 1h
  ephemeral:
    inactivity_timeout: 30m
database:
  type: sqlite
  debug: false
  gorm:
    prepare_stmt: true
    parameterized_queries: true
    skip_err_record_not_found: true
    slow_threshold: 1000
  sqlite:
    path: /var/lib/headscale/db.sqlite
    write_ahead_log: true
    wal_autocheckpoint: 1000
log:
  level: warn
  format: json
policy:
  mode: file
  path: /etc/headscale/policy.hujson
dns:
  magic_dns: false
  base_domain: ""
  override_local_dns: false
  nameservers:
    global: []
    split: {}
  search_domains: []
  extra_records: []
unix_socket: /var/run/headscale/headscale.sock
unix_socket_permission: "0770"
YAML

docker run -d --name "$container" --network host \
  -v "$work_dir/headscale.yaml:/etc/headscale/config.yaml:ro" \
  -v "$work_dir/policy.hujson:/etc/headscale/policy.hujson:ro" \
  -v "$work_dir/headscale-state:/var/lib/headscale" \
  docker.io/headscale/headscale:0.29.5 serve >/dev/null

ready=0
for _ in $(seq 1 60); do
  if docker exec "$container" headscale users list >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" -ne 1 ]]; then
  echo "Headscale fixture did not become ready" >&2
  docker ps -a --filter "name=^/$container$" >&2 || true
  docker logs "$container" >&2 || true
  docker inspect "$container" --format '{{json .State}}' >&2 || true
  exit 1
fi

docker exec "$container" headscale users create g15-resource >/dev/null
user_id="$(docker exec "$container" headscale users list --name g15-resource --output json | python3 -c 'import json,sys; rows=json.load(sys.stdin); assert len(rows)==1; print(rows[0]["id"])')"
[[ "$user_id" =~ ^[0-9]+$ ]]
auth_key="$(docker exec "$container" headscale preauthkeys create --user "$user_id" | tr -d '\r' | tail -n1)"
test "${#auth_key}" -ge 20

if ! id "$probe_user" >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin "$probe_user"
fi
uid_value="$(id -u "$probe_user")"
sudo chown -R "$probe_user":"$probe_user" "$work_dir/worker-state" "$work_dir/home"

# The Actions resource fixture has one approved egress origin: its real pinned
# Headscale control server on loopback. Any other worker-owned packet is rejected
# and counted. This also catches unexpected telemetry/support traffic.
sudo iptables -I OUTPUT 1 -m owner --uid-owner "$uid_value" '!' -d 127.0.0.0/8 -m comment --comment fdn-g15-worker -j REJECT
sudo ip6tables -I OUTPUT 1 -m owner --uid-owner "$uid_value" '!' -d ::1/128 -m comment --comment fdn-g15-worker -j REJECT

sudo -u "$probe_user" env \
  HOME="$work_dir/home" \
  FABUSHI_FDN_WORKER_CELL_ID="g15-resource-cell" \
  FABUSHI_FDN_WORKER_CONTROL_URL="http://127.0.0.1:8080" \
  FABUSHI_FDN_WORKER_AUTH_KEY="$auth_key" \
  FABUSHI_FDN_WORKER_STATE_DIR="$work_dir/worker-state" \
  FABUSHI_FDN_WORKER_HOSTNAME="g15-resource-worker" \
  FABUSHI_FDN_WORKER_BIND="127.0.0.1:8791" \
  FABUSHI_FDN_REMOTE_TARGET_PORT="8792" \
  "$worker_binary" >"$worker_log" 2>&1 &
sudo_pid="$!"

status_ready=0
for _ in $(seq 1 90); do
  worker_pid="$(pgrep -u "$uid_value" -f "$worker_binary" | head -n1 || true)"
  if [[ -n "$worker_pid" ]] && curl --fail --silent --show-error --max-time 2 http://127.0.0.1:8791/v1/fdn/status > "$evidence_dir/network-worker-status.json"; then
    status_ready=1
    break
  fi
  if ! kill -0 "$sudo_pid" 2>/dev/null; then
    cat "$worker_log" >&2
    exit 1
  fi
  sleep 1
done
test "$status_ready" -eq 1
test -n "$worker_pid"

# Warm the real tsnet worker before the steady-state interval.
sleep 20

clock_ticks="$(getconf CLK_TCK)"
start_ticks="$(awk '{print $14 + $15}' "/proc/$worker_pid/stat")"
start_ns="$(date +%s%N)"
max_rss_kib=0
max_state_bytes=0
max_log_bytes=0
min_available_bytes=9223372036854775807
total_bytes=0

for _ in $(seq 1 60); do
  sleep 5
  kill -0 "$worker_pid"
  rss_kib="$(awk '/^VmRSS:/ {print $2}' "/proc/$worker_pid/status")"
  state_bytes="$(du -sb "$work_dir/worker-state" | awk '{print $1}')"
  log_bytes="$(stat -c %s "$worker_log")"
  read -r fs_total fs_available < <(df -B1 --output=size,avail "$work_dir/worker-state" | tail -n1)
  if (( rss_kib > max_rss_kib )); then max_rss_kib="$rss_kib"; fi
  if (( state_bytes > max_state_bytes )); then max_state_bytes="$state_bytes"; fi
  if (( log_bytes > max_log_bytes )); then max_log_bytes="$log_bytes"; fi
  if (( fs_available < min_available_bytes )); then min_available_bytes="$fs_available"; fi
  total_bytes="$fs_total"
done

end_ns="$(date +%s%N)"
end_ticks="$(awk '{print $14 + $15}' "/proc/$worker_pid/stat")"
elapsed_ns=$((end_ns - start_ns))
delta_ticks=$((end_ticks - start_ticks))

ipv4_blocked="$(sudo iptables -nvx -L OUTPUT | awk '/fdn-g15-worker/ {sum += $1} END {print sum+0}')"
ipv6_blocked="$(sudo ip6tables -nvx -L OUTPUT | awk '/fdn-g15-worker/ {sum += $1} END {print sum+0}')"
blocked_packets=$((ipv4_blocked + ipv6_blocked))

state_limit_bytes=$((20 * 1024 * 1024))
log_limit_bytes=$((20 * 1024 * 1024))
rss_limit_bytes=$((150 * 1024 * 1024))
max_rss_bytes=$((max_rss_kib * 1024))
reserve_five_percent=$(((total_bytes + 19) / 20))
reserve_bytes=$((1024 * 1024 * 1024))
if (( reserve_five_percent > reserve_bytes )); then reserve_bytes="$reserve_five_percent"; fi

export FDN_G15_EXPECTED_SHA="$EXPECTED_SHA"
export FDN_G15_ELAPSED_NS="$elapsed_ns"
export FDN_G15_DELTA_TICKS="$delta_ticks"
export FDN_G15_CLOCK_TICKS="$clock_ticks"
export FDN_G15_MAX_RSS_BYTES="$max_rss_bytes"
export FDN_G15_RSS_LIMIT_BYTES="$rss_limit_bytes"
export FDN_G15_MAX_STATE_BYTES="$max_state_bytes"
export FDN_G15_STATE_LIMIT_BYTES="$state_limit_bytes"
export FDN_G15_MAX_LOG_BYTES="$max_log_bytes"
export FDN_G15_LOG_LIMIT_BYTES="$log_limit_bytes"
export FDN_G15_TOTAL_BYTES="$total_bytes"
export FDN_G15_MIN_AVAILABLE_BYTES="$min_available_bytes"
export FDN_G15_RESERVE_BYTES="$reserve_bytes"
export FDN_G15_BLOCKED_PACKETS="$blocked_packets"
export FDN_G15_RUN_ID="${GITHUB_RUN_ID:-}"

python3 - "$evidence_dir/fdn-g15-resource-privacy.json" <<'PY'
import json, os, sys
out = sys.argv[1]
elapsed_ns = int(os.environ["FDN_G15_ELAPSED_NS"])
delta_ticks = int(os.environ["FDN_G15_DELTA_TICKS"])
hz = int(os.environ["FDN_G15_CLOCK_TICKS"])
elapsed_s = elapsed_ns / 1_000_000_000
cpu_percent = (delta_ticks / hz) / elapsed_s * 100
report = {
    "backendSha": os.environ["FDN_G15_EXPECTED_SHA"],
    "runId": os.environ.get("FDN_G15_RUN_ID"),
    "environment": "github-hosted-ubuntu-24.04",
    "runtime": {
        "worker": "shipping official-device-network-worker",
        "tailscale": "v1.104.1",
        "coordinator": "docker.io/headscale/headscale:0.29.5",
        "coordinatorMode": "real pinned Headscale on loopback; no mock transport",
        "steadyStateSeconds": round(elapsed_s, 3),
    },
    "budgets": {
        "rssBytes": {
            "maxObserved": int(os.environ["FDN_G15_MAX_RSS_BYTES"]),
            "limit": int(os.environ["FDN_G15_RSS_LIMIT_BYTES"]),
            "pass": int(os.environ["FDN_G15_MAX_RSS_BYTES"]) < int(os.environ["FDN_G15_RSS_LIMIT_BYTES"]),
        },
        "cpuSingleCorePercent": {
            "fiveMinuteAverage": round(cpu_percent, 6),
            "limitExclusive": 1.0,
            "pass": cpu_percent < 1.0,
        },
        "workerStateBytes": {
            "maxObserved": int(os.environ["FDN_G15_MAX_STATE_BYTES"]),
            "ownedStateLimit": int(os.environ["FDN_G15_STATE_LIMIT_BYTES"]),
            "pass": int(os.environ["FDN_G15_MAX_STATE_BYTES"]) <= int(os.environ["FDN_G15_STATE_LIMIT_BYTES"]),
        },
        "workerLogBytes": {
            "maxObserved": int(os.environ["FDN_G15_MAX_LOG_BYTES"]),
            "perComponentLimit": int(os.environ["FDN_G15_LOG_LIMIT_BYTES"]),
            "pass": int(os.environ["FDN_G15_MAX_LOG_BYTES"]) <= int(os.environ["FDN_G15_LOG_LIMIT_BYTES"]),
        },
        "diskReserveBytes": {
            "filesystemTotal": int(os.environ["FDN_G15_TOTAL_BYTES"]),
            "minimumAvailableObserved": int(os.environ["FDN_G15_MIN_AVAILABLE_BYTES"]),
            "requiredReserve": int(os.environ["FDN_G15_RESERVE_BYTES"]),
            "pass": int(os.environ["FDN_G15_MIN_AVAILABLE_BYTES"]) >= int(os.environ["FDN_G15_RESERVE_BYTES"]),
        },
    },
    "egress": {
        "actionsApprovedOrigins": ["http://127.0.0.1:8080"],
        "productionApprovedControlOrigin": "https://fdn.ombhrum.com",
        "unexpectedWorkerOwnedPacketsRejected": int(os.environ["FDN_G15_BLOCKED_PACKETS"]),
        "pass": int(os.environ["FDN_G15_BLOCKED_PACKETS"]) == 0,
        "telemetryContract": "envknob.SetNoLogsNoSupport; Headscale external DERP URLs empty; DERP auto-update and Headscale update checks disabled",
    },
}
passes = [v["pass"] for v in report["budgets"].values()] + [report["egress"]["pass"]]
report["status"] = "PASS" if all(passes) else "FAIL"
report["exitCode"] = 0 if all(passes) else 1
with open(out, "w", encoding="utf-8") as f:
    json.dump(report, f, indent=2, sort_keys=True)
print(json.dumps(report, sort_keys=True))
if report["exitCode"]:
    raise SystemExit(report["exitCode"])
PY

# Runtime credential and common auth material must not enter logs/status/evidence.
if grep -R -aF -- "$auth_key" "$evidence_dir" >/dev/null 2>&1; then
  echo "G15 privacy failure: preauth key leaked into evidence" >&2
  exit 1
fi
if grep -R -aE 'hskey-auth-|tskey-auth-|Authorization:[[:space:]]*Bearer|FABUSHI_FDN_WORKER_AUTH_KEY=' "$evidence_dir" >/dev/null 2>&1; then
  echo "G15 privacy failure: credential-like material found in evidence" >&2
  exit 1
fi

# Shipping network/privacy contract: no Tailscale support logging, no web client,
# no external DERP-map fetch, no Headscale update check, no DNS projection.
grep -F 'envknob.SetNoLogsNoSupport()' official-device-network-worker/main.go >/dev/null
grep -F 'RunWebClient: false' official-device-network-worker/main.go >/dev/null
grep -F '  urls: []' fdn-network-coordinator/config.yaml.template >/dev/null
grep -F '  auto_update_enabled: false' fdn-network-coordinator/config.yaml.template >/dev/null
grep -F 'disable_check_updates: true' fdn-network-coordinator/config.yaml.template >/dev/null
grep -F '    global: []' fdn-network-coordinator/config.yaml.template >/dev/null

FABUSHI_FDN_HEADSCALE_SERVER_URL=https://fdn.ombhrum.com bash fdn-network-coordinator/render-config.sh
python3 - <<'PY'
from pathlib import Path
text = Path("fdn-network-coordinator/runtime/config.yaml").read_text()
assert "server_url: https://fdn.ombhrum.com" in text
assert "urls: []" in text
assert "auto_update_enabled: false" in text
assert "disable_check_updates: true" in text
assert "global: []" in text
for forbidden in ("controlplane.tailscale.com", "log.tailscale.io", "login.tailscale.com"):
    assert forbidden not in text
PY
rm -rf fdn-network-coordinator/runtime

sha256sum "$evidence_dir/fdn-g15-resource-privacy.json" "$evidence_dir/network-worker-status.json" "$worker_log" > "$evidence_dir/SHA256SUMS"
