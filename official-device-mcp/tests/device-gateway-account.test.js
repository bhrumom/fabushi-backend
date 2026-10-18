import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import {
  attachDeviceGateway,
  callRegisteredDevice,
  createAuthenticatedReverseWebSocketPrivateTransport,
  listRegisteredDevices,
  registerDeviceTools,
  resetDeviceGatewayStateForTests,
  stableCallDigest,
} from "../lib/device-gateway.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function opened(ws) {
  return new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function nextJson(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (raw) => {
      try { resolve(JSON.parse(raw.toString("utf8"))); } catch (error) { reject(error); }
    });
    ws.once("error", reject);
  });
}

async function closeServer(server, gateway) {
  await gateway.close();
  await new Promise((resolve) => server.close(resolve));
}

test("device gateway isolates equal device ids by Fabushi account and routes calls", async (t) => {
  resetDeviceGatewayStateForTests();
  const server = createServer((_req, res) => res.writeHead(404).end());
  const gateway = attachDeviceGateway(server, {
    resolveAccount: async (token) => ({
      "token-account-a": { userId: "account:a" },
      "token-account-b": { userId: "account:b" },
    })[token] ?? null,
    defaultLeaseSeconds: 60,
  });
  const port = await listen(server);
  const a = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { Authorization: "Bearer token-account-a" } });
  const b = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { Authorization: "Bearer token-account-b" } });
  t.after(async () => {
    a.terminate();
    b.terminate();
    await closeServer(server, gateway);
    resetDeviceGatewayStateForTests();
  });
  await Promise.all([opened(a), opened(b)]);
  const descriptor = {
    name: "computer_state",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
  };
  a.send(JSON.stringify({ type: "register", deviceId: "runner-1", name: "Runner A", platform: "linux", capabilities: ["computer_state"], tools: [descriptor], metadata: { kind: "github-actions", runId: "11" } }));
  b.send(JSON.stringify({ type: "register", deviceId: "runner-1", name: "Runner B", platform: "linux", capabilities: ["computer_state"], tools: [descriptor], metadata: { kind: "github-actions", runId: "22" } }));
  await Promise.all([nextJson(a), nextJson(b)]);
  assert.equal(listRegisteredDevices("account:a")[0].name, "Runner A");
  assert.equal(listRegisteredDevices("account:b")[0].name, "Runner B");
  assert.equal(listRegisteredDevices("account:a")[0].metadata.runId, "11");
  assert.equal(listRegisteredDevices("account:missing").length, 0);

  a.once("message", (raw) => {
    const call = JSON.parse(raw.toString("utf8"));
    if (call.type === "call") a.send(JSON.stringify({ type: "result", requestId: call.requestId, ok: true, result: { structuredContent: { app: "Fabushi" } } }));
  });
  const result = await callRegisteredDevice("account:a", "runner-1", "computer_state", {});
  assert.deepEqual(result.result.structuredContent, { app: "Fabushi" });
  await assert.rejects(() => callRegisteredDevice("account:b", "runner-1", "missing_tool", {}), /does not expose/);
});

test("device gateway rejects an unrecognized Fabushi account bearer", async (t) => {
  resetDeviceGatewayStateForTests();
  const server = createServer((_req, res) => res.writeHead(404).end());
  const gateway = attachDeviceGateway(server, { resolveAccount: async () => null });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { Authorization: "Bearer bad-token" } });
  t.after(async () => {
    ws.terminate();
    await closeServer(server, gateway);
    resetDeviceGatewayStateForTests();
  });
  const status = await new Promise((resolve) => {
    ws.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    ws.once("error", () => {});
  });
  assert.equal(status, 401);
});

