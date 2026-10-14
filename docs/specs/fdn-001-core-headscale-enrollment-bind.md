# FDN-001 Core to Headscale enrollment and binding

Status: implementation in progress.
Owner: Fabushi Backend / FDN network coordinator.
Parent: FDN-001.

## Goal

Redeem a Core-issued one-time network enrollment grant, mint exactly one bounded Headscale 0.29.5 pre-auth key, correlate the resulting Headscale node to that exact key, and bind the coordinator-observed node identity back into Platform Core without trusting target-supplied account, cell, generation, IP, hostname, or node identifiers.

## Authority boundaries

Core is authoritative for userId, deviceId, cellId, generation, expiry and revoke. Backend alone owns FDN_NETWORK_AUTHORITY_TOKEN and Headscale administrative access. The caller supplies only grantId and grantSecret. Official MCP credentials, device names, IPs, hostnames, and self-reported node IDs are never enrollment authority.

## Start

The coordinator owner consumes only {grantId, grantSecret}. It records a domain-separated secret digest, redeems Core, requires the Core-derived cell to match the configured cell, invokes the existing bounded 0.29.5 mint owner, resolves the exact minted preAuthKey id, and persists the redeemed Core projection plus encrypted key material. A Core redeem timeout is redeem_outcome_unknown and never causes blind re-redemption or a second key mint.

## Complete

Completion consumes only {grantId}. It lists Headscale nodes and selects exactly one node whose preAuthKey.id equals the journaled key id. It derives nodeId from the node's allocated Tailscale address, computes a domain-separated proof over Core identity/generation and coordinator-observed Headscale identity, then calls Core network-bind. A bind timeout is bind_outcome_unknown; reconciliation uses Core cell snapshot and only accepts the exact userId/deviceId/cellId/generation/nodeId tuple.

## Security

Raw Core grant secrets are never persisted. Recoverable Headscale keys are AES-256-GCM encrypted with FABUSHI_FDN_ENROLLMENT_STATE_KEY_B64, state is atomically replaced with mode 0600, and successful completion erases ciphertext. No secret is logged or written into policy files.

## Verification

GitHub Actions only. Tests cover strict input shape, one-key behavior, uncertain redemption, exact preAuthKey-to-node correlation, CGNAT/ULA validation, deterministic proof, Core bind identity validation, reconciliation, encrypted key recovery and erasure. Headscale remains pinned to 0.29.5.

This is a G02 prerequisite only; G02/G03/G05 require real cross-account and transport E2E evidence.
