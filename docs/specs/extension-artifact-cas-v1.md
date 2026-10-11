# Fabushi Extension Artifact CAS v1

Status: active implementation slice  
Parent: FPM-001  
Depends on: Publisher Namespace v1, Extension Release Governance v1  
Date: 2026-10-11

## Goal

Add a Fabushi-owned, content-addressed artifact store to the existing Backend Marketplace owner and make artifact scan state a mandatory release-approval gate.

This is additive to the existing immutable-GitHub Mini App compatibility path. It does not replace the Host's final install authorization.

## Ownership

- Database: the existing Marketplace / AccountSync SQLite connection.
- Artifact bytes: `<DATA_DIR>/extensions/artifacts/sha256/<first-two-hex>/<sha256>`.
- Namespace/release authorization: existing Publisher Namespace and Release stores.
- Reviewer authorization: existing Marketplace review token.
- No second registry or account store.

## Upload contract

Authenticated namespace owners upload an artifact as `application/octet-stream`.

Metadata is supplied by headers:
- `x-fabushi-extension-kind`
- `x-fabushi-extension-namespace`
- `x-fabushi-extension-name`
- `x-fabushi-extension-version`
- `x-fabushi-artifact-id`
- `x-fabushi-artifact-platform`
- `x-fabushi-artifact-format`
- optional `x-fabushi-artifact-architecture`

The server:
1. enforces a bounded upload size;
2. computes SHA-256 itself;
3. atomically writes bytes into the CAS;
4. verifies an existing CAS object has the same size if the digest already exists;
5. inserts immutable release-artifact metadata;
6. sets scan state to `pending`.

Client-supplied digests are not trusted.

## Scan gate

Reviewer may record:
- `passed`
- `rejected`

with scanner name, scanner version and notes. Scan credentials are never persisted.

A release cannot be approved unless:
- it has at least one bound artifact; and
- every bound artifact is `passed`.

A rejected artifact permanently blocks that artifact binding. Corrected bytes require a different digest / artifact upload.

Revocation/yank keeps CAS bytes for audit/rollback policy; garbage collection is a later lifecycle operation.

## Public artifact metadata

Approved Registry releases may expose only non-secret install metadata:
- artifact id;
- SHA-256;
- byte size;
- platform;
- architecture;
- format;
- scanner verdict provenance;
- immutable download path / URL produced by the server.

Public metadata does not itself grant execution permission.

## Security

- namespace ownership is checked on upload;
- release must already exist and match namespace/kind/name/version;
- path components never control filesystem paths; only computed SHA-256 does;
- symlink/path traversal is impossible in CAS object addressing;
- upload is written to a sibling temporary file and renamed atomically;
- scan state defaults to fail-closed `pending`;
- reviewer cannot approve release before all artifacts pass;
- no artifact is considered signed merely because it is scanned.

## Digital signatures

Digital signing is **not faked in this slice**. A later signing slice must use configured/rotatable managed Ed25519 keys, publish key IDs and trust epochs, sign canonical release + artifact digests, and support revocation. Temporary process-generated keys are forbidden as production trust anchors.

## Verification

GitHub Actions only. Tests cover digest computation, deduplication, persistence, ownership, immutable bindings, scan transitions, approval gating, HTTP raw upload, traversal-resistant CAS paths and byte-for-byte download.
