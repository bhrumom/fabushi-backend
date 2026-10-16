# FDN production environment bootstrap

Status: active; owner: Backend FDN delivery; 2026-10-15.
Parent: Desktop FDN-001; backend fdn-network-coordinator/README.md and ingress spec.

## Context / goal
Production run 38655182839 build succeeds and deploy fails at seven absent values.
Provision authorized real deployment inputs securely, preserve fail-closed authority
boundaries, and enable exact-source Actions delivery when real service prerequisites exist.

## Requirements
- ENV-01: Dedicated SSH deployment identity to existing approved controller server
  bhrum2 (144.24.17.21), using existing ubuntu administrative account. Do not replace
  any existing key. Generate private key on server; transfer directly into protected
  Backend production secrets through gh stdin; never output or persist in repository.
  Restrict SSH key forwarding/PTY via authorized_keys restrict option. This workflow
  installs privileged services, so this remains a privileged deployment identity.
- ENV-02: Pin host key from authenticated device-control connection. Set only
  FABUSHI_FDN_DEPLOY_HOST/USER/SSH_KEY/KNOWN_HOSTS. Retain no transient private key.
- ENV-03: Controller worker must target linux/arm64 matching inspected aarch64 server.
  Native Go tests remain on hosted runner; cross-compile shipping worker explicitly.
- ENV-04: Create fabushi-fdn service group/account before installing group-owned env
  files. Never bypass production preflight or Core exact-head requirements.
- ENV-05: Network/enrollment/MCP env payloads require real isolated Headscale cell,
  Core network authority, immutable subject, rootless Docker, enrolled tsnet controller,
  distinct broker/vault secrets and trusted HTTPS ingress. Leave absent if unconfigured.
  Do not invent placeholder/production credentials or promote account tokens.
- ENV-06: Use standard isolated account factory for test identities (user 2026-10-15
  follow-up). Never provision legacy privileged TestAccount or SQL users, and never
  send isolated test credentials to production Core. Factory cloud device lifecycle now passes28/28 actual assertions at4ccf4f31
  (run38696016535), with independent auth/platform zero-row verification. Literal
  cancellation TTL also passes38699994522. These isolated accounts remain test-only.
- ENV-07: All executable verification/deployment acceptance in GitHub Actions only.
  Remote server administration and read-only inventory allowed; no server tests.

## Current / target state and architecture
Server bhrum2 has legacy official MCP at loopback8792 and rootful Docker workloads.
Dedicated fabushi-fdn(uid993) rootless Docker, Headscale0.29.5, Core authority,
DNS-only fdn.ombhrum.com TLS ingress and public UDP3478 are now configured.
Controller, enrollment and MCP stack4213b49 is now installed and healthy;
production account/cell and all three service payloads are real and configured.
Existing legacy service and ingress stay untouched until an accepted cutover plan.
FDN new MCP defaults8790, already used by another service: production MCP port
and ingress must be explicitly reconciled, not overwritten by a generated payload.
Backend owns service deployment, Core owns identity/grants, factory owns temporary
ordinary identities and cleanup. No alternate auth system or global Docker access.

## Interfaces and failure modes
Use existing seven encrypted production secret names. Worker authority remains
outside network worker. Partial bootstrap is not successful deploy. Arm64 mismatch,
missing group, invalid32-byte state key, occupied ports, unavailable rootless Docker,
unconfigured authority or unsafe fixture cleanup must fail before activation.
The earlier48-character launcher mismatch was corrected to the broker's canonical
decoded32-byte state-key contract before deployment.

## Plan / verification
Record spec first, configure four independently valid SSH inputs, prepare delivery
architecture/bootstrap correction PR. Validate only in Actions. Inspect actual secret
names/timestamps without value retrieval. Reuse factory only after real allocation
and cleanup support pass; no production smoke using isolated test credentials.