test("browser agent requires the published extension origin and first-frame Fabushi authentication", async (t) => {
  resetDeviceGatewayStateForTests();
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const server = createServer((_req, res) => res.writeHead(404).end());
  const gateway = attachDeviceGateway(server, {
    resolveAccount: async (token) => token === "browser-account-token" ? { userId: "account:browser", label: "Browser User" } : null,
    browserExtensionId: extensionId,
    defaultLeaseSeconds: 60,
  });
  const port = await listen(server);
  const browser = new WebSocket(`ws://127.0.0.1:${port}/browser-agent`, { origin: `chrome-extension://${extensionId}` });
  t.after(async () => {
    browser.terminate();
    await closeServer(server, gateway);
    resetDeviceGatewayStateForTests();
  });
  await opened(browser);
  browser.send(JSON.stringify({ type: "authenticate", accessToken: "browser-account-token" }));
  assert.deepEqual(await nextJson(browser), { type: "authenticated", accountLabel: "Browser User" });
  browser.send(JSON.stringify({
    type: "register",
    deviceId: "chrome-profile-1",
    name: "Chrome",
    platform: "chrome-extension",
    capabilities: ["list_tabs"],
    tools: [{ name: "list_tabs", inputSchema: { type: "object" }, outputSchema: { type: "object" } }],
  }));
  assert.equal((await nextJson(browser)).type, "registered");
  assert.equal(listRegisteredDevices("account:browser")[0].id, "chrome-profile-1");
  assert.equal(listRegisteredDevices("account:other").length, 0);

  browser.once("message", (raw) => {
    const call = JSON.parse(raw.toString("utf8"));
    if (call.type === "call") browser.send(JSON.stringify({ type: "result", requestId: call.requestId, ok: true, result: { structuredContent: { tabs: [] } } }));
  });
  const routed = await callRegisteredDevice("account:browser", "chrome-profile-1", "list_tabs", {});
  assert.deepEqual(routed.result.structuredContent, { tabs: [] });
  await assert.rejects(() => callRegisteredDevice("account:other", "chrome-profile-1", "list_tabs", {}), /Unknown device/);

  const wrongOrigin = new WebSocket(`ws://127.0.0.1:${port}/browser-agent`, { origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba" });
  const status = await new Promise((resolve) => {
    wrongOrigin.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    wrongOrigin.once("error", () => {});
  });
  assert.equal(status, 403);
});

test("device reconnect rejects calls that were bound to the previous socket generation", async (t) => {
  resetDeviceGatewayStateForTests();
  const server = createServer((_req, res) => res.writeHead(404).end());
  const gateway = attachDeviceGateway(server, {
    resolveAccount: async (token) => token === "token-account-a" ? { userId: "account:a" } : null,
    defaultLeaseSeconds: 60,
  });
  const port = await listen(server);
  const first = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { Authorization: "Bearer token-account-a" } });
  let replacement = null;
  t.after(async () => {
    first.terminate();
    replacement?.terminate();
    await closeServer(server, gateway);
    resetDeviceGatewayStateForTests();
  });
  await opened(first);
  const descriptor = { name: "computer_state", inputSchema: { type: "object" }, outputSchema: { type: "object" } };
  first.send(JSON.stringify({
    type: "register",
    deviceId: "runner-reconnect",
    name: "First generation",
    platform: "linux",
    capabilities: ["computer_state"],
    tools: [descriptor],
    secureInputPublicKey: { kty: "EC", crv: "P-256", x: "a".repeat(43), y: "b".repeat(43) },
  }));
  await nextJson(first);
  assert.equal(listRegisteredDevices("account:a")[0].secureInputPublicKey.crv, "P-256");

  const pendingRejection = assert.rejects(
    callRegisteredDevice("account:a", "runner-reconnect", "computer_state", {}, 30),
    /reconnected/,
  );
  const outbound = await nextJson(first);
  assert.equal(outbound.type, "call");

  replacement = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { Authorization: "Bearer token-account-a" } });
  await opened(replacement);
  replacement.send(JSON.stringify({
    type: "register",
    deviceId: "runner-reconnect",
    name: "Second generation",
    platform: "linux",
    capabilities: ["computer_state"],
    tools: [descriptor],
  }));
  await nextJson(replacement);
  await pendingRejection;
  assert.equal(listRegisteredDevices("account:a")[0].name, "Second generation");
});

