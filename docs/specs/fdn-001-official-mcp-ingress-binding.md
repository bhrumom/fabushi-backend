# FDN-001 official MCP private ingress binding owner

Status: implementation in progress
Owner: Fabushi Backend / official device network worker + FDN coordinator
Parent: bhrumom/fabushi-desktop/docs/specs/fabushi-same-account-device-network.md (FDN-001)
Core dependency: target network ingress peer projection in bhrumom/fabushi-platform-core.

## Goal

Make the first-party official-device-MCP tsnet controller node discoverable to the target Host as an exact, Core-authorized private peer without giving the Go network worker any Fabushi account credential, deviceSecret, official MCP service token, or Core network-authority secret.

## Boundaries

- The Go network worker owns only tsnet state, private dial transport and a loopback HTTP surface.
- The worker may expose a bounded, no-secret status document containing only its configured cellId and current self Tailscale node address.
- `FDN_NETWORK_AUTHORITY_TOKEN` remains owned by the coordinator/deployment process. It is never passed to the Go worker or official MCP request handlers.
- The coordinator binds the worker's observed node into the Core account/cell/service ingress projection.
- The service id is fixed to `official-device-mcp`.
- A controller node belongs to one isolated cell/account projection. Multi-account sharing of one controller network identity is prohibited until the FDN multi-account cell gates pass.
- Core/Host session, exact-tool grant, requestId/digest, generation, revoke and expiry checks remain mandatory; network ingress binding is routing authority only.

## Worker status

The loopback worker exposes `GET /v1/fdn/status` with no query string. It returns:
`{ "cellId": "...", "nodeId": "100.x.x.x|fd7a:...", "ready": true }`.

The nodeId is obtained from the running pinned tsnet server after it reaches Running. Prefer a valid CGNAT Tailscale IPv4 address; use the Tailscale ULA address only if no IPv4 address is present. No auth key, ControlURL, state path, hostname, peer list, account token, request payload or service credential is returned.

## Coordinator ingress binder

A dedicated coordinator process/script:
- reads worker status only from an exact loopback URL;
- requires configured `FABUSHI_FDN_INGRESS_USER_ID` and exact `FABUSHI_FDN_CELL_ID`;
- persists `{userId,cellId,nodeId,generation,expiresAt}` in the existing restricted FDN state root with atomic mode-0600 replacement;
- calls only Core internal network-ingress bind/revoke using `FDN_NETWORK_AUTHORITY_TOKEN`;
- advances generation when the worker node changes; exact restart reconciliation must not create a second generation;
- never logs or persists the authority token or worker AuthKey;
- fails closed on cell/node/status mismatch or non-loopback worker endpoint.

## Failure and recovery

If Core bind outcome is unknown, the binder keeps the same persisted generation/node and reconciles by re-sending the exact bind identity, which Core accepts idempotently. It must not allocate another generation merely because an HTTP response was lost. If the worker node changes, generation advances once from durable state. Revocation is attempted before intentional replacement/shutdown when possible; Core expiry remains the eventual fail-closed boundary.

## Verification

GitHub Actions only. The existing FDN official-device-MCP workflow must test:
- loopback status route and no-secret schema;
- valid Tailscale self-node selection;
- unknown field/query/method rejection;
- binder loopback/cell/user/node validation;
- monotonic durable generation and exact restart reconciliation;
- no authority/AuthKey persistence or logging;
- Core bind request exact fields and fixed serviceId;
- existing private request worker and official MCP tests/build/vet remain green.

## Acceptance for this slice

Exact-head Actions success plus source evidence is sufficient to integrate this owner. It is not G05/G16: real production controller enrollment, direct/DERP/WSS tool calls and cross-account negative evidence remain required.