## Acceptance and compliance
| ID | Status | Evidence |
| --- | --- | --- |
| ENV-01/02 | passed | Four encrypted production SSH values; probe38670452945 |
| ENV-03/04 | passed | PR76 ARM64 and service identity bootstrap integrated |
| ENV-05 | passed | Ordinary production account/cell, three protected payloads, deployed4213b49;38830333777/38830843065 |
| ENV-06 | passed | Factory4ccf4f31 run38696016535 actual28/28, zero-row verifier; cancelled-run TTL38699994522 auth/platform0 |
| ENV-07 | passed | Investigation only outside Actions; no builds/tests executed |
| AC-1 four SSH inputs securely set | passed | Protected production secret names/timestamps and SSH probe38670452945 |
| AC-2 all seven real inputs and deployed healthy exact-source stack | passed |4213b49 run38830333777 plus independent38830843065 HTTP/provenance inventory |
| AC-3 production OAuth/direct/DERP/WSS/isolation/revoke/recovery | blocked | Real Host/transport/OAuth/negative fixtures remain; liveness is not E2E |

## Release / rollback / evidence
Use dedicated PR and protected production workflow. Remove added authorized key
by its unique comment and delete only four newly created FDN secrets to undo SSH
bootstrap. Do not revoke legacy MCP/keys. Existing atomic controller installer keeps
previous release; no activation until all prerequisites verified. Report source SHA,
Actions run/job/count/exit/artifact separately from secret-name readback.

## Provenance
User request2026-10-15; Backend#69,#75; Desktop#91; authenticated device inventory;
current production workflow and four systemd units inspected via canonical GitHub API.

## Bootstrap follow-up
ENV-08: Validate the enrollment state key by canonical base64 shape and decoded32-byte
length, independently from48-character authority/broker token requirements. Exercise
valid/short/malformed keys in Actions without starting production services.
ENV-09: A protected-main manual SSH probe may verify pinned SSH identity, aarch64,
sudo availability and absence/presence of service configuration without deploying.
Do not execute builds or tests on the server; this probe is read-only configuration
inventory from Actions. Record only fixed booleans and architecture.
Four FDN SSH input names confirmed encrypted in production at2026-10-15T01:01Z.

## Dedicated ordinary production subject (user decision2026-10-15)

The user explicitly selected creating a new dedicated production account rather
than providing an existing account. This is ordinary production registration owned
by Core, independent of the standard isolated test factory and its janitor.

- PA01: Use canonical browser register/code/register/login flow against production
  Core. Proposed username fdn_acceptance_20261015; verified operator Gmail alias
  bhrumom+fabushi-fdn-acceptance-20261015@gmail.com receives a real code. No SQL
  insert, privileged TestAccount, isolated credential promotion or second issuer.
- PA02: The ordinary canonical registration APIs may automate account creation
  with a strong generated password retained only in restricted operator storage.
  This does not require manual form entry. Browser-only credential/terms handoff
  rules apply when using computer UI; do not extend them into an invented universal
  registration requirement. Never request password/code in chat or expose session
  credentials in logs/artifacts or automatically save them in browser storage.
- PA03: Read immutable production account ID only after canonical authentication;
  derive exact Core cell using existing authority projection. Username/email/IP
  must never substitute for immutable ID. Keep controller and enrollment secrets
  distinct from ordinary user credentials. Account is persistent and purpose-bound;
  isolated factory TTL/janitor is not authorized to delete production rows.
- PA04: Securely assemble the remaining three production payloads with real cell,
  controller AuthKey, dedicated rootless Docker, private loopback ports, separate
  broker/state/vault keys and Core authority. No placeholder, missing prerequisite
  or ordinary account token is accepted by service configuration. Preserve legacy
  MCP ingress until explicit validated cutover.
- PA05: All executable acceptance runs in Actions, records exact source, commands,
  exit/counts and sanitized artifacts. Registration success alone does not prove
  production MCP OAuth/direct/DERP/WSS/isolation/revoke/outcome_unknown behavior.

Plan: prepared canonical registration -> canonical verified registration (API, or operator UI submission) ->
canonical identity readback -> existing Core cell/controller enrollment -> encrypted
three-value configuration -> exact-source delivery -> real production acceptance.
On registration response loss, reconcile account ownership through canonical login;
never blindly re-register or mutate D1. On deployment uncertainty preserve journal
and fail closed. Rollback stops only new FDN units/ingress, retaining account and
existing legacy service. Account deletion or credential reset is a separate request.