test("device gateway keeps the registered socket alive when async audit rejects", async (t) => {
  resetDeviceGatewayStateForTests();
  const server = createServer((_req, res) => res.writeHead(404).end());
  const gateway = attachDeviceGateway(server, {
    resolveAccount: async (token) => token === "token-account-a" ? { userId: "account:a" } : null,
    audit: async () => { throw new Error("simulated ENOSPC"); },
    defaultLeaseSeconds: 60,
  });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { Authorization: "Bearer token-account-a" } });
  t.after(async () => {
    ws.terminate();
    await closeServer(server, gateway);
    resetDeviceGatewayStateForTests();
  });
  await opened(ws);
  ws.send(JSON.stringify({
    type: "register",
    deviceId: "audit-rejection-device",
    name: "Audit rejection device",
    platform: "android",
    capabilities: ["fabushi.app.status"],
  }));
  const registered = await nextJson(ws);
  assert.equal(registered.type, "registered");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal(listRegisteredDevices("account:a")[0].status, "online");
});

test("device discovery hides every disconnected device and drops ephemeral GitHub runners immediately", async (t) => {
  resetDeviceGatewayStateForTests();
  const server = createServer((_req, res) => res.writeHead(404).end());
  const gateway = attachDeviceGateway(server, {
    resolveAccount: async (token) => token === "live-account-token" ? { userId: "account:live" } : null,
    defaultLeaseSeconds: 60,
  });
  const port = await listen(server);
  const descriptor = { name: "vps_status", inputSchema: { type: "object" }, outputSchema: { type: "object" } };
  const persistent = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { Authorization: "Bearer live-account-token" } });
  const ephemeral = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { Authorization: "Bearer live-account-token" } });
  t.after(async () => {
    persistent.terminate();
    ephemeral.terminate();
    await closeServer(server, gateway);
    resetDeviceGatewayStateForTests();
  });
  await Promise.all([opened(persistent), opened(ephemeral)]);
  persistent.send(JSON.stringify({
    type: "register",
    deviceId: "mahayana-cli-persistent",
    name: "Mahayana CLI",
    platform: "linux",
    capabilities: ["vps_status"],
    tools: [descriptor],
    metadata: { kind: "mahayana-cli" },
  }));
  ephemeral.send(JSON.stringify({
    type: "register",
    deviceId: "gha-123-1-cli",
    name: "GitHub Actions CLI",
    platform: "linux",
    capabilities: ["vps_status"],
    tools: [descriptor],
    metadata: { kind: "github-actions", runId: "123" },
  }));
  await Promise.all([nextJson(persistent), nextJson(ephemeral)]);
  assert.deepEqual(listRegisteredDevices("account:live").map((device) => device.id).sort(), ["gha-123-1-cli", "mahayana-cli-persistent"]);

  const persistentClosed = new Promise((resolve) => persistent.once("close", resolve));
  persistent.close();
  await persistentClosed;
  assert.deepEqual(listRegisteredDevices("account:live").map((device) => device.id), ["gha-123-1-cli"]);
  await assert.rejects(() => callRegisteredDevice("account:live", "mahayana-cli-persistent", "vps_status", {}), /offline/);

  const ephemeralClosed = new Promise((resolve) => ephemeral.once("close", resolve));
  ephemeral.close();
  await ephemeralClosed;
  assert.equal(listRegisteredDevices("account:live").length, 0);
  await assert.rejects(() => callRegisteredDevice("account:live", "gha-123-1-cli", "vps_status", {}), /Unknown device/);
});


