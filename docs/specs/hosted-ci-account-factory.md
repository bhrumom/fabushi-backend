# Hosted isolated CI account factory — Specification

Status: active; deployment acceptance pending
Owner: Fabushi Backend; normal auth remains Platform Core
Date: 2026-10-15

## 1. Context / problem
User explicitly requests operating the computer to finish the real cloud testing
environment, including automatic ordinary registration, code delivery and login.
The existing factory passes 49 contracts and a real wasm/local-D1 slice, but has
no hosted mailbox, janitor, durable deployment or independent TTL service.
Current Backend main: c73bccfa183d94d4d1d803c060d4ebd0d45a7c99.
Core current main: f781e6c85375ba0945aa4fd4c19ead89e396dfdb.
Cloudflare UI is signed in; D1 inventory has six existing databases, none named
ci-isolated. GitHub ci-isolated environment has no secrets or variables.

## 2. Goal
Deploy the existing factory orchestration against real isolated cloud D1 and
canonical auth Worker; prove normal code/registration/login and independent TTL.

## 3. Non-goals
No production bindings/data mutations, no alternate auth issuer, no shortened
synthetic JWT, no privileged TestAccount. Cloud mailbox bridge acceptance does
not claim SMTP delivery, actual physical devices, packaged E2E or whole P0–P4.

## 4. Requirements
- HAF-01: Dedicated test ACCOUNT_DB and PLATFORM_DB, independent RSA keys, auth
  Worker and factory Worker. Deployment reads actual bindings and refuses known
  production IDs/origins. Existing resources are not repurposed by name alone.
- HAF-02: Reuse AccountFactory, CanonicalAuthAdapter and verified OIDC handler.
  Extract runtime-independent factory logic without changing Node journal APIs.
  Add Cloudflare SQLite Durable Object journal as the single lifecycle owner;
  synchronous quota reservation and serialization across allocations prevent
  canonical MAX(user.id)+1 registration races. No multi-owner journal.
- HAF-03: Bridge receives canonical generated six-digit registration codes only
  for identities reserved in its journal, authenticated with a dedicated secret.
  Mailbox lookup is internal to orchestration; no public code retrieval endpoint.
  Codes expire, are consumed once and never enter logs/artifacts. @ci.invalid
  remains deliberate test transport; real external email is a separate gate.
- HAF-04: Janitor bound only to test D1, validates planned lease ownership before
  SQL. Delete child auth data and accounts, verify zero residual, fail closed for
  unhandled schema references. No SQL provisioning. Initial hosted acceptance
  covers ordinary authentication data only, not later MCP/device-created data.
- HAF-05: Independent cloud cron/alarm sweeps real wall-clock expired leases,
  including interrupted client/partially provisioned state. Persist failure and
  retry; restrict public endpoints to existing OIDC lease API and safe health.
- HAF-06: Trusted Actions ci-isolated OIDC, pinned repo IDs/workflow/refs, bounded
  TTL/quota. Production deploy credentials must not be reused. Deployment needs
  isolated resource authorization; UI creation of security-sensitive API access
  requires action-time confirmation under computer-use policy.
- HAF-07: All builds, bundling, migrations checks and executable verification in
  GitHub Actions only. Publish exact Backend/Core SHA, wasm digest, cloud bindings,
  deployment IDs and sanitized assertions. Missing configuration fails explicitly.

## 5. Current / 6. Target
Current: runner-only runtime. Target: Actions OIDC -> factory Worker -> singleton
SQLite Durable Object -> canonical cloud auth Worker -> isolated D1. Auth calls
bridge on factory; bridge is processed independently while allocation awaits it.
Cron invokes internal DO sweep, never an unauthenticated public sweep route.

## 7. Architecture / ownership
Backend owns adapters/deployment; Core owns normal auth. Earlier suggested Node
host is an option, not mandatory: existing Cloudflare account supports a hosted
adapter without provisioning a separate VM. Existing Node SQLite implementation
remains for runtime/contracts. Durable Object storage supplies persistence and
single ownership; lifecycle processing must allow bridge callbacks to avoid a
self-call deadlock. HTTP callers cannot choose DO IDs or database IDs.

## 8. Interfaces
Existing POST /v1/leases {scenarioId}, DELETE /v1/leases/:id, OIDC bearer.
Internal bridge: existing capabilities and email/send-registration-code routes,
exact Core header/secret contract; no new registration bypass.
Health exposes only environment, exact SHAs, no credentials/account metadata.

## 9. Constraints
No new subscription or paid upgrade without explicit spending approval. Fail
on free-tier limits. Logs omit bodies/tokens/code. Read-only UI inventory and
resource setup permitted; local build/test prohibited. TTL default15min/max1h.

## 10. Failure modes
Cold start, DO eviction, duplicate requests, allocation/cleanup interleaving,
bridge replay/oversize/unknown recipient, janitor partial deletion, schema drift,
missing permissions, expired token and CI cancellation must fail closed or retain
retriable state. Rollout cannot overwrite keys of an active deployment silently.

