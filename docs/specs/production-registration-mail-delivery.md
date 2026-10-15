# Production registration mail delivery repair

Status: discovery/spec;2026-10-15. Owner: Backend existing system-mail/registration bridge and controller mail API deployment. Parent: fdn-production-environment-bootstrap.md PA01–05.

## Context / goal / current state
The user explicitly requests that the agent resolve the delivery failure and finish ordinary production account creation. Canonical Core registration API accepts code-send requests, but actual operator mailbox searches find no message. Existing /opt/fabushi-mail-api queues to Postfix; relayhost empty, SASL disabled, direct MX TCP25 deliveries time out. Twelve queued messages observed, including Gmail and Cloudflare MX timeouts. Queue acceptance is not delivery evidence. No account exists yet.

## Requirements and non-goals
- MAIL01: Preserve ordinary production start/code/register/session owner and real mailbox ownership verification. Never extract queued OTPs, alter challenge rows, bypass code checks, use isolated test tokens in production or create SQL users.
- MAIL02: Repair existing mail delivery transport through an approved authenticated TLS relay (prefer the existing cloud account's Email Delivery on587 or HTTPS), with exact verified sender/domain and certificate validation. Inspect available cloud resources before provisioning. No public open relay, broader system access, firewall weakening or personal mailbox impersonation.
- MAIL03: Credentials are scoped to mail submission, stored only in root-readable service configuration and encrypted deployment storage as needed; never command args, logs, chat, CI artifacts or ordinary controller service env. Do not repurpose the network authority or user access tokens. Preserve existing bridge authentication.
- MAIL04: Configuration changes require backup, narrow atomic replacement, syntax validation in Actions, and reload of affected mail service only. Preserve unrelated Postfix configuration and queues. Do not blindly flush stale OTP mail or modify unrelated queued recipients. Retain old transport configuration for rollback.
- MAIL05: Prove actual fresh-code receipt in intended Gmail mailbox, then canonical API registration and immutable production account identity. Record only nonsecret request/status/message metadata; code/password/session material must not be recorded. All executable verification/acceptance in GitHub Actions; outside Actions only read-only inspection, editing, API/Git, and operational provisioning/administration.
- MAIL06: Use existing authorized cloud resources where possible; no purchase or subscription without concrete required approval. Computer UI credential/access/terms confirmation rules apply only when that interface is used. Prepare the specific change before any unavoidable confirmation.

## Design / ownership / failure handling
Core owns challenges and account identity; Backend bridge owns authenticated system-mail calls; existing controller mail API owns transport submission. An authenticated relay replaces broken direct MX delivery without introducing another registration or identity system. API success means submission acceptance; independent mailbox receipt is required before claiming delivery. On provider outage fail closed or retain bounded existing queue semantics; do not expose provider secrets or blindly retry account creation after unknown outcomes. Reconcile ordinary login/poll after uncertain registration outcome.

## Plan / acceptance / rollback
Discover relay and sender/domain configuration -> configure minimal approved submission capability -> Actions contract/config verification -> install narrow transport repair -> fresh normal registration code -> actual mailbox receipt -> ordinary registration/readback -> continue PA03–05. MAIL01–06 each require passed evidence or explicit blocked reason. SMTP accepted/queued alone fails MAIL05. Rollback restores only changed mail files and reloads its service, retaining queue and existing accounts. No account deletion, password reset or unrelated mail sending is authorized.

## Provenance
User2026-10-15: API registration is allowed; subsequent instruction "我怎么解决，你需要去解决". Authenticated bhrum2 readback: fabushi-mail-api and Postfix active; relayhost empty;12 queued recipient delay reports are TCP25 timeout. Canonical Backend system-mail.js/auth-provider-bridge.js and Core account.rs/identity_auth.rs inspected. Official Oracle Email Delivery supports approved sender plus authenticated TLS587/HTTPS; exact account availability remains discovery.