test("iOS device registration strictly projects PushKit token and explicit logout revokes it", async (t) => {
  resetDeviceGatewayStateForTests();
  const server = createServer((_req, res) => res.writeHead(404).end());
  const syncs = [];
  const gateway = attachDeviceGateway(server, {
    resolveAccount: async (token) => token === "ios-account-token" ? { userId: "account:ios" } : null,
    syncHumanCallVoIPDevice: async (record) => {
      syncs.push({ accountId: record.accountId, deviceId: record.deviceId, token: record.token });
    },
    defaultLeaseSeconds: 60,
  });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, {
    headers: { Authorization: "Bearer ios-account-token" },
  });
  t.after(async () => {
    ws.terminate();
    await closeServer(server, gateway);
    resetDeviceGatewayStateForTests();
  });
  await opened(ws);
  const token = "ab".repeat(32);
  ws.send(JSON.stringify({
    type: "register",
    deviceId: "ios-phone-1",
    name: "Fabushi iPhone",
    platform: "ios",
    capabilities: ["fabushi.app.status"],
    metadata: { kind: "fabushi-ios", humanCallVoIPToken: token },
  }));
  assert.equal((await nextJson(ws)).type, "registered");
  assert.deepEqual(syncs, [{ accountId: "account:ios", deviceId: "ios-phone-1", token }]);
  const listed = listRegisteredDevices("account:ios")[0];
  assert.equal(listed.metadata.kind, "fabushi-ios");
  assert.equal(Object.hasOwn(listed.metadata, "humanCallVoIPToken"), false);

  ws.send(JSON.stringify({ type: "unregister", reason: "logout" }));
  assert.equal((await nextJson(ws)).type, "unregistered");
  assert.deepEqual(syncs[1], { accountId: "account:ios", deviceId: "ios-phone-1", token: null });
  assert.equal(listRegisteredDevices("account:ios").length, 0);
});

test("iOS device registration rejects malformed PushKit tokens before persistence", async (t) => {
  resetDeviceGatewayStateForTests();
  const server = createServer((_req, res) => res.writeHead(404).end());
  let syncCount = 0;
  const gateway = attachDeviceGateway(server, {
    resolveAccount: async () => ({ userId: "account:ios" }),
    syncHumanCallVoIPDevice: async () => { syncCount += 1; },
    defaultLeaseSeconds: 60,
  });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, {
    headers: { Authorization: "Bearer valid-account-token-that-is-long" },
  });
  t.after(async () => {
    ws.terminate();
    await closeServer(server, gateway);
    resetDeviceGatewayStateForTests();
  });
  await opened(ws);
  const closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
  ws.send(JSON.stringify({
    type: "register",
    deviceId: "ios-phone-bad",
    name: "Fabushi iPhone",
    platform: "ios",
    capabilities: ["fabushi.app.status"],
    metadata: { kind: "fabushi-ios", humanCallVoIPToken: "not-hex" },
  }));
  assert.equal(await closed, 1008);
  assert.equal(syncCount, 0);
  assert.equal(listRegisteredDevices("account:ios").length, 0);
});


test("official device_call binds one stable requestId to the Core journal and target frame", async (t) => {
  resetDeviceGatewayStateForTests();
  const server = createServer((_req, res) => res.writeHead(404).end());
  const gateway = attachDeviceGateway(server, {
    resolveAccount: async (token) => token === "journal-account-token" ? { userId: "account:journal" } : null,
    defaultLeaseSeconds: 60,
  });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { Authorization: "Bearer journal-account-token" } });
  t.after(async () => {
    ws.terminate();
    await closeServer(server, gateway);
    resetDeviceGatewayStateForTests();
  });
  await opened(ws);
  ws.send(JSON.stringify({
    type: "register",
    deviceId: "journal-device",
    name: "Journal device",
    platform: "linux",
    capabilities: ["computer_state"],
    tools: [{ name: "computer_state", inputSchema: { type: "object" }, outputSchema: { type: "object" } }],
  }));
  await nextJson(ws);

  const handlers = new Map();
  const mcp = { registerTool(name, _definition, handler) { handlers.set(name, handler); } };
  const journalEvents = [];
  registerDeviceTools(mcp, {
    accountId: "account:journal",
    operationJournal: {
      async create(record) {
        journalEvents.push({ type: "create", ...record });
        return { operationId: "op-1" };
      },
      async complete(record) {
        journalEvents.push({ type: "complete", ...record });
      },
      async outcomeUnknown(record) {
        journalEvents.push({ type: "outcome_unknown", ...record });
      },
    },
    requireOperationJournal: true,
  });

  let targetFrame = null;
  ws.once("message", (raw) => {
    targetFrame = JSON.parse(raw.toString("utf8"));
    ws.send(JSON.stringify({
      type: "result",
      requestId: targetFrame.requestId,
      ok: true,
      result: { structuredContent: { app: "Fabushi" } },
    }));
  });
  const reply = await handlers.get("device_call")({
    deviceId: "journal-device",
    toolName: "computer_state",
    argumentsJson: "{}",
    diskPreflight: { impact: "none", reason: "state query has no material disk growth", targets: [] },
  });
  assert.equal(reply.structuredContent.status, "completed");
  assert.match(reply.structuredContent.requestId, /^[a-f0-9]{32}$/u);
  assert.equal(targetFrame.requestId, reply.structuredContent.requestId);
  assert.equal(targetFrame.toolName, "computer_state");
  assert.deepEqual(Object.keys(targetFrame).sort(), ["arguments", "diskPreflight", "requestId", "toolName", "type"].sort());
  assert.equal(journalEvents[0].type, "create");
  assert.equal(journalEvents[0].accountId, "account:journal");
  assert.equal(journalEvents[0].deviceId, "journal-device");
  assert.equal(journalEvents[0].toolName, "computer_state");
  assert.equal(journalEvents[0].requestId, targetFrame.requestId);
  assert.match(journalEvents[0].requestSha256, /^[a-f0-9]{64}$/u);
  assert.equal(journalEvents[1].type, "complete");
  assert.equal(journalEvents[1].requestId, targetFrame.requestId);
});

