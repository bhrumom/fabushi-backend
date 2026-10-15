# FDN direct TLS ingress
Status:active;owner:Backend FDN infrastructure;2026-10-15.
Parent:FDN-001;fdn-rootless-coordinator-bootstrap.md.

## Context and goal
RootlessHeadscale0.29.5 is deployed onloopback8080. Core authority reconciles401
without credential and200 with the same securely staged credential in Actions
38672973704 after all10 pendingPLATFORM_DB migrations were applied in38672810857.
Headscale control usesPOST upgrade with tailscale-control-protocol. Its deployment
documentation says Cloudflare Proxy/Tunnel is incompatible. Prepare a direct TLS
entry without publishing new access until action-time confirmation.

## Requirements
- IN01: DNS-onlyA fdn.ombhrum.com ->144.24.17.21; no proxy/tunnel and no token/D1
  permission expansion. User must confirm actual DNS save/publication at action
  time under Computer Use policy; stage is permitted before confirmation.
- IN02: Reuse actual HAProxyTCP443 defaultbackendApache127.0.0.1:9443 and Apache80.
  Add only dedicated hostname vhosts; preserve all existing SNI routes/defaults.
  Preserve tailscale-control-protocol via ApacheProxyPass upgrade=any.
- IN03: Use existing certbot/registered ACME account withwebrootHTTP challenge and
  realfdn hostname certificate. Never self-signed production cert or TLS bypass.
  No new ToS acceptance or registration fallback; missing account blocks.
- IN04: Block/api,/metrics,/debug,/swagger on the public vhost. Headscale admin
  gRPC/metrics remain loopback. Logs contain time/method/status/duration only,
  not tokens,paths,query bodies or client cookies. No Core authority in Apache.
- IN05: Only after user confirms publication,protected-main Actions may activate
  HTTP challenge vhost,obtain cert,activate TLS vhost,and openUDP3478 forSTUN.
  The stage mode copies exact-SHA config and observes local runtime only,without
  enabling a vhost or changing firewall. No enrollment keys/users/nodes created.
- IN06: Render/check Apache config only in Actions with synthetic certs. Production
  server actions are installation/runtime reloads and read-only status. Record
  exact source,stage/publish mode,exit,Headscale state and real TLS health status.

## Ownership,interfaces and failure modes
Existing Apache/HAProxy remain owners; no new reverse proxy daemon. Repo keeps
vhost templates and exact-source installer. Stage under/opt/fabushi-fdn-ingress.
Public endpoint forwards only toloopback8080. The admin API is not part of the
public authority plane. DNS missing,certificate issuance failure,reload failure,
firewall failure or route incompatibility is blocked,never healthy acceptance.

## Plan and verification
Specfirst -> two hostname fragments + stage/publish installer -> real Apache syntax
check using Actions generated test certificate -> merge -> stage only -> review
DNS-onlyA draft + request action-time publication confirmation -> publish -> real
TLS health + later actual tsnet enrollment/direct/DERP tests. Health alone is not
G02/G05/G16. No local workstation/server build,test,lint or generator execution.

## Acceptance,rollback,evidence
IN01–06, AC1 (stage) and AC2 (public TLS endpoint) passed at exact source
`f644870335ac779d683ff28908fff434c6fb0558`. Stage run38692462081 and confirmed
publish run38692737102 both succeeded (exit0). Actual artifact records active
service, running healthy pinned Headscale image, DNS-only A publication, real
certificate expiring2027-01-13, dedicated hostname vhosts and UDP3478 firewall
allowance. Public HTTPS health passed; /metrics, /api/v1/node, /swagger and /debug
each returned403. Actual STUN packet reachability/control upgrade, enrollment and
direct/DERP/WSS are separate unverified gates; health is not their acceptance.
Rollback disables onlyfabushi-fdn HTTP/TLS sites and removes only the newUDP3478
allow rule if this workflow created it; restore prior unchanged routes. Preserve
certificates/state/keys; do not remove shared Apache/HAProxy. Capture only source,
mode,runtime state,HTTP/TLS exit,artifact; no production private cert content.

## Provenance
User's production environment request and confirmed limited CF token. Public
publication was explicitly confirmed by the user after stage delivery on2026-10-15. Authenticated server inspection shows
HAProxy443,Apache80/9443,existing certbot and registered Let's Encrypt account.
Headscale deployment reference:
https://headscale.net/stable/ref/integration/reverse-proxy/ (Cloudflare limitation,
Apache upgrade=any,STUNUDP3478; community-maintained page on project docs site).
