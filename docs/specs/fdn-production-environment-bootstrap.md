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
  send isolated test credentials to production Core. Factory #75 is currently fixing
  hosted OIDC allocation; factory auth-only janitor does not yet accept device/MCP data.
- ENV-07: All executable verification/deployment acceptance in GitHub Actions only.
  Remote server administration and read-only inventory allowed; no server tests.

## Current / target state and architecture
Server bhrum2 has legacy official MCP at loopback8792 and rootful Docker workloads.
It has no /etc/fabushi, FDN systemd services, Headscale or rootless coordinator.
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
| ENV-01/02 | blocked | Bootstrap and readback pending |
| ENV-03/04 | blocked | Workflow correction and exact-head Actions pending |
| ENV-05 | blocked | Headscale/rootless Docker/Core service authority not configured |
| ENV-06 | blocked | Hosted factory allocation #75 pending; device/MCP cleanup separate |
| ENV-07 | passed | Investigation only outside Actions; no builds/tests executed |
| AC-1 four SSH inputs securely set | blocked | Pending |
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
