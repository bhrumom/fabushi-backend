#!/usr/bin/env bash
set -euo pipefail
umask 077

expected_backend_sha="${1:-}"
expected_core_sha="${2:-}"
output="${3:-/tmp/fdn-g15-official-device-mcp.json}"
service="fabushi-fdn-official-device-mcp.service"
root="/opt/fabushi-fdn/current"
state_root="/var/lib/fabushi-fdn"

fail() { echo "fdn official-device-mcp G15: $*" >&2; exit 64; }
[[ $EUID -eq 0 ]] || fail "root is required"
[[ "$expected_backend_sha" =~ ^[a-f0-9]{40}$ ]] || fail "invalid backend sha"
[[ "$expected_core_sha" =~ ^[a-f0-9]{40}$ ]] || fail "invalid core sha"
test "$(cat "$root/BACKEND_SHA")" = "$expected_backend_sha"
test "$(cat "$root/CORE_SHA")" = "$expected_core_sha"
systemctl is-active --quiet "$service"

unit="$(systemctl cat "$service")"
grep -Fx 'MemoryMax=150M' <<<"$unit" >/dev/null
grep -Fx 'TasksMax=256' <<<"$unit" >/dev/null
grep -F 'ExecStart=/usr/bin/node /opt/fabushi-fdn/current/official-device-mcp/bin/fabushi-remote-mcp.js' <<<"$unit" >/dev/null
grep -F 'EnvironmentFile=/etc/fabushi/fdn-official-device-mcp.env' <<<"$unit" >/dev/null
grep -F 'User=fabushi-fdn' <<<"$unit" >/dev/null

pid="$(systemctl show -p MainPID --value "$service")"
[[ "$pid" =~ ^[1-9][0-9]*$ ]] || fail "invalid MainPID"
cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline")"
[[ "$cmdline" == *"/usr/bin/node"* || "$cmdline" == node* ]]
[[ "$cmdline" == *"/opt/fabushi-fdn/current/official-device-mcp/bin/fabushi-remote-mcp.js"* ]]

egress_chain="FABUSHI_FDN_MCP_EGRESS"
egress_comment="fdn-g15-official-device-mcp-egress"
egress_cgroup="system.slice/fabushi-fdn-official-device-mcp.service"

stack_has_egress_owner() {
  local cmd="$1" save_cmd save
  save_cmd="${cmd}-save"
  command -v "$cmd" >/dev/null 2>&1 || return 1
  command -v "$save_cmd" >/dev/null 2>&1 || return 1
  save="$("$save_cmd" 2>/dev/null || true)"
  grep -F -- "-A $egress_chain " <<<"$save" | grep -F -- "--comment $egress_comment" | grep -F -- "-j REJECT" >/dev/null || return 1
  grep -F -- "-A OUTPUT " <<<"$save" | grep -F -- "$egress_cgroup" | grep -F -- "-j $egress_chain" >/dev/null || return 1
}

read_stack_egress_counter() {
  local cmd="$1"
  "$cmd" -w -nvx -L "$egress_chain" 2>/dev/null | awk -v marker="$egress_comment" 'index($0,marker){sum += $1} END {print sum+0}'
}

egress_owner_present=false
if stack_has_egress_owner iptables; then
  if grep -q '[^[:space:]]' /proc/net/if_inet6 2>/dev/null; then
    if stack_has_egress_owner ip6tables; then egress_owner_present=true; fi
  else
    egress_owner_present=true
  fi
fi

egress_start=""
if [[ "$egress_owner_present" = true ]]; then
  egress_start="$(read_stack_egress_counter iptables)"
  if grep -q '[^[:space:]]' /proc/net/if_inet6 2>/dev/null; then
    egress_start=$((egress_start + $(read_stack_egress_counter ip6tables)))
  fi
fi

clock_ticks="$(getconf CLK_TCK)"
start_ticks="$(awk '{print $14 + $15}' "/proc/$pid/stat")"
start_ns="$(date +%s%N)"
journal_since="$(date --iso-8601=seconds)"
max_rss_kib=0
max_state_bytes=0
max_audit_bytes=0
min_available_bytes=9223372036854775807
total_bytes=0

state_file="$state_root/.fabushi/remote-mcp-state.json"
audit_file="$state_root/.fabushi/remote-mcp-audit.jsonl"

