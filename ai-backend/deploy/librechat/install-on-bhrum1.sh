#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-ai.ombhrum.com}"
LIBRECHAT_DIR="${LIBRECHAT_DIR:-/opt/librechat/current}"
LIBRECHAT_REPO="${LIBRECHAT_REPO:-https://github.com/danny-avila/LibreChat.git}"
LIBRECHAT_REF="${LIBRECHAT_REF:-main}"
CADDY_MODE="${CADDY_MODE:-direct}"
CADDY_TUNNEL_PORT="${CADDY_TUNNEL_PORT:-8090}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root or with sudo." >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl git gnupg lsb-release

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

install -d -m 0755 "$(dirname "$LIBRECHAT_DIR")"
if [[ ! -d "$LIBRECHAT_DIR/.git" ]]; then
  git clone "$LIBRECHAT_REPO" "$LIBRECHAT_DIR"
fi

cd "$LIBRECHAT_DIR"
git fetch --tags origin
git checkout "$LIBRECHAT_REF"
git pull --ff-only origin "$LIBRECHAT_REF" || true

if [[ ! -f .env ]]; then
  cp .env.example .env
fi

set_env() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" key "=" && done == 0 {
      print key "=" value
      done = 1
      next
    }
    { print }
    END {
      if (done == 0) {
        print key "=" value
      }
    }
  ' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

ensure_hex_secret() {
  local key="$1"
  local bytes="$2"
  local current
  local example
  current="$(grep -E "^${key}=" .env | tail -n 1 | cut -d= -f2- || true)"
  example="$(grep -E "^${key}=" .env.example | tail -n 1 | cut -d= -f2- || true)"
  if [[ -z "$current" || "$current" == "$example" || "$current" == "changeme" || "$current" == *"your"* || "$current" == *"replace"* ]]; then
    set_env "$key" "$(openssl rand -hex "$bytes")"
  fi
}

cp "$SCRIPT_DIR/librechat.yaml" "$LIBRECHAT_DIR/librechat.yaml"
cat > "$LIBRECHAT_DIR/docker-compose.override.yml" <<'EOF'
services:
  api:
    environment:
      - CONFIG_PATH=/app/librechat.yaml
    ports: !override
      - "127.0.0.1:3080:3080"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - type: bind
        source: ./librechat.yaml
        target: /app/librechat.yaml
EOF

set_env "DOMAIN_CLIENT" "https://${DOMAIN}"
set_env "DOMAIN_SERVER" "https://${DOMAIN}"
set_env "TRUST_PROXY" "1"
ensure_hex_secret "CREDS_KEY" 32
ensure_hex_secret "CREDS_IV" 16
ensure_hex_secret "JWT_SECRET" 32
ensure_hex_secret "JWT_REFRESH_SECRET" 32
ensure_hex_secret "MEILI_MASTER_KEY" 32

if [[ -f /opt/dacheng-ai/.env ]] && grep -q '^DEEPSEEK_API_KEY=' /opt/dacheng-ai/.env && ! grep -q '^DEEPSEEK_API_KEY=' .env; then
  deepseek_key="$(grep '^DEEPSEEK_API_KEY=' /opt/dacheng-ai/.env | tail -n 1 | cut -d= -f2-)"
  set_env "DEEPSEEK_API_KEY" "$deepseek_key"
fi

docker compose pull
docker compose up -d

install -d -m 0755 /etc/caddy/conf.d
if [[ "$CADDY_MODE" == "tunnel" ]]; then
  sed "s/:8090/:${CADDY_TUNNEL_PORT}/g" "$SCRIPT_DIR/Caddyfile.tunnel" \
    > /etc/caddy/conf.d/ai.ombhrum.com.caddy
else
  sed "s/ai\\.ombhrum\\.com/${DOMAIN}/g" "$SCRIPT_DIR/Caddyfile" \
    > /etc/caddy/conf.d/ai.ombhrum.com.caddy
fi

if [[ "$CADDY_MODE" == "tunnel" ]]; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup.$(date +%Y%m%d%H%M%S)"
  cat > /etc/caddy/Caddyfile <<'EOF'
{
	auto_https off
}

import /etc/caddy/conf.d/*.caddy
EOF
elif ! grep -q 'import /etc/caddy/conf.d/\*.caddy' /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.backup.$(date +%Y%m%d%H%M%S)"
  printf '\nimport /etc/caddy/conf.d/*.caddy\n' >> /etc/caddy/Caddyfile
fi

systemctl enable --now docker
systemctl enable --now caddy
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy

echo "LibreChat domain deployment prepared for https://${DOMAIN}"
