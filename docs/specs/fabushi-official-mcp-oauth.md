# Fabushi official MCP production routing and delivery — Specification
Status: active
Owner: Fabushi Backend
Last updated: 2026-10-09

## Context and goal
User authorizes provisioning and publishing a fully usable Fabushi Google/GitHub MCP market through their logged-in Mac. Native marketplace is Desktop PR #49; provider authorization belongs to canonical Platform Core. The public API is owned by this repository's production compatibility gateway. Existing routing does not forward /api/mcp/, so adding broker code alone cannot connect users.

## Requirements
- B-MCP-1: Forward only /api/mcp/oauth/ and /api/mcp/connections/ to the existing canonical platform origin, preserving manual provider redirects and response bodies. No foreign-origin redirects carrying Fabushi credentials and no retry of uncertain connection mutations after service-binding failure.
- B-MCP-2: Extend existing gateway owner; do not rebuild account login, duplicate the marketplace UI or deploy legacy copies. Keep minimum-scope login unchanged.
- B-MCP-3: Provide a manually dispatched main-only platform Worker delivery that checks out canonical Core main at an explicitly selected SHA, proves its exact-head OAuth verification success, builds in Actions, records D1 recovery, applies ACCOUNT_DB migration, deploys mahayana-platform, and records health/routing/provenance.
- B-MCP-4: Provider clients stay in Worker secret bindings. Dedicated MCP_GOOGLE_CLIENT_ID/SECRET and MCP_GITHUB_CLIENT_ID/SECRET may coexist with existing OAUTH login clients. Callback is https://api.ombhrum.com/api/mcp/oauth/callback. No secrets in source, logs, artifacts or desktop package.
- B-MCP-5: Existing Production Worker Delivery remains the gateway deployment owner; its main-only credential/security/migration/build/provenance policy remains mandatory. All builds and checks run in Actions; Mac is configuration/control only.

## Architecture and contracts
Core implements authenticated /api/mcp/oauth/start, /attempts/:id, /ack, /cancel and /connections/:id/refresh and /revoke; public /authorize and /callback use hashed expiring browser tickets, single-use state and PKCE. Native Desktop receives tokens directly via authenticated polling and keeps them in encrypted account-scoped storage. This repository forwards the fixed first-party paths and deploys canonical sources, without becoming a second credential owner.

## Current and target state
Current backend main is 5330037b29fc8f8a587f72879495b286fc4a582d. Existing gateway forwards account auth and /v1 only. Existing production gateway workflow is main-only manual dispatch. Target preserves those contracts and adds canonical provider connection routing and reproducible Core Worker deployment.

## Failure handling and constraints
Missing Cloudflare registration, credentials, Google preview qualification or provider approvals remain explicit blocks. Reject non-main, unverified Core source, missing signing secrets and unregistered clients. Do not mask these failures or report live connectivity from fixtures. Token rotation/revoke calls are never retried by the compatibility gateway. Additive ACCOUNT_DB migration rolls back by retaining tables and disabling routes; recovery bookmark precedes mutation.

## Implementation and verification
Spec commit precedes gateway/workflow changes. Existing Actions static delivery gate covers the gateway workflow; add focused route tests that prove manual redirects, path isolation and no retry for uncertain mutations. Core Actions compiles the real wasm Worker and verifies connection cryptography/migration invariants; Desktop Actions verifies native lifecycle and shipping composition. Production dispatch requires verified canonical source and configured provider applications; retain exact repositories/commits/runs/deployment IDs.

## Acceptance
- AC-B1: Exact-head routing/static integrity gate succeeds.
- AC-B2: Core and gateway production deployments succeed from canonical main with provenance.
- AC-B3: Public /api/mcp/ routes reach the real broker and fresh packaged Desktop connects/discovers/calls GitHub and Google, including expiry/revoke/account-switch.

## Evidence and compliance
All acceptance is pending; no live OAuth/provider operation or publication is claimed. Core implementation is owned by fabushi-platform-core; native integration by fabushi-desktop. User login/consent via unified-device-control private card is pending. Existing Google project has Chrome publishing clients and an enableable Gmail MCP API; qualification remains unverified.

## References
https://developers.google.com/workspace/guides/configure-mcp-servers
https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md
Related: docs/specs/production-worker-delivery.md; Desktop docs/specs/fabushi-official-mcp-marketplace.md.

Build closure: Core deploy/platform-worker/Cargo.toml references the canonical Worker src/lib.rs and the canonical platform-core dependency, with a committed dedicated lock. Build in core/deploy/platform-worker; wrangler remains in the canonical Worker directory and points to that output. Do not build the legacy imported parent workspace whose migrated CLI members are absent. Rollout order: merge verified Core/backend source; dispatch existing backend production gateway delivery; dispatch this platform delivery against verified Core main; configure/confirm provider applications and run real connection acceptance; publish verified Desktop candidate.

## Delivery recovery discovered 2026-10-09
Production gateway run 37889336367 passed all nine remote security-secret checks, but failed before deployment because lexicographic migration order applies human_call_convergence/device_claim before human_call_signaling creates their table. Public MCP start still returns 502/upstream 404. Repository secret-list absence does not prove inherited Actions credentials absent.

B-MCP-6: Preserve historical migration filenames and add an earlier idempotent bootstrap with exactly the signaling base schema. Existing channels/events and applied migration records must survive. Verify SQLite upgrade paths for missing base tables, existing base tables with data, and already upgraded tables with migration history. Capture the remote D1 recovery bookmark before gateway migrations and retain recovery evidence on failure.
B-MCP-7: Platform delivery must resolve the same Cloudflare credential aliases and account variables as gateway delivery, fail closed on missing credentials, and compile only once with the committed Core lock before deployment. Preserve exact main/SHA/provider preflights.