PA01–04 now passed: canonical registration/private OTP completion established immutable
ordinary production identity and cell; actual service configuration/deployment passed.
PA05 verification stays Actions-only; full production E2E remains AC-3 blocked.
Neither isolated factory nor public infrastructure checks substitute for those gates.

## Infrastructure / factory evidence refresh

- Core live-account/session guard:c7d0e24b7561c6f5d1bb3c0e975f599643252504;
  canonical production delivery38695093688 passed. This is not an end-to-end
  production subject/MCP acceptance result.
- Backend infrastructure sourcee35cc868a13f1809ec40337cc02a4692893b31d7;
  public probe38700633492 passed8/8, skipped0, exit0: DNS exact destination,
  real TLS health, DERP latency endpoint, four admin403s, external STUN binding.
  STUN accepts pinned upstream IPv4-mapped response representation and still
  requires a public IPv4, exact packet identity/source and nonzero mapped port.
- Isolated device factory source4ccf4f31ce035b19a0b697828f091d320e04b77b,
  Corec7d0e24, run38696016535:74 contracts and28 actual cloud assertions pass;
  independent auth/platform remaining0. No isolated identity becomes production.
- Literal cancelled consumer38699748493/observer38699994522 at3373f2ad84ad4df3cacd1c6d0ac28cbcc9c5d2a4:
  initial37 rows including1 platform device; after expiry auth0/platform0/total0.
  Observer performs no sweep/cleanup and checked actual cancelled run identity.
- Dedicated rootless daemon uses source-preserving slirp4netns and disables its
  own userland proxy. Existing official br_netfilter kernel module is loaded and
  persisted as a documented host prerequisite; no sysctl/rootful daemon change.
- Oracle NSG fabushi-fdn-bhrum2-stun attaches only target primary VNIC and allows
  stateful UDP3478 ingress. Shared subnet security list remains unchanged.

AC-2 and PA03–04 now pass per the later production evidence. AC-3 stays blocked.
Public endpoint probes do not establish
private enrolled direct/DERP routing, reverse-WSS tool calls, per-account denial,
revocation, response-loss/outcome_unknown, or an installed Host acceptance.

User follow-up2026-10-15 requests standard API creation instead of assuming mandatory
manual registration. Core browser/start, browser/register/code, browser/register and
protected attempt poll are ordinary public registration APIs, not a test issuer.
The earlier send-only response did not establish delivery. This was later resolved
by actual inbox delivery, encrypted owner OTP and canonical registration/profile
readback; the successful send response itself was never used as account evidence.


## Controller administrative bootstrap (2026-10-15)

CB01: The ordinary production subject has now been canonically registered and
verified. Read immutable accountId and canonical cellId from root-only operator
credentials; never embed ordinary login credentials in service env payloads.
The coordinator admin may create exactly one controller node for this cell using
its existing dedicated Headscale administrative owner. This is controller deployment,
not target-device enrollment. The target broker still requires Core grant redemption
before its mint script; no fabricated target grant, SQL binding or device token.

CB02: Resolve exactly one Headscale user by exact canonical cell name, create only
if absent, then require a unique positive numeric ID. Mint a nonreusable,
nonephemeral 300-second controller preauthkey only after the immutable Actions build
artifact has passed. Retain the key only in root-private bootstrap storage and
protected service configuration. Never output its value. One node's persisted tsnet
state is durable across restart; the consumed key grants no second enrollment.
Missing state after key consumption requires an explicit new administrative mint;
do not silently rotate/recreate nodes or extend key TTL. Unknown activation outcome
requires node/state reconciliation before retry.

CB03: Assemble three env payloads from verified identity, existing Core authority,
loopback worker8791/enrollment8793/MCP8794, rootless uid993 daemon and distinct
random broker, AES256 enrollment state and MCP vault keys. Preserve these durable
keys idempotently in root-only storage. Preserve legacy MCP8792/ingress. Ordinary
access/refresh/device tokens remain forbidden. Use the existing public MCP origin
only for later validated cutover; staging a listener is not public acceptance.

