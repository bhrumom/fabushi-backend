# Fabushi Unified Extension Registry v1 — Backend Implementation Slice

Status: active implementation slice  
Parent product spec: `bhrumom/fabushi-desktop/docs/specs/fabushi-plugins-marketplace-open-ecosystem.md` (FPM-001)  
Related: OMA-001, `docs/specs/fabushi-official-mcp-oauth.md`  
Owner: existing Fabushi Backend MiniApp/Plugins Marketplace domain  
Date: 2026-10-11

## Goal

Establish the first production-compatible **single product contract** for Fabushi Marketplace discovery without creating a second marketplace, installer, account database, MCP runtime, or permission owner.

The backend will expose a versioned, strict, read-only Extension Registry projection over existing shipping authorities:

- existing `MiniAppMarketplace` approved manifests;
- existing `officialMcpApps` catalog;
- existing account/install/OAuth flows remain unchanged.

This slice is **not** the complete FPM-001 implementation.

## Requirements

### FPM-BE-R01 — Stable typed identity

Every projected entry has:

- `kind`: `mcp-connector | skill | web-miniapp`;
- `identity.namespace`, `identity.name`, `identity.kind`;
- stable `id = <namespace>/<name>:<kind>`;
- `origin = public | team | private-created`;
- `trustDomain = catalog-authorized | team-authorized | private-local-author`;
- version/release channel/platform compatibility;
- requested capabilities;
- publisher verification represented only from evidence available to this owner.

Unknown enum values fail closed.

### FPM-BE-R02 — Existing-owner adaptation

- Approved `MiniAppMarketplace` manifests project to `web-miniapp`.
- Backend-owned `officialMcpApps` project to `mcp-connector`.
- This slice does not fabricate Skills; if no backend-owned Skill catalog source exists, `kind=skill` returns an empty result.
- Existing `/v1/marketplace/*`, MCP, OAuth, account sync and install writes remain authoritative and unchanged.

### FPM-BE-R03 — Browse/detail API

Add:

- `GET /v1/extensions`
- `GET /v1/extensions/:kind/:namespace/:name`

Browse supports `q`, `kind`, `platform`, `origin`, `limit`, `cursor`.

Pagination is deterministic over stable identity sort keys. Invalid cursors, kinds, origins and platforms are rejected instead of silently broadened.

### FPM-BE-R04 — No fabricated marketplace metrics

The response must not invent ratings, installs, publisher verification, moderation or security badges. Optional evidence fields are omitted when this backend cannot prove them.

### FPM-BE-R05 — Compatibility and migration metadata

Each adapter emits legacy identifiers so Desktop/iOS/Android can migrate existing `pluginId/serverId` references without changing installation truth in this slice.

### FPM-BE-R06 — Security

- Public registry responses contain no OAuth token, secret, API key, account credential or private installation data.
- MCP runtime endpoints remain server-owned references, not executable Renderer/WebView code.
- Unknown schema versions and unsafe identity components fail closed.

## Non-goals for this slice

- Publisher namespace claim/write APIs.
- Artifact upload/signing/scanning/moderation implementation.
- Ratings/reviews/install-count backend.
- New client UI.
- Mini App package installer.
- AI creation/install flow.
- Replacing current MiniApp install state or official MCP OAuth paths.
- Claiming FPM-001 acceptance.

## Owner map

| Responsibility | Existing owner used |
| --- | --- |
| Mini App approved catalog | `ai-backend/src/miniapp_marketplace*.js` |
| Official MCP app list/runtime | `ai-backend/src/official_mcp_apps.js` |
| Account install truth | `AccountSyncStore` + existing MiniApp marketplace compatibility store |
| MCP OAuth/runtime | existing official MCP / platform broker path |
| Unified browse projection | new minimal adapter under the same Backend Marketplace domain |

## Verification

GitHub Actions only.

Required tests:

1. strict enum/schema rejection;
2. stable identity and deterministic cursor pagination;
3. Mini App → `web-miniapp` projection;
4. official MCP → `mcp-connector` projection;
5. kind/platform/origin filters;
6. skill filter does not fabricate entries;
7. detail lookup;
8. response secret scan;
9. existing MiniApp Marketplace tests remain green.

## Acceptance for this slice

This slice is accepted only when the exact branch HEAD has a successful GitHub Actions job running the new contract tests plus relevant existing MiniApp Marketplace tests. It must not be described as complete FPM-001, complete Registry, or release acceptance.
