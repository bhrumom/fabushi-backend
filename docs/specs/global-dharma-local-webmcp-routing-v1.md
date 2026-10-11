# Global Dharma Local WebMCP Routing v1

Status: active implementation slice
Parent: FPM-001 / OMA-001
Date: 2026-10-11

## Goal

Allow Fabushi Bot natural-language planning for the installed Global Dharma offline Mini App without routing execution to the legacy remote Global Dharma MCP runtime.

The Backend may suggest a tool only from the **actual active page tool names supplied by the Host**. Tool execution remains owned by the iOS active WKWebView session.

## Compatibility

The historical remote Global Dharma MCP contract (`start`, `stop`, `status`, `send`, etc.) remains unchanged for callers that use that remote runtime. This Spec adds a separate local-WebMCP routing vocabulary and never changes the remote server's registered tools.

## Local tool contract

| Command | Executed tool | Approval | Meaning |
|---|---|---|---|
| `offline_capabilities` | `offline.capabilities` | none | list real offline/protected capabilities |
| `offline_state` | `offline.state.read` | none | read current page-owned persisted state/revision |
| `offline_practice` | `offline.practice.record` | required | perform one free local mutation |
| `prayer_wheel` | `local.prayer-wheel.start` | required | protected local mutation; Host also requires current entitlement |

The local surface is `local-webmcp`, kind `web`, entry `index.html`, local=true, platforms mobile/iOS.

## Route request

`POST /v1/marketplace/plugins/global-dharma/route` may include:

```json
{
  "input": "...",
  "availableTools": ["offline.state.read", "..."]
}
```

When `availableTools` is supplied:
- normalize/deduplicate at most 128 valid tool identifiers;
- for Global Dharma, rank only the local route commands whose exact `tool` is present;
- if no eligible command matches, return no executable dispatch;
- never fall back to a remote Global Dharma tool;
- response execution describes the local web surface/tool and is planning metadata only.

When `availableTools` is absent, existing legacy routing behavior remains unchanged.

## iOS contract

Before routing Global Dharma natural language, iOS must require a current active page tool list and send exactly those names. After receiving a route, iOS must ensure the returned tool remains registered by the active session. The Host then performs per-tool user approval and protected entitlement enforcement before invoking the page implementation.

## Acceptance

- GDR-01 legacy remote Global Dharma tools remain unchanged.
- GDR-02 local routing cannot suggest a tool absent from `availableTools`.
- GDR-03 free state/capability questions map to read-only local tools.
- GDR-04 free local action maps to `offline.practice.record`.
- GDR-05 prayer-wheel maps only to `local.prayer-wheel.start`.
- GDR-06 empty/stale active tool list produces no executable remote fallback.
- GDR-07 exact-head Backend CI passes.
