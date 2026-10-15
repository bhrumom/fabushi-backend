# Hosted isolated CI account factory — Specification

Status: active; cloud auth lifecycle accepted; literal cancellation observation pending
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

## 19. Cloud deployment and first failure (2026-10-15)
The user explicitly approved creation and storage of the named Cloudflare token
at action time. UI confirmed token creation (expires 2026-10-22), GitHub secret
CI_CLOUDFLARE_API_TOKEN was saved in ci-isolated, and API readback confirms the
secret name only. The environment allows only main. Do not record credential value.
Main 580b15028bed6d725e6aaf1f715f73280b17555f passed 57 contracts/bundle
(Actions 38660478906) and canonical wasm 15 assertions (38660478842).
Cloud Actions 38661203282 deployed both test Workers, verified real independent
D1 bindings and health, and recorded compiled wasm/deployment versions. First
allocation failed HTTP 503, so HAC-3/4 remain blocked. Do not weaken auth to pass.

HAF-08: Add bounded non-secret cloud failure diagnostics: fixed auth route names,
HTTP status, allowlisted failure category, and database table counts only. Never
return/log upstream bodies, errors containing identities, codes, credentials or
raw exception messages. The same protected Actions workflow must retain failed
cloud evidence. Installing deployment tooling must occur without the cloud token
in environment; expose it only to the actual trusted deployment/inspection step.
The existing handler may accept an optional error observer, without changing its
status/error contract or authorization and without letting observer errors escape.
Verify sanitization with adversarial errors containing secrets and regress all
existing factory contracts before deploying the correction.

HAF-09: Restore canonical Cloudflare public Worker-to-Worker routing in both
hosted configs with global_fetch_strictly_public. Canonical Core wrangler.toml
already declares this flag; the initial generated auth/factory configs omitted
it. Cloudflare's official Fetch documentation requires service bindings or this
flag for Worker-to-Worker fetch. This deployment deliberately uses fixed public
HTTPS test origins, not private routing or arbitrary service bindings. Confirm
actual deployed flags in settings readback and retain 1042 as an allowlisted
worker_interop_blocked diagnostic category. This is an identified configuration
defect; only a new actual cloud run may establish whether it was the allocation
failure cause or whether additional failures remain.
Reference: https://developers.cloudflare.com/workers/runtime-apis/fetch/.

HAF-10: Add a dedicated main-only Actions cancellation probe. Prepare ordinary
A/B/C through the same OIDC factory, independently read owned auth-row references
from test D1, upload metadata only, then hold the job for operator cancellation.
After the job is actually cancelled, an independent observe job verifies its
GitHub run identity/conclusion, recomputes lease ownership and only reads the
fixed test D1. It must first see live owned rows before expiry, then see zero
owned rows after wall-clock TTL without calling explicit cleanup or sweep.
Only the additional exact main workflow path may be authorized by OIDC; no other
repository/ref/event permission is added. Metadata never includes passwords,
access/refresh tokens, code, OIDC or cloud token. Report workflow source and
actual deployed factory/Core source separately. All executable work remains in
Actions; operator Git/API dispatch/cancel is allowed locally. This is the
required evidence for literal client/Actions cancellation acceptance, distinct
from the original completed-client abandonment smoke.

Cloud run 38662123463 confirms restored flags and deployment pass, but allocation
still fails before any recorded auth fetch with fixture_request_failed and an
unclassified category. Add fixed handler-stage and allowlisted stack-function
labels (not raw stack/error text) so OIDC/body/journal failures can be separated.
Observers must still not change the response status or disclose credentials.

HAF-11: A deploy API success/HTTP 200 health is insufficient during edge version
propagation. Before auth acceptance, bounded polling must require factory health
backendSha/coreSha to equal the requested exact source; never accept predecessor
health or weaken exactDeployedSource. Record only validated 40-hex observed source
metadata on mismatch. Cloud 38662573835 attempt 1 correctly failed this guard;
rerun attempt 2 uses the same source and a new per-attempt lease identity.

HAF-12: Cloud 38662573835 attempt 2 localizes failure to OIDC (TypeError), before
normal account authentication. Add a portable hosted no-redirect transport using
manual mode plus explicit rejection of every 3xx response, for both the fixed
GitHub JWKS fetch and ordinary auth adapter. This preserves the existing no-follow
security contract and every RSA/issuer/audience/identity check. Node's existing
error-mode callers remain unchanged. Adversarial contracts must prove no redirect
is followed and no request credentials are forwarded to another URL.
An Actions-only actual workerd probe, without JWT/account/cloud credentials,
compares public fixed-JWKS fetch behavior and records only the fixed diagnostic
category/status; no production diagnostic endpoint is added. It must establish
runtime behavior before the next hosted acceptance, not infer it from Node tests.

