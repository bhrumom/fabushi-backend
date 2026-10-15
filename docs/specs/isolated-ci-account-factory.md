# Isolated CI Account Factory — Specification

Status: active; implementation and deployment acceptance are separate
Owner: Fabushi Backend (orchestration); Platform Core (ordinary authentication)
Last updated: 2026-10-14
Related task: FCM-027 / user-directed next-generation testing migration

## 1. Context / problem
The user explicitly requests executing the attached layered-testing proposal,
especially isolated test accounts. Canonical Backend main at discovery is
f07ecfc809784f9977db26ccb2a745cb3f98874a. Legacy account provisioning directly
mutates production ACCOUNT_DB. Existing development bindings reuse production
KV/service resources. Backend has only a production GitHub environment; no
ci-isolated environment or fixture configuration was found. Ordinary account
issuance lives in the Rust Platform Core Worker and uses RS256/Argon2id, not
the legacy JS TestAccount shortcut.

## 2. Goal
Provide a durable, fail-closed run-scoped factory, a canonical registration/login
adapter, cryptographically verified Actions OIDC authorization, cleanup/TTL,
and exact-source Actions evidence. Configure and prove live integration when
independent test resources exist. Missing infrastructure must fail explicitly.

## 3. Non-goals
No production database mutation, production credentials, legacy TestAccount
token, second account issuer, alternate JWT/password algorithm or personal-device
test execution. Contract fixtures do not prove live registration or device E2E.

## 4. Requirements
- AF-01: Validate GitHub RS256 OIDC signature, fixed issuer/audience, time,
  repository id, repository owner id, workflow ref, ref, source SHA, run id and
  attempt. Deny fork/untrusted PR events; no bearer claims without signature.
- AF-02: Only an explicitly configured HTTPS test origin and independently
  identified test resources may be used. Reject production origins/resource IDs,
  redirects, credentials in URLs and unconfigured mailbox/janitor adapters.
- AF-03: Every lease is scoped by repository/run_id/run_attempt/scenario_id.
  A/B/C ordinary users and two A device identities are unique. Persist planned
  usernames obey Core's 3–32 ASCII alphanumeric/underscore/hyphen contract;
  identities before registration; never persist or publish passwords/tokens.
  Serialize allocation and enforce active-lease quota and maximum TTL.
- AF-04: Use /api/auth/browser/start, register/code, register, attempts polling
  and /api/auth/login on canonical Core. Receive real generated codes only
  through a test mailbox. Verify returned account identity; never insert users.
- AF-05: Cleanup is idempotent, ownership scoped, durable and retriable after
  partial/ambiguous create failure. A test-only janitor revokes sessions and
  removes all owned data, then proves zero owned residuals. TTL sweep continues
  after client failure. No lease reports cleaned from logout alone.
- AF-06: CI contracts cover negative identity/configuration/isolation/replay,
  quota, partial provisioning, failed cleanup and TTL. Actual live Actions
  acceptance is separate and must fail as not-configured if missing.
- AF-07: Adopt P0..P4 of the attached proposal across canonical repositories;
  preserve existing tests, require independent exact-SHA evidence, account/device
  isolation, revocation and official MCP packaged-app verification before formal
  acceptance. No missing/cancelled/skipped required test can be PASS.

## 5. Current state / 6. Target state
Current: shared production identities and no isolated environment. Target:
trusted Actions -> fixture orchestrator -> normal Core auth + independent test
mailbox -> per-run users/sessions/devices -> janitor -> verified zero residuals.

## 7. Architecture / ownership
Backend owns factory orchestration and durable lease metadata. Core owns all
authentication, password hashing, session rotation/revocation. Test environment
mailbox and janitor are infrastructure adapters with no production bindings.
SQLite lease journal contains ownership metadata only, protected by OS access.
Cross-device consumers remain in Desktop/iOS/Android; no production route is
added by installing the factory library.

## 8. Interfaces / data flow
Factory create(identity, scenario) returns {leaseId, expiresAt, accounts} once.
Accounts contain ordinary session credentials for the requesting run only.
Repeated allocation of the same active lease returns conflict (no second user).
cleanup(identity, leaseId) denies other runs; sweep() is an operator-only TTL
operation. Journal records planned account name/email/device IDs before network
calls, state allocating/active/cleanup_failed/cleaned and expiration.
Mailbox receive({email, attemptId}) returns the actual delivered six-digit code.
Janitor remove({leaseId, accounts}) must delete/revoke only the passed owned
identities; inspect(...) returns {remaining:0}. Neither adapter is a fake success.

## 9. Constraints
Actions only for every executable verification; Node 24 built-ins, no external
auth library/dependency required. Bounded network requests, no redirect following,
no retry of registration/refresh or uncertain mutations. Max 1-hour lease,
default 15 minutes; credentials are bounded by janitor revocation and isolated
environment lifetime, not by re-signing Core tokens. Explicitly do not claim the
issued token exp has been shortened until Core configuration proves it.

