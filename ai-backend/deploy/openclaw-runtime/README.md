# OpenClaw Runtime Updates

The Dacheng AI backend serves desktop OpenClaw runtime updates from:

```bash
/opt/dacheng-ai/data/openclaw-runtime
```

Place signed/notarized runtime archives in that directory and publish a `manifest.json` like:

```json
{
  "schema": 1,
  "channel": "stable",
  "generatedAt": "2026-06-20T00:00:00.000Z",
  "latest": {
    "version": "openclaw-embedded-2026.06.3",
    "minAppVersion": "1.0.1",
    "defaultPort": 18789,
    "defaultModel": "openclaw/default",
    "defaultModelOverride": "",
    "gatewayArgs": ["gateway", "--port", "{port}", "--force"],
    "platforms": {
      "macos-arm64": {
        "fileName": "openclaw-embedded-2026.06.3-macos-arm64.zip",
        "sha256": "replace-with-64-char-sha256",
        "size": 0,
        "nodeExecutable": "node/bin/node",
        "cliEntrypoint": "openclaw/openclaw.mjs"
      }
    }
  }
}
```

The public endpoints are:

```bash
GET https://ai.ombhrum.com/api/openclaw/runtime/manifest?platform=macos-arm64
GET https://ai.ombhrum.com/api/openclaw/runtime/files/<archive>
```

The app validates `sha256`, checks that `nodeExecutable` and `cliEntrypoint`
exist after extraction, then switches to the downloaded runtime. If anything
fails, it keeps using the bundled runtime.