Cloud 38663361216 on 72f4a038ab1d59be9f6425017a3c2569bb184c2d passes
12 actual cloud assertions through explicit zero-residual cleanup/deleted-session
denial. A second ordinary allocation for TTL fails /browser/register HTTP 500.
Classify bounded upstream failure bodies into fixed resource/memory/constraint/
database categories (never raw text) to distinguish cloud runtime and data errors.

HAF-13: Explicitly prove wrong-code rejection in the hosted auth-only fixture.
CanonicalAuthAdapter gains an opt-in assertRejectsWrongCode flag (default false,
existing callers unchanged). The cloud test factory enables it: receive actual
code, construct a guaranteed different six-digit code, submit via ordinary Core
registration, require authenticated poll still pending, then submit the actual
code and require completion normally. Never accept a completed wrong-code attempt.
Expose only a boolean successful-check marker on an authorized created lease;
cloud acceptance independently requires this marker and includes the named
invalidVerificationCodeDenied assertion. Codes/passwords stay in memory. Verify
both rejection of an unsafe issuer and normal retry using adversarial contracts.
This remains test infrastructure; normal Core validators/algorithms are unchanged.

HAF-14: Cloud run 38664043542 identifies a database constraint failure after
prior cleanup. Normalize canonical numeric users.id to decimal strings before
querying Core TEXT user_id/legacy_user_id columns: D1 binds JS numbers as REAL,
whose TEXT affinity can differ (10001.0 versus canonical 10001). Persist normalized
references including existing journal records. Add Actions regression with REAL
binding emulation, TEXT credential/session/principal ownership, independent table
counts and a second account lifecycle reusing the freed numeric ID.
Before new allocations, perform a one-time ownership-checked repair of historical
cleaned leases using persisted references; never delete a captured ID currently
belonging to another identity. Persist the repair marker only after independent
zero-residual inspection. This repair is limited to this dedicated test DB and
does not provision accounts or alter canonical auth. Cloud success and independent
global zero counts must confirm the hypothesis; unit success alone is insufficient.

HAF-15: Cloud 38665170954 attempt 2 passes exact-source/OIDC guards but reports
registration-code HTTP 503 (canonical email availability). Preserve bounded fixed
route/status history and bridge capability/delivery counters in protected failure
diagnostics, never identities, code or response bodies. Classify only literal
known bridge error codes and subrequest-limit text. Poll exact-source health in
the acceptance runner too, since separate edge requests can briefly disagree.
Use the diagnostics to distinguish infrastructure limits from ordinary auth errors;
no automatic retry of uncertain account mutations or paid upgrade is allowed.

HAF-16: Cloud 38665783121 shows A/B complete wrong-code rejection, registration
and password login; C code request fails before any bridge callback (17th auth
request; four prior successful HTML responses). Source review finds the adapter
leaves successful HTML response bodies unread, retaining runtime connection slots.
Explicitly cancel HTML bodies after checking status, since completion is proved
by the authenticated poll; cancel rejected response bodies before throwing too.
No request is retried and no code/password validator is bypassed. Adversarial
contracts must prove both paths release the stream; real cloud rerun must prove
all three accounts plus the second full lifecycle before accepting the diagnosis.
Reference: Cloudflare Workers limits, simultaneous outgoing connections (6);
https://developers.cloudflare.com/workers/platform/limits/.

HAF-17: Stream cancellation passes contracts but cloud 38666172358 reproduces
the same C code-capability failure; HAF-16 alone is not established as the cause.
Keep the resource fix, and remove unnecessary re-entrant DO dispatch for the
static bridge capabilities route. The outer Worker must authenticate the exact
bridge secret before returning the unchanged {email:true,alipay:false}; delivery
still enters the singleton journal and validates reserved recipients. No caller
can retrieve codes or mutate leases via capabilities. This reduces nested actor
entries while retaining a single mutable lifecycle/mailbox owner. Verify denied
secret behavior and actual cloud lifecycle; do not declare the preceding
connection hypothesis confirmed without real successful evidence.

## 20. Deployed auth-only acceptance (2026-10-15)

This section supersedes earlier pending configuration/status snapshots; failure
history above remains provenance, not current status. Accepted runtime source:
Backend f6dbe6417b6252fdbbfb01bbd4b093ab2b7ae592; Core
f781e6c85375ba0945aa4fd4c19ead89e396dfdb. The following documentation update
does not change deployed executable sources or claim a new deployment SHA.

- Contracts and actual workerd bundle/probe: Actions 38666607783, 65/65, no
  failed/skipped tests, exit 0.