test("official device_call reports disconnect after dispatch as outcome_unknown and never falls back without required Core journal", async (t) => {
  resetDeviceGatewayStateForTests();
  const server = createServer((_req, res) => res.writeHead(404).end());
  const gateway = attachDeviceGateway(server, {
    resolveAccount: async (token) => token === "unknown-account-token" ? { userId: "account:unknown" } : null,
    defaultLeaseSeconds: 60,
  });
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`, { headers: { Authorization: "Bearer unknown-account-token" } });
  t.after(async () => {
    ws.terminate();
    await closeServer(server, gateway);
    resetDeviceGatewayStateForTests();
  });
  await opened(ws);
  ws.send(JSON.stringify({
    type: "register",
    deviceId: "unknown-device",
    name: "Unknown device",
    platform: "linux",
    capabilities: ["computer_state"],
    tools: [{ name: "computer_state", inputSchema: { type: "object" }, outputSchema: { type: "object" } }],
  }));
  await nextJson(ws);

  const handlers = new Map();
  const mcp = { registerTool(name, _definition, handler) { handlers.set(name, handler); } };
  registerDeviceTools(mcp, { accountId: "account:unknown", requireOperationJournal: true });
  const blocked = await handlers.get("device_call")({
    deviceId: "unknown-device",
    toolName: "computer_state",
    argumentsJson: "{}",
    diskPreflight: { impact: "none", reason: "state query has no material disk growth", targets: [] },
  });
  assert.equal(blocked.structuredContent.status, "failed");
  assert.match(blocked.structuredContent.resultJson, /Core operation journal is required/u);

  const journalEvents = [];
  handlers.clear();
  registerDeviceTools(mcp, {
    accountId: "account:unknown",
    requireOperationJournal: true,
    operationJournal: {
      async create(record) { journalEvents.push({ type: "create", ...record }); return { operationId: "op-unknown" }; },
      async complete(record) { journalEvents.push({ type: "complete", ...record }); },
      async outcomeUnknown(record) { journalEvents.push({ type: "outcome_unknown", ...record }); },
    },
  });
  ws.once("message", () => ws.close());
  const unknown = await handlers.get("device_call")({
    deviceId: "unknown-device",
    toolName: "computer_state",
    argumentsJson: "{}",
    diskPreflight: { impact: "none", reason: "state query has no material disk growth", targets: [] },
  });
  assert.equal(unknown.structuredContent.status, "outcome_unknown");
  assert.equal(journalEvents.some((event) => event.type === "complete"), false);
  const unknownEvent = journalEvents.find((event) => event.type === "outcome_unknown");
  assert.equal(unknownEvent.requestId, unknown.structuredContent.requestId);
});


test("production device_call authority can be injected independently of the in-memory registry", async () => {
  resetDeviceGatewayStateForTests();
  const handlers = new Map();
  const mcp = { registerTool(name, _definition, handler) { handlers.set(name, handler); } };
  const calls = [];
  registerDeviceTools(mcp, {
    accountId: "account:core",
    requireOperationJournal: true,
    operationJournal: {
      async create(record) { return { operationId: "core-op", ...record }; },
      async complete() {},
      async outcomeUnknown() {},
    },
    listDevices: async () => [{
      id: "core-device",
      name: "Core device",
      platform: "linux",
      status: "online",
      lastSeen: new Date().toISOString(),
      expiresAt: null,
      metadata: {},
      secureInputPublicKey: null,
      capabilities: ["computer_state"],
      toolSchemaCount: 1,
      toolSchemaVersion: "core-projection-v1",
    }],
    describeDeviceTool: async (_accountId, deviceId, toolName) => ({
      deviceId,
      toolName,
      available: true,
      schemaVersion: "core-projection-v1",
      tool: { name: toolName, inputSchema: { type: "object" }, outputSchema: { type: "object" } },
      message: "Core-authorized projection.",
    }),
    callDevice: async (accountId, deviceId, toolName, args, _timeoutSeconds, _diskPreflight, options) => {
      calls.push({ accountId, deviceId, toolName, args, options });
      return { ok: true, result: { structuredContent: { source: "core-authorized-transport" } } };
    },
  });

  const listed = await handlers.get("list_devices")({});
  assert.equal(listed.structuredContent.devices[0].id, "core-device");

  const reply = await handlers.get("device_call")({
    deviceId: "core-device",
    toolName: "computer_state",
    argumentsJson: "{}",
    diskPreflight: { impact: "none", reason: "state query has no material disk growth", targets: [] },
  });
  assert.equal(reply.structuredContent.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].accountId, "account:core");
  assert.equal(calls[0].deviceId, "core-device");
  assert.match(calls[0].options.requestId, /^[a-f0-9]{32}$/u);
  assert.match(calls[0].options.requestSha256, /^[a-f0-9]{64}$/u);
  assert.equal(calls[0].options.journalContext.operationId, "core-op");
  assert.deepEqual(listRegisteredDevices("account:core"), []);
});


test("operation request digest is canonical across object key order", () => {
  const preflightA = { impact: "none", reason: "no growth", targets: [] };
  const preflightB = { targets: [], reason: "no growth", impact: "none" };
  const left = stableCallDigest("computer_state", {
    z: 1,
    nested: { b: 2, a: 1 },
    list: [{ y: 2, x: 1 }],
  }, preflightA);
  const right = stableCallDigest("computer_state", {
    list: [{ x: 1, y: 2 }],
    nested: { a: 1, b: 2 },
    z: 1,
  }, preflightB);
  assert.match(left, /^[a-f0-9]{64}$/u);
  assert.equal(left, right);
  assert.notEqual(left, stableCallDigest("computer_state", {
    list: [{ x: 1, y: 2 }],
    nested: { a: 1, b: 3 },
    z: 1,
  }, preflightA));
});


test("authenticated reverse-WebSocket FDN fallback is account-scoped and requires explicit target opt-in", async (t) => {
  resetDeviceGatewayStateForTests();
  const server = createServer((_req, res) => res.writeHead(404).end());
  const gateway = attachDeviceGateway(server, {
    resolveAccount: async (token) => ({
      "token-fdn-a": { userId: "account:fdn-a" },
      "token-fdn-b": { userId: "account:fdn-b" },
    })[token] ?? null,
    defaultLeaseSeconds: 60,
  });
  const port = await listen(server);
  const optedIn = new WebSocket(`ws://127.0.0.1:${port}/agent`, {
    headers: { Authorization: "Bearer token-fdn-a" },
  });
  const ordinary = new WebSocket(`ws://127.0.0.1:${port}/agent`, {
    headers: { Authorization: "Bearer token-fdn-a" },
  });
  t.after(async () => {
    optedIn.terminate();
    ordinary.terminate();
    await closeServer(server, gateway);
    resetDeviceGatewayStateForTests();
  });
  await Promise.all([opened(optedIn), opened(ordinary)]);
  optedIn.send(JSON.stringify({
    type: "register",
    deviceId: "fdn-target-1",
    name: "FDN target",
    platform: "linux",
    capabilities: ["fabushi-fdn-private-transport"],
    tools: [],
    leaseSeconds: 60,
  }));
  ordinary.send(JSON.stringify({
    type: "register",
    deviceId: "ordinary-target-1",
    name: "Ordinary target",
    platform: "linux",
    capabilities: ["computer_state"],
    tools: [],
    leaseSeconds: 60,
  }));
  await Promise.all([nextJson(optedIn), nextJson(ordinary)]);

  let privateDispatches = 0;
  optedIn.on("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type !== "fdnPrivate") return;
    privateDispatches += 1;
    optedIn.send(JSON.stringify({
      type: "fdnPrivateResult",
      requestId: message.requestId,
      ok: true,
      result: {
        type: "controllerGranted",
        deviceId: "fdn-target-1",
        networkGeneration: message.payload.networkGeneration,
      },
    }));
  });

  const transport = createAuthenticatedReverseWebSocketPrivateTransport();
  const result = await transport.request({
    accountId: "account:fdn-a",
    deviceId: "fdn-target-1",
    networkGeneration: 9,
    payload: { type: "grantController", deviceId: "fdn-target-1", networkGeneration: 9 },
    timeoutSeconds: 5,
  });
  assert.equal(result.type, "controllerGranted");
  assert.equal(result.deviceId, "fdn-target-1");
  assert.equal(result.networkGeneration, 9);
  assert.equal(privateDispatches, 1);

  await assert.rejects(
    () => transport.request({
      accountId: "account:fdn-b",
      deviceId: "fdn-target-1",
      payload: { type: "grantController", deviceId: "fdn-target-1", networkGeneration: 9 },
      timeoutSeconds: 5,
    }),
    /Unknown device/u,
  );
  await assert.rejects(
    () => transport.request({
      accountId: "account:fdn-a",
      deviceId: "ordinary-target-1",
      payload: { type: "grantController", deviceId: "fdn-target-1", networkGeneration: 9 },
      timeoutSeconds: 5,
    }),
    /has not opted into the authenticated FDN reverse-WebSocket fallback/u,
  );
});

