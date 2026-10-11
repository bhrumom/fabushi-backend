# Fabushi Extension Release Governance v1

Status: active implementation slice  
Parent: FPM-001  
Depends on: unified Extension Registry v1 and Publisher Namespace v1  
Date: 2026-10-11

## Goal

Add the first durable public-release workflow to the existing Fabushi Backend Marketplace owner:

`draft -> pending_review -> approved | rejected -> revoked`

A release version is immutable after creation. Correcting code or metadata requires a new version. Public Registry discovery only includes `approved` releases; `rejected`, `draft`, `pending_review` and `revoked` releases never appear as installable public entries.

## Authority and reuse

- account/publisher identity: existing marketplace account resolver;
- namespace authorization: existing `ExtensionPublisherStore`;
- reviewer authorization: existing `FABUSHI_MARKETPLACE_REVIEW_TOKEN` owner;
- storage: same SQLite connection as existing Marketplace account state;
- manifest validation/public shape: existing `normalizeExtensionEntry`;
- public browse/detail: existing `/v1/extensions`.

No second registry, account system, reviewer secret, or install authority is introduced.

## Release key

A release is uniquely identified by:
- namespace;
- extension name;
- kind;
- semantic version.

Stable extension identity remains `<namespace>/<name>:<kind>`.

## Publisher workflow

1. Namespace owner creates an immutable release draft.
2. Server overwrites security-sensitive authority fields:
   - `origin=public`;
   - `trustDomain=catalog-authorized` only as candidate metadata; public trust is effective only when state is approved;
   - publisher identity is the owned namespace;
   - `publisher.verified=false` unless a later verified-publisher authority supplies evidence.
3. Publisher submits draft for review.
4. Draft payload cannot be mutated or replaced in-place.

## Review workflow

Existing Marketplace reviewer authorization may:
- approve a pending release;
- reject a pending release with notes;
- revoke an approved release for a security/policy reason.

Publisher may yank its own approved release. Revocation/yank is durable and removes that version from public discovery.

Approval never grants Host capabilities. Client install still requires platform compatibility and Host permission.

## Integrity

The server computes SHA-256 over the canonical normalized descriptor JSON and stores it as the immutable descriptor digest. Public projection includes the digest.

Duplicate release keys are conflicts even after rejection/revocation. A new upload must use a new version.

## API slice

Authenticated publisher:
- `POST /v1/extensions/publisher/releases`
- `POST /v1/extensions/publisher/releases/:kind/:namespace/:name/:version/submit`
- `POST /v1/extensions/publisher/releases/:kind/:namespace/:name/:version/yank`
- `GET /v1/extensions/publisher/releases`

Reviewer:
- `POST /v1/extensions/review/releases/:kind/:namespace/:name/:version`
- `POST /v1/extensions/review/releases/:kind/:namespace/:name/:version/revoke`

## Security constraints

- namespace ownership is rechecked on every publisher mutation;
- unknown kinds/origins/trust fields fail closed in the shared normalizer;
- secret-shaped public fields are rejected;
- reviewer token is never persisted;
- unapproved release metadata is not exposed from public Registry;
- approval cannot overwrite a different existing version;
- audit stores reviewer/publisher actions but not credentials.

## Non-goals for this slice

Artifact upload/storage, package signatures, malware scanning, publisher verification, typosquat scoring, ratings, dependency solver, payment, and client install/update remain later FPM slices.

## Verification

GitHub Actions only. Tests cover immutable duplicate rejection, ownership, state transitions, reviewer authorization route, approved-only public browse/detail, revocation removal, digest stability, and legacy catalog regression.