CB04: Transfer payloads only as GitHub sealed-box ciphertext encrypted with the
production environment public key. Plaintext stays in trusted server memory/root
storage and encrypted GitHub secrets. Verify secret names/timestamps only. Existing
protected delivery still requires all seven inputs and exact Core gates. It may fail
closed on missing payloads after building, then rerun only the failed deploy job
immediately after mint to keep the 300-second validity window. No build/test runs
on the server; activation and acceptance remain in GitHub Actions.

CB05: Record build source/artifact, deployment attempt, actual systemd health and
controller Core ingress projection. Registration, successful secret writes, or a
public health endpoint alone do not satisfy production MCP/transport acceptance.
On failure retain private journal and inspect sanitized state. Rollback stops only
new services or uses existing previous release; never alter legacy service or
delete production identity, persistent network state or vault keys.

Acceptance: CB01 immutable identity/cell matched; CB02 one exact-cell controller
with bounded oneuse key; CB03 all three real isolated payloads; CB04 secure secret
writes plus protected Actions delivery; CB05 exact-source health/projection evidence.
Every criterion remains pending until its own recorded observation. This operational
extension preserves ENV01–09 and PA01–05 and the target enrollment grant boundary.

## Observed activation failures / correction contract (2026-10-16)

Run38746114659 attempt2 built and verified b8d82eb8 successfully; all seven
production inputs and exact Core gates passed. Activation failed before ingress;
new units were subsequently stopped after observing repeated startup failures.
Legacy MCP remains running. No enrolled Headscale controller node exists yet.

ST01: Enrollment keeps ProtectHome=tmpfs and all other hardening, with only its
own dedicated rootless Docker unix socket bind mounted through a generated unit
drop-in. Installer derives service UID, validates DOCKER_HOST matches that UID,
and never exposes the entire /run/user tree or rootful daemon. Worker requires
AF_NETLINK for upstream netmon.New interface monitoring; permit only that extra
family without kernel/network-administration capabilities. Confirm this inferred
worker startup cause by actual activation, not by claiming source inspection proves it.

ST02: MCP service configuration must use the fixed endpoint path
/v1/fdn/private-request. Startup failures remain fail closed. Preserve distinct
vault/state keys and existing root-private journal across correction.

ST03: Activation must wait boundedly (at most100 seconds) for worker HTTP status
before starting the Core ingress binder; tsnet.Up already has a90-second bound.
Every activation failure, including an early systemctl/binder error, must reach
rollback handling rather than escape set-e. For first install stop only the new
units/timer; with a previous different release restore its units/current symlink
and services. Reinstalling the same SHA must not delete the current release tree
or pretend it is a valid previous rollback. Preserve persistent state and env.

ST04: Keep sanitized startup diagnosis to fixed categories (filesystem-permission,
address-family, network-permission, timeout, unknown) based on typed errors; never
log raw upstream errors, keys, URLs or callback payload. Actions must exercise
these categories and deploy start-failure rollback/reinstall behavior. Existing
coordinator, Go, MCP build/test contracts remain required. Final actual deployment
health and Core ingress projection must pass at the exact new source.

Release through a scoped Backend PR; no local/server builds/tests. A replacement
controller preauthkey is permitted only after read-only reconciliation finds no
enrolled node and no persisted identity; mint immediately before failed-job retry.
Old keys stay expired, persistent service encryption keys remain unchanged.

## Symlink entrypoint correction (2026-10-16)

ST05: Actual deployment38829239481 of118c4a2 confirmed the worker enters Running
and Core ingress binds node100.88.207.67 generation1; MCP8794 listens. Enrollment
exited0 because its argv current-symlink path differed from import.meta's resolved
release path. Direct entry detection must compare canonical filesystem paths,
while importing the module must remain side-effect free. Actions must launch the
real service through a release/current symlink, observe ready plus unauthenticated
401 without contacting Core, and require invalid configuration to exit nonzero.
No change to grant/token/state authority or network identity. Preserve the already
enrolled node and private tsnet identity; do not mint another key or create a node.
The whole deployment is still failed until exact-source service health passes.

