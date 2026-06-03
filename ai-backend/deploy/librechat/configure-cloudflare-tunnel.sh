#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-ai.ombhrum.com}"
MCP_DOMAIN="${MCP_DOMAIN:-vps-mcp.ombhrum.com}"
TUNNEL_CONFIG="${TUNNEL_CONFIG:-/home/ubuntu/.cloudflared/config.yml}"
CADDY_TUNNEL_PORT="${CADDY_TUNNEL_PORT:-8090}"

if [[ ! -f "$TUNNEL_CONFIG" ]]; then
  echo "Tunnel config not found: $TUNNEL_CONFIG" >&2
  exit 1
fi

tunnel_line="$(grep -E '^tunnel:' "$TUNNEL_CONFIG" | head -n 1)"
credentials_line="$(grep -E '^credentials-file:' "$TUNNEL_CONFIG" | head -n 1)"

if [[ -z "$tunnel_line" || -z "$credentials_line" ]]; then
  echo "Tunnel config must contain tunnel and credentials-file entries." >&2
  exit 1
fi

sudo cp "$TUNNEL_CONFIG" "${TUNNEL_CONFIG}.backup.$(date +%Y%m%d%H%M%S)"
sudo tee "$TUNNEL_CONFIG" >/dev/null <<EOF
$tunnel_line
$credentials_line

ingress:
  - hostname: ${DOMAIN}
    service: http://localhost:${CADDY_TUNNEL_PORT}
  - hostname: ${MCP_DOMAIN}
    service: http://localhost:8787
  - service: http_status:404
EOF

sudo systemctl restart chatgpt-vps-tunnel.service
echo "Cloudflare Tunnel ingress configured for https://${DOMAIN} without Workers."
