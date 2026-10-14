import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { createFabushiRemoteMcpServer } from "../lib/fabushi-remote-mcp-server.js";
import { resetDeviceGatewayStateForTests } from "../lib/device-gateway.js";

function challenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function opened(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function nextJson(socket) {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => {
      try { resolve(JSON.parse(raw.toString("utf8"))); } catch (error) { reject(error); }
    });
    socket.once("error", reject);
  });
}

test("Fabushi remote MCP binds ChatGPT OAuth and Runner devices to one account", async (t) => {
  resetDeviceGatewayStateForTests();
  let browserDeviceId = "";
  const accountClient = {
    async startBrowserLogin({ deviceId }) {
      browserDeviceId = deviceId;
      return {
        attemptId: "attempt-1",
        pollSecret: "poll-secret-1",
        loginUrl: "https://accounts.example.test/login/attempt-1",
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      };
    },
    async pollBrowserLogin(attemptId, pollSecret) {
      assert.equal(attemptId, "attempt-1");
      assert.equal(pollSecret, "poll-secret-1");
      return { status: "completed", session: { accessToken: "session-account-token" } };
    },
    async resolveAccessToken(token) {
      if (!["session-account-token", "runner-account-token"].includes(token)) throw new Error("unauthorized");
      return { userId: "user:test-account", label: "CI Test Account", user: { id: "user:test-account" } };
    },
  };
  const service = createFabushiRemoteMcpServer({
    host: "127.0.0.1",
    port: 0,
    statePath: "",
    auditPath: "",
    accountClient,
    defaultLeaseSeconds: 120,
  });
  const address = await service.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  let device = null;
  let client = null;
  t.after(async () => {
    if (client) await client.close().catch(() => {});
    device?.terminate();
    await service.close();
    resetDeviceGatewayStateForTests();
  });

  const unauthorized = await fetch(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate"), /oauth-protected-resource/);

  const redirectUri = "http://127.0.0.1/callback";
  const registration = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  }).then((response) => response.json());
  assert.match(registration.client_id, /^fabushi_/);

  const verifier = "v".repeat(64);
  const authorizeUrl = new URL(`${origin}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    state: "state-1",
    scope: "devices.read devices.control",
    resource: `${origin}/mcp`,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorizeResponse.status, 302);
  assert.equal(authorizeResponse.headers.get("location"), "https://accounts.example.test/login/attempt-1");
  assert.match(browserDeviceId, /^mcp-oauth-[A-Za-z0-9_-]{32,128}$/);
  const requestId = browserDeviceId.slice("mcp-oauth-".length);
  const completionPage = await fetch(`${origin}/oauth/fabushi/complete?request_id=${encodeURIComponent(requestId)}`).then((response) => response.text());
  assert.match(completionPage, /正在返回 AI 客户端/);

  const authorization = await fetch(`${origin}/oauth/fabushi/status?request_id=${encodeURIComponent(requestId)}`).then((response) => response.json());
  assert.equal(authorization.status, "completed");
  const callback = new URL(authorization.redirectUrl);
  assert.equal(callback.searchParams.get("state"), "state-1");
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      resource: `${origin}/mcp`,
      code,
      code_verifier: verifier,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.match(tokens.access_token, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(tokens.refresh_token, /^[A-Za-z0-9_-]{40,}$/);

  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
  });
  client = new Client({ name: "fabushi-remote-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  const listedTools = await client.listTools();
  assert.deepEqual(listedTools.tools.map((tool) => tool.name), ["fabushi_account", "list_devices", "describe_device_tool", "device_call"]);

  device = new WebSocket(`ws://127.0.0.1:${address.port}/agent`, {
    headers: { Authorization: "Bearer runner-account-token" },
  });
  await opened(device);
  const tool = {
    name: "computer_state",
    title: "Read computer state",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object" },
  };
  device.send(JSON.stringify({
    type: "register",
    deviceId: "gha-runner-123",
    name: "GitHub Actions Runner 123",
    platform: "linux",
    capabilities: ["computer_state"],
    tools: [tool],
    leaseSeconds: 120,
    metadata: { kind: "github-actions", repository: "bhrumom/fabushi", runId: "123" },
  }));
  const registered = await nextJson(device);
  assert.equal(registered.type, "registered");

  const devices = await client.callTool({ name: "list_devices", arguments: {} });
  assert.equal(devices.structuredContent.devices.length, 1);
  assert.equal(devices.structuredContent.devices[0].id, "gha-runner-123");
  assert.equal(devices.structuredContent.devices[0].metadata.runId, "123");

  device.once("message", (raw) => {
    const message = JSON.parse(raw.toString("utf8"));
    if (message.type === "call") {
      device.send(JSON.stringify({
        type: "result",
        requestId: message.requestId,
        ok: true,
        result: { structuredContent: { activeApp: "Fabushi" }, content: [{ type: "text", text: "Fabushi is active" }] },
      }));
    }
  });
  const called = await client.callTool({
    name: "device_call",
    arguments: { deviceId: "gha-runner-123", toolName: "computer_state", argumentsJson: "{}" },
  });
  assert.equal(called.structuredContent.status, "completed");
  assert.deepEqual(JSON.parse(called.structuredContent.resultJson), { activeApp: "Fabushi" });

  const refreshed = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: registration.client_id,
      resource: `${origin}/mcp`,
      refresh_token: tokens.refresh_token,
    }),
  }).then((response) => response.json());
  assert.ok(refreshed.access_token);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
});

test("Fabushi remote MCP rejects unsafe redirect, missing PKCE, wrong resource, and excess clients", async (t) => {
  resetDeviceGatewayStateForTests();
  let browserLoginStarts = 0;
  const service = createFabushiRemoteMcpServer({
    host: "127.0.0.1",
    port: 0,
    statePath: "",
    auditPath: "",
    limits: { clients: 1 },
    accountClient: {
      async startBrowserLogin() {
        browserLoginStarts += 1;
        throw new Error("should not start for invalid authorization requests");
      },
      async resolveAccessToken() { throw new Error("unused"); },
    },
  });
  const address = await service.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await service.close();
    resetDeviceGatewayStateForTests();
  });

  const unsafe = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://client.example.test/callback#fragment"] }),
  });
  assert.equal(unsafe.status, 400);

  const registered = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://client.example.test/callback"] }),
  }).then((response) => response.json());
  assert.ok(registered.client_id);

  const overflow = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://other.example.test/callback"] }),
  });
  assert.equal(overflow.status, 503);

  const missingPkce = new URL(`${origin}/oauth/authorize`);
  missingPkce.search = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: "https://client.example.test/callback",
    response_type: "code",
    state: "required-state",
    resource: `${origin}/mcp`,
  }).toString();
  assert.equal((await fetch(missingPkce)).status, 400);

  const wrongResource = new URL(`${origin}/oauth/authorize`);
  wrongResource.search = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: "https://client.example.test/callback",
    response_type: "code",
    state: "required-state",
    resource: "https://attacker.example.test/mcp",
    code_challenge: challenge("z".repeat(64)),
    code_challenge_method: "S256",
  }).toString();
  const wrongResourceResponse = await fetch(wrongResource);
  assert.equal(wrongResourceResponse.status, 400);
  assert.equal((await wrongResourceResponse.json()).error, "invalid_target");
  assert.equal(browserLoginStarts, 0);
});