## Read-only deployed-service inventory

ENV10: Existing protected-main SSH inventory may accept an optional exact runtime
SHA. With it, inventory the installed Backend/Core provenance, all three services,
ingress timer/last binder result, worker ready HTTP, MCP8794 health HTTP and the
unauthenticated enrollment POST status. Assertions execute in Actions against
captured bounded metadata; no mutation or authorization relaxation. Record only
known public health bodies, fixed status values and source hashes. Never copy
service envs, tsnet identity, user/session/vault credentials or private process env.
The result is service liveness/provenance, not OAuth/native/direct/DERP acceptance.

## Account-facing enrollment proxy deployment boundary

ENV11: Read-only inventory found existing dacheng-ai-backend source9943899852
predates registerFdnEnrollmentProxy and has neither broker setting. Reuse its
canonical marketplace-node-delivery.yml ARM64 build/full-test/prune/full-test,
backup, immutable-release and rollback owner (marketplace-node-production-delivery
MND01–06); do not replace its persisted environment, database or registry owner.
The co-located API requires only a dedicated root0600 additive EnvironmentFile
with FABUSHI_FDN_ENROLLMENT_BROKER_URL=http://127.0.0.1:8793, the already-created
broker credential, and FABUSHI_FDN_HEADSCALE_CONTROL_URL=https://fdn.ombhrum.com.
The proxy validates and returns this trusted control origin after account/grant
correlation. Never provide Core authority or ordinary account tokens. Validate exact
subject/generation denial through the existing account proxy contracts. Preserve
all existing drop-ins and signing/reviewer configuration. Configure without secret
output and let canonical delivery activate the existing service. Public gateway
routing/Host enrollment is a separate gate requiring source discovery before any
route changes. Do not infer end-to-end availability from a running coordinator.


## Requirement-to-evidence review (2026-10-16)

| Criteria | Status | Evidence / limits |
| --- | --- | --- |
| ENV01–04 | passed | Pinned restricted SSH, protected inputs; ARM64 artifact installed via38830333777 |
| ENV05 / PA01–04 / CB01–04 | passed | Canonical ordinary account; exact cell; one controller node; sealed payload transfer;4213b49 real deployment |
| ENV06 | passed | Isolated factory28/28 and zero-row/cancelled-run evidence above; no promotion |
| ENV07–10 / PA05 verification boundary / CB05 | passed | Actions-only contracts/delivery;38830843065 exact4213b49 HTTP/status/provenance inventory |
| ST01–04 | passed |003fe6e Actions38828838237 four startup/reinstall/rollback contracts; real worker Running + binder on118c4a2; durable identity preserved |
| ST05 | passed | f831fb9 Actions38830016942 six service contracts, including actual symlink listener401;4213b49 full deployment and independent HTTP inventory |
| ENV11 | partial / blocked on final activation | Account API4213b49 deployed38830720805; ARM64 full142+142 pass. Third trusted control origin added to private env; next canonical release must activate it. Public Host gateway is tracked by GW01–04 in fdn-001-account-enrollment-proxy.md |
| AC-1 / AC-2 | passed | Seven real encrypted production inputs;4213b49/ c7d0e24; run38830333777 installed-and-health-checked;38830843065 four active units/timer, workerReady, MCPhealthy, enrollment401, ingress success |
| AC-3 / full G05/G16 | blocked | Actual OAuth-to-Host transport, public direct/DERP/WSS, cross-account/revoke/response-loss evidence still required |

Runtime bundle SHA256086e9a2f065825e10c40ee6bd5144be44805a87d68c8b2f602ad3ebb3a363da9.
Inventory workflow sourceb06a45d differs from deployed runtime4213b49 only in
operational spec/inventory additions; evidence identifies the exact installed source.
No service-liveness result is labeled native/transport acceptance. New pipeline
changes require their own exact source/run evidence before completion.
