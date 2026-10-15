# Isolated CI Account Factory

This is test infrastructure; production gateways do not import it. All builds,
contracts and runtime verification run only in GitHub Actions.

- `ci-account-factory.yml`: PR unit/contract gate. No account lifecycle in a real
  service is claimed by these injected-boundary tests.
- `ci-account-factory-runtime.yml`: actual pinned Rust wasm account Worker,
  real GitHub OIDC, normal registration/mailbox/Argon2id/RS256/refresh/logout,
  independent users and ownership cleanup on disposable runner-local D1.
  D1 is emulated; the email transport is an isolated receiver. The actual code
  challenge, password and session algorithms remain canonical Core behavior.

`factory.mjs` owns only per-run metadata. `oidc.mjs` verifies GitHub signatures
and immutable repo/workflow/run authority. `canonical-auth.mjs` calls ordinary
Core endpoints. `service.mjs` exposes POST /v1/leases and DELETE /v1/leases/:id
only after OIDC. Create credentials are delivered once, never persisted in the
journal or uploaded as artifacts. Same-lease replay conflicts rather than creating
duplicates. Planned usernames/emails/device IDs are recorded before network I/O.

A hosted deployment must supply independent test ACCOUNT_DB/PLATFORM_DB/mailbox,
allowlisted HTTPS origin, complete production resource inventory, a test-only
ownership-scoped janitor whose inspect proves zero owned data, persistent journal,
and an independent TTL scheduler. Missing adapters/configuration throw
not_configured. No production-token/environment fallback exists. The deployment
must use one factory process per journal; multi-process/replica cleanup needs a
separately accepted distributed claim protocol. The SQLite reservation alone is
not a distributed lifecycle lock.

The Actions runtime creates unique signing keys/databases on every run; cancelling
or losing the disposable runner destroys the entire isolated runtime. Its controlled
factory-clock TTL case checks actual resource removal without changing Core's auth
clock. Hosted TTL after client cancellation and real Desktop/mobile device/MCP
behavior remain separate acceptance requirements, not proved by this runner.

Ordinary short-lived effective credentials are bounded by the isolated runtime
and lease janitor. Core's token expiry itself is not re-signed or changed by this
factory. Never store raw account responses, passwords, signing keys, OIDC/access/
refresh tokens or the runner Worker config in evidence. Preserve only source/run,
suite counts, compiled wasm digest, named assertions and residual counts.

Full requirement and blocked deployment checklist:
`docs/specs/isolated-ci-account-factory.md`. Full program P0–P4 lives in canonical
fabushi-governance FCM-027. Existing production TestAccount identities remain
historical compatibility pending a separate audit, never standard fixture input.

## Hosted Cloudflare adapter

`cloud/` reuses the same factory orchestration and canonical auth adapter, with a
singleton SQLite Durable Object journal, authenticated registration-code bridge,
D1 auth-only janitor and independent minute cron. No separate VM or Node runtime
is required for this adapter. `factory.mjs` still exports the existing Node
journal/API; `factory-core.mjs` is shared runtime-independent logic.

The two `fabushi-ci-isolated-*` D1 resources in `cloud/resources.json` were created
through Cloudflare UI on 2026-10-15. Existing development/production DBs are not
reused. The manual `ci-account-factory-cloud.yml` deploy runs only from main and
requires `ci-isolated` secret `CI_CLOUDFLARE_API_TOKEN`; no production-secret
fallback. New RSA/bridge keys are created inside Actions only on first deployment;
subsequent delivery preserves secrets. Partial bootstrap requires operator
recovery instead of silently rotating active keys. The cloud workflow binds only
the two test databases, verifies deployed bindings, runs normal auth acceptance,
waits for real wall-clock TTL and independently checks real D1 for auth residue.

SMTP delivery remains NOT_VERIFIED: reserved `@ci.invalid` emails use the isolated
cloud bridge, with real Core-generated/validated codes. This verifies registration
and auth in cloud, not public mail delivery. Actual cancellation, packaged clients,
MCP/device data cleanup and cross-device E2E are separate acceptance gates. The
first janitor blocks when owned resources exist beyond accepted auth-only scope.
See `docs/specs/hosted-ci-account-factory.md` for requirements and actual evidence.

## Operating the isolated cloud environment

The deployed factory origin is
`https://fabushi-ci-isolated-accounts.bhrumom.workers.dev`; ordinary auth is
`https://fabushi-ci-isolated-auth.bhrumom.workers.dev`. Both are dedicated test
Workers. The main-only GitHub environment stores `CI_CLOUDFLARE_API_TOKEN`; its
current authorization expires 2026-10-22. Expiry affects future deployment and
credentialed D1 inspection; already deployed OIDC allocation and cron do not use
that token. Application RSA/bridge keys remain in
Cloudflare secrets and are preserved across deployments. Never paste them into
workflow input, shell commands, repository files, or artifacts.

From GitHub Actions, dispatch `Isolated Cloud Account Delivery` on main to compile
the pinned Core, deploy, register ordinary A/B/C via actual generated codes, log
in automatically, verify sessions/revocation, delete, re-register and wait for
real 15-minute TTL. The workflow independently inspects all auth tables in the
actual D1 database. Required success artifacts are cloud-deployment.json,
cloud-runtime.json and cloud-verification.json, all matching the same run/source.
A deployment alone is not acceptance.

The factory accepts verified Actions OIDC only from the two explicitly allowed
main workflows in cloud/prepare.mjs. POST /v1/leases with {scenarioId} returns
one-time ordinary account sessions for the calling run; DELETE /v1/leases/:id
requires that same run identity. Tests keep credentials in memory. Arbitrary
external callers, untrusted branches and other workflows cannot allocate. Adding
a consumer workflow requires an explicit reviewed policy change.

For literal cancellation verification, run `Isolated Cloud Account Cancellation
Probe` with mode=prepare after cloud delivery finishes. Wait for the metadata
artifact and hold step, cancel only that probe run, then dispatch mode=observe
with its cancelled_run_id. The observer must see live owned rows before expiry
and zero rows afterward using read-only D1 queries; it never requests cleanup.
Do not overlap preparation with delivery's global-zero check.

If allocation or cleanup fails, preserve sanitized evidence and the journal.
Do not recreate databases, reset lease ownership, reuse production credentials,
rotate signing keys, or mark failed/cancelled checks passed. To stop allocations
while retaining recovery, deploy an empty trusted-workflow allowlist; cron cleanup
continues independently. Restore only through a reviewed main deployment after
residual inspection. Auth-only cleanup deliberately blocks unsupported owned
account resources; expanding to MCP/device data needs its own accepted scope.
