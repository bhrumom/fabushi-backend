# Managed Marketplace signing initialization

Status: active. Date: 2026-10-13. Parent: fabapp-manifest-signing-v1.md.
User authority: explicitly requested completing all missing setup for Global
Dandelion publication, including missing signing configuration.

The five managed signing/review secrets are absent according to the current
production preflight. Initialize one Ed25519 identity through the existing
backend production environment; this is an explicit administrator operation,
not automatic generation by the Worker or a CI test key promoted to production.

## Requirements

- BS-01: an explicit initialization command refuses to overwrite any existing
  signing secret or partial configuration. Generate Ed25519 PKCS8/private and
  raw-public representations plus a random 256-bit review token in memory only.
- BS-02: store all five values in GitHub encrypted production-environment secrets;
  never stdout, source, artifact, command arguments or plaintext disk files.
  Partial GitHub writes are reported as partial and must not trigger new identity
  generation on retry. Public key/fingerprint/key ID/epoch are public audit data.
- BS-03: Cloudflare mutations execute only in a manually dispatched workflow
  from canonical main with environment=production and existing Cloudflare auth.
  Bind exact source SHA. No deployment/bootstrap on PR events.
- BS-04: reject partial existing remote configuration; existing complete remote
  identity is preserved, never automatically rotated. For absent remote values,
  upload only the five names in one bulk request, preserving other secrets.
- BS-05: verify key-pair coherence before upload; public audit output must contain
  neither private key nor reviewer token. Never weaken existing security preflight.
- BS-06: production signing remains separate from publisher namespace binding,
  artifact scan/review, release signatures, client trust pinning and permissions.

## Ownership, failure and rollback

GitHub/Cloudflare own encrypted secret storage; existing Worker signing route is
the only signer. No new service, root or private export API. Admin initialization
explicitly supplements the prior prohibition on automatically generating production
keys: ordinary deployments/startup/tests still cannot create keys.
Unknown/partial existing config fails closed. Source or permission failure never
falls back to another account. Bootstrap is not rotation/revocation; any later
rotation must use a separate reviewed plan and retain old package trust history.

## Implementation / verification / acceptance

Configuration-only local GitHub API operations may create encrypted environment
secrets; no Worker mutation or test executes on the workstation. Cloudflare
configuration and all executable verification run in GitHub Actions. Tests cover
main-only execution, invalid/mismatched keys, absent/partial/complete existing
configuration, no-overwrite and private-output rejection. Then merge green exact
head, dispatch canonical-main initialization, existing secret preflight and
canonical production delivery. Require real public signer metadata/endpoint.

BS-01..06 are pending implementation/evidence. Missing credentials/runner/review
remain failures, not passing status. Public audit binds source, actor, run, key
fingerprint and operations; no secrets. Canonical production delivery retains its
D1 recovery bookmark, main-source checks, health and provenance requirements.
