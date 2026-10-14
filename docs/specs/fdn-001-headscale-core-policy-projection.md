# FDN-001 Core-driven Headscale policy projection

Status: implementation in progress.
Owner: Fabushi Backend / FDN network coordinator.
Parent authority: bhrumom/fabushi-desktop/docs/specs/fabushi-same-account-device-network.md (FDN-001).

## Goal

Project the canonical Platform Core Remote Computer live network-binding state into the existing per-cell Headscale policy owner without creating another device registry or using device self-report as authority.

## Authority and credentials

- Platform Core remains authoritative for Fabushi account/device/network-binding generation, expiry and revoke.
- The projector may call only the dedicated internal Core network-authority cell-snapshot route using `FDN_NETWORK_AUTHORITY_TOKEN`.
- Official MCP service access tokens, Fabushi account access tokens, deviceSecret, clientToken and mobileToken are not accepted by this projector.
- The authority token is read from process environment only and is never written into policy, logs, errors, artifacts or command arguments.

## Snapshot contract

The projector requests exactly one bounded `cellId` from Core. The accepted response contains only live rows with `userId`, `deviceId`, `cellId`, `nodeId`, `generation` and `expiresAt`.

The projector fails closed if:
- response identity differs from the requested cell;
- any row is expired, malformed, duplicated, outside Tailscale CGNAT/ULA addressing, or contains an unexpected field;
- more than one Fabushi `userId` is present in a cell;
- the response exceeds the supported bound;
- Core is unavailable or returns an error.

## Policy

Every cell starts with `grants: []`. For a non-empty valid single-account snapshot, generate one grant:
- `src: ["*"]` inside this physically/account-isolated Headscale cell;
- `dst`: only current Core-projected node addresses;
- `ip: ["tcp:8792"]`.

The wildcard source does not authorize tool execution. It permits only the Remote Computer private target port inside an already isolated single-account cell; Core sessions/tool grants/operation journal and target Host account+deviceSecret authorization remain mandatory. A cell containing bindings from multiple Fabushi accounts fails closed and retains deny-all policy.

Policy replacement is atomic. A failed fetch/validation/render must never replace the last known policy with a broader rule.

## Verification

GitHub Actions only:
- pure projection tests cover empty deny-all, valid single-account output, mixed-account rejection, stale/invalid/duplicate nodes, unexpected fields, token separation and exact TCP port;
- Headscale 0.29.5 config validation consumes the generated policy fixture;
- exact tested source SHA is recorded.

This code/CI slice does not count as G02/G03/G05 production acceptance until a real approved coordinator deployment proves Core snapshot consumption, account isolation, revoke/generation rotation and real tool calls over WireGuard direct and DERP.
