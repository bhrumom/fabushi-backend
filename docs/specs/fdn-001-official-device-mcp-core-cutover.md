# FDN-001 official device MCP Core cutover

Status: implementation in progress.

## Authority

The official device MCP remains the external entrypoint, but its production device
directory is the service-bound Platform Core Remote Computer inventory. The
in-memory /agent WebSocket registry is not an authoritative device database.

A device may contribute live fallback transport metadata only after the same
account/device identity is present in Core. Device-provided tool descriptions do
not create authorization: exact tool execution is still fenced by the Core
session/grant/operation journal and is re-authorized by the target Host.

## Controller versus target credentials

The official MCP Core service access token is a controller credential. It may
list the service-bound account inventory, pair a controller client, create or
reconcile sessions, create/query/cancel operations, and mark an operation
outcome_unknown. It must never call target-only session activation, exact-tool
grant/revoke, operation claim, or operation result endpoints.

Target-only actions remain account + deviceSecret authority on the target Host.

## Transport

WireGuard/DERP/private streams are preferred. Authenticated reverse WebSocket may
remain as a fallback transport, but only after canonical Core account/device and
operation checks. Transport loss after dispatch is outcome_unknown and does not
cause automatic replay of side effects.

Before every private target stage that can authorize or execute work, the
controller must re-resolve the service-bound Core network route. A previously
resolved route is not a durable capability: expiry, revoke, generation rotation,
connection switch, or delegation switch must fail the next private stage closed.
Within one stage, the route used to construct request identity and the route
handed to the transport must be the same snapshot to avoid a route-generation
TOCTOU. Only cellId/nodeId/generation/expiresAt are routing hints; application
authorization remains Core/Host-owned.

### Controller network-worker IPC

The official MCP process must not open arbitrary public sockets from tool input.
Its preferred private transport is a supervised first-party network worker reached
only through bounded local IPC. The controller supplies the already-validated
Core route snapshot (cellId, nodeId, generation, expiresAt), the fixed product
Remote Computer port, timeout, and one bounded JSONL frame. The worker owns
Tailscale/Headscale node state and decides direct-versus-DERP transport; it does
not decide tool authorization.

The controller must reject non-loopback worker endpoints, route expiry, invalid
node identities, responses larger than the bounded result limit, response
identity mismatches, and transport errors. Once an operation frame may have been
dispatched, timeout/disconnect remains outcome_unknown and is never converted to
an automatic replay. Authenticated reverse WebSocket remains an explicit
fallback only, never an implicit replacement for a failed private-network
dispatch.

## Durable state

Official MCP service refresh credentials and service-bound Remote Computer
client/session credentials must be encrypted at rest and fenced to the service
connection/delegation/account/device. Restart recovery must query/reconcile the
Core operation journal rather than repeat side effects.

All tests and builds run in GitHub Actions.
