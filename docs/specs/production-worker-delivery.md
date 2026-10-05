# Production Worker Delivery

Status: Implementing

## Goal

Make `bhrumom/fabushi-backend` the canonical, auditable production delivery owner for the Fabushi Cloudflare Worker after the repository split. Production delivery must happen in GitHub Actions from canonical `main`; the legacy monorepo must not remain the mutation owner.

## Authority and boundaries

- Canonical source: this repository only.
- Production Worker: `fabushi-flutter-web-prod`.
- Public origin: `https://api.ombhrum.com`.
- Canonical account database binding: `DB` / `fabushi-db`.
- Canonical message resources: production `R2_BUCKET` / `bushi`.
- No desktop or persistent developer device may run the production migration or deployment.
- The workflow is manually dispatched and must refuse to mutate production unless it is executing from `refs/heads/main`.

## Requirements

R1. Production mutation is owned by a workflow in this repository and is available only through `workflow_dispatch`.

R2. The workflow must fail closed unless Cloudflare API token and account ID are available.

R3. Before the first D1 mutation, the workflow must query the remote production Worker secret list and require the security-sensitive secret names already required by the canonical Worker contract.

R4. Apply all pending `DB` migrations to the remote production D1 database before deploying the Worker. Transient Cloudflare D1 failures may retry with a bounded retry policy; non-transient failures must stop immediately.

R5. Deploy exactly the checked-out canonical `main` revision with `wrangler deploy --env production`. No checkout of a different ref and no legacy source copy is allowed.

R6. After deployment, verify `https://api.ombhrum.com/health` returns a successful JSON health response.

R7. Emit a provenance artifact containing repository, source SHA, run ID/attempt, production Worker name, D1 binding, migration result, deploy result, health URL, and UTC completion time.

R8. A pull request that changes the delivery workflow or its guard scripts must run a static syntax/config gate in GitHub Actions. The static gate must not mutate Cloudflare.

R9. The production delivery workflow itself is not a PR test. It may run only from canonical `main` after the delivery changes are merged.

R10. The legacy `bhrumom/fabushi` repository is a reference source only and must not perform this deployment.

## Verification plan

1. GitHub Actions static gate checks Bash syntax, workflow contract markers, `wrangler.toml` secret-literal absence, main-only mutation guard, migration-before-deploy order, and the exact production health origin.
2. Merge the delivery owner only after that exact PR HEAD is green.
3. Dispatch the production delivery workflow from the resulting canonical `main`.
4. Require the production job to complete migration, deploy, health smoke, and provenance upload successfully.
5. Only the resulting production run may be used as evidence that Human messaging reply/resources/reactions are shipping backend semantics.

## Acceptance criteria

| ID | Criterion | Status |
| --- | --- | --- |
| AC-1 | Canonical backend owns production delivery | pending |
| AC-2 | Production secret preflight is fail-closed | pending |
| AC-3 | Remote D1 migrations run before Worker deploy | pending |
| AC-4 | Deployment is pinned to canonical main SHA | pending |
| AC-5 | Public production health smoke succeeds | pending |
| AC-6 | Deployment provenance artifact is uploaded | pending |
| AC-7 | Delivery control-plane PR exact HEAD passes static gate | pending |
| AC-8 | Canonical-main production delivery run succeeds | pending |
