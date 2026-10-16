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

## Production public gateway completion (2026-10-16)

Actual controller4213b49 run38830333777 passed deployment, and independent
inventory38830843065 confirmed worker/MCP HTTP readiness, enrollment401 and
Core ingress binder success. Existing account API4213b49 run38830720805 passed
ARM64 full142 tests before and after production pruning and actual deployment;
its additive broker configuration reuses the existing private credential.

GW01: Host's canonical default base is https://api.ombhrum.com. The compatibility
gateway must forward exactly POST /api/fdn/network-enrollment/start and /complete
to the same exact paths at existing https://ai.ombhrum.com. Extend the existing
router with one narrow adapter owned by this proxy; no new issuer, device database,
Network Core, protocol or generic outbound proxy. Keep all existing route owners.
GW02: Reject query parameters, non-POST methods, non-JSON content types and bodies
over64KiB before forwarding. Unknown paths remain unclaimed. Forward only bearer
Authorization and JSON Content-Type; exclude cookies, authority/admin headers and
caller-selected destinations. Preserve upstream sanitized status/body, no-store,
and fixed X-Fabushi-Fdn-Owner=existing-account-api marker.
GW03: Send at most one upstream request, redirect=manual, bounded15-second timeout.
An uncertain upstream response yields a generic502 without raw error/credential,
failover, redirect following or replay. Core grant and broker idempotency remain
unchanged. The target Host retains durable request/outcome_unknown recovery.
GW04: Actions-only focused tests cover exact routing/body/header boundary, rejected
inputs/no dispatch, network failure/redirect/no retry and secret-free error output.
Canonical Worker delivery retains its security preflight, D1 bookmark/migration
and deployment owner. After deployment, Actions must call both public routes
without credentials and observe401 plus the fixed owner marker, recording exact
source/run/status. This proves route ownership/denial only, not enrollment success
or full production OAuth/native/direct/DERP acceptance.

Rollback: canonical Worker previous-version rollback; account API and controller
remain installed. Do not delete production identity, data, keys or network state.
AC-GW1 all focused contracts pass exact head; AC-GW2 real public401/marker for
both routes at deployed exact source; AC-GW3 full target enrollment remains a
separate requirement with real Host identity/grant and native authorization.
Current GW01–04/AC-GW1–3 pending implementation/verification; no fake credentials
or isolated factory promotion is acceptable as production enrollment evidence.