for _ in $(seq 1 60); do
  sleep 5
  test -r "/proc/$pid/status"
  rss_kib="$(awk '/^VmRSS:/ {print $2}' "/proc/$pid/status")"
  state_bytes=0
  audit_bytes=0
  [[ -f "$state_file" ]] && state_bytes="$(stat -c %s "$state_file")"
  [[ -f "$audit_file" ]] && audit_bytes="$(stat -c %s "$audit_file")"
  read -r fs_total fs_available < <(df -B1 --output=size,avail "$state_root" | tail -n1)
  (( rss_kib > max_rss_kib )) && max_rss_kib="$rss_kib"
  (( state_bytes > max_state_bytes )) && max_state_bytes="$state_bytes"
  (( audit_bytes > max_audit_bytes )) && max_audit_bytes="$audit_bytes"
  (( fs_available < min_available_bytes )) && min_available_bytes="$fs_available"
  total_bytes="$fs_total"
done

end_ns="$(date +%s%N)"
end_ticks="$(awk '{print $14 + $15}' "/proc/$pid/stat")"
elapsed_ns=$((end_ns - start_ns))
delta_ticks=$((end_ticks - start_ticks))
journal_bytes="$(journalctl -u "$service" --since "$journal_since" --no-pager --output=cat | wc -c)"
if journalctl -u "$service" --since "$journal_since" --no-pager --output=cat | grep -aEiq 'authorization:[[:space:]]*bearer[[:space:]]+[A-Za-z0-9._~+/-]{12,}|(access|refresh|device|mobile)[_-]?token[[:space:]]*[:=][[:space:]]*[A-Za-z0-9._~+/-]{12,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'; then
  privacy_scan="fail"
else
  privacy_scan="pass"
fi

rss_limit=$((150 * 1024 * 1024))
state_limit=$((20 * 1024 * 1024))
log_limit=$((20 * 1024 * 1024))
max_rss_bytes=$((max_rss_kib * 1024))
reserve_five_percent=$(((total_bytes + 19) / 20))
reserve_bytes=$((1024 * 1024 * 1024))
(( reserve_five_percent > reserve_bytes )) && reserve_bytes="$reserve_five_percent"

egress_end=""
egress_rejected=""
if [[ "$egress_owner_present" = true ]]; then
  egress_end="$(read_stack_egress_counter iptables)"
  if grep -q '[^[:space:]]' /proc/net/if_inet6 2>/dev/null; then
    egress_end=$((egress_end + $(read_stack_egress_counter ip6tables)))
  fi
  (( egress_end >= egress_start )) || fail "egress reject counter reset during the steady-state window"
  egress_rejected=$((egress_end - egress_start))
fi

export FDN_MCP_BACKEND_SHA="$expected_backend_sha"
export FDN_MCP_CORE_SHA="$expected_core_sha"
export FDN_MCP_ELAPSED_NS="$elapsed_ns"
export FDN_MCP_DELTA_TICKS="$delta_ticks"
export FDN_MCP_CLOCK_TICKS="$clock_ticks"
export FDN_MCP_MAX_RSS="$max_rss_bytes"
export FDN_MCP_RSS_LIMIT="$rss_limit"
export FDN_MCP_MAX_STATE="$max_state_bytes"
export FDN_MCP_STATE_LIMIT="$state_limit"
export FDN_MCP_MAX_AUDIT="$max_audit_bytes"
export FDN_MCP_JOURNAL_BYTES="$journal_bytes"
export FDN_MCP_LOG_LIMIT="$log_limit"
export FDN_MCP_FS_TOTAL="$total_bytes"
export FDN_MCP_FS_AVAILABLE="$min_available_bytes"
export FDN_MCP_FS_RESERVE="$reserve_bytes"
export FDN_MCP_PRIVACY_SCAN="$privacy_scan"
export FDN_MCP_EGRESS_START="$egress_start"
export FDN_MCP_EGRESS_END="$egress_end"
export FDN_MCP_EGRESS_REJECTED="$egress_rejected"

