# Fabushi .fabapp Manifest Signing v1

Status: active implementation slice  
Parent: FPM-001 / OMA-001  
Depends on: Extension Release Signing v1, Extension Trust Feed v1  
Date: 2026-10-11

## Goal

Reuse the existing managed Marketplace Ed25519 trust root to sign strict catalog `.fabapp` manifests accepted by native Hosts without exposing the signing private key or creating a second trust root.

This adapter is for package-integrity signing. Existing Registry release signatures remain independently required for approved artifact provenance.

## Trust boundary

- The only signing material is the already configured `FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY`, key ID and trust epoch.
- No API returns private key material.
- Missing, invalid or revoked configured trust fails closed.
- The signing endpoint is reviewer-authorized using the existing Marketplace review authorization boundary.
- Tests may use ephemeral Ed25519 keys; production must not generate one automatically.

## Manifest contract

The request must contain one strict unsigned manifest object with exactly:

- `manifestVersion=1`
- `packageClass="catalog"`
- valid `appId`, `publisherId`, semantic `version`
- `displayName`
- safe relative `entrypoint`
- `runtime="web"`
- positive `minHostApi`
- boolean `offlineCore`
- unique capability identifiers
- network policy `deny|allowlist`; when `offlineCore=true`, mode must be `deny` and origins empty
- non-empty exact file table with SHA-256, byte count and MIME

The incoming unsigned manifest must not contain `signature` or unknown fields.

## Canonical payload

The native iOS verifier signs/verifies:

`UTF8("fabushi.fabapp.manifest.v1\\0") || canonical_json(unsigned_manifest)`

Canonical JSON recursively sorts object keys, preserves array order, emits JSON primitives without whitespace, and rejects non-finite/unsupported values.

The response adds:

```json
"signature": {
  "algorithm": "Ed25519",
  "keyId": "<managed key id>",
  "value": "<base64url raw signature>"
}
```

The same response exposes the corresponding **raw 32-byte Ed25519 public key** as base64url plus key ID/trust epoch/fingerprint so native trust registration can bind the package signer to the signed Marketplace trust feed. SPKI DER remains the Registry envelope format; raw key material is a derived public representation only.

## HTTP

`POST /v1/extensions/review/fabapp/sign`

- requires existing reviewer authorization;
- accepts JSON `{ manifest: <strict unsigned manifest> }`;
- returns `{ manifest, trust }`;
- never accepts caller-selected key IDs, signatures or private material;
- fails closed when managed signing configuration is absent.

This endpoint signs package manifests only. It does not approve a release, scan an artifact, publish bytes, grant Host capabilities or create entitlement.

## Global Dharma

`global-dharma@1.1.0` is the first production consumer. Its publisher identity remains `fabushi-official` unless current canonical publisher ownership is migrated through the existing Marketplace governance flow.

Its offline package must use `networkPolicy.mode="deny"`. The protected tool `local.prayer-wheel.start` is only a requested Host capability; package signing never grants its entitlement.

## Verification

GitHub Actions only. Tests must cover:

- canonical payload matches the native domain-separated contract;
- output signature verifies with raw public key;
- tampered manifest/signature fails;
- unknown/malformed fields rejected;
- offline network-policy violation rejected;
- duplicate capability/file/path hazards rejected;
- caller-provided signature rejected;
- reviewer authorization required;
- missing managed signer returns fail-closed error;
- no private key appears in responses.

## Acceptance

- FAS-01 same managed trust root, no second key store.
- FAS-02 strict native-compatible canonical manifest signature.
- FAS-03 reviewer-only API.
- FAS-04 raw public-key representation is derived and bound to the managed signer.
- FAS-05 package signature does not replace Registry artifact scan/release signature.
- FAS-06 exact-head backend CI passes.


## Production Cloudflare Worker adapter

The canonical public production API at `api.ombhrum.com` is the Cloudflare Worker in `fabushi/web`, not the Node test/runtime in `ai-backend`. Therefore production signing must expose the same contract from that Worker rather than assuming Node Express routes are deployed.

The Worker adapter is deliberately narrow:

- `GET /v1/extensions/trust` returns only public signer metadata for the currently configured managed key.
- `POST /v1/extensions/review/fabapp/sign` requires the reviewer token and signs only the strict manifest-v1 payload defined above.
- it never serves generic release approval, artifact upload, entitlement, or private key material.
- it uses the same `FABUSHI_MARKETPLACE_SIGNING_PRIVATE_KEY`, `FABUSHI_MARKETPLACE_SIGNING_KEY_ID`, `FABUSHI_MARKETPLACE_TRUST_EPOCH` and reviewer token contract as the Node implementation.
- because WebCrypto cannot portably derive an Ed25519 public key from a PKCS#8 private key, production additionally configures `FABUSHI_MARKETPLACE_SIGNING_PUBLIC_KEY_RAW` as the base64url 32-byte public key corresponding to the managed private key. Startup/signing must self-check each produced signature against this public key.
- production delivery security preflight fails closed unless all signing/reviewer secrets are present.

This adapter exists only to make the already-reviewed signing contract reachable from the actual production control plane; it is not a second signer or a second trust root.
