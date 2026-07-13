# LibreChat on ai.ombhrum.com

This deployment keeps Cloudflare in DNS/proxy/tunnel mode only. Do not create,
attach, or route a Cloudflare Worker for `ai.ombhrum.com`.

## Topology

- `https://ai.ombhrum.com/` -> LibreChat Web on `127.0.0.1:3080`
- `https://ai.ombhrum.com/api/ai/*` -> Dacheng AI bridge on `127.0.0.1:8788`
- `https://ai.ombhrum.com/api/agent/*` -> Codex/OpenClaw agent runs on the Dacheng AI bridge
- `https://ai.ombhrum.com/api/resources/*` -> Dacheng AI bridge resource tools
- `https://ai.ombhrum.com/api/openclaw/*` -> OpenClaw desktop runtime updates and proxy API
- `https://ai.ombhrum.com/api/botfather/*` -> Bot Father Codex generation API
- `https://ai.ombhrum.com/api/miniapps/*` -> MiniApp registry, sandbox source, and review API
- `https://ai.ombhrum.com/api/codex/*` and `/codex-deepseek/*` -> Codex task and Responses adapters
- `https://ai.ombhrum.com/health` -> Dacheng AI bridge health endpoint

Cloudflare may keep the record proxied when using a direct DNS record. If SSE
streaming or WebSocket upgrades misbehave, switch only this DNS record to
DNS-only and keep the same origin configuration.

## Deploy

### Direct DNS/proxy mode

1. Point Cloudflare DNS at the VPS:

   ```bash
   CF_API_TOKEN=... CF_ZONE_ID=... AI_ORIGIN_IP=... ./upsert-cloudflare-dns.sh
   ```

2. Copy this directory to `bhrum1`, then run:

   ```bash
   sudo DOMAIN=ai.ombhrum.com ./install-on-bhrum1.sh
   ```

### Cloudflare Tunnel mode

If `bhrum1` already runs a named Cloudflare Tunnel, route the hostname to the
same VPS and let local Caddy handle path routing:

```bash
cloudflared tunnel route dns --overwrite-dns <tunnel-id> ai.ombhrum.com
sudo DOMAIN=ai.ombhrum.com CADDY_MODE=tunnel CADDY_TUNNEL_PORT=8090 ./install-on-bhrum1.sh
sudo DOMAIN=ai.ombhrum.com CADDY_TUNNEL_PORT=8090 ./configure-cloudflare-tunnel.sh
```

This still uses Cloudflare DNS/Tunnel only; no Worker is created.

### Runtime configuration

The installer generates missing `CREDS_IV`, `CREDS_KEY`, `JWT_SECRET`,
`JWT_REFRESH_SECRET`, and `MEILI_MASTER_KEY` values in
`/opt/librechat/current/.env`. If the existing Dacheng AI bridge has
`DEEPSEEK_API_KEY`, the installer copies it locally into LibreChat's `.env`
without printing it.

Keep `DOMAIN_CLIENT=https://ai.ombhrum.com`, `DOMAIN_SERVER=https://ai.ombhrum.com`,
and `TRUST_PROXY=1`. Do not commit runtime secrets.

After any config edit, restart services:

```bash
sudo systemctl restart dacheng-ai-backend
sudo systemctl reload caddy
cd /opt/librechat/current
sudo docker compose up -d
```

## Verification

```bash
curl -I https://ai.ombhrum.com
curl -s https://ai.ombhrum.com/health
curl -s https://ai.ombhrum.com/api/ai/models
curl -s https://ai.ombhrum.com/api/botfather/generate-miniapp \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"创建一个每日念佛计数器"}'
curl -N https://ai.ombhrum.com/api/ai/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"请用一句话介绍大乘 AI","clientMembershipHint":true}'
```

The last command should stream server-sent events from the same bridge contract
the Flutter app already consumes.
