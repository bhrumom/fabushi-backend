# FDN public network probe

Status: active; owner: Backend FDN infrastructure; 2026-10-15.
Parent: FDN-001 and fdn-direct-tls-ingress.md.

## Context and goal
Confirmed publication run38692737102 proves HTTPS health, administrative denial
and a local UDP firewall allowance. It does not establish external UDP reachability.
Prove the fixed public endpoint from an independent GitHub hosted runner without
creating accounts/nodes or sharing production authority with a test environment.

## Requirements and boundaries
- NP01: Run only in Actions, against fixed fdn.ombhrum.com:443/3478 and expected
  IPv4 144.24.17.21. No arbitrary host, workflow input, cloud credential or SSH.
- NP02: Verify normal TLS health, DERP latency probe, and four administrative
  paths denied with403. Refuse redirects. DERP probe is reachability only.
- NP03: Send one RFC5389 UDP Binding Request with random96-bit transaction ID,
  upstream Tailscale SOFTWARE=tailnode and CRC32 FINGERPRINT. The pinned upstream
  parser must accept the actual emitted Python packet in Actions.
  Require exact remote address, successful Binding Response, magic cookie,
  matching transaction, bounded/padded attributes and valid mapped IPv4/port.
  A timeout or malformed response fails; it must never be interpreted as success.
- NP04: Write sanitized exact source/run/environment, named assertion counts,
  exit/status and timings even on failure. Do not log mapped runner addresses,
  packet bodies or sensitive content. Unit regression must reject wrong source,
  transaction, cookie, truncated attributes and absent/invalid mapped address.
- NP05: Do not label this direct/DERP tool-call, control-protocol upgrade,
  enrollment, MCP OAuth or G05/G16 acceptance. Those need authorized real nodes.

## Current and target state; ownership
Existing Apache/HAProxy/Headscale remain unchanged. A bounded stdlib Python probe
and hosted Actions workflow extend deployment evidence, not product auth or a
second network owner. It opens no inbound runner ports and mutates no resources.
No schema, API, dependencies or production rollout is required.

## Plan, verification and acceptance
Spec -> protocol parser/probe and Actions -> adversarial parser regression ->
protected-main actual external run -> record all NP01–05. AC1: independent real
STUN response plus HTTPS/DERP probes and denial pass on exact main. Missing UDP
route is blocked, not skip. No local/server executable checks.

## Failure, rollback and observability
DNS drift, redirect, TLS error, timeout, invalid source/transaction/attributes or
unexpected HTTP status fail with fixed category and sanitized evidence. No
automatic mutation retries. Stop/disable this read-only workflow to roll back.

## Provenance
User2026-10-15 requests finishing real environments. Published sourcef6448703;
RFC5389 Binding Request/Response; pinned Tailscale1.104.1 ProbeHandler:
https://pkg.go.dev/tailscale.com@v1.104.1/derp/derpserver .

## Actual failure follow-up
Runs38693700361/38693879484 proved UDP did not reach the host. User confirmed
UDP3478 exposure and logged into OCI. A dedicated fabushi-fdn-bhrum2-stun NSG
allows only UDP3478 and is attached only to bhrum2 VNIC; shared security list
unchanged. Run38695411802 reached the host but timed out. Source review of
Tailscale1.104.1 net/stun/stun.go finds ParseBindingRequest requires SOFTWARE
and FINGERPRINT; the generic initial request lacked both. Preserve failures,
verify pinned parser interoperability, then rerun actual external acceptance.
Reference: https://github.com/tailscale/tailscale/blob/v1.104.1/net/stun/stun.go .

## IPv4-mapped IPv6 response correction
Headscale0.29.5 serverSTUNListener uses netip.AddrFromSlice on UDPAddr.IP without
Unmap; a valid IPv4 peer may be encoded as family2 IPv4-mapped IPv6. The initial
parser reported the same stun_mapping_invalid for an unsupported family and a
private address, so that status alone did not establish private source rewriting.
NP06: Accept a correctly decoded public IPv4 mapping in either family1 or family2
IPv4-mapped representation. Decode XOR mask with cookie+transaction exactly;
keep strict source/transaction/length/public IPv4/port checks and reject private,
loopback, malformed or unrelated IPv6 mappings. Test interoperability against the
pinned upstream Response generator, not only handcrafted packets, then run actual
external acceptance. No extra host change is justified by the old generic error
without this discriminating probe. Earlier rootless configuration deliveries and
rollback remain recorded but do not prove the external source-address property.
Reference: Headscalev0.29.5 hscontrol/derp/server/derp_server.go lines389–390;
Tailscalev1.104.1 net/stun/stun.go Response/ParseResponse unmapping behavior.
