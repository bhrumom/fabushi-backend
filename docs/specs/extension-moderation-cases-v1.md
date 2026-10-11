# Fabushi Extension Moderation Cases v1

Status: active implementation slice  
Parent: FPM-001  
Owner: existing Fabushi Backend Marketplace SQLite domain  
Date: 2026-10-11

## Goal

Add durable, auditable extension abuse reports and publisher appeals without creating a second moderation service or weakening immutable release governance.

## Scope

This slice covers canonical publisher releases in the unified Extension Registry.

It provides:
- authenticated user abuse reports;
- reviewer-only report disposition;
- reviewer-triggered release revocation for substantiated reports;
- publisher-owner appeals against an actioned report;
- reviewer-only appeal disposition;
- append-only case audit.

It does not implement ratings, automated malware scanning, legal takedown automation, content-age review, recommendation ranking or organization policy.

## Identity and authority

The existing Marketplace account resolver owns caller identity.

The existing:
- `ExtensionPublisherStore` owns namespace ownership;
- `ExtensionReleaseStore` owns immutable release state/revocation;
- `ExtensionSigningStore` owns trust keys;
- Marketplace SQLite database remains the only moderation persistence authority.

Moderation never edits artifact bytes, release descriptors, release signatures or trust-key history.

## Case types

### Report

Authenticated account reports one exact `kind/namespace/name/version`.

Allowed reason codes:
- `malware`
- `impersonation`
- `privacy`
- `policy`
- `other`

Report states:
- `open`
- `dismissed`
- `actioned`

One reporter cannot hold duplicate open reports for the same exact release. A resolved case may be followed by a new report when new evidence exists.

Reviewer disposition:
- `dismiss`: report becomes `dismissed`;
- `revoke`: the exact release must be approved or already revoked; the release is revoked through the existing ReleaseStore, then the report becomes `actioned`.

The retry path is recovery-safe: if release revocation succeeded but process termination happened before case state update, retrying the same open case observes the already-revoked release and completes the case instead of restoring or double-mutating it.

### Appeal

Only the current namespace owner may appeal an `actioned` report for its release.

One open appeal per actioned report is allowed.

Appeal states:
- `open`
- `accepted`
- `rejected`

Reviewer disposition records the decision and audit evidence.

**Accepted appeal does not reactivate a revoked immutable release.** Remediation uses a new release version and the ordinary artifact scan/review/signing path. This preserves revocation and audit history.

## Data minimization and security

Case public/API payloads never contain access tokens, authorization headers, OAuth credentials, signing private keys or reviewer token values.

Reason/details/resolution text have strict length bounds.

Reviewer operations reuse the existing Marketplace reviewer authorization boundary.

Report/appeal listing is scoped:
- reporter may list their own reports;
- namespace owner may list appeals/cases relevant to owned namespaces;
- reviewer may use reviewer routes for moderation queues.

This initial slice exposes only the minimum endpoints needed by those scopes; no global unauthenticated moderation feed exists.

## API

- `POST /v1/extensions/reports`
- `GET /v1/extensions/reports/mine`
- `POST /v1/extensions/review/reports/:caseId/resolve`
- `POST /v1/extensions/publisher/reports/:caseId/appeal`
- `GET /v1/extensions/publisher/appeals`
- `POST /v1/extensions/review/appeals/:caseId/resolve`

All response errors are typed and fail closed.

## Audit

Every state transition writes append-only:
- case ID;
- action;
- actor identity/class;
- non-secret payload;
- timestamp.

Release revocation continues to write the existing release audit independently.

## Verification

GitHub Actions only.

Required tests:
- unauthenticated report rejected;
- invalid reason/release rejected;
- duplicate open report rejected;
- reviewer auth required;
- dismiss does not revoke;
- actioned report revokes approved release;
- recovery retry succeeds if release already revoked;
- only namespace owner can appeal;
- duplicate open appeal rejected;
- accepted/rejected appeal never reactivates release;
- case audit order is stable and contains no secret fields;
- existing Registry, artifact, signing, account-sync and Mini App tests remain green.