Plan: spec first, additive bootstrap, SQLite migration regression in Actions, aligned delivery credentials, pinned locked Worker build, exact-head CI, merge and dispatch canonical main, then public routing and packaged/provider acceptance. No database reset, renamed history or skipped pending migration. Rollback retains the additive tables and recovery bookmark; revert deployment while preserving recorded migration history.
Acceptance AC-B4: migration upgrade/data-preservation regression and delivery configuration checks pass exact-head Actions. AC-B1-B3 remain subject to production and provider evidence.

Recovery compliance: B-MCP-1/2/4/5 preserved; B-MCP-6/7 and AC-B4 passed on implementation 341929e in Actions 37889599910 (six delivery contracts and three real SQLite upgrade/data-preservation cases) and 37889599965 (three gateway cases). This follow-up keeps Wrangler normal bundling while suppressing only the already-completed build hook. AC-B2/3 remain blocked on production delivery and real provider/packaged acceptance; failed run 37889336367 made no Worker deployment. Final-head verification is required again before merge.


## FDN-001 official device-control migration — 2026-10-14

This repository also becomes the canonical owner of the existing Fabushi official **device-control MCP** that historically lived under `bhrumom/fabushi/chatgpt-vps-control`. This is a migration of the same public product and protocol, not a second MCP service.

### Requirements

- B-FDN-1: Preserve the existing public MCP concepts and compatible tools `fabushi_account`, `list_devices`, `describe_device_tool`, and `device_call`; do not fork a second account system, device registry, or public endpoint.
- B-FDN-2: Account identity must come from the existing Fabushi account APIs. Equal device IDs across different Fabushi accounts remain isolated. Device self-reported names, IPs, email addresses, or node IDs are never sufficient authority.
- B-FDN-3: The migrated gateway keeps account-scoped WebSocket registration, bounded device/tool catalog sizes, explicit capability filtering, pending-call bounds, disconnect handling, audit hooks, and credential redaction. Dynamic tool descriptions are data, never authorization.
- B-FDN-4: The first canonical migration preserves source behavior from legacy main `7f2935500cec3a199caf7823557ce5d106e051f4` and verifies it in GitHub Actions before any production cutover. No builds or tests run on persistent hosts.
- B-FDN-5: Subsequent FDN work must replace direct account-scoped socket reachability with the accepted FDN-001 path: account/device authorization -> Remote Computer session/requestId reconciliation -> restricted network gateway -> target Host second authorization. WireGuard/DERP/reverse-WSS transport must not weaken application authorization.
- B-FDN-6: Production cutover keeps the existing public origin and OAuth direction for third-party MCP clients connecting to Fabushi. Provider-marketplace OAuth remains a separate flow and credential boundary.
- B-FDN-7: Side-effecting device operations require stable request identity, result reconciliation, cancellation, audit, revocation fencing, and explicit outcome-unknown handling before automatic network retry is allowed.

### Acceptance

- AC-FDN-B1: Canonical Backend package compiles/checks and its focused account-isolation, device-routing, and MCP OAuth tests pass on the exact PR head.
- AC-FDN-B2: Legacy source is no longer the implementation owner after cutover; deployment provenance points to a Backend canonical SHA while the public endpoint and installed clients remain compatible.
- AC-FDN-B3: Real official MCP calls reach an authorized same-account Fabushi device through the FDN transport/session path and a cross-account negative case is rejected.
- AC-FDN-B4: revoke/account-switch/network-loss/result-loss cases prove stale grants and ambiguous side effects are fenced rather than replayed blindly.

Current status: AC-FDN-B1 is being implemented in this branch. AC-FDN-B2..B4 remain pending and must not be reported as passed until exact deployment/device evidence exists.


### FDN-001 Core operation-journal cutover slice — 2026-10-14

- B-FDN-8: `device_call` must allocate a stable opaque requestId before transport dispatch and bind that request to the authenticated Fabushi account, target device, exact tool name and request digest in the canonical Platform Core Remote Computer operation journal. A transport timeout, socket disconnect, or response loss after dispatch is `outcome_unknown`; it is never interpreted as “not executed” and is never automatically replayed.
- B-FDN-9: The Backend gateway may retain reverse-WSS as one transport, but transport reachability is not authorization. Production Core-journal mode is fail-closed: if Core operation create/query/claim authorization is unavailable, the gateway must not silently fall back to direct unjournaled execution.
- B-FDN-10: The target device receives only the opaque requestId, exact tool name, bounded arguments and disk preflight needed by the existing executor. Ordinary Fabushi login access tokens, Remote Computer deviceSecret/mobileToken, MCP grant material, network private keys and Core service credentials are never included in the device call frame.
- B-FDN-11: The public `device_call` response distinguishes `completed`, `failed`, and `outcome_unknown` and carries the stable requestId. Query/cancel surfaces may be added compatibly, but unknown outcomes cannot be retried automatically.
- AC-FDN-B5: Exact-head Actions prove stable request identity, account/device/tool binding through an injected canonical Core journal adapter, fail-closed production configuration, transport-loss => outcome_unknown, and no secret fields in target call frames. Real deployed Core/session/network/Host E2E remains required before G09/G16 or FDN-A04/A08/A16 can pass.
