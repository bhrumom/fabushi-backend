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

Before any production target description or device call is dispatched, the
official MCP controller must resolve the target through Platform Core's
service-bound `POST /v1/computers/:device_id/network-route` projection. The
service response is accepted only when deviceId, connectionId, delegationId,
positive generation, unexpired expiresAt, and active state match the current MCP
delegation and the inventory generation. Only cellId/nodeId/generation/expiresAt
may be handed to the private transport as routing hints; proof material,
deviceSecret, login credentials, target grants, and network private keys remain
outside the controller boundary. A route mismatch or expiry fails closed and
must not fall back to an unscoped /agent registry path.

## Durable state

Official MCP service refresh credentials and service-bound Remote Computer
client/session credentials must be encrypted at rest and fenced to the service
connection/delegation/account/device. Restart recovery must query/reconcile the
Core operation journal rather than repeat side effects.

All tests and builds run in GitHub Actions.
