#!/usr/bin/env bash
set -euo pipefail
umask 077

bundle="${1:-}"
backend_sha="${2:-}"
core_sha="${3:-}"
action="${4:-install}"
root=/opt/fabushi-fdn
state=/var/lib/fabushi-fdn
etc_root=/etc/fabushi
units=/etc/systemd/system

fail() { echo "fabushi-fdn install: $*" >&2; exit 64; }
health_failure() { printf 'fabushi-fdn install: health check failed at stage=%s\n' "$1" >&2; }
[[ $EUID -eq 0 ]] || fail "root is required"
[[ "$backend_sha" =~ ^[a-f0-9]{40}$ ]] || fail "invalid backend sha"
[[ "$core_sha" =~ ^[a-f0-9]{40}$ ]] || fail "invalid core sha"

ensure_layout() {
  getent group fabushi-fdn >/dev/null || groupadd --system fabushi-fdn
  id fabushi-fdn >/dev/null 2>&1 || useradd --system --gid fabushi-fdn --home "$state" --shell /usr/sbin/nologin fabushi-fdn
  install -d -m 0755 "$root/releases" "$etc_root"
  install -d -o fabushi-fdn -g fabushi-fdn -m 0700 "$state"
}

unit_names="fabushi-fdn-enrollment.service fabushi-fdn-official-mcp-ingress.service fabushi-fdn-official-mcp-ingress.timer fabushi-fdn-network-worker.service fabushi-fdn-official-device-mcp.service"

install_units() {
  local release="$1" uid socket
  for unit in $unit_names; do
    install -m 0644 "$release/fdn-network-coordinator/systemd/$unit" "$units/$unit" || return 1
  done
  uid="$(id -u fabushi-fdn)"
  socket="$(sed -n 's/^DOCKER_HOST=unix:\/\///p' "$etc_root/fdn-network-enrollment.env")"
  [[ "$socket" = "/run/user/$uid/docker.sock" ]] || return 1
  install -d -m 0755 "$units/fabushi-fdn-enrollment.service.d" || return 1
  printf '[Service]\nBindReadOnlyPaths=%s\n' "$socket" > "$units/fabushi-fdn-enrollment.service.d/rootless-socket.conf" || return 1
  systemctl daemon-reload
}

health() {
  systemctl is-active --quiet fabushi-fdn-network-worker.service >/dev/null 2>&1 ||
    { health_failure "service health"; return 1; }
  systemctl is-active --quiet fabushi-fdn-enrollment.service >/dev/null 2>&1 ||
    { health_failure "service health"; return 1; }
  systemctl is-active --quiet fabushi-fdn-official-device-mcp.service >/dev/null 2>&1 ||
    { health_failure "service health"; return 1; }
  systemctl is-active --quiet fabushi-fdn-official-mcp-ingress.timer >/dev/null 2>&1 ||
    { health_failure "service health"; return 1; }
  curl --fail --silent --max-time 5 http://127.0.0.1:8791/v1/fdn/status >/dev/null 2>&1 ||
    { health_failure "HTTP health check"; return 1; }
}

activate() {
  systemctl restart fabushi-fdn-network-worker.service >/dev/null 2>&1 ||
    { health_failure "service activation"; return 1; }
  local ready=false deadline=$((SECONDS+95))
  while (( SECONDS < deadline )); do
    if curl --fail --silent --max-time 1 http://127.0.0.1:8791/v1/fdn/status >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  [[ "$ready" = true ]] || { health_failure "worker readiness"; return 1; }
  systemctl restart fabushi-fdn-enrollment.service >/dev/null 2>&1 ||
    { health_failure "service activation"; return 1; }
  systemctl restart fabushi-fdn-official-device-mcp.service >/dev/null 2>&1 ||
    { health_failure "service activation"; return 1; }
  systemctl restart fabushi-fdn-official-mcp-ingress.timer >/dev/null 2>&1 ||
    { health_failure "service activation"; return 1; }
  systemctl start fabushi-fdn-official-mcp-ingress.service >/dev/null 2>&1 ||
    { health_failure "service activation"; return 1; }
  health
}

stop_new() {
  systemctl stop fabushi-fdn-official-mcp-ingress.timer fabushi-fdn-official-device-mcp.service fabushi-fdn-enrollment.service fabushi-fdn-network-worker.service || true
}

