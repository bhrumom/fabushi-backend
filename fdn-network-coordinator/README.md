# FDN-001 Headscale coordinator cell

This directory is the deployment boundary for one isolated Fabushi FDN network cell.

- Headscale is pinned to **0.29.5**. Do not use `latest`.
- The policy starts at `grants: []` (deny-all). A cell is not usable until the
  existing Fabushi control plane projects current Core bindings into explicit grants.
- Each production cell gets a distinct Headscale state volume and node credentials.
  A node credential or state directory must never be reused across Fabushi accounts/cells.
- Embedded DERP is enabled with client verification and no public Tailscale DERP map.
- Headscale's HTTP listener is expected to sit behind the approved HTTPS ingress;
  admin gRPC and metrics remain loopback-only.
- `render-config.sh` only accepts an HTTPS origin and produces the runtime config.
- This deployment template alone is **not** G02/G03/G05 acceptance. Production
  deployment, Core-driven grant projection, two-account negative tests, real
  WireGuard direct calls and real DERP-relayed calls still require exact-SHA evidence.

## Core-driven policy projection

`project-core-policy.mjs` consumes the Platform Core network-authority-only live
cell snapshot and atomically replaces the Headscale policy. It rejects mixed
Fabushi accounts, expired/malformed/duplicate/non-tailnet nodes, unexpected
fields and oversized snapshots. Empty snapshots remain deny-all. A valid
single-account cell permits only `tcp:8792` to current Core-projected target
nodes; application-layer execution is still authorized by Core/Host.

Production must provide `FABUSHI_CORE_API_BASE_URL`,
`FDN_NETWORK_AUTHORITY_TOKEN`, `FABUSHI_FDN_CELL_ID`, and a writable
`FABUSHI_FDN_POLICY_PATH`. The authority token must be injected as a secret and
must never be placed in command arguments, policy files or logs.

This projection code and CI are prerequisites only. G02/G03/G05 still require
approved production deployment, generation/revoke propagation, two-account
negative evidence and real WireGuard/DERP tool calls.

## Enrollment service lifecycle

`enrollment-service.mjs` is supervised on the coordinator host by
`systemd/fabushi-fdn-enrollment.service`. It remains loopback-only and is not
an additional public device API. The existing ai-backend account proxy is the
product-facing boundary; the service owns only Core network-authority redemption,
Headscale enrollment correlation, and Core node binding.

Production installation requirements:

- run as the dedicated `fabushi-fdn` OS account;
- install `/etc/fabushi/fdn-network-enrollment.env` with mode `0600`;
- keep broker state under `/var/lib/fabushi-fdn` with mode `0700`;
- use a dedicated rootless Docker daemon for the coordinator account and set
  `DOCKER_HOST` to its `/run/user/<uid>/docker.sock`; the launcher rejects the
  rootful system Docker socket;
- use a distinct `FABUSHI_FDN_ENROLLMENT_BROKER_TOKEN`; never reuse the Core
  network-authority token, Fabushi account token, deviceSecret, or MCP service token;
- expose the loopback service only through the approved authenticated internal
  ingress used by ai-backend.

The unit hardens the service with `NoNewPrivileges`, strict filesystem
protection, private temporary/device namespaces, a restrictive umask, and a
single writable state root. It refuses to start unless Headscale is healthy.

This lifecycle wiring is still only a G02 prerequisite. Real production
deployment, enrollment from a signed Fabushi client, cross-account isolation,
WireGuard direct calls, DERP relay calls, and authenticated fallback calls must
be proven separately before G02/G03/G05 can pass.
