import assert from "node:assert/strict";
import test from "node:test";
import { createFabushiAccountClient, FabushiAccountAuthError, normalizeFabushiApiBaseUrl } from "../lib/fabushi-account-auth.js";

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("Fabushi account client validates access tokens and caches account identity", async () => {
  const requests = [];
  const client = createFabushiAccountClient({
    baseUrl: "https://api.example.test",
    now: () => 1_000,
    fetchImpl: async (url, init) => {
      requests.push({ url, authorization: init.headers.Authorization });
      return jsonResponse(200, { id: "user:one", username: "runner-test" });
    },
  });
  const token = "a".repeat(48);
  assert.deepEqual(await client.resolveAccessToken(token), {
    userId: "user:one",
    label: "runner-test",
    user: { id: "user:one", username: "runner-test" },
  });
  await client.resolveAccessToken(token);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${token}`);
});

test("Fabushi account client drives the existing browser-login contract", async () => {
  const calls = [];
  const client = createFabushiAccountClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.endsWith("/api/auth/browser/start")) {
        return jsonResponse(200, {
          attemptId: "attempt-1",
          loginUrl: "https://api.example.test/api/auth/browser/portal?attemptId=attempt-1",
          pollSecret: "secret-1",
          expiresAt: 10,
          pollAfterMs: 750,
        });
      }
      return jsonResponse(200, { status: "completed", session: { accessToken: "b".repeat(48) } });
    },
  });
  const started = await client.startBrowserLogin({ deviceId: "mcp-client", platform: "web" });
  assert.equal(started.attemptId, "attempt-1");
  const polled = await client.pollBrowserLogin(started.attemptId, started.pollSecret);
  assert.equal(polled.status, "completed");
  assert.deepEqual(calls[0].body, { deviceId: "mcp-client", platform: "web" });
  assert.deepEqual(calls[1].body, { pollSecret: "secret-1" });
});

test("Fabushi account client rejects invalid and unauthorized tokens without echoing them", async () => {
  const client = createFabushiAccountClient({
    baseUrl: "https://api.example.test",
    fetchImpl: async () => jsonResponse(401, { error: { code: "unauthorized", message: "expired" } }),
  });
  await assert.rejects(() => client.resolveAccessToken("x"), (error) => error instanceof FabushiAccountAuthError && error.code === "invalid_account_token");
  await assert.rejects(() => client.resolveAccessToken("z".repeat(48)), (error) => error instanceof FabushiAccountAuthError && error.code === "unauthorized" && !error.message.includes("zzzz"));
});

test("Fabushi API URL is HTTPS except for loopback development", () => {
  assert.equal(normalizeFabushiApiBaseUrl("https://api.ombhrum.com/"), "https://api.ombhrum.com");
  assert.equal(normalizeFabushiApiBaseUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.throws(() => normalizeFabushiApiBaseUrl("http://example.test"), /HTTPS/);
});


test("official MCP service delegation bootstrap binds exact Core identity without persisting account token", async () => {
  const calls = [];
  const accountAccessToken = "a".repeat(64);
  const client = createFabushiAccountClient({
    baseUrl: "https://api.ombhrum.com",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, authorization: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
      return jsonResponse(200, {
        accessToken: "s".repeat(64),
        refreshToken: "r".repeat(64),
        delegationId: "service-delegation-1",
        accessTokenExpiresAt: 1_900_000_000,
        refreshTokenExpiresAt: 1_900_003_000,
      });
    },
  });

  const delegated = await client.createOfficialMcpServiceDelegation({
    accountAccessToken,
    connectionId: "official-mcp:connection-1",
    externalClientId: "chatgpt-client-1",
    resource: "https://api.ombhrum.com/mcp",
    scopes: ["devices.control", "devices.read"],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.ombhrum.com/v1/auth/service-token");
  assert.equal(calls[0].authorization, `Bearer ${accountAccessToken}`);
  assert.deepEqual(calls[0].body, {
    serviceId: "official-device-mcp",
    connectionId: "official-mcp:connection-1",
    externalClientId: "chatgpt-client-1",
    resource: "https://api.ombhrum.com/mcp",
    scopes: ["devices.control", "devices.read"],
  });
  assert.equal(delegated.delegationId, "service-delegation-1");
  assert.equal(delegated.accessToken, "s".repeat(64));
  assert.equal(delegated.refreshToken, "r".repeat(64));
  assert.equal(JSON.stringify(delegated).includes(accountAccessToken), false);
});

test("official MCP service refresh rotates Core credential without ordinary account Authorization", async () => {
  const calls = [];
  const client = createFabushiAccountClient({
    baseUrl: "https://api.ombhrum.com",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, authorization: init.headers.Authorization, body: JSON.parse(init.body) });
      return jsonResponse(200, {
        accessToken: "n".repeat(64),
        refreshToken: "q".repeat(64),
        delegationId: "service-delegation-1",
        accessTokenExpiresAt: 1_900_000_100,
        refreshTokenExpiresAt: 1_900_003_100,
      });
    },
  });
  const result = await client.refreshOfficialMcpServiceDelegation({
    delegationId: "service-delegation-1",
    refreshToken: "r".repeat(64),
    connectionId: "official-mcp:connection-1",
    externalClientId: "chatgpt-client-1",
    resource: "https://api.ombhrum.com/mcp",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.ombhrum.com/v1/auth/service-token/refresh");
  assert.equal(calls[0].authorization, undefined);
  assert.deepEqual(calls[0].body, {
    delegationId: "service-delegation-1",
    refreshToken: "r".repeat(64),
    connectionId: "official-mcp:connection-1",
    externalClientId: "chatgpt-client-1",
    resource: "https://api.ombhrum.com/mcp",
  });
  assert.equal(result.refreshToken, "q".repeat(64));
});

test("service refresh timeout fails closed and is never automatically replayed", async () => {
  let calls = 0;
  const client = createFabushiAccountClient({
    baseUrl: "https://api.ombhrum.com",
    timeoutMs: 1_000,
    fetchImpl: async (_url, init) => {
      calls += 1;
      await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    },
  });
  await assert.rejects(
    () => client.refreshOfficialMcpServiceDelegation({
      delegationId: "service-delegation-1",
      refreshToken: "r".repeat(64),
      connectionId: "official-mcp:connection-1",
      externalClientId: "chatgpt-client-1",
      resource: "https://api.ombhrum.com/mcp",
    }),
    (error) => error instanceof FabushiAccountAuthError && error.code === "account_request_timeout",
  );
  assert.equal(calls, 1);
});

test("Remote Computer inventory uses only the delegated service access token and is bounded", async () => {
  const calls = [];
  const serviceAccessToken = "s".repeat(64);
  const client = createFabushiAccountClient({
    baseUrl: "https://api.ombhrum.com",
    fetchImpl: async (url, init) => {
      calls.push({ url, authorization: init.headers.Authorization });
      return jsonResponse(200, { computers: [{ deviceId: "device-1", online: true }] });
    },
  });
  assert.deepEqual(await client.listRemoteComputers(serviceAccessToken), [{ deviceId: "device-1", online: true }]);
  assert.deepEqual(calls, [{ url: "https://api.ombhrum.com/v1/computers", authorization: `Bearer ${serviceAccessToken}` }]);
});


test("Core Remote Computer controller client preserves service-bound identities and stable operation requests", async () => {
  const calls = [];
  const serviceToken = "s".repeat(64);
  const clientToken = "c".repeat(64);
  const mobileToken = "m".repeat(64);
  const digest = "a".repeat(64);
  const client = createFabushiAccountClient({
    baseUrl: "https://api.ombhrum.com",
    fetchImpl: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: init.method, authorization: init.headers.Authorization, body });
      if (url.endsWith("/v1/computers/pair")) return jsonResponse(200, {
        deviceId: "device-1", clientId: "remote-client-1", clientToken, serviceBound: true,
      });
      if (url.endsWith("/sessions")) return jsonResponse(200, {
        sessionId: "remote-session-1", deviceId: "device-1", clientId: "remote-client-1", mobileToken, state: "pending",
      });
      if (url.endsWith("/sessions/reconcile")) return jsonResponse(200, {
        sessionId: "remote-session-1", deviceId: "device-1", clientId: "remote-client-1", mobileToken, state: "pending",
      });
      if (url.endsWith("/operations")) return jsonResponse(200, {
        operationId: "remote-operation-1", requestId: "operation-request-0001", sessionId: "remote-session-1",
        clientId: "remote-client-1", toolName: "computer_state", requestSha256: digest, state: "pending",
      });
      return jsonResponse(200, {
        operationId: "remote-operation-1", requestId: "operation-request-0001", sessionId: "remote-session-1",
        clientId: "remote-client-1", toolName: "computer_state", requestSha256: digest, state: "outcome_unknown",
      });
    },
  });

  const paired = await client.pairRemoteComputer(serviceToken, { pairingCode: "A1B2C3D4E5F6", label: "Official MCP" });
  assert.equal(paired.clientToken, clientToken);
  const session = await client.createRemoteComputerSession(serviceToken, {
    deviceId: paired.deviceId, clientId: paired.clientId, clientToken: paired.clientToken, requestId: "session-request-0001",
  });
  assert.equal(session.mobileToken, mobileToken);
  await client.reconcileRemoteComputerSession(serviceToken, {
    deviceId: paired.deviceId, clientId: paired.clientId, clientToken: paired.clientToken, requestId: "session-request-0001",
  });
  await client.createRemoteComputerOperation(serviceToken, {
    deviceId: paired.deviceId, sessionId: session.sessionId, clientId: paired.clientId, mobileToken: session.mobileToken,
    requestId: "operation-request-0001", toolName: "computer_state", requestSha256: digest,
  });
  await client.queryRemoteComputerOperation(serviceToken, {
    deviceId: paired.deviceId, sessionId: session.sessionId, clientId: paired.clientId, mobileToken: session.mobileToken,
    requestId: "operation-request-0001",
  });
  await client.cancelRemoteComputerOperation(serviceToken, {
    deviceId: paired.deviceId, sessionId: session.sessionId, clientId: paired.clientId, mobileToken: session.mobileToken,
    requestId: "operation-request-0001",
  });
  await client.markRemoteComputerOperationOutcomeUnknown(serviceToken, {
    deviceId: paired.deviceId, sessionId: session.sessionId, clientId: paired.clientId, mobileToken: session.mobileToken,
    requestId: "operation-request-0001",
  });

  assert.equal(calls.length, 7);
  assert.ok(calls.every((call) => call.authorization === `Bearer ${serviceToken}`));
  assert.deepEqual(calls[0].body, { pairingCode: "A1B2C3D4E5F6", label: "Official MCP" });
  assert.deepEqual(calls[1].body, { clientId: "remote-client-1", clientToken, requestId: "session-request-0001" });
  assert.deepEqual(calls[3].body, {
    clientId: "remote-client-1", mobileToken, requestId: "operation-request-0001",
    toolName: "computer_state", requestSha256: digest, sensitiveResult: false,
  });
  assert.deepEqual(calls[4].body, { clientId: "remote-client-1", mobileToken });
  assert.match(calls[4].url, /operations\/operation-request-0001\/query$/u);
  assert.match(calls[5].url, /operations\/operation-request-0001\/cancel$/u);
  assert.match(calls[6].url, /operations\/operation-request-0001\/outcome-unknown$/u);
});

test("Core Remote Computer controller client rejects malformed and mismatched authority before routing", async () => {
  let calls = 0;
  const serviceToken = "s".repeat(64);
  const client = createFabushiAccountClient({
    baseUrl: "https://api.ombhrum.com",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, {
        operationId: "remote-operation-1", requestId: "different-request-0001", sessionId: "remote-session-1",
        clientId: "remote-client-1", toolName: "computer_state", requestSha256: "a".repeat(64), state: "pending",
      });
    },
  });
  await assert.rejects(
    () => client.createRemoteComputerOperation(serviceToken, {
      deviceId: "device-1", sessionId: "remote-session-1", clientId: "remote-client-1", mobileToken: "m".repeat(64),
      requestId: "short", toolName: "computer_state", requestSha256: "a".repeat(64),
    }),
    (error) => error instanceof FabushiAccountAuthError && error.code === "invalid_request_id",
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () => client.createRemoteComputerOperation(serviceToken, {
      deviceId: "device-1", sessionId: "remote-session-1", clientId: "remote-client-1", mobileToken: "m".repeat(64),
      requestId: "operation-request-0001", toolName: "computer_state", requestSha256: "a".repeat(64),
    }),
    (error) => error instanceof FabushiAccountAuthError && error.code === "remote_operation_identity_mismatch",
  );
  assert.equal(calls, 1);
});


test("official MCP reads only the service-bound minimal Core network route", async () => {
  const calls = [];
  const serviceToken = "s".repeat(64);
  const client = createFabushiAccountClient({
    baseUrl: "https://api.ombhrum.com",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, authorization: init.headers.Authorization, body: init.body });
      return jsonResponse(200, {
        deviceId: "device-fdn-1",
        cellId: "cell-fdn-account-a",
        nodeId: "100.64.0.10",
        generation: 17,
        expiresAt: 1_900_000_000,
        connectionId: "official-mcp:connection-0001",
        delegationId: "delegation-0001",
        active: true,
      });
    },
  });
  const route = await client.getRemoteComputerNetworkRoute(serviceToken, {
    deviceId: "device-fdn-1",
    connectionId: "official-mcp:connection-0001",
    delegationId: "delegation-0001",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.ombhrum.com/v1/computers/device-fdn-1/network-route");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].authorization, `Bearer ${serviceToken}`);
  assert.equal(calls[0].body, undefined);
  assert.deepEqual(route, {
    deviceId: "device-fdn-1",
    cellId: "cell-fdn-account-a",
    nodeId: "100.64.0.10",
    generation: 17,
    expiresAt: 1_900_000_000,
    connectionId: "official-mcp:connection-0001",
    delegationId: "delegation-0001",
    active: true,
  });
});

test("official MCP rejects controller network routes that leak target-only proof material", async () => {
  const client = createFabushiAccountClient({
    baseUrl: "https://api.ombhrum.com",
    fetchImpl: async () => jsonResponse(200, {
      deviceId: "device-fdn-1",
      cellId: "cell-fdn-account-a",
      nodeId: "100.64.0.10",
      generation: 17,
      expiresAt: 1_900_000_000,
      connectionId: "official-mcp:connection-0001",
      delegationId: "delegation-0001",
      active: true,
      proofSha256: "a".repeat(64),
    }),
  });
  await assert.rejects(
    () => client.getRemoteComputerNetworkRoute("s".repeat(64), {
      deviceId: "device-fdn-1",
      connectionId: "official-mcp:connection-0001",
      delegationId: "delegation-0001",
    }),
    (error) => error instanceof FabushiAccountAuthError
      && error.code === "remote_network_route_secret_leak",
  );
});