case "$action" in
  install)
    [[ -f "$bundle" ]] || fail "bundle missing"
    ensure_layout
    release="$root/releases/$backend_sha"
    tmp="$root/releases/.$backend_sha.tmp.$$"
    rm -rf "$tmp"
    install -d -m 0755 "$tmp"
    tar -xzf "$bundle" -C "$tmp"
    test -x "$tmp/bin/official-device-network-worker"
    test -f "$tmp/official-device-mcp/bin/fabushi-remote-mcp.js"
    test -f "$tmp/fdn-network-coordinator/systemd/fabushi-fdn-enrollment.service"
    test -f "$tmp/fdn-network-coordinator/systemd/fabushi-fdn-network-worker.service"
    test -f "$tmp/fdn-network-coordinator/systemd/fabushi-fdn-official-device-mcp.service"
    test -x "$tmp/fdn-network-coordinator/install-official-device-mcp-egress-guard.sh"
    printf '%s
' "$backend_sha" > "$tmp/BACKEND_SHA"
    printf '%s
' "$core_sha" > "$tmp/CORE_SHA"
    chown -R root:root "$tmp"
    chmod -R go-w "$tmp"
    if [[ -d "$release" ]]; then
      # An immutable exact-source release is reused, never removed while current.
      test "$(cat "$release/BACKEND_SHA")" = "$backend_sha"
      test "$(cat "$release/CORE_SHA")" = "$core_sha"
      rm -rf "$tmp"
    else
      mv "$tmp" "$release"
    fi

    previous=""
    if [[ -L "$root/current" ]]; then
      previous="$(readlink -f "$root/current" || true)"
      if [[ "$previous" = "$release" ]]; then
        previous="$(readlink -f "$root/previous" 2>/dev/null || true)"
      else
        [[ -n "$previous" ]] && ln -sfn "$previous" "$root/previous"
      fi
    fi
    ln -sfn "$release" "$root/current.new"
    mv -Tf "$root/current.new" "$root/current"

    if ! {
      install_units "$release" &&
      systemctl enable fabushi-fdn-network-worker.service fabushi-fdn-enrollment.service fabushi-fdn-official-device-mcp.service fabushi-fdn-official-mcp-ingress.timer &&
      activate
    }; then
      stop_new
      if [[ -n "$previous" && "$previous" != "$release" && -d "$previous" ]]; then
        ln -sfn "$previous" "$root/current.rollback"
        mv -Tf "$root/current.rollback" "$root/current"
        if ! { install_units "$previous" && activate; }; then stop_new; fi
      fi
      fail "health check failed; previous release restored when available"
    fi
    ;;
  rollback)
    ensure_layout
    [[ -L "$root/previous" ]] || fail "no previous release"
    previous="$(readlink -f "$root/previous")"
    [[ -d "$previous" ]] || fail "previous release missing"
    current="$(readlink -f "$root/current" || true)"
    ln -sfn "$previous" "$root/current.rollback"
    mv -Tf "$root/current.rollback" "$root/current"
    [[ -n "$current" ]] && ln -sfn "$current" "$root/previous"
    install_units "$previous"
    activate
    ;;
  health)
    health
    ;;
  uninstall)
    systemctl disable --now fabushi-fdn-official-mcp-ingress.timer fabushi-fdn-official-device-mcp.service fabushi-fdn-enrollment.service fabushi-fdn-network-worker.service 2>/dev/null || true
    if [[ -x "$root/current/fdn-network-coordinator/install-official-device-mcp-egress-guard.sh" ]]; then
      "$root/current/fdn-network-coordinator/install-official-device-mcp-egress-guard.sh" remove || true
    fi
    rm -f "$units"/fabushi-fdn-{network-worker,enrollment,official-device-mcp,official-mcp-ingress}.service
    rm -f "$units/fabushi-fdn-official-mcp-ingress.timer"
    systemctl daemon-reload
    rm -rf "$root"
    rm -f "$etc_root/fdn-network-worker.env" "$etc_root/fdn-network-enrollment.env" "$etc_root/fdn-official-device-mcp.env"
    rm -rf "$state"
    ;;
  *) fail "unknown action" ;;
esac