- Canonical wasm/emulated-D1 regression: Actions 38666607691, 15/15 named
  assertions, exit 0; explicitly not the hosted result.
- Actual remote-cloud delivery: Actions 38666610725 attempt 1, 16/16 named
  assertions, exit 0; independent REST inspection reports remaining=0 across
  every users/email mapping/account_* auth table. Two successive complete A/B/C
  allocations succeed, including explicit deletion and real abandoned-client TTL.
- Actual compiled wasm SHA256:
  9991f2f1f55ff5e00951a60dd44ad6d792c8b1c4347bdad0e9b27188db101672.
- Auth deployment 1d12c22e-2904-4d42-ac78-4c59c2b5fb89, version
  fecab31e-eff4-4562-9873-5b68b3527bf9. Factory deployment
  10d9666b-9b84-463f-bd0b-db4d58dd263d, version
  da0ce4bd-5a58-4243-ac26-06452adfffdb. Both actual test-D1 bindings read back.
- Literal cancellation: prepare 38668206894 actually cancelled; observer
  38668322225 attempt 2 pending. Prepare independently sees 36 owned auth rows.
  Attempt 1 started before the cancelled conclusion settled and failed closed;
  it produced no passing report. No cleanup/sweep is sent by the observer.

| Criterion | Status | Evidence / reason |
| --- | --- | --- |
| HAF-01 | passed | Dedicated two test D1s, independent initial RSA/bridge secrets and binding readback in cloud-deployment.json |
| HAF-02 | passed | Shared factory + singleton DO, reservation/restart/isolation contracts and two actual successive lifecycle allocations |
| HAF-03 | passed | Real canonical code delivery/validation; wrong code rejected and unauthenticated bridge denied; SMTP excluded |
| HAF-04 | passed | Normal auth only; ownership/partial/orphan/schema contracts plus independently zero actual auth tables |
| HAF-05 | blocked | Abandoned-client real wall-clock TTL passed; literal cancelled-job observer pending |
| HAF-06 | passed | Real OIDC, immutable repo/owner/workflow/main checks; dedicated user-authorized expiring token; main-only environment |
| HAF-07 | passed | All product verification executed only in Actions; source/run/count/exit/wasm/deploy artifacts recorded |
| HAF-08 | passed | Sanitized adversarial diagnostics; installation separate from credential-bearing deploy step |
| HAF-09 | passed | Actual deployed global_fetch_strictly_public readback and cloud Worker calls |
| HAF-10 | blocked | Actual cancellation confirmed; read-only TTL observer pending |
| HAF-11 | passed | Exact edge-source polling and observedFactorySha/CoreSha match accepted source |
| HAF-12 | passed | Actual workerd public-JWKS probe distinguishes unsupported error mode; manual transport rejects all redirects; cloud real OIDC passes |
| HAF-13 | passed | Actual invalidVerificationCodeDenied, normal correct-code registration and adversarial unsafe-issuer rejection contracts |
| HAF-14 | passed | REAL-bind/TEXT child independent-count regression, ownership-safe ID reuse, historical repair, second cloud allocation and global zero |
| HAF-15 | passed | Bounded route/status history and counts localize cloud boundary; no response bodies/credentials in evidence |
| HAF-16 | passed | Ignored/rejected streams cancelled, explicit cancellation contracts; not claimed as the sole prior cloud failure cause |
| HAF-17 | passed | Authenticated static outer capability route, mutable journal delivery retained, actual unauthenticatedBridgeDenied plus full cloud lifecycle |
| HAC-1 | passed | Accepted source 65 contracts and actual workerd bundle/probe; canonical wasm regression 15 assertions |
| HAC-2 | passed | Actual bindings, deployment/version IDs, source and wasm digest recorded |
| HAC-3 | passed | 16 actual cloud assertions, normal A/B/C auth and zero auth-table residue |
| HAC-4 | passed | Independent minute cron reclaims abandoned client after real 15-minute TTL |

Scope remains cloud ordinary authentication with isolated @ci.invalid transport.
Actual SMTP, packaged app/physical-device discovery, MCP/device-created data
cleanup, full P2..P4 and formal release are NOT_VERIFIED by these reports.
The preserved deployment token expires 2026-10-22; changing provider permissions
or paid plans is not part of this acceptance. Operations are in
ci/account-factory/README.md.

Evidence:
https://github.com/bhrumom/fabushi-backend/actions/runs/38666610725
https://github.com/bhrumom/fabushi-backend/actions/runs/38666607783
https://github.com/bhrumom/fabushi-backend/actions/runs/38666607691
https://github.com/bhrumom/fabushi-backend/actions/runs/38668206894
https://github.com/bhrumom/fabushi-backend/actions/runs/38668322225
