# Dedicated production acceptance account bootstrap
Status: active;2026-10-15. Owner: existing Backend deployment/ordinary Core registration. Parent: fdn-production-environment-bootstrap.md PA01–05 and production-registration-mail-delivery.md.

## Context, goal and boundary
User explicitly selected a new ordinary production acceptance account and requests API automation. Production mail repair7110dc6c/Actions38741571017 now delivers the real authenticated mail API fixture to Gmail inbox; a fresh production registration message also arrives. Gmail connector replaces its OTP with '[one-time authentication code withheld]'. Never bypass this protection through another mailbox interface, raw-message extraction or queued-mail inspection. The only manual requirement here is encrypted owner input of the OTP, not manual account/password creation.

## Requirements
- ID01: Use existing canonical production browser/start, browser/register/code, browser/register and password login APIs. Dedicated usernamefdn_acceptance_20261015 and operator-owned Gmail alias already approved. No factory/SQL/legacy privileged identity or new auth issuer.
- ID02: Generate a strong password internally; persist pending state and final credentials only under root-owned0700 /etc/fabushi/production-acceptance-account with0600 files. Keep ordinary account/session secrets out of logs, chat, artifacts, device-call arguments and controller service env. Password creation is via ordinary API administration, not computer UI credential entry.
- ID03: Prepare normal challenge only after actual mail transport works. Receive OTP using unified-device render_sensitive_input with end-to-end decryption. User alone enters code; private tool writes it under0700 /home/ubuntu/.fabushi-production-registration, then complete consumer reads a bounded regular0600 file. Never ask for OTP in chat. Remove consumed transient OTP.
- ID04: Existing valid pending attempt is reused; expired challenge is explicit. Mark registration outcome unknown before sending; on network loss or ambiguous result never blindly register again. Reconcile through canonical login with the preserved generated password. No account reset/deletion or automatic password rotation.
- ID05: Accept only canonical userId/username/email from login response; reject privileged built-in IDs, retain immutable ID, derive cell only with current Core's fabushi-fdn-cell-v1 SHA256 contract. Persist session separately as private operator state; never promote it into the three controller payloads.
- ID06: Source verification runs only in Actions at exact revision. Account creation is authorized production administration, not a passing production MCP/G05/G16 test. Preserve sanitized source/run/account metadata and keep remaining network/Host acceptance explicitly pending.

## Plan, failure, acceptance and release
Spec -> minimal operational API consumer/private input handoff -> Actions contracts and syntax -> protected exact-main deployment/prepare -> encrypted OTP owner input -> canonical registration/login -> private credential storage and sanitized immutable subject -> continue production cell/service configuration. Bound network requests30s; strict OTP shape/expiry and response checks. Actual code generation/email verification stays Core-owned. No external account purchase or legal/permission bypass. Runtime code is a bootstrap operator, not another service.

Accept ID01–06 separately: exact-head CI; actual fresh delivery; safe private input; actual created ordinary account ID; correct root-private state. Missing input is blocked, never pass. Rollback removes only operator bootstrap executable; preserve account/credentials and challenge reconciliation state. Account deletion/reset requires separate request. The registered account is persistent, never subject to isolated factory TTL janitor.

## Provenance
User API-account instructions and explicit production identity decision; normal Core account.rs and cell derivation in remote_computer.rs atc7d0e24. User confirmation covers dedicated account and mail infrastructure; Gmail explicitly withholds OTP content. The unified device sensitive-input tool provides the intended private OTP path.

## Source compliance review / runtime gates
| ID | Status | Evidence or remaining gate |
| --- | --- | --- |
| ID01 | passed in source | Canonical fixed production routes and normal register/login; no factory/SQL/internal issuer |
| ID02 | passed in source | Atomic0600 state, root0700 directory, generated password, redacted failures; targeted private-state contracts |
| ID03 | blocked on owner input | Private encrypted card/owner-only OTP file; no connector withholding bypass; runtime input not yet supplied |
| ID04 | passed in source | Valid challenge reuse, expiry refusal, durable unknown outcome, canonical login reconciliation; duplicate register forbidden by response-loss contract |
| ID05 | passed in source | Profile/session immutable ID equality, exact ordinary verified account, privileged-subject rejection, canonical cell derivation; actual identity pending |
| ID06 | passed for source / runtime pending | Actions38743129472 exactea924d20 passed seven targeted contracts and Python compilation; final refinement requires exact-head check |

Actual mail infrastructure delivery: Backend7110dc6c29466d9ffa7d500caadb0bf348a65b92,
Actions38741571017, appSha256a87b23e97041ac664ed7350fd6da4f5bcf18980929f3ad66bce9aef59d570a28.
Actual fixture with run marker arrived in Gmail inbox; a subsequent normal Core
registration code arrived too. SMTP-only user and exact-address IAM policy, approved
sender and activeDKIM are configured. Account creation remains blocked only on
private owner OTP input; production MCP/private network acceptance remains separate.
