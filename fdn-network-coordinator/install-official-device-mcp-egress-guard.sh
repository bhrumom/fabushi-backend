#!/usr/bin/env bash
set -euo pipefail
umask 077

action="${1:-install}"
chain="FABUSHI_FDN_MCP_EGRESS"
comment="fdn-g15-official-device-mcp-egress"
cgroup_path="system.slice/fabushi-fdn-official-device-mcp.service"
api_host="api.ombhrum.com"

fail() { echo "fabushi-fdn official-device-mcp egress guard: $*" >&2; exit 64; }
[[ $EUID -eq 0 ]] || fail "root is required"
command -v iptables >/dev/null || fail "iptables is required"
command -v getent >/dev/null || fail "getent is required"

ipv6_enabled=false
if grep -q '[^[:space:]]' /proc/net/if_inet6 2>/dev/null; then
  command -v ip6tables >/dev/null || fail "ip6tables is required while IPv6 is enabled"
  ipv6_enabled=true
fi

mapfile -t api4 < <(getent ahostsv4 "$api_host" 2>/dev/null | awk '{print $1}' | sort -u)
mapfile -t api6 < <(getent ahostsv6 "$api_host" 2>/dev/null | awk '{print $1}' | sort -u)
mapfile -t resolvers < <(awk '/^[[:space:]]*nameserver[[:space:]]+/ {print $2}' /etc/resolv.conf | sort -u)
if (( ${#api4[@]} == 0 )) && { [[ "$ipv6_enabled" != true ]] || (( ${#api6[@]} == 0 )); }; then
  fail "api.ombhrum.com did not resolve to an address usable by this host"
fi

delete_jump() {
  local cmd="$1"
  while "$cmd" -w -D OUTPUT -m cgroup --path "$cgroup_path" -j "$chain" 2>/dev/null; do :; done
}

remove_stack() {
  local cmd="$1"
  delete_jump "$cmd"
  "$cmd" -w -F "$chain" 2>/dev/null || true
  "$cmd" -w -X "$chain" 2>/dev/null || true
}

install_stack() {
  local cmd="$1" family="$2" ip resolver
  delete_jump "$cmd"
  "$cmd" -w -N "$chain" 2>/dev/null || true
  "$cmd" -w -F "$chain"
  "$cmd" -w -A "$chain" -o lo -j ACCEPT
  if [[ "$family" = 4 ]]; then
    for ip in "${api4[@]}"; do "$cmd" -w -A "$chain" -p tcp -d "$ip" --dport 443 -j ACCEPT; done
  else
    for ip in "${api6[@]}"; do "$cmd" -w -A "$chain" -p tcp -d "$ip" --dport 443 -j ACCEPT; done
  fi
  for resolver in "${resolvers[@]}"; do
    if [[ "$family" = 4 && "$resolver" != *:* ]]; then
      "$cmd" -w -A "$chain" -p udp -d "$resolver" --dport 53 -j ACCEPT
      "$cmd" -w -A "$chain" -p tcp -d "$resolver" --dport 53 -j ACCEPT
    elif [[ "$family" = 6 && "$resolver" == *:* ]]; then
      "$cmd" -w -A "$chain" -p udp -d "$resolver" --dport 53 -j ACCEPT
      "$cmd" -w -A "$chain" -p tcp -d "$resolver" --dport 53 -j ACCEPT
    fi
  done
  "$cmd" -w -A "$chain" -m comment --comment "$comment" -j REJECT
  "$cmd" -w -I OUTPUT 1 -m cgroup --path "$cgroup_path" -j "$chain"
}

case "$action" in
  install)
    install_stack iptables 4
    if [[ "$ipv6_enabled" = true ]]; then install_stack ip6tables 6; fi
    ;;
  remove)
    remove_stack iptables
    if command -v ip6tables >/dev/null 2>&1; then remove_stack ip6tables; fi
    ;;
  *) fail "unknown action" ;;
esac
