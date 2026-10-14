# FDN-001 account-bound network enrollment proxy

Status: implementation contract.
Owner: `ai-backend` product API.
Parent: FDN-001.
Coordinator dependency: internal FDN enrollment service.

## Boundary

The product-facing endpoint uses the existing Fabushi account resolver. It must not use the historical ai-backend `devices` table, device names, IPs, email equality, or the official MCP in-memory registry as network enrollment authority.

The coordinator independently redeems the Core grant. Platform Core access tokens use the canonical account database id as `sub`. ai-backend keeps its historical local storage namespace (`user:<id>`) separate and also carries `fabushiAccountId`, sourced only from the authenticated remote account `id`. The proxy releases enrollment material only when the coordinator's Core-derived `target.userId` exactly equals that raw `fabushiAccountId` and the coordinator target generation equals the enrollment generation. Username, email, local userId prefixes, and token hashes are never identity fallbacks for FDN.

## Routes

- `POST /api/fdn/network-enrollment/start` with exactly `{grantId, grantSecret}`
- `POST /api/fdn/network-enrollment/complete` with exactly `{grantId}`

Both routes require an authenticated Fabushi account. They return only the sanitized `enrollment` projection plus the Core-derived deviceId needed by the target client.

## Coordinator transport

`FABUSHI_FDN_ENROLLMENT_BROKER_URL` must be either:
- loopback HTTP for a co-located deployment, or
- HTTPS for an approved authenticated internal ingress.

`FABUSHI_FDN_ENROLLMENT_BROKER_TOKEN` is a distinct secret used only between ai-backend and the coordinator enrollment service. It is not the Core `FDN_NETWORK_AUTHORITY_TOKEN`, a Fabushi user token, a Remote Computer deviceSecret, or a Headscale pre-auth key.

If either setting is absent or malformed the proxy fails closed with service-unavailable. No fallback to the legacy devices registry is permitted.

## Acceptance

GitHub Actions must prove strict request shape, transport URL policy, broker credential projection, authenticated subject matching, generation matching, upstream error redaction and a source-level ban on legacy registry authority.

This is a G02 prerequisite only. Real production ingress/deployment and tsnet registration remain pending until exact-SHA evidence exists.
