import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";
import { createFabushiRemoteMcpServer } from "../lib/fabushi-remote-mcp-server.js";
import { resetDeviceGatewayStateForTests } from "../lib/device-gateway.js";
import { createServiceCredentialVault } from "../lib/service-credential-vault.js";

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
  const missingPreflight = await client.callTool({
    name: "device_call",
    arguments: { deviceId: "gha-runner-123", toolName: "computer_state", argumentsJson: "{}" },
  });
  assert.equal(missingPreflight.isError, true);
  assert.equal(missingPreflight.structuredContent, undefined);

  const called = await client.callTool({
    name: "device_call",
    arguments: {
      deviceId: "gha-runner-123",
      toolName: "computer_state",
      argumentsJson: "{}",
      diskPreflight: {
        impact: "none",
        reason: "computer_state reads current application state and does not materially grow device storage.",
        targets: [],
      },
    },
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


test("Core service delegation state persists only encrypted refresh and recovers once after restart", async (t) => {
  resetDeviceGatewayStateForTests();
  const directory = await mkdtemp(join(tmpdir(), "fabushi-core-service-state-"));
  const statePath = join(directory, "state.json");
  const vault = createServiceCredentialVault({ key: Buffer.alloc(32, 13).toString("base64url") });
  const ordinaryAccountToken = "ordinary-account-token-" + "a".repeat(48);
  const firstCoreAccess = "core-access-" + "b".repeat(64);
  const firstCoreRefresh = "core-refresh-" + "c".repeat(64);
  const rotatedCoreAccess = "rotated-access-" + "d".repeat(64);
  const rotatedCoreRefresh = "rotated-refresh-" + "e".repeat(64);
  let browserDeviceId = "";
  let bootstrapCalls = 0;
  let refreshCalls = 0;
  let connectionId = "";

  const accountClient = {
    async startBrowserLogin({ deviceId }) {
      browserDeviceId = deviceId;
      return {
        attemptId: "attempt-service-state",
        pollSecret: "poll-service-state",
        loginUrl: "https://accounts.example.test/login/service-state",
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      };
    },
    async pollBrowserLogin(attemptId, pollSecret) {
      assert.equal(attemptId, "attempt-service-state");
      assert.equal(pollSecret, "poll-service-state");
      return { status: "completed", session: { accessToken: ordinaryAccountToken } };
    },
    async resolveAccessToken(token) {
      assert.equal(token, ordinaryAccountToken);
      return { userId: "user:service-state", label: "Service State User", user: { id: "user:service-state" } };
    },
    async createOfficialMcpServiceDelegation(input) {
      bootstrapCalls += 1;
      assert.equal(input.accountAccessToken, ordinaryAccountToken);
      assert.match(input.connectionId, /^official-mcp:[A-Za-z0-9_-]{24,160}$/u);
      connectionId = input.connectionId;
      assert.equal(input.externalClientId.startsWith("fabushi_"), true);
      assert.equal(input.resource, "https://api.ombhrum.com/mcp");
      assert.deepEqual(input.scopes, ["devices.read", "devices.control"]);
      return {
        accessToken: firstCoreAccess,
        refreshToken: firstCoreRefresh,
        delegationId: "service-delegation-state-1",
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 300,
        refreshTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        connectionId: input.connectionId,
        externalClientId: input.externalClientId,
        resource: input.resource,
        scopes: input.scopes,
      };
    },
    async refreshOfficialMcpServiceDelegation() {
      throw new Error("initial server must use bootstrap access token from memory");
    },
  };

  const first = createFabushiRemoteMcpServer({
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "https://api.ombhrum.com",
    statePath,
    auditPath: "",
    accountClient,
    requireCoreServiceState: true,
    serviceCredentialVault: vault,
  });
  const firstAddress = await first.listen();
  const origin = `http://127.0.0.1:${firstAddress.port}`;
  const redirectUri = "http://127.0.0.1/callback";
  const registration = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri] }),
  }).then((response) => response.json());
  const verifier = "s".repeat(64);
  const authorizeUrl = new URL(`${origin}/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    state: "service-state",
    scope: "devices.read devices.control",
    resource: "https://api.ombhrum.com/mcp",
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  const authorize = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorize.status, 302);
  const requestId = browserDeviceId.slice("mcp-oauth-".length);
  const authorization = await fetch(`${origin}/oauth/fabushi/status?request_id=${encodeURIComponent(requestId)}`).then((response) => response.json());
  assert.equal(authorization.status, "completed");
  const code = new URL(authorization.redirectUrl).searchParams.get("code");
  const issuedResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      resource: "https://api.ombhrum.com/mcp",
      code,
      code_verifier: verifier,
    }),
  });
  assert.equal(issuedResponse.status, 200);
  const issued = await issuedResponse.json();
  assert.equal(bootstrapCalls, 1);
  assert.ok(connectionId);

  const persisted = await readFile(statePath, "utf8");
  for (const forbidden of [ordinaryAccountToken, firstCoreAccess, firstCoreRefresh]) {
    assert.equal(persisted.includes(forbidden), false, forbidden);
  }
  assert.match(persisted, /"algorithm": "A256GCM"/u);
  assert.match(persisted, /"delegationId": "service-delegation-state-1"/u);
  await first.close();

  const recoveryClient = {
    async resolveAccessToken() { throw new Error("ordinary account token must not be needed after restart"); },
    async refreshOfficialMcpServiceDelegation(input) {
      refreshCalls += 1;
      assert.equal(input.delegationId, "service-delegation-state-1");
      assert.equal(input.connectionId, connectionId);
      assert.equal(input.externalClientId, registration.client_id);
      assert.equal(input.resource, "https://api.ombhrum.com/mcp");
      assert.equal(input.refreshToken, firstCoreRefresh);
      return {
        accessToken: rotatedCoreAccess,
        refreshToken: rotatedCoreRefresh,
        delegationId: input.delegationId,
        accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 300,
        refreshTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        connectionId: input.connectionId,
        externalClientId: input.externalClientId,
        resource: input.resource,
      };
    },
  };
  const second = createFabushiRemoteMcpServer({
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "https://api.ombhrum.com",
    statePath,
    auditPath: "",
    accountClient: recoveryClient,
    requireCoreServiceState: true,
    serviceCredentialVault: vault,
  });
  const secondAddress = await second.listen();
  const secondOrigin = `http://127.0.0.1:${secondAddress.port}`;
  t.after(async () => {
    await second.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    resetDeviceGatewayStateForTests();
  });

  for (let index = 0; index < 2; index += 1) {
    const response = await fetch(`${secondOrigin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.access_token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.notEqual(response.status, 503);
  }
  assert.equal(refreshCalls, 1);
  const rotatedState = await readFile(statePath, "utf8");
  for (const forbidden of [ordinaryAccountToken, firstCoreAccess, firstCoreRefresh, rotatedCoreAccess, rotatedCoreRefresh]) {
    assert.equal(rotatedState.includes(forbidden), false, forbidden);
  }
});

