# FDN-001 Headscale 0.29.5 enrollment key mint

Status: implementation contract
Owner: Fabushi Backend / FDN network coordinator
Parent authority: FDN-001
Core prerequisite: Platform Core network-enrollment grant contract (migration 0033)

## Goal

Mint the actual short-lived, one-time Headscale pre-authentication key only after
Backend has redeemed a valid Core network-enrollment grant. Headscale
administrative authority remains inside the coordinator boundary and is never
given to Desktop, Android, iOS, Web, official MCP, or a model-facing tool.

## Headscale version contract

Production is locked to Headscale 0.29.5.

In 0.29.5:
- preauth keys are non-reusable unless `--reusable` is explicitly supplied;
- `preauthkeys create --user` accepts the numeric user identifier in this
  pinned CLI;
- `--expiration` accepts a human-readable duration.

Do not depend on later Headscale CLI behavior that permits a user name directly
for `preauthkeys create --user`.

## Opaque user mapping

Core returns a stable opaque `cellId`. The coordinator uses that exact
validated cell ID as the Headscale username. Raw Fabushi account IDs, emails and
device names are never Headscale usernames.

The mint owner:
1. lists Headscale users filtered by the exact cell name;
2. creates the opaque user only when it does not exist;
3. resolves exactly one numeric Headscale user ID;
4. fails closed on ambiguous or malformed results.

## Key lifetime and semantics

The mint owner accepts a remaining Core grant TTL in seconds.
- allowed range: 15..300 seconds;
- the Headscale key expiration is never longer than that TTL;
- the command must never pass `--reusable`;
- the command must never pass `--ephemeral` unless a later accepted product
  contract explicitly changes node persistence semantics;
- the raw preauth key is returned only on stdout to the immediate trusted caller
  and must not be written to files or normal logs.

A Core grant must be redeemed before invoking this owner. This script does not
perform Core redemption itself and cannot mint from a Fabushi account token,
official MCP service token, deviceSecret, or arbitrary device input.

## Admin boundary

All Headscale CLI commands execute inside the existing coordinator service via
`docker compose exec -T headscale headscale ...`. The target client never sees
the Headscale admin socket, API key, database or CLI.

## Node correlation

The eventual enrollment gateway must also return a coordinator-generated
expected hostname derived from the Core grant identity/generation. After tsnet
registration, Backend must resolve the unique Headscale node for the opaque cell
and expected hostname, derive a proof from coordinator-observed node identity,
and call the existing Core network-binding authority. A target-reported IP or
node ID is not sufficient.

This mint slice deliberately stops before that node-correlation/bind step.

## Verification

GitHub Actions only:
- shell/source contract forbids `--reusable` and secret logging;
- run real Headscale 0.29.5;
- create/reuse an opaque test cell user;
- mint a key with <=300 second expiration;
- verify the returned key is non-empty;
- inspect Headscale preauth key JSON and prove reusable=false and the owner is
  the expected opaque cell;
- a second user lookup resolves the same single user rather than creating a
  parallel identity.

This is a G02 prerequisite only. It is not G02/G03/G05 acceptance until Core
grant redemption, public target enrollment gateway, node correlation/binding,
revocation/generation propagation, cross-account negative tests, and real
transport tool calls are proven.
