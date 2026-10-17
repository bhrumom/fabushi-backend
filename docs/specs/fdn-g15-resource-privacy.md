# FDN-001 G15 resource and privacy evidence

This change is a bounded G15 resource/privacy slice for the production-owned
`official-device-network-worker` and its official MCP/network coordinator
composition. It is not G03, G05, G09, G16, and it does not turn PR evidence into
Backend current-main evidence.

## Frozen product budgets

The authoritative Desktop FDN-001 specification requires all of the following
without relaxation:

- idle network-worker steady-state RSS below 150 MiB;
- five-minute mean CPU below 1% of one core;
- per-component log growth bounded to 20 MiB for this acceptance fixture;
- peak-space safety leaving at least `max(1 GiB, 5% of filesystem capacity)`;
- bounded Fabushi-owned state/cache rather than unbounded accumulation;
- explicit approved outbound destinations and no undeclared telemetry;
- no secrets in logs or evidence artifacts.

The existing official MCP disk preflight remains the production write gate and
continues to preserve `max(1 GiB, 5%)`. This slice does not weaken it.

## Production owners

- `official-device-network-worker/main.go`: shipping `tsnet.Server`, with
  Tailscale support logging disabled and no web client.
- `fdn-network-coordinator/config.yaml.template`: production Headscale config;
  external DERP-map URLs are empty, automatic DERP-map updates are disabled,
  Headscale update checks are disabled, and DNS projection is empty.
- `fdn-network-coordinator/systemd/fabushi-fdn-network-worker.service`: shipping
  service sandbox. This slice adds a hard 150 MiB service memory ceiling and a
  bounded task count while preserving the existing only-owned-state writable
  path `/var/lib/fabushi-fdn`.
- `official-device-mcp/lib/device-disk-safety.js`: existing production
  filesystem reserve enforcement.

## Actions-only measurement

`.github/workflows/fdn-g15-resource-privacy.yml` builds the exact shipping Go
worker and runs `.github/scripts/fdn-g15-resource-privacy.sh` only in GitHub
Actions.

The probe starts the pinned real Headscale
`docker.io/headscale/headscale:0.29.5` and registers the pinned shipping
Tailscale `v1.104.1` worker against it. This is not a mocked transport. After
warm-up, the job samples the real worker every five seconds for five minutes and
fails if any frozen budget is exceeded.

For the isolated Actions fixture, the worker process runs as a dedicated uid.
Owner-based IPv4/IPv6 OUTPUT rules allow only loopback, where the real pinned
Headscale control server is running. Any attempted worker-owned packet to another
destination is rejected and counted; a non-zero count fails the gate. This is a
strict test fixture for undeclared telemetry/egress. Production's approved
control origin remains `https://fdn.ombhrum.com`.

Because Tailscale port mapping normally probes local gateways using UPnP,
NAT-PMP, or PCP as part of legitimate NAT traversal, the loopback-only G15
fixture sets `TS_DISABLE_PORTMAPPER=true` for the worker process. This is an
Actions-fixture isolation knob only: it prevents G05 NAT-traversal traffic from
being misclassified as undeclared privacy egress, does not change production
worker behavior, and does not relax the zero unexpected-egress requirement.
Real direct/DERP/fallback route evidence remains owned by G05.

The artifact contains only bounded status/resource data, the worker log, and
SHA-256 checksums. The job fails on the live pre-auth key or common bearer/token
and private-key patterns in evidence.

## Evidence promotion rule

A pull-request success is bounded PR evidence only. It may be promoted to
current-main G15 resource/privacy evidence only after repository-protected merge,
re-reading the new Backend main SHA, and obtaining a successful exact-main run
with its run ID, job ID, artifact ID and artifact digest.
