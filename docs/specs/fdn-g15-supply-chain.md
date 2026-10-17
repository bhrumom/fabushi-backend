# FDN-001 G15 supply-chain evidence

Status: implementation contract.
Owner: Fabushi Backend CI.
Parent authority: `bhrumom/fabushi-desktop/docs/specs/fabushi-same-account-device-network.md` (FDN-001).

## Goal

Produce a secret-free, exact-source, fail-closed supply-chain evidence slice for the
Backend-owned parts of FDN-001 without claiming the complete G15, G03, G05, G09 or
G16 gates.

This slice covers the production dependency graphs used by:

- `official-device-mcp`;
- `official-device-network-worker`;
- the pinned Headscale coordinator image in `fdn-network-coordinator`.

## Authority and non-goals

The existing Fabushi account, Platform Core Remote Computer, Host/Coordinator and
official MCP ownership boundaries remain unchanged. This CI must not add a device
registry, an authorization path, a transport fallback, a runtime secret, or a mock
device.

Passing this workflow is bounded G15 supply-chain evidence only. It is not real
cross-account isolation, direct/DERP/WSS transport, official MCP-to-device execution,
native-device acceptance, signed installer acceptance, performance acceptance, or a
release promotion.

## Requirements

### Exact source and toolchain

- The workflow must run on `pull_request`, `push` to `main`, and
  `workflow_dispatch`.
- Checkout must bind to the exact event SHA and fail if `git rev-parse HEAD` differs.
- Every GitHub Action used by this workflow must be pinned by a full 40-hex commit SHA.
- Node is pinned to `24.22.0`.
- Go must use the exact `go 1.27.1` declared by the worker module and
  `GOTOOLCHAIN=local`; CI must not silently download a different Go toolchain.

### npm production graph

- `npm ci --ignore-scripts` must consume the committed lockfile without mutation.
- Every production lock entry must have an exact version, an integrity digest, an
  HTTPS resolved source, and a known allowed license.
- The installed production graph must pass `npm ls --omit=dev --all`.
- `npm audit --omit=dev --audit-level=low` must report zero production
  vulnerabilities. Network/audit-service errors fail closed rather than being ignored.
- Allowed npm licenses are MIT, BSD-2-Clause, BSD-3-Clause, ISC, Apache-2.0,
  MPL-2.0, 0BSD, CC0-1.0 and Boost-1.0. Strong-copyleft-only, source-available-only,
  missing and unknown licenses fail.

### Go/Tailscale graph

- `go mod download all`, `go mod verify`, and readonly graph/package listing must
  succeed without changing `go.mod` or `go.sum`.
- `replace` directives are forbidden in this production worker module.
- Every non-main module must have an exact version and a resolved module directory.
- `tailscale.com` must remain exactly `v1.104.1` with matching `go.sum`
  entries.
- Every module must expose a recognizable license in its module root. A permissive
  license option is required; GPL/AGPL/LGPL/SSPL/Commons-Clause/Elastic/Business-
  Source-only or unknown licensing fails closed.

### Headscale, SBOM and provenance

- Coordinator source must remain exactly `docker.io/headscale/headscale:0.29.5`
  and must reject floating `latest`, `stable` and `main` tags.
- CI generates and validates a CycloneDX 1.6 JSON SBOM containing the real npm
  production graph and real readonly Go module graph.
- CI emits license reports, audit output, dependency inventories, SHA-256 checksums
  and a source-bound provenance manifest.
- The evidence directory is uploaded as a GitHub Actions artifact. The workflow
  records the GitHub artifact ID/digest and creates both signed SLSA build-provenance
  and CycloneDX SBOM attestations for that exact artifact digest via GitHub OIDC.
  No repository or production secret is used.

## Verification

All executable verification occurs in GitHub Actions. The workflow logs must expose:

- exact source SHA;
- exact commands;
- npm production package count and audit vulnerability count;
- Go module/package count and Tailscale pin;
- npm and Go license-scan counts;
- CycloneDX component count;
- artifact ID and digest;
- provenance and SBOM attestation IDs/URLs.

## Acceptance

This bounded slice is `passed` only when a `pull_request` run on the exact PR
HEAD is terminal success and its evidence artifact/digest plus signed attestations
are readable. A failed or skipped scan is not accepted as evidence.

## Rollback

Remove this workflow, verifier and this spec in one reviewed change. Runtime
identity, account data, device records, network state, credentials and deployment
state are untouched by this CI slice.
