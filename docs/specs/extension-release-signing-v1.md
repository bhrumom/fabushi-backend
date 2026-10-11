# Fabushi Extension Release Signing v1

Status: active implementation slice  
Parent: FPM-001  
Depends on: Release Governance v1, Artifact CAS v1  
Date: 2026-10-11

## Goal

Cryptographically bind an approved canonical Extension release to its normalized descriptor and scanned artifact digests with a managed Ed25519 key.

A Marketplace review decision is not enough to create public trust. Approval of a canonical release must fail closed unless valid signing configuration is present.

## Trust boundary

Production signing material comes only from explicit server configuration:

- `FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY`: PKCS#8 PEM Ed25519 private key.
- `FABUSHI_MARKETPLACE_SIGNING_KEY_ID`: stable public key identifier.
- `FABUSHI_MARKETPLACE_TRUST_EPOCH`: positive integer trust epoch.

The backend must never generate a process-local production trust key automatically.

Tests may generate ephemeral test keys because those keys never represent production trust.

## Canonical signed payload

Protocol: `fabushi.extension-release-signature.v1`

The signed UTF-8 JSON payload uses fixed field insertion order and contains:

- protocol;
- keyId;
- trustEpoch;
- stable extension identity;
- release version;
- descriptorDigest;
- sorted artifact list:
  - artifactId;
  - SHA-256 digest;
  - byte size;
  - platform;
  - architecture;
  - format.

Only artifacts with final `passed` scan state may be signed.

The signature is Ed25519 over the exact canonical payload bytes.

## Persistence

A separate immutable signature record is stored in the existing Marketplace SQLite database, keyed by release identity/version. It stores:

- algorithm `Ed25519`;
- key ID;
- trust epoch;
- public key SPKI DER encoded as base64;
- public key SHA-256 fingerprint;
- canonical payload;
- base64 signature;
- signed timestamp.

Repeated signing for the same release may return the same existing signature only if payload, key ID and trust epoch match. Otherwise it fails closed instead of silently replacing provenance.

## Approval flow

1. Release is pending review.
2. Every bound artifact has passed the security scan gate.
3. Signing configuration is loaded and validated.
4. Canonical payload is generated.
5. Ed25519 signature is created and verified immediately using the derived public key.
6. Signature record is committed.
7. Release transitions to approved.

If signing fails, release remains pending review.

## Public Registry

Approved canonical release metadata includes a public signature envelope sufficient for native clients/Host to verify:

- protocol;
- algorithm;
- keyId;
- trustEpoch;
- publicKey;
- publicKeyFingerprint;
- payload;
- signature;
- signedAtMs.

The presence of a valid Marketplace signature proves source/integrity only. It does not grant Host permissions.

## Key rotation and revocation

This slice introduces `keyId` and `trustEpoch`, but does not yet implement a full signed key-revocation feed. Rotation is performed by deploying new managed key configuration and incrementing trust epoch. A later trust-feed slice must provide signed active/revoked key metadata and offline staleness policy.

## Verification

GitHub Actions only. Tests must prove:
- missing/invalid config fails closed;
- signature verifies;
- payload binds descriptor and artifact digests;
- changing bytes/digest invalidates verification;
- duplicate signature cannot be overwritten by a different key/epoch;
- HTTP approval without configured signer is rejected;
- approval with configured signer exposes a verifiable public envelope.
