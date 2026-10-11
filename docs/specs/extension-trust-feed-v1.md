# Fabushi Extension Trust Feed v1

Status: active implementation slice  
Parent: FPM-001  
Depends on: Extension Release Signing v1  
Date: 2026-10-11

## Goal

Persist Marketplace signing-key provenance and make key revocation immediately quarantine every canonical release signed by that trust key.

## Authority

The existing Marketplace SQLite database remains the single server authority. Configured signing keys are registered by key ID + trust epoch + public-key fingerprint. Existing immutable release signatures remain historical evidence and are never rewritten.

## Key state

Each trust key is:
- active; or
- revoked.

A configured signer is registered as active on startup. Reusing the same key ID + epoch with different public key material fails startup/initialization closed.

Reviewer authorization reuses the existing Marketplace review token.

## Public feed

`GET /v1/extensions/trust` returns non-secret key metadata:
- protocol;
- keyId;
- trustEpoch;
- algorithm;
- publicKey;
- publicKeyFingerprint;
- status;
- createdAtMs;
- revokedAtMs;
- revocationReason.

## Revocation

`POST /v1/extensions/review/trust/:keyId/:trustEpoch/revoke`

Revocation is append-only from the public API. A revoked key cannot be reactivated through this API.

Once revoked:
- its release signatures remain stored;
- those canonical releases are omitted from public Registry browse/detail;
- approved artifact bytes are no longer downloadable through the public approved-artifact route when no still-trusted approved binding exists;
- Host/client trust verification can reject the key using the feed.

## Rotation

A new configured key uses a new key ID and/or incremented trust epoch. Old active keys remain valid for previously approved releases until explicitly revoked. Re-signing an immutable old release in place is prohibited.

## Security

Trust proves Marketplace source/integrity only. It never grants Host permissions.

## Verification

GitHub Actions only. Tests cover registration, material-conflict failure, rotation coexistence, revocation immutability, public feed privacy, Registry quarantine, and reviewer authorization.