## 10. Failure modes
Invalid OIDC/config rejects before network or state mutation. Lost registration
response retains planned identities for cleanup. Cleanup failure blocks reuse
and remains sweepable. Process restart reads journal. Quota counts incomplete
leases. Cancelled runner needs independent hosted janitor/TTL; runner-only cleanup
cannot satisfy hosted TTL acceptance. Database IDs and origins alone do not prove
actual deployment bindings: live resource inventory is required.

## 11. Strategy
Spec first -> factory/OIDC/journal/adapters -> adversarial contract tests -> Actions
PR evidence -> configure independently scoped infrastructure -> live lifecycle ->
consumer rollout -> protected merge and exact-main readback. Governance FCM-027
records the full P0..P4 rollout and blocks not yet evidenced phases.

## 12. Verification
Node test runner in GitHub Actions; actual RSA-signed OIDC fixtures and persistent
SQLite restarts. HTTP contract adapter tests assert normal Core routes/no
redirects/no synthetic tokens. Live workflow requires real deployed fixture URL,
OIDC audience and independent test configuration; upload only sanitized evidence.

## 13. Acceptance
- AC-1: AF-01..06 contracts pass on exact PR head in Actions, with count/exit/run.
- AC-2: Live create A/B/C, A multi-device sessions, cross-run denial, revocation,
  delete/zero residual and TTL-after-cancellation pass using isolated resources.
- AC-3: No routine provisioning writes production D1 in active control plane.
- AC-4: All P0..P4 gates and protected integration evidence are recorded.

## 14. Release / rollback
Dedicated PR. No production deploy and no database migration on production.
Deploy factory only with independent test resources and trusted workflow allowlist.
Rollback stops allocations and keeps janitor/journal until residual count is zero.
Legacy privileged identity remains historical compatibility; audit separately.

## 15. Observability
Store exact SHA/run/attempt/scenario, lifecycle state and cleanup residual count.
Never artifacts of account responses/passwords/OIDC/session tokens. Record contracts
as contracts; live and packaged E2E have independent status/artifact evidence.

## 16. References
User attachment: docs/specs/sources/2026-10-14-next-generation-testing.txt.
Backend AGENTS.md; docs/specs/fabushi-official-mcp-oauth.md.
Core src/worker_api/account.rs and account-migrations: canonical account owner.
Legacy .github/workflows/provision-mcp-ci-test-account.yml and ci.yml inspected
via GitHub API 2026-10-14. Canonical governance owner is fabushi-governance,
superseding the proposal's pre-split repository mapping.

## 17. Compliance record
| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| AF-01..06 / AC-1 | blocked | Exact-head Actions evidence pending |
| AF-02 live inventory / AC-2 | blocked | Independent test resources, mailbox, janitor and hosted fixture service not configured |
| AF-07 / AC-4 | blocked | Cross-platform P2..P4 and integration remain required |
| AC-3 | blocked | Legacy/governance production provision workflow retirement pending |

## 18. Actions-owned real Worker runtime slice

AF-08: In Actions only, compile the exact pinned canonical Core wasm Worker,
run it with Wrangler local D1 in a disposable runner directory, generate unique
RSA keys and HTTPS loopback trust, and use the existing registration email bridge
with a bounded mailbox receiver. No Cloudflare credentials or remote D1 command
is available. Run actual browser registration, Argon2id password login, RS256
session/user-info/refresh/logout, A same-account multi-session and B isolation.
The factory HTTP boundary must verify a real Actions OIDC token. Direct SQL is
allowed only for the isolated local janitor, never for account creation. Verify
all created account/session/password/challenge/attempt references disappear.

AC-5: Exact Backend and Core SHA, actual compiled wasm digest, Actions run,
assertion count and zero residual are recorded. This is real Worker/auth runtime
with emulated D1; it is not deployed-cloud or packaged multi-device acceptance.
Hosted TTL cancellation and cross-device tests remain AC-2/4 blockers. Normal Core
registration remains unchanged; the email bridge substitutes delivery transport,
not code validation or password/session algorithms. The runtime may expose Core
bugs, which must be repaired under the Core owner's spec before acceptance.

## 19. Verified foundation and remaining deployment gates (2026-10-15)

Implementation source: 4f8eab3e914236642ef5923349765247b3f0b573.
Contracts: Actions 38599519762, 49 tests, 49 passed, zero failed/skipped/cancelled,
exit 0. Runtime: Actions 38599511598, actual compiled Core
 a445d3a093c4c08159f6bd4132cb62a51e2ce05a, 15 named assertions and the independent
source/assertion/compiled-wasm validator pass, exit 0. The source pin is immutable;
future Core dependencies need explicit re-pin and compatibility verification.
The account.rs implementation is unchanged in Core's documentation-only evidence
commit. Emulated D1 is explicitly distinguished from a deployed cloud database.

