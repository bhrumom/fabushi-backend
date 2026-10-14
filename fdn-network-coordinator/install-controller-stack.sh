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
[[ $EUID -eq 0 ]] || fail "root is required"
[[ "$backend_sha" =~ ^[a-f0-9]{40}$ ]] || fail "invalid backend sha"
[[ "$core_sha" =~ ^[a-f0-9]{40}$ ]] || fail "invalid core sha"

ensure_layout() {
  getent group fabushi-fdn >/dev/null || groupadd --system fabushi-fdn
  id fabushi-fdn >/dev/null 2>&1 || useradd --system --gid fabushi-fdn --home "$state" --shell /usr/sbin/nologin fabushi-fdn
  install -d -m 0755 "$root/releases" "$etc_root"
  install -d -o fabushi-fdn -g fabushi-fdn -m 0700 "$state"
}

health() {
  systemctl is-active --quiet fabushi-fdn-network-worker.service
  systemctl is-active --quiet fabushi-fdn-enrollment.service
  systemctl is-active --quiet fabushi-fdn-official-device-mcp.service
  systemctl is-active --quiet fabushi-fdn-official-mcp-ingress.timer
  curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8791/v1/fdn/status >/dev/null
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
    printf '%s
' "$backend_sha" > "$tmp/BACKEND_SHA"
    printf '%s
' "$core_sha" > "$tmp/CORE_SHA"
    chown -R root:root "$tmp"
    chmod -R go-w "$tmp"
    rm -rf "$release"
    mv "$tmp" "$release"

    previous=""
    if [[ -L "$root/current" ]]; then
      previous="$(readlink -f "$root/current" || true)"
      [[ -n "$previous" ]] && ln -sfn "$previous" "$root/previous"
    fi
    ln -sfn "$release" "$root/current.new"
    mv -Tf "$root/current.new" "$root/current"

    for unit in       fabushi-fdn-enrollment.service       fabushi-fdn-official-mcp-ingress.service       fabushi-fdn-official-mcp-ingress.timer       fabushi-fdn-network-worker.service       fabushi-fdn-official-device-mcp.service
    do
      install -m 0644 "$release/fdn-network-coordinator/systemd/$unit" "$units/$unit"
    done
    systemctl daemon-reload
    systemctl enable fabushi-fdn-network-worker.service fabushi-fdn-enrollment.service fabushi-fdn-official-device-mcp.service fabushi-fdn-official-mcp-ingress.timer
    systemctl restart fabushi-fdn-network-worker.service
    systemctl restart fabushi-fdn-enrollment.service
    systemctl restart fabushi-fdn-official-device-mcp.service
    systemctl restart fabushi-fdn-official-mcp-ingress.timer
    systemctl start fabushi-fdn-official-mcp-ingress.service
    if ! health; then
      if [[ -n "$previous" && -d "$previous" ]]; then
        ln -sfn "$previous" "$root/current.rollback"
        mv -Tf "$root/current.rollback" "$root/current"
        systemctl restart fabushi-fdn-network-worker.service fabushi-fdn-enrollment.service fabushi-fdn-official-device-mcp.service
        systemctl restart fabushi-fdn-official-mcp-ingress.timer
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
    systemctl daemon-reload
    systemctl restart fabushi-fdn-network-worker.service fabushi-fdn-enrollment.service fabushi-fdn-official-device-mcp.service
    systemctl restart fabushi-fdn-official-mcp-ingress.timer
    systemctl start fabushi-fdn-official-mcp-ingress.service
    health
    ;;
  health)
    health
    ;;
  uninstall)
    systemctl disable --now fabushi-fdn-official-mcp-ingress.timer fabushi-fdn-official-device-mcp.service fabushi-fdn-enrollment.service fabushi-fdn-network-worker.service 2>/dev/null || true
    rm -f "$units"/fabushi-fdn-{network-worker,enrollment,official-device-mcp,official-mcp-ingress}.service
    rm -f "$units/fabushi-fdn-official-mcp-ingress.timer"
    systemctl daemon-reload
    rm -rf "$root"
    rm -f "$etc_root/fdn-network-worker.env" "$etc_root/fdn-network-enrollment.env" "$etc_root/fdn-official-device-mcp.env"
    rm -rf "$state"
    ;;
  *) fail "unknown action" ;;
esac
