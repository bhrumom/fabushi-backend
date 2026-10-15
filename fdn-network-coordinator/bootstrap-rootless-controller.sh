#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || exit 64
archive=${1:?archive required}
sha=${2:?source SHA required}
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || exit 64
[[ "$(uname -m)" = aarch64 ]] || exit 64
command -v dockerd-rootless-setuptool.sh >/dev/null
if ! command -v newuidmap >/dev/null || ! command -v newgidmap >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y uidmap
fi
getent group fabushi-fdn >/dev/null || groupadd --system fabushi-fdn
id fabushi-fdn >/dev/null 2>&1 || useradd --system --gid fabushi-fdn --home-dir /var/lib/fabushi-fdn --shell /usr/sbin/nologin fabushi-fdn
if id -nG fabushi-fdn | tr ' ' '\n' | grep -qx docker; then echo rootful_docker_group_forbidden >&2; exit 64; fi
install -d -o fabushi-fdn -g fabushi-fdn -m 0700 /var/lib/fabushi-fdn
for kind in subuid subgid; do
  if awk -F: '$1=="fabushi-fdn" && $3>=65536 {found=1} END {exit !found}' "/etc/$kind"; then continue; fi
  if awk -F: '$2<=965535 && $2+$3-1>=900000 {found=1} END {exit !found}' "/etc/$kind"; then echo subordinate_id_range_conflict >&2; exit 64; fi
  if [[ $kind = subuid ]]; then usermod --add-subuids 900000-965535 fabushi-fdn; else usermod --add-subgids 900000-965535 fabushi-fdn; fi
done
fdn_uid=$(id -u fabushi-fdn)
loginctl enable-linger fabushi-fdn
systemctl start "user@$fdn_uid.service"
run_user() { sudo -H -u fabushi-fdn env XDG_RUNTIME_DIR="/run/user/$fdn_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$fdn_uid/bus" "$@"; }
if ! run_user systemctl --user is-active --quiet docker.service; then
  run_user dockerd-rootless-setuptool.sh install --force
fi
# STUN must observe the caller source IP; RootlessKit2 builtin rewrites it.
command -v slirp4netns >/dev/null
user_dropin=/var/lib/fabushi-fdn/.config/systemd/user/docker.service.d
install -d -o fabushi-fdn -g fabushi-fdn -m 0700 "$user_dropin"
source_ip_config=$(mktemp)
trap 'rm -f "$source_ip_config"' EXIT
cat > "$source_ip_config" <<'SOURCE_IP'
[Service]
Environment="DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns"
Environment="DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=slirp4netns"
SOURCE_IP
if ! cmp -s "$source_ip_config" "$user_dropin/20-fdn-source-ip.conf"; then
  install -o fabushi-fdn -g fabushi-fdn -m 0600 "$source_ip_config" "$user_dropin/20-fdn-source-ip.conf"
  run_user systemctl --user daemon-reload
  run_user systemctl --user restart docker.service
fi
run_user systemctl --user enable --now docker.service
root=/opt/fabushi-fdn-infra
release="$root/releases/$sha"
install -d -m 0755 "$root/releases"
if [[ ! -d "$release" ]]; then
  install -d -m 0755 "$release"
  tar -xzf "$archive" -C "$release"
  chown -R root:root "$release"
fi
runtime=/var/lib/fabushi-fdn/headscale-runtime
if [[ ! -d "$runtime" ]]; then
  install -d -o fabushi-fdn -g fabushi-fdn -m 0700 "$runtime"
  install -o fabushi-fdn -g fabushi-fdn -m 0600 "$release/runtime/config.yaml" "$runtime/config.yaml"
  install -o fabushi-fdn -g fabushi-fdn -m 0600 "$release/runtime/policy.hujson" "$runtime/policy.hujson"
fi
# Never replace persisted keys or policy on a repeat deployment.
rm -rf "$release/runtime"
ln -s "$runtime" "$release/runtime"
if [[ -L "$root/current" ]]; then ln -sfn "$(readlink -f "$root/current")" "$root/previous"; fi
ln -sfn "$release" "$root/current.new"
mv -Tf "$root/current.new" "$root/current"
cat > /etc/systemd/system/fabushi-fdn-headscale.service <<UNIT
[Unit]
Description=Fabushi dedicated rootless Headscale coordinator
After=network-online.target user@$fdn_uid.service
Wants=network-online.target user@$fdn_uid.service
[Service]
Type=oneshot
RemainAfterExit=yes
User=fabushi-fdn
Group=fabushi-fdn
Environment=DOCKER_HOST=unix:///run/user/$fdn_uid/docker.sock
WorkingDirectory=/opt/fabushi-fdn-infra/current
ExecStart=/usr/bin/docker compose --project-name fabushi-fdn-coordinator up -d
ExecStop=/usr/bin/docker compose --project-name fabushi-fdn-coordinator stop
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now fabushi-fdn-headscale.service
printf 'source_sha=%s\nrootless_user=fabushi-fdn\nsocket=/run/user/%s/docker.sock\nheadscale_image=docker.io/headscale/headscale:0.29.5\n' "$sha" "$fdn_uid"
printf 'source_preserving_port_driver=slirp4netns\n'
run_user systemctl --user is-active docker.service
systemctl is-active fabushi-fdn-headscale.service
run_user env DOCKER_HOST="unix:///run/user/$fdn_uid/docker.sock" docker compose --project-directory "$root/current" --project-name fabushi-fdn-coordinator ps --format json
