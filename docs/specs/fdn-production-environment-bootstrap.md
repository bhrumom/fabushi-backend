# FDN production environment bootstrap

Status: active; owner: Backend FDN delivery; 2026-10-15.
Parent: Desktop FDN-001; backend fdn-network-coordinator/README.md and ingress spec.

## Context / goal
Production run 38655182839 build succeeds and deploy fails at seven absent values.
Provision authorized real deployment inputs securely, preserve fail-closed authority
boundaries, and enable exact-source Actions delivery when real service prerequisites exist.

## Requirements
- ENV-01: Dedicated SSH deployment identity to existing approved controller server
  bhrum2 (144.24.17.21), using existing ubuntu administrative account. Do not replace
  any existing key. Generate private key on server; transfer directly into protected
  Backend production secrets through gh stdin; never output or persist in repository.
  Restrict SSH key forwarding/PTY via authorized_keys restrict option. This workflow
  installs privileged services, so this remains a privileged deployment identity.
- ENV-02: Pin host key from authenticated device-control connection. Set only
  FABUSHI_FDN_DEPLOY_HOST/USER/SSH_KEY/KNOWN_HOSTS. Retain no transient private key.
- ENV-03: Controller worker must target linux/arm64 matching inspected aarch64 server.
  Native Go tests remain on hosted runner; cross-compile shipping worker explicitly.
- ENV-04: Create fabushi-fdn service group/account before installing group-owned env
  files. Never bypass production preflight or Core exact-head requirements.
- ENV-05: Network/enrollment/MCP env payloads require real isolated Headscale cell,
  Core network authority, immutable subject, rootless Docker, enrolled tsnet controller,
  distinct broker/vault secrets and trusted HTTPS ingress. Leave absent if unconfigured.
  Do not invent placeholder/production credentials or promote account tokens.
- ENV-06: Use standard isolated account factory for test identities (user 2026-10-15
  follow-up). Never provision legacy privileged TestAccount or SQL users, and never
  send isolated test credentials to production Core. Factory cloud device lifecycle now passes28/28 actual assertions at4ccf4f31
  (run38696016535), with independent auth/platform zero-row verification. Literal
  cancellation TTL also passes38699994522. These isolated accounts remain test-only.
- ENV-07: All executable verification/deployment acceptance in GitHub Actions only.
  Remote server administration and read-only inventory allowed; no server tests.

## Current / target state and architecture
Server bhrum2 has legacy official MCP at loopback8792 and rootful Docker workloads.
Dedicated fdnuid993 rootless Docker, Headscale0.29.5, Core authority,
DNS-only fdn.ombhrum.com TLS ingress and public UDP3478 are now configured.
Only the new controller/MCP/enrollment stack awaits the real account/cell payloads.
Existing legacy service and ingress stay untouched until an accepted cutover plan.
FDN new MCP defaults8790, already used by another service: production MCP port
and ingress must be explicitly reconciled, not overwritten by a generated payload.
Backend owns service deployment, Core owns identity/grants, factory owns temporary
ordinary identities and cleanup. No alternate auth system or global Docker access.

## Interfaces and failure modes
Use existing seven encrypted production secret names. Worker authority remains
outside network worker. Partial bootstrap is not successful deploy. Arm64 mismatch,
missing group, invalid32-byte state key, occupied ports, unavailable rootless Docker,
unconfigured authority or unsafe fixture cleanup must fail before activation.
The enrollment launcher currently requires48 characters for a32-byte base64 state
key (44 chars); reconcile with the broker's decoded32-byte contract before deployment.

## Plan / verification
Record spec first, configure four independently valid SSH inputs, prepare delivery
architecture/bootstrap correction PR. Validate only in Actions. Inspect actual secret
names/timestamps without value retrieval. Reuse factory only after real allocation
and cleanup support pass; no production smoke using isolated test credentials.

## Acceptance and compliance
| ID | Status | Evidence |
| --- | --- | --- |
| ENV-01/02 | passed | Four encrypted production SSH values; probe38670452945 |
| ENV-03/04 | passed | PR76 ARM64 and service identity bootstrap integrated |
| ENV-05 | blocked | Infrastructure configured; actual production subject/cell and three service payloads pending |
| ENV-06 | passed | Factory4ccf4f31 run38696016535 actual28/28, zero-row verifier; cancelled-run TTL38699994522 auth/platform0 |
| ENV-07 | passed | Investigation only outside Actions; no builds/tests executed |
| AC-1 four SSH inputs securely set | passed | Protected production secret names/timestamps and SSH probe38670452945 |
| AC-2 all seven real inputs and deployed healthy exact-source stack | blocked | ENV-05 |
| AC-3 production OAuth/direct/DERP/WSS/isolation/revoke/recovery | blocked | AC-2 and scoped fixture infrastructure |

## Release / rollback / evidence
Use dedicated PR and protected production workflow. Remove added authorized key
by its unique comment and delete only four newly created FDN secrets to undo SSH
bootstrap. Do not revoke legacy MCP/keys. Existing atomic controller installer keeps
previous release; no activation until all prerequisites verified. Report source SHA,
Actions run/job/count/exit/artifact separately from secret-name readback.

## Provenance
User request2026-10-15; Backend#69,#75; Desktop#91; authenticated device inventory;
current production workflow and four systemd units inspected via canonical GitHub API.

