# Fabushi Extension Trust Feed v1

Status: active implementation slice  
Parent: FPM-001  
Depends on: Extension Release Signing v1  
Date: 2026-10-11

## Goal

Persist Marketplace signing-key provenance, publish a cryptographically signed and freshness-bounded trust feed, and make key revocation immediately quarantine every canonical release signed by that trust key.

## Authority

The existing Marketplace SQLite database remains the single server authority. Configured signing keys are registered by key ID + trust epoch + public-key fingerprint. Existing immutable release signatures remain historical evidence and are never rewritten.

## Key state

Each trust key is:
- active; or
- revoked.

A configured signer is registered as active on startup. Reusing the same key ID + epoch with different public key material fails startup/initialization closed.

Reviewer authorization reuses the existing Marketplace review token.

## Signed public feed

`GET /v1/extensions/trust` returns one `fabushi.extension-trust-feed.v1` envelope signed by the currently configured managed Ed25519 Marketplace key.

The signed canonical payload binds:
- protocol;
- issuedAtMs;
- expiresAtMs;
- signing key ID, trust epoch and public-key fingerprint;
- the complete sorted public trust-key set;
- each key's algorithm, public key, fingerprint, active/revoked status, creation time, revocation time and revocation reason.

The outer envelope exposes the exact signed payload, signature, signing public key/fingerprint, key ID, trust epoch, issued time and expiry time.

The feed contains no private key, OAuth credential, review token, account identifier or other secret.

## Freshness / offline policy

A trust feed has a finite TTL. Default TTL is 24 hours and may be configured with `FABUSHI_MARKETPLACE_TRUST_FEED_TTL_MS`, bounded to at most 7 days.

Clients/Hosts must fail closed for new install/update authorization when:
- the feed signature is invalid;
- the feed signer is not an active key inside the signed payload;
- the payload/envelope signer identity differs;
- the feed is expired;
- the feed is unreasonably future-dated;
- the feed protocol is unknown.

An already installed extension may continue only according to the platform's separately documented offline execution policy; a stale feed must never authorize a new artifact or update.

## Revocation

`POST /v1/extensions/review/trust/:keyId/:trustEpoch/revoke`

Revocation is append-only from the public API. A revoked key cannot be reactivated through this API.

The currently configured feed-signing key cannot revoke itself. Emergency compromise handling requires first deploying a new managed signer with a new key ID and/or higher trust epoch, then revoking the previous key with the new signer active. This ensures the revocation statement is itself signed by non-revoked trust material.

Once revoked:
- its release signatures remain stored;
- those canonical releases are omitted from public Registry browse/detail;
- approved artifact bytes are no longer downloadable through the public approved-artifact route when no still-trusted approved binding exists;
- Host/client trust verification rejects the key using the signed feed.

## Rotation

A new configured key uses a new key ID and/or incremented trust epoch. Old active keys remain valid for previously approved releases until explicitly revoked. Re-signing an immutable old release in place is prohibited.

Rotation coexistence is intentional: the new key signs the feed while old approved releases remain trusted until the reviewer revokes the old key.

## Security

Trust proves Marketplace source/integrity only. It never grants Host permissions.

Revocation is a distribution-integrity control, not an execution permission grant. Host capability authorization remains independent and fail-closed.

## Verification

GitHub Actions only. Tests cover:
- trust-key registration;
- key-material conflict failure;
- rotation coexistence;
- current-signer self-revocation refusal;
- old-key revocation immutability;
- signed feed verification;
- tamper rejection;
- expiry/future-date rejection;
- public feed privacy;
- Registry quarantine;
- artifact-download quarantine;
- reviewer authorization.