## 11. Strategy
Spec -> UI isolated resources -> hosted adapters + Actions contract/bundle checks
-> reviewable deployment workflow -> configure minimal cloud permission -> deploy
-> real normal auth lifecycle -> abandoned-client wall-clock TTL -> compliance.

## 12. Verification
Actions only: existing contracts regressions; DO journal/bridge/janitor negative
contracts; actual workerd bundle/runtime; cloud resource binding inventory;
trusted cloud registration A/B/C, OTP rejection, login/multi-session/cross-account,
revocation, explicit zero-residual cleanup and orphan TTL. Test raw credentials
stay in memory; no credential-bearing artifacts.

## 13. Acceptance
- HAC-1: Existing + hosted adversarial contracts and real bundle pass exact SHA.
- HAC-2: Deployed Worker versions/bindings and independent resource IDs recorded.
- HAC-3: Actual cloud registration/code/login/isolation/cleanup assertions pass.
- HAC-4: Independent TTL reclaims abandoned client data using real wall clock.

## 14. Release / rollback
Dedicated Backend PR under codex/ prefix. Test-only manual Actions deploy, pinned
Core. Do not replace production routes. Rollback disables new allocations while
keeping cleanup active until zero residual; preserve journal and key continuity.

## 15. Observability
Only SHA/run/attempt/deployment/resource IDs, assertion names, counts, cleanup
state/residuals. A failed cloud gate cannot be labelled emulated-runtime PASS.

## 16. References
User requests in this chat; isolated-ci-account-factory.md; original proposal;
Cloudflare UI resource inventory on 2026-10-15; canonical Core account.rs/migrations;
Cloudflare Durable Object SQLite API and GitHub OIDC official docs.

## 17. Compliance
| Criterion | Status | Evidence / reason |
| --- | --- | --- |
| HAF-01..07 / HAC-1..4 | blocked | Implementation, configuration and cloud Actions evidence pending |

## 18. Pre-deployment compliance review

Implementation tree: 66ba75d5cfb8f066e583007a4b816c236ed1ba5a;
Backend implementation SHA: d3ea951c806855cc7cdcf1d3d8fb831de086a8a7.
Actions 38659521876: 56 contracts, 56 passed, zero failed/skipped, exit 0;
Wrangler 4.151.0 actual factory dry-run bundle succeeded (25.35 KiB).
Actions 38659603779: pinned actual Core wasm runtime and independent evidence
validator passed all 15 assertions, exit 0. This remains emulated D1 evidence.

| Criterion | Status | Evidence / remaining obligation |
| --- | --- | --- |
| HAF-01 | blocked | UI created test ACCOUNT_DB 459512de-7c4b-4194-bd66-d379efab79a8 and PLATFORM_DB 6807cd15-0dc7-4088-97bf-170302858fab; deployed keys/bindings not yet verified |
| HAF-02 | blocked | Shared factory refactor + durable reservation/restart contracts pass; actual hosted lifecycle owner not yet exercised |
| HAF-03 | blocked | Reserved-recipient, invalid code, expiry and one-time consumption contracts pass; cloud bridge delivery pending; SMTP explicitly out of scope |
| HAF-04 | blocked | Ownership, unrelated-account preservation, partial deletion/orphan detection and outside-scope refusal contracts pass; actual remote D1 janitor pending |
| HAF-05 | blocked | Cron implemented; actual wall-clock TTL and literal client cancellation not yet verified |
| HAF-06 | blocked | Dedicated token configured only to review page, not created; action-time permission confirmation pending |
| HAF-07 | passed | Only Actions executed product contracts/build/runtime; no local executable verification; missing deployment credential fails explicitly |
| HAC-1 | passed | 56 contracts and actual Worker bundle at implementation source; canonical runtime regression 15/15 |
| HAC-2 | blocked | Real resource creation confirmed by UI, Workers deployment/version/binding readback pending |
| HAC-3 | blocked | No hosted auth lifecycle PASS claimed |
| HAC-4 | blocked | No independent hosted TTL PASS claimed |

Cloud smoke abandons a completed allocation client and waits without cleanup;
this is distinct from literal cancellation of a running Actions job. Until a
separate cancelled-job run is observed reclaimed, cancellation acceptance remains
blocked even if the abandoned-client TTL smoke passes. Auth-only cloud acceptance
does not supersede AC-2/AC-4 of the parent program or device/MCP cleanup gates.

Deployment security: before saving the dedicated credential, restrict the GitHub
ci-isolated environment to main deployments. Preserve any stronger existing
protection rules; never allow untrusted branch workflows to obtain cloud secrets.
The hosted handler snapshots non-secret account/session/principal IDs before
returning credentials; janitor refuses inconsistent planned email/username rather
than reporting a false zero-residual result after profile changes.
