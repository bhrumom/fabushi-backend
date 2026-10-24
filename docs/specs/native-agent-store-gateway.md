# Native Agent Store public gateway

Status: active; implementation and production acceptance pending
Date: 2026-10-24
Owner: existing Backend public gateway and Node AccountSyncStore

## Context / goal / authority
User explicitly requires retaining cloud automation, cloud Agents and file sync as Fabushi-owned services while removing Cursor dependencies. Backend main 069f69d routes every /v1 path to Core; source and unauthenticated production probes show api.ombhrum.com/v1/account/agents returns 404 while ai.ombhrum.com/v1/account/agents returns the existing native ACCOUNT_AUTH_REQUIRED 401. Node miniapp_marketplace_http + AccountSyncStore already own account-scoped Agents, Bot memberships, file objects, conflict preservation and account synchronization. Do not create a duplicate Rust/Node data truth or wipe existing records. Desktop's separate unshipped Rust account_agent_store copy is reference, not the selected deployed file authority.

## Requirements and architecture
NAS-R1: narrowly route existing /v1/account/agents collection, Agent detail/store, /v1/account/bots collection/membership, and /v1/account/sync to the existing fixed https://ai.ombhrum.com owner before the broad Core gateway. Keep all other /v1 routes on their current owner.
NAS-R2: preserve request method, query, body and native Authorization/device/idempotency context. Never accept an owner origin from user input, environment or query. No retry/failover after a request may have committed. Missing session is still enforced by the existing stable account resolver; never derive account identity from a device ID or raw token digest.
NAS-R3: do not follow or expose upstream redirects on private state routes; return an explicit unavailable error. Disable caching. Preserve 401/403/404/409 and successful response bodies. Errors must not reveal credentials or private request bodies.
NAS-R4: preserve existing data, schema, limits and CAS/conflict behavior; no conversion of Cursor credentials or fake native APIs. This routing unit does not prove large-file parity, saved environments, native cloud scheduling, sharing/multipart, Desktop file-consumer cutover or deployed acceptance.

## Exact route/method contract
- /v1/account/agents: GET
- /v1/account/agents/:agentId: GET, PUT
- /v1/account/agents/:agentId/store: GET, PUT, DELETE
- /v1/account/bots: GET
- /v1/account/bots/:botId/add: POST, DELETE
- /v1/account/sync: GET
Unsupported methods on these owned paths return 405 with Allow. Other paths fall through. Request body/auth validation remains in existing Node owners.

## Strategy / failure and migration
Add one narrow gateway adapter and order it before platform-gateway. Reuse existing AccountSyncStore and authenticated HTTP integration suites. No database/schema/data migration or new storage binding. A failed write proxy returns 502 with unknown outcome and must be reconciled; no hidden replay. Production rollout follows normal Backend Worker pipeline only after exact-source checks; rollback removes the route and leaves Node account data intact, with the known public 404 limitation explicit.

## Verification and acceptance
AC1: gateway tests prove exact route selection, method allowlists, fixed origin, auth/query/body preservation, redirect refusal and one-attempt error handling.
AC2: existing actual SQLite/Node HTTP multi-device account and conflict tests remain passing in GitHub Actions; no local executable verification.
AC3: deployed first-party route/auth/account isolation and Desktop read/write/conflict/restart acceptance use the exact service/client revisions; not inferred from mocks or unauthenticated probes.
Full migration requires AC3 and all remaining native-cloud service requirements; this gateway alone is not completion.

## References / compliance
AGENTS.md; docs/specs/spec-first-ai-development.md; ai-backend/src/account_sync_store.js; ai-backend/src/miniapp_marketplace_http.js; fabushi/web/src/router.js and routes/platform-gateway-routes.js; Desktop PR #172; Core PR #24. All ACs pending. No production writes or deployment performed by discovery.
