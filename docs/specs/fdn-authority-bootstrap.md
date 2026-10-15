# FDN authority bootstrap
Status: active. Owner: Backend FDN deployment. Date:2026-10-15.
Parent:fdn-production-environment-bootstrap.md and Desktop FDN-001.

## Context and goal
Four production SSH values passed real Actions connectivity. Three service env
payloads still need real network infrastructure and Core service authority.
User confirmed creating the bounded Workers-Scripts-Edit Cloudflare token and
saving it as FABUSHI_FDN_CF_BOOTSTRAP_TOKEN in Backend production. It expires
2026-10-16. Configure only service authority; never substitute ordinary account
credentials or isolated factory identities for production users.

## Requirements
- AB01: Main-only manual Actions under protected production. Token is supplied
  only to the credentialed step. No local executable verification.
- AB02: Read actual mahayana-platform settings using the approved token. Emit
  only booleans and source/run IDs. A preflight-only dispatch must not mutate.
- AB03: Bootstrap generates an independent48-byte random service authority only
  when Core and server both lack it. Stage securely on the approved server in
  /etc/fabushi/fdn-authority-bootstrap.env with root ownership/mode0600 before
  sending to Cloudflare. Send secret only through SSH stdin/HTTPS body; never
  log it, put it in argv, repository or artifacts. Existing SSH identity and
  host-key pin are reused with strict checking.
- AB04: Never rotate an existing Core authority automatically. Existing Core
  secret without matching server material is blocked. Partial/unknown PUT is
  reconciled through read-only snapshot using the same staged authority, not a
  fresh random secret or repeated bind. A definite initial PUT rejection may
  be retried manually using the existing staged value only while Core is absent.
- AB05: Verify Core authority with a read-only empty-cell snapshot; unauthorized
  request must deny. No accounts,devices,node bindings or grants are created.
  Missing route/schema/deployment fails explicitly and retains staged material.
- AB06: The stage file is not an enrollment payload or a healthy deployment.
  Headscale,rootless Docker,cell/account identity,worker enrollment,three complete
  payloads,fixture consumer authorization and device cleanup remain separate.

## Architecture and contracts
Cloudflare secretFDN_NETWORK_AUTHORITY_TOKEN remains the Core/coordinator trust
boundary. Go worker and MCP handlers never receive it. Bootstrap runs in the
Backend existing protected environment. It talks only to the known account
c9b14ac29b7815a5fcc704799d1a0f25 and Workermahayana-platform and the existing approved
SSH host. No generic configurable provider URL. Production read endpoint is
https://mahayana-platform.bhrumom.workers.dev/v1/internal/computers/network-bindings/cell-snapshot.
Only {cellId:"cell-fdn-bootstrap-readonly"} is queried; no mutation route.

## Failures and verification
Tests in Actions cover missing/existing/partial state decisions,secret-generation
size,no retry on uncertain mutation,and redaction-safe errors. Workflow verifies
actual token permissions/settings and optionally installs authority. Record
exact Backend/Core source,run,mode,status/exit and configuration booleans only.
HTTP timeout/redirect/unknown settings stops. Existing authority is never printed.

## Plan,delivery,rollback
Spec first -> pure planner/adversarial tests -> main-only workflow -> exact-head
Actions -> merge -> preflight -> authorized bootstrap -> ledger. No endpoint
activation or full production acceptance follows just from secret installation.
Rollback cannot silently revoke established controller access: stop before any
rotation/deletion; keep secure staged value for operator recovery. Revoke/delete
the temporary Cloudflare token after remaining bootstrap completes or expiry.

## Acceptance/compliance
| Criterion | Status | Evidence |
| --- | --- | --- |
| AB01–AB05 | blocked | Exact-head contracts and actual Actions dispatch pending |
| AB06 | passed | Scope and independent remaining gates explicitly documented |
| AC1 token stored protected,settings readable | blocked | Secret-name API readback passed;actual permission read pending |
| AC2 staged same authority accepted by real Core | blocked | Actual bootstrap pending |

## Provenance
User2026-10-15 confirmation;Backend#76;production SSH38670452945;main52a2555;
Coremainf781e6c;existing network authority guard and cell-snapshot contract.
Standard factory cloud38666610725 passes ordinary auth only and does not grant
new consumer workflows or device/MCP cleanup implicitly.

## Production preflight and Core delivery prerequisite
User confirmed the expiring Workers-Scripts-Edit token. Secret-name API readback
confirms FABUSHI_FDN_CF_BOOTSTRAP_TOKEN. PR83 merged as44ee2c6; seven contracts pass
in38671601579. Protected-main preflight38671649756 proves cloud settings readable,
Core authority absent,server stage absent,unauthenticated FDN route404. No authority
was generated or published. AB01/02 pass; AB03–05 actual bootstrap remain blocked.

AB07: Existing official-mcp-platform-delivery.yml remains the owner for canonical
Core release. Permit the explicitly approved FDN production token as the last
production credential fallback; never use the CI account factory token. Preserve
all exact-main/exact-Core checks,provider/signing configuration validation,Worker
build,pre-migration recovery bookmark,migration ordering,health and provenance.
FDN route404 is a production delivery prerequisite,not permission to bypass auth.
The accepted token currently has no D1 access. If Actions confirms that insufficient
permission blocks the existing D1 recovery/migration steps,prepare a separately
reviewable D1-Edit permission change on the same account and expiry,then obtain
mandatory action-time confirmation before saving. Do not widen privileges silently.

The existing delivery may discover other unconfigured production values; retain
those failures. A successful source check/build or token permission check does not
constitute deployed production routing. Tests/builds remain Actions-only.

## PLATFORM_DB delivery correction
Existing release38671901555 deployed exactCoref781e6c and migrated ACCOUNT_DB.
Authority38672077824 safely staged/published one key; immediate read401 failed.
Reconciliation38672189288 reused that same material without publication and read500.
Core network snapshot readsPLATFORM_DB.remote_computer_network_bindings; existing
release migrates onlyACCOUNT_DB. Missing platform migrations are the current
hypothesis,not accepted proof until actual remote migration inventory is read.

AB08: Existing canonical delivery must always inventory pendingPLATFORM_DB migrations
and capture its recovery bookmark before any mutation. Add manual migrate_platform
boolean defaultfalse. A preflight may list but not apply platform migrations. After
reading the actual pending canonical SQL,an explicittrue dispatch may apply the
canonicalPLATFORM_DB migration chain before Worker activation. Preserve independent
ACCOUNT_DB recovery/migration. Upload both recovery bookmarks and pending inventory,
including on failure. No ad-hocSQL or production account provisioning.
AB09: Actions contracts cover both-bookmarks-before-mutation,migration-before-deploy,
explicit migration opt-in,and no isolated cloud credential fallback. Actual schema
and authority acceptance still require protected-main Actions; no fake passing500.
