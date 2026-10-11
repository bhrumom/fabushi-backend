# Fabushi Extension Publisher Namespace v1

Status: active implementation slice  
Parent: FPM-001  
Depends on: `fabushi.extension-registry.v1`  
Date: 2026-10-11

## Goal

Add durable publisher namespace ownership to the existing Backend Marketplace domain without creating a second account or identity system.

This slice establishes the authorization root required before public extension release writes can be accepted.

## Authority

- Account identity: existing `resolveMarketplaceAccountIdentity`.
- Persistent database: the same SQLite connection owned by `AccountSyncStore`.
- Namespace store: additive tables in that database.
- Registry read model: existing `extension_registry.js`.

## Contract

Namespace names are lower-case ASCII identifiers matching `^[a-z0-9][a-z0-9._-]{1,63}$`.

A namespace has exactly one owner account in v1 and an immutable creation timestamp. Display name may change. Ownership transfer is a two-party propose/accept flow: the current owner proposes a target account and only that authenticated target may accept. Every step is audited.

Public reads expose namespace name/display/status but never account IDs.

Authenticated writes:
- create namespace;
- update display name;
- propose transfer to another account ID;
- accept a pending transfer as the exact target account;
- cancel a pending transfer as the current owner.

The reserved `fabushi` namespace cannot be claimed or transferred through the public publisher API.

Every mutation writes an append-only audit record containing action, namespace, actor account, target account when applicable, timestamp and a non-secret JSON payload.

## Security invariants

- Anonymous writes are rejected by existing account identity resolution.
- A different account cannot update or propose transfer for a namespace; a non-target account cannot accept a transfer.
- Namespace collisions return conflict and never overwrite ownership.
- Reserved namespaces fail closed.
- Audit records are append-only through the public API.
- No token, credential or OAuth material is stored in namespace records or audit payloads.

## Non-goals

- Team multi-member publisher roles.
- Publisher verification badges.
- Public release upload/review/signing.
- Key rotation.
- Billing.
- Extension installation.

Those build on this ownership root in later slices.

## Verification

GitHub Actions only.

Tests must prove create/read/update, two-party propose/accept/cancel transfer, duplicate rejection, unauthorized mutation rejection, reserved namespace rejection, account privacy in public reads, persistent reopen behavior, and audit ordering.
