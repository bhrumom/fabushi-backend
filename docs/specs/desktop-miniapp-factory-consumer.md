# Signed Desktop mini-app consumer of the canonical account factory

Status: implementation,2026-10-16. Owners: existing AF/HAF orchestration and
authorized cloud workflow; Desktop owns native runtime and release promotion.

## Goal and scope

User requests completing Global Dandelion using the now accepted account factory.
Use ordinary A/B accounts issued by the existing isolated canonical Core and
prove real signed Desktop account departure/isolation without static passwords.
Production identity/install/chat remain independent Desktop gates. This does not
claim isolated credentials are production identities or physical/native transfers.

## Requirements

- DFC-01: extend only the already authorized Backend main
  ci-account-factory-cloud.yml workflow with an explicit Desktop consumer mode.
  Keep default delivery unchanged. No new OIDC repo/ref/workflow allowlist, D1,
  issuer, mail bridge, cloud token or privileged test identity.
- DFC-02: before allocating, verify the Desktop canonical-main source run,
  required exact-source CI, successful signing/notary/chat/production MU-07 steps,
  artifact ownership/source/size/digest and actual installed codesign/Gatekeeper.
  Operator inputs contain public immutable metadata only, never credentials.
  An unsuccessful candidate run or arbitrary PR artifact cannot pass shipping.
- DFC-03: validate the fixed factory/auth origins and accepted deployed
  factory/Core sources. Use fresh verified Actions OIDC for the existing
  POST lease and owner-scoped DELETE. Never retry uncertain allocation.
- DFC-04: credentials stay in consumer memory. Deliver refresh-token-free native
  CI descriptors through private600 FIFOs to the existing account bootstrap;
  do not write session JSON. Run native app-data/credential/profile paths on a
  disposable Actions RAM volume, keeping the product's normal credential owner.
  Child environment excludes OIDC/cloud/GitHub/password/SSH credentials.
- DFC-05: actual signed native UI must prove A install/preference, Sign Out
  destroys A window, B has distinct real identity/no A install/data/another origin,
  B removal closes B window, return to A retains A installation/origin/setting.
  Native issuer scoping/egress denial must be reviewed before running this mode.
- DFC-06: finally cleanup with fresh same-run OIDC must return remaining=0 and
  both delivered ordinary A/B sessions must independently reject with 401.
  Missing/ambiguous cleanup fails evidence;
  independent existing TTL remains recovery after cancellation. Do not delete
  unrelated accounts or retry auth mutations. Unsupported owned resources block.
- DFC-07: evidence includes Backend consumer/factory/Core/Desktop/binary/harness
  source, immutable archive digest, counts/exits, named assertions and cleanup,
  no credentials/profile/database/clipboard contents. Upload an explicit safe
  diagnostics directory only, never runner RAM volume or private runtime paths.
  The upload allowlist is candidate.json, factory-acceptance.json and the two
  reviewed account-switch JSON/mini-app screenshot files, not generic traces or
  test-results trees. Actions artifact-read permission is consumer-job scoped.
- DFC-08: run every executable check only in Actions, real macOS for signed app.
  Contracts test bad source/run/digest/issuer, same-user masquerading, poisoned
  child environment, invalid session delivery, incomplete assertions/cleanup.
  A contract pass is not signed packaged acceptance.

## Architecture and implementation

Existing factory Worker/DO/auth/janitor are unchanged. The consumer lives under
ci/account-factory/cloud, validates metadata before execution, allocates once,
owns in-memory descriptor/FIFO lifecycle and invokes the reviewed Desktop harness
with only the real-account-switch case. It uses no Cloudflare deploy credential.
Existing cloud workflow default job retains deployment/full lifecycle behavior;
the new main-only macOS job consumes accepted deployment without redeploying it.
Use matching immutable Desktop source for test code and actual signed executable.
Desktop promotion independently verifies this exact binary-bound report.

## Failure, verification, release and rollback

Untrusted source, failed/missing gate, invalid digest, missing macOS automation,
unknown deployed source, expired lease, unsupported native environment or nonzero
residue fail closed. No auth bypass, synthetic ledger/resources, raw SQL creation,
public code lookup, arbitrary command/provider or production-token fallback.
Node contracts and syntax run on PR in existing factory CI; actual consumer runs
only reviewed main. Preserve cloud allocation ownership on uncertain outcomes.
Rollback removes consumer mode while keeping cleanup/TTL and existing deployment.

AC-1: DFC-01..04/06..08 exact-source adversarial contracts pass Actions.
AC-2: DFC-05 actual signed source/binary-bound macOS run passes, cleanup zero.
AC-3: Desktop verifies report at public promotion, preserves all production gates.
All initially blocked pending implementation/evidence. No formal acceptance claim.

References: user2026-10-16; hosted-ci-account-factory.md and its latest cloud
acceptance, isolated-ci-account-factory.md, ci/account-factory/README.md;
Desktop desktop-miniapp-factory-acceptance.md, DMW/MU/DCI.