test("authenticated reverse-WebSocket private transport sends cancellation and rejects the uncertain request", async (t) => {
  resetDeviceGatewayStateForTests();
  const server = createServer((_req, res) => res.writeHead(404).end());
  const gateway = attachDeviceGateway(server, {
    resolveAccount: async (token) => token === "token-fdn-a" ? { userId: "account:fdn-a" } : null,
    defaultLeaseSeconds: 60,
  });
  const port = await listen(server);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/agent`, {
    headers: { Authorization: "Bearer token-fdn-a" },
  });
  t.after(async () => {
    socket.terminate();
    await closeServer(server, gateway);
    resetDeviceGatewayStateForTests();
  });
  await opened(socket);
  socket.send(JSON.stringify({
    type: "register",
    deviceId: "fdn-cancel-target",
    name: "FDN cancel target",
    platform: "linux",
    capabilities: ["fabushi-fdn-private-transport"],
    tools: [],
    leaseSeconds: 60,
  }));
  await nextJson(socket);
  const received = [];
  socket.on("message", raw => received.push(JSON.parse(raw.toString("utf8"))));
  const controller = new AbortController();
  const transport = createAuthenticatedReverseWebSocketPrivateTransport();
  const pending = transport.request({
    accountId: "account:fdn-a",
    deviceId: "fdn-cancel-target",
    payload: { type: "grantController", deviceId: "fdn-cancel-target", networkGeneration: 9 },
    timeoutSeconds: 5,
    signal: controller.signal,
  });
  while (!received.some(message => message.type === "fdnPrivate")) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  controller.abort();
  await assert.rejects(pending, error => error?.outcomeUnknown === true && /cancelled after dispatch/u.test(error.message));
  assert.ok(received.some(message => message.type === "fdnPrivateCancel" && typeof message.requestId === "string"));
});
