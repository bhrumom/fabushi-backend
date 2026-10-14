import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket from "ws";
import {
  attachDeviceGateway,
  callRegisteredDevice,
  listRegisteredDevices,
  resetDeviceGatewayStateForTests,
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