python3 - "$output" <<'PY'
import json, os, sys
elapsed_ns=int(os.environ["FDN_MCP_ELAPSED_NS"])
ticks=int(os.environ["FDN_MCP_DELTA_TICKS"])
hz=int(os.environ["FDN_MCP_CLOCK_TICKS"])
elapsed_s=elapsed_ns/1_000_000_000
cpu=((ticks/hz)/elapsed_s)*100
egress_start_raw=os.environ.get("FDN_MCP_EGRESS_START","")
egress_end_raw=os.environ.get("FDN_MCP_EGRESS_END","")
egress_raw=os.environ.get("FDN_MCP_EGRESS_REJECTED","")
egress_start=int(egress_start_raw) if egress_start_raw else None
egress_end=int(egress_end_raw) if egress_end_raw else None
egress_count=int(egress_raw) if egress_raw else None
egress_sample_complete = egress_start is not None and egress_end is not None and egress_count is not None
egress_sample_consistent = egress_sample_complete and egress_count == egress_end - egress_start
report={
  "backendSha":os.environ["FDN_MCP_BACKEND_SHA"],
  "coreSha":os.environ["FDN_MCP_CORE_SHA"],
  "runtime":{"process":"shipping systemd fabushi-fdn-official-device-mcp.service","steadyStateSeconds":round(elapsed_s,3)},
  "budgets":{
    "rssBytes":{"maxObserved":int(os.environ["FDN_MCP_MAX_RSS"]),"limit":int(os.environ["FDN_MCP_RSS_LIMIT"])},
    "cpuSingleCorePercent":{"fiveMinuteAverage":round(cpu,6),"limitExclusive":1.0},
    "stateBytes":{"maxObserved":int(os.environ["FDN_MCP_MAX_STATE"]),"limit":int(os.environ["FDN_MCP_STATE_LIMIT"])},
    "auditBytes":{"maxObserved":int(os.environ["FDN_MCP_MAX_AUDIT"]),"limit":int(os.environ["FDN_MCP_LOG_LIMIT"])},
    "journalBytes":{"observed":int(os.environ["FDN_MCP_JOURNAL_BYTES"]),"limit":int(os.environ["FDN_MCP_LOG_LIMIT"])},
    "diskReserveBytes":{"filesystemTotal":int(os.environ["FDN_MCP_FS_TOTAL"]),"minimumAvailableObserved":int(os.environ["FDN_MCP_FS_AVAILABLE"]),"requiredReserve":int(os.environ["FDN_MCP_FS_RESERVE"])},
  },
  "privacy":{"journalSecretScan":os.environ["FDN_MCP_PRIVACY_SCAN"]},
  "unexpectedWorkerOwnedPacketsRejected":egress_count,
  "egress":{"startCount":egress_start,"endCount":egress_end,"rejectedCount":egress_count,"counterOwner":"cgroup-scoped netfilter chain FABUSHI_FDN_MCP_EGRESS / comment fdn-g15-official-device-mcp-egress" if egress_sample_complete else None},
}
checks=[
 report["budgets"]["rssBytes"]["maxObserved"] < report["budgets"]["rssBytes"]["limit"],
 report["budgets"]["cpuSingleCorePercent"]["fiveMinuteAverage"] < 1.0,
 report["budgets"]["stateBytes"]["maxObserved"] <= report["budgets"]["stateBytes"]["limit"],
 report["budgets"]["auditBytes"]["maxObserved"] <= report["budgets"]["auditBytes"]["limit"],
 report["budgets"]["journalBytes"]["observed"] <= report["budgets"]["journalBytes"]["limit"],
 report["budgets"]["diskReserveBytes"]["minimumAvailableObserved"] >= report["budgets"]["diskReserveBytes"]["requiredReserve"],
 report["privacy"]["journalSecretScan"] == "pass",

]
if not all(checks) or (egress_sample_complete and not egress_sample_consistent):
  report["status"]="FAIL"
  report["exitCode"]=1
elif not egress_sample_complete:
  report["status"]="BLOCKED_EGRESS_REJECT_COUNTER"
  report["exitCode"]=78
elif egress_count != 0:
  report["status"]="FAIL"
  report["exitCode"]=1
else:
  report["status"]="PASS"
  report["exitCode"]=0
for section in report["budgets"].values():
  if "limit" in section and "maxObserved" in section:
    section["pass"]=section["maxObserved"] < section["limit"] if section is report["budgets"]["rssBytes"] else section["maxObserved"] <= section["limit"]
report["budgets"]["cpuSingleCorePercent"]["pass"]=report["budgets"]["cpuSingleCorePercent"]["fiveMinuteAverage"] < 1.0
report["budgets"]["journalBytes"]["pass"]=report["budgets"]["journalBytes"]["observed"] <= report["budgets"]["journalBytes"]["limit"]
report["budgets"]["diskReserveBytes"]["pass"]=report["budgets"]["diskReserveBytes"]["minimumAvailableObserved"] >= report["budgets"]["diskReserveBytes"]["requiredReserve"]
report["egress"]["pass"]=egress_sample_consistent and egress_count == 0
with open(sys.argv[1],"w",encoding="utf-8") as f: json.dump(report,f,indent=2,sort_keys=True)
print(json.dumps(report,sort_keys=True))
raise SystemExit(report["exitCode"])
PY
