# Isolated CI device and MCP resource lifecycle

Status: active; owner: Backend Account Factory; 2026-10-15.
Parents: isolated-ci-account-factory.md AF02/05/07; hosted-ci-account-factory.md.

## Context, goal and non-goals
Cloud factory currently proves ordinary auth and auth-only cleanup. FDN consumers
need normal Remote Computer registration and MCP delegation without leaking test
resources. Extend the same singleton lease owner and isolated D1s; do not create
another issuer or use these credentials against production Core/Headscale.
Production controller account assignment, packaged clients and G05/G16 remain
separate. No new paid resources, public admin access or OIDC workflow expansion.

## Requirements
- DR01: Initialize only the independently inventoried test PLATFORM_DB with the
  pinned canonical Remote Computer migrations (0006,0014–17,0024–25,0027–34).
  Persist filename/digest after each migration, reject drift or unowned preexisting
  schema, preserve ambiguous failures for operator recovery. Never production SQL.
- DR02: Reuse ordinary account factory allocation/OTP/login. Existing main-only
  cloud delivery workflow is the first consumer; no arbitrary workflow allocation.
  Pin Core with live ordinary-session Remote Computer authorization (CorePR23).
- DR03: Capture canonical decimal user IDs before deletion. Janitor must verify
  journal lease/name/email ownership including persisted IDs and refuse ID reuse.
  Support only reviewed account MCP/connection/delegation and Remote Computer
  tables. Capture indirect connection/delegation IDs before deleting parents.
  Unknown owned resource/schema scope fails before deleting anything.
- DR04: Revoke owned auth sessions before platform removal. Delete reviewed
  platform child/audit/network rows before device parents, then account service
  children and auth rows. Persist references for partial-failure/restart cleanup;
  zero-residual proof covers both D1s and mailbox. Never delete another lease.
- DR05: Consumers stop mutations before explicit cleanup. TTL uses the same
  revocation/cleanup path; revoked signed tokens must fail ordinary list/register/
  heartbeat. CorePR23 live checks are mandatory; auth-only logout proof alone is
  insufficient. Do not claim atomic cross-D1 transactions or arbitrary in-flight
  exactly-once execution.
- DR06: Actions adversarial SQLite contracts cover FK ordering, indirect/orphan
  references, cross-lease preservation, ID reuse, unknown scope and partial retry.
  Cloud acceptance registers two A devices and B device through canonical API,
  tests idempotent inventory and cross-account denial, logout denial, cleanup and
  stale signed-token denial. Abandoned-client TTL must also include device rows.
- DR07: Independent cloud verifier inspects actual remote tables in PLATFORM_DB
  and auth tables after lifecycle/TTL. Evidence contains only exact source/run,
  assertion counts/residue, no passwords/tokens/deviceSecret/code or SQL row body.

## Architecture and interfaces
CloudDeviceJanitor extends existing CloudJanitor only in the hosted Worker;
auth-only callers retain their existing scope. PLATFORM_DB is already an isolated
binding, not a new resource. AccountFactory and journal still own lease identity,
expiry and retry. Core owns session validation, device API and schema. No cloud
network authority or Headscale key is installed in this factory slice.
Schema preparation uses reviewed canonical SQL, same pinned Core wasm/auth keys.
Existing cloud auth acceptance remains mandatory; additional evidence is scoped
to actual cloud control-plane resources, not a signed target Host or MCP call.

## Plan and verification
Spec -> resource janitor and isolated migration helper -> adversarial Actions
contracts/workerd bundle -> update pinned Core/consumer -> reviewed PR -> deploy
main with existing ci-isolated token -> actual cloud auth/device lifecycle/TTL ->
independent real D1 inspection -> requirement-by-requirement compliance.
AC1: DR01–04/06 contracts pass exact source. AC2: DR02/05–07 real cloud assertions,
actual Core source and zero residue pass. AC3: production/pacakged E2E remains
blocked until its own account/deployment evidence; never substitute test origin.

## Failure, delivery and rollback
Wrong resources/digests/ownership, unsupported owned tables, SQL failure or residue
blocks cleanup and preserves journal for independent cron retry. Missing schemas
block consumer before ordinary registration. Partial install must not auto-reset
databases or rotate signing keys. Stop new allocations on regression, preserve
janitor/journal/state for recovery. No credential logging, artifacts or shell args.

## Provenance
User2026-10-15: use standard factory and finish external conditions. Backend
cloud sourcef6dbe641 accepted auth-only; CorePR23 fixes stale ordinary session
authorization found during this discovery. Account/Remote Computer SQL reviewed
at Coref781e6c; inherited current schema remains source of truth.

## Accepted cloud lifecycle and remaining cancellation evidence
Source4ccf4f31ce035b19a0b697828f091d320e04b77b, Corec7d0e24b7561c6f5d1bb3c0e975f599643252504:
Actions38696016535 passed74/74 contracts,28/28 actual remote-cloud assertions,
exit0, no skipped tests. Independent remote inspection reports auth remaining0,
platform remaining0. Device registration/idempotent directory, pair/session
reconcile, cross-account denials, revoked/deleted signed-token list/register/
heartbeat denials and abandoned-client device TTL all passed. DR01–07/AC1/AC2
passed for this slice. Account MCP/delegation cleanup has actual SQLite contracts;
no live OAuth/MCP call or physical Host is claimed. AC3 remains blocked separately.

DR08: Extend the existing authorized main cancellation consumer to register one
ordinary owned device before its job is actually cancelled. Preserve sanitized
metadata/references and positive platform count. An independent read-only observer
must verify the actual cancelled GitHub identity, see positive live platform rows
before expiry, and auth/platform counts both zero after independent cloud TTL.
It must not call cleanup/sweep, register devices, mutate D1 or use production
resources. Missing/late metadata or unsupported ownership fails. Publish actual
factory/Core source separately from consumer/observer source, as before. Existing
74 contracts and read-only query guards remain required; runtime cancellation is
accepted only after actual prepare/cancel/observe. No OIDC policy change required.
