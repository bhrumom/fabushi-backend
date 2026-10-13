# Existing Marketplace Node production delivery

Status: active implementation pending. Date: 2026-10-13.
Owner: canonical backend Marketplace / existing Dacheng Node service.
User authority: complete missing setup for proprietary Global Dandelion publication.

## Context and goal

Production ai.ombhrum.com returns 404 for unified Registry. Existing service on
bhrum2 runs canonical historical source 5448c51a462e0e0cd118cc63cac5a8fc06cc4b66
in /opt/dacheng-ai/releases; Ubuntu24.04, Node22.22.2, port8788. Current backend
main contains Registry namespace/release/artifact/scan/sign/review/trust APIs but
is not deployed. Reuse this service, account resolver and persistent stores;
do not add a second Marketplace. Existing dataDir=/opt/dacheng-ai/data and
/opt/dacheng-ai/.env must survive untouched.

## Requirements

- MND-01: main-only manual production-environment Actions delivery. Bind exact
  canonical source. Node22/Ubuntu24 dependencies, builds and all tests in Actions;
  VPS only receives prepared bytes/config and restarts the existing service.
- MND-02: administrator initializes one dedicated deploy SSH identity in memory;
  private key only encrypted GitHub secret/ephemeral0600 runner identity. Refuse
  overwrite. Server key restricted to fixed canonical-service deploy helper,
  no shell/forwarding/PTY; no personal login credential or broad persistent token.
- MND-03: pin observed server host Ed25519 key, not ssh-keyscan at deploy time.
  Validate fixed command sourceSHA/digest, bounded tar and paths/links/special
  members before extracting only into new immutable release directory.
- MND-04: capture existing SQLite online backups before service change; preserve
  original environment, data ownership and historical release. Signer/reviewer
  values transferred over SSH stdin only, never artifact/log/source/tool argument.
  Reuse existing managed signing root, refuse changed existing identity config.
- MND-05: switch a dedicated systemd drop-in to verified release, restart service,
  require health and Registry route. On failure restore previous drop-in/service;
  retain backups/new release for diagnosis. No data reset or automatic destructive
  database restore. Migration is additive; backup restoration requires separate
  recovery decision if startup has changed persistent schema.
- MND-06: public api gateway forwards existing Registry paths to this existing
  Marketplace owner, while preserving its narrow Worker manifest-signing route
  and all other canonical Rust /v1 paths. Do not retry uncertain writes or change
  account/reviewer authentication. Publisher ownership and scan/review remain real.

## Architecture, verification and acceptance

Prepared release is source/src + package metadata + Node22 production dependencies,
not private .env or data. Runner verifies main, builds/tests once, transfers framed
private configuration and hashed archive to forced helper. Helper has no arbitrary
command argument; only fixed service release/disk/backup/health operations.
Code provenance includes source/run/archive digest, Node and server host pin; no
credentials. Tests in Actions cover archive paths/links/limits, command validation,
configuration no-overwrite and gateway route/header/no-retry ownership. Exact
head CI precedes merge and configuration/deploy; real route check follows.
Deployment != release approval or successful installed mini-app runtime.

AC-1: protected deploy identity and host pin, no private disclosure.
AC-2: main prepared artifact, preserved data/config/backup, successful service and
existing Registry read/reviewer authorization; rollback drill documented.
AC-3: canonical gateway reaches same owner, other APIs regress without bypass.
All pending. Missing network/device/credentials must not become a passing claim.

References: production-worker-delivery.md, unified-extension-registry-v1.md,
extension-release-governance-v1.md, extension-release-signing-v1.md;
live systemd/source/route evidence from 2026-10-13. No persistent-device build/test.
