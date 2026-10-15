#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || exit 64
archive=${1:?}
sha=${2:?}
action=${3:-stage}
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || exit 64
[[ $action = stage || $action = publish ]] || exit 64
release=/opt/fabushi-fdn-ingress/releases/$sha
install -d -m 0755 "$release"
tar -xzf "$archive" -C "$release"
chown -R root:root "$release"
chmod -R go-w "$release"
printf 'source_sha=%s\nmode=%s\n' "$sha" "$action"
systemctl is-active fabushi-fdn-headscale.service
fdn_uid=$(id -u fabushi-fdn)
sudo -H -u fabushi-fdn env DOCKER_HOST="unix:///run/user/$fdn_uid/docker.sock" docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} {{.Image}}' fabushi-fdn-coordinator-headscale-1
if [[ $action = stage ]]; then printf 'ingress_staged_only=true\n'; exit 0; fi
# Publication is a separately confirmed deployment, never a stage side effect.
command -v certbot >/dev/null
install -d -m 0755 /var/www/fabushi-fdn-acme
install -m 0644 "$release/apache-fdn-http.conf" /etc/apache2/sites-available/fabushi-fdn-http.conf
a2ensite fabushi-fdn-http.conf
systemctl reload apache2
certbot certonly --webroot --webroot-path /var/www/fabushi-fdn-acme --domain fdn.ombhrum.com --non-interactive --keep-until-expiring
install -m 0644 "$release/apache-fdn-tls.conf" /etc/apache2/sites-available/fabushi-fdn-tls.conf
a2ensite fabushi-fdn-tls.conf
systemctl reload apache2
ufw allow 3478/udp
printf 'tls_ingress_activated=true\nstun_udp_3478_allowed=true\n'