| Criterion | Status | Evidence / remaining obligation |
| --- | --- | --- |
| AF-01 | passed | Real Actions RSA OIDC + immutable repository/owner subject and negative claim/signature contracts |
| AF-02 | blocked | Runner databases/keys/mailbox are isolated and production aliases denied; hosted independent resource inventory/configuration is not established |
| AF-03 | passed | Run/attempt/scenario identity, A/B/C ordinary users, A two device-scoped sessions, persistent metadata/no credentials, replay/quota contracts |
| AF-04 | passed | Actual Core browser code/registration/poll/login, real delivered challenge, Argon2id and RS256; zero SQL account insertion by factory |
| AF-05 | blocked | Actual local janitor proves zero rows, TTL and stale sessions deny; independent hosted TTL after client cancellation remains unconfigured |
| AF-06 | passed | 49 adversarial contracts + 15 actual Worker assertions, independent expected-result/hash validator |
| AF-07 | blocked | Canonical governance/legacy retirement merged; full P2..P4 consumer, real platform/device and release evidence remains |
| AF-08 | passed | Exact Core wasm/normal authentication with emulated D1, true OIDC and controlled factory-clock TTL; Core auth clock remains real |
| AC-1 | passed | 49 exact implementation-source contract tests in Actions 38599519762 |
| AC-2 | blocked | Hosted/cloud/device/cancellation acceptance incomplete; this runner does not substitute for it |
| AC-3 | passed | Governance PR 3 and legacy PR 2756 retire production provisioning; both canonical main files read back after merge |
| AC-4 | blocked | Full P0..P4 integration/release program incomplete |
| AC-5 | passed | 15 actual Worker assertions, compiled digest and independent report verification in Actions 38599511598 |

Governance main: 9f80bb33b1256c0c511245fb4f1d1f093824ec40 (PR 3).
Legacy retirement main: 6a5a20655c3f3b8bcf8214c09285076f27e14090 (PR 2756).
PR: https://github.com/bhrumom/fabushi-backend/pull/70.
Runtime: https://github.com/bhrumom/fabushi-backend/actions/runs/38599511598.
Contracts: https://github.com/bhrumom/fabushi-backend/actions/runs/38599519762.
No hosted Account Factory, real cross-device package or whole-program completion
is claimed. Existing production privileged identities have not been deleted.

## 20. Accepted Core main dependency re-pin

Core PR 21 is merged; canonical main at re-pin is
f781e6c85375ba0945aa4fd4c19ead89e396dfdb. Main also includes independently merged
Remote Computer/schema changes relative to the earlier a445d3a implementation
pin. Therefore re-run the real account compatibility suite on f781e6c rather than
implicitly reusing the older wasm evidence. Its existing Core Actions 38600063038
and 38600063041 pass. Backend source/run and newly compiled wasm digest must be
recorded by the new runtime report. This does not claim production deployment.

## 21. Hosted auth deployment evidence (2026-10-15)

Backend runtime source f6dbe6417b6252fdbbfb01bbd4b093ab2b7ae592, pinned Core
f781e6c85375ba0945aa4fd4c19ead89e396dfdb: 65/65 contracts and actual workerd
bundle/probe (Actions 38666607783), 15/15 canonical wasm/emulated-D1 assertions
(38666607691), 16/16 actual remote-cloud auth assertions with independent real
D1 remaining=0 (38666610725). All final runs exit 0; earlier failed iterations
remain in hosted-ci-account-factory.md and are not passing acceptance.
Cloud now has dedicated D1 databases/Workers, independently generated RSA keys,
reserved-code bridge and minute cron; production resources are not used.
The hosted spec's latest compliance section is authoritative for this slice.

| Criterion | Status | Evidence / remaining obligation |
| --- | --- | --- |
| AF-01 | passed | Verified Actions OIDC in actual cloud and adversarial signature/claim/repository/ref/workflow contracts |
| AF-02 | passed | Actual isolated resource/binding inventory, dedicated secrets, production deny inventory and no-follow transport |
| AF-03 | passed | Two successive cloud A/B/C allocations, A dual sessions, ownership/quota/replay contracts and durable metadata |
| AF-04 | passed | Actual cloud normal Core OTP registration, wrong-code rejection, password login and canonical algorithms; no SQL provisioning |
| AF-05 | blocked | Auth-only explicit zero and abandoned-client real TTL passed; literal cancellation observer pending, MCP/device-created data outside accepted scope |
| AF-06 | passed | 65 contracts, 15 actual wasm runtime assertions and 16 cloud assertions with independent real-D1 zero validator |
| AF-07 | blocked | Full P2..P4 consumer/platform/device/package/release rollout remains |
| AF-08 | passed | Recompiled pinned canonical wasm and exact-source compatibility run 38666607691 |
| AC-1 | passed | Accepted-source main contracts 65/65, no failed/skipped, exit 0 |
| AC-2 | blocked | Cloud auth passed; literal cancellation observation pending; actual device/MCP consumers remain |
| AC-3 | passed | Production ordinary provision retirement merged earlier; cloud uses only independently bound test D1s |
| AC-4 | blocked | Full P0..P4 integration/release program not complete |
| AC-5 | passed | Actual pinned wasm, digest, 15 runtime assertions and independent source/result validator |

The @ci.invalid bridge is real canonical code transport for isolated tests, not
SMTP acceptance. Core JWT expiry is unchanged; independent cloud janitor bounds
effective account/session lifetime. This is not formal product release evidence.