## Bootstrap follow-up
ENV-08: Validate the enrollment state key by canonical base64 shape and decoded32-byte
length, independently from48-character authority/broker token requirements. Exercise
valid/short/malformed keys in Actions without starting production services.
ENV-09: A protected-main manual SSH probe may verify pinned SSH identity, aarch64,
sudo availability and absence/presence of service configuration without deploying.
Do not execute builds or tests on the server; this probe is read-only configuration
inventory from Actions. Record only fixed booleans and architecture.
Four FDN SSH input names confirmed encrypted in production at2026-10-15T01:01Z.

## Dedicated ordinary production subject (user decision2026-10-15)

The user explicitly selected creating a new dedicated production account rather
than providing an existing account. This is ordinary production registration owned
by Core, independent of the standard isolated test factory and its janitor.

- PA01: Use canonical browser register/code/register/login flow against production
  Core. Proposed username fdn_acceptance_20261015; verified operator Gmail alias
  bhrumom+fabushi-fdn-acceptance-20261015@gmail.com receives a real code. No SQL
  insert, privileged TestAccount, isolated credential promotion or second issuer.
- PA02: The ordinary canonical registration APIs may automate account creation
  with a strong generated password retained only in restricted operator storage.
  This does not require manual form entry. Browser-only credential/terms handoff
  rules apply when using computer UI; do not extend them into an invented universal
  registration requirement. Never request password/code in chat or expose session
  credentials in logs/artifacts or automatically save them in browser storage.
- PA03: Read immutable production account ID only after canonical authentication;
  derive exact Core cell using existing authority projection. Username/email/IP
  must never substitute for immutable ID. Keep controller and enrollment secrets
  distinct from ordinary user credentials. Account is persistent and purpose-bound;
  isolated factory TTL/janitor is not authorized to delete production rows.
- PA04: Securely assemble the remaining three production payloads with real cell,
  controller AuthKey, dedicated rootless Docker, private loopback ports, separate
  broker/state/vault keys and Core authority. No placeholder, missing prerequisite
  or ordinary account token is accepted by service configuration. Preserve legacy
  MCP ingress until explicit validated cutover.
- PA05: All executable acceptance runs in Actions, records exact source, commands,
  exit/counts and sanitized artifacts. Registration success alone does not prove
  production MCP OAuth/direct/DERP/WSS/isolation/revoke/outcome_unknown behavior.

Plan: prepared canonical registration -> canonical verified registration (API, or operator UI submission) ->
canonical identity readback -> existing Core cell/controller enrollment -> encrypted
three-value configuration -> exact-source delivery -> real production acceptance.
On registration response loss, reconcile account ownership through canonical login;
never blindly re-register or mutate D1. On deployment uncertainty preserve journal
and fail closed. Rollback stops only new FDN units/ingress, retaining account and
existing legacy service. Account deletion or credential reset is a separate request.

Current PA01 registration page prepared; PA02 API completion pending real email delivery; PA03–05
blocked on actual production identity and subsequent deployment. Requirements are
not relaxed by successful isolated factory or public infrastructure checks.

## Infrastructure / factory evidence refresh

- Core live-account/session guard:c7d0e24b7561c6f5d1bb3c0e975f599643252504;
  canonical production delivery38695093688 passed. This is not an end-to-end
  production subject/MCP acceptance result.
- Backend infrastructure sourcee35cc868a13f1809ec40337cc02a4692893b31d7;
  public probe38700633492 passed8/8, skipped0, exit0: DNS exact destination,
  real TLS health, DERP latency endpoint, four admin403s, external STUN binding.
  STUN accepts pinned upstream IPv4-mapped response representation and still
  requires a public IPv4, exact packet identity/source and nonzero mapped port.
- Isolated device factory source4ccf4f31ce035b19a0b697828f091d320e04b77b,
  Corec7d0e24, run38696016535:74 contracts and28 actual cloud assertions pass;
  independent auth/platform remaining0. No isolated identity becomes production.
- Literal cancelled consumer38699748493/observer38699994522 at3373f2ad84ad4df3cacd1c6d0ac28cbcc9c5d2a4:
  initial37 rows including1 platform device; after expiry auth0/platform0/total0.
  Observer performs no sweep/cleanup and checked actual cancelled run identity.
- Dedicated rootless daemon uses source-preserving slirp4netns and disables its
  own userland proxy. Existing official br_netfilter kernel module is loaded and
  persisted as a documented host prerequisite; no sysctl/rootful daemon change.
- Oracle NSG fabushi-fdn-bhrum2-stun attaches only target primary VNIC and allows
  stateful UDP3478 ingress. Shared subnet security list remains unchanged.

Remaining AC-2/3 and PA03–05 stay blocked. Public endpoint probes do not establish
private enrolled direct/DERP routing, reverse-WSS tool calls, per-account denial,
revocation, response-loss/outcome_unknown, or an installed Host acceptance.

User follow-up2026-10-15 requests standard API creation instead of assuming mandatory
manual registration. Core browser/start, browser/register/code, browser/register and
protected attempt poll are ordinary public registration APIs, not a test issuer.
Server accepted send request, but actual mailbox delivery is not yet confirmed.
Do not claim delivered email or a created account from a successful send response.
