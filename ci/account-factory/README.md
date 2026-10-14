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
