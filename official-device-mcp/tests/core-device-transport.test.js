import assert from "node:assert/strict";
import test from "node:test";
import {
  CoreDeviceTransportOutcomeUnknownError,
  createCoreDeviceTransport,
} from "../lib/core-device-transport.js";

function networkRoute(generation = 9) {
  return {
    deviceId: "device-fdn-1",
    cellId: "cell-fdn-account-a",
    nodeId: "100.64.0.10",
    generation,
    expiresAt: 1_900_000_000,
    connectionId: "official-mcp:connection-0001",
    delegationId: "delegation-0001",
    active: true,
  };
}

function baseInput() {
  return {
    accountId: "user:fdn",
    deviceId: "device-fdn-1",
    toolName: "computer_state",
    args: { includeWindows: true },
    timeoutSeconds: 90,
    diskPreflight: { impact: "none", reason: "read only", targets: [] },
    requestId: "operation-request-00000001",
    requestSha256: "a".repeat(64),
    computer: { online: true, networkBound: true, networkGeneration: 7 },
    coreServiceAccessToken: "s".repeat(64),
    connectionId: "official-mcp:connection-0001",
    delegationId: "delegation-0001",
  };
}

test("Core device transport uses target grant then Core session/operation and confirms the result", async () => {
  const events = [];
  const clientToken = "c".repeat(64);
  const mobileToken = "m".repeat(64);
  const privateTransport = {
    async request({ payload, deviceId, networkGeneration }) {
      events.push(["private", payload.type]);
      assert.equal(deviceId, "device-fdn-1");
      assert.equal(networkGeneration, 9);
      if (payload.type === "grantController") {
        return {
          type: "controllerGranted",
          deviceId,
          clientId: "client-fdn-1",
          clientToken,
          connectionId: payload.connectionId,
          delegationId: payload.delegationId,
          requestId: payload.requestId,
          networkGeneration,
        };
      }
      if (payload.type === "authorizeTool") {
        return {
          type: "toolAuthorized",
          deviceId,
          sessionId: payload.sessionId,
          clientId: payload.clientId,
          toolName: payload.toolName,
          expiresAt: payload.expiresAt,
          grantGeneration: 11,
          networkGeneration,
        };
      }
      assert.equal(payload.type, "operation");
      assert.equal(payload.requestId, "operation-request-00000001");
      assert.equal(payload.requestSha256, "a".repeat(64));
      assert.equal(payload.grantGeneration, 11);
      return {
        type: "operationResult",
        deviceId,
        sessionId: payload.sessionId,
        requestId: payload.requestId,
        requestSha256: payload.requestSha256,
        resultSha256: "b".repeat(64),
        status: "completed",
        networkGeneration,
      };
    },
  };
  const accountClient = {
    async getRemoteComputerNetworkRoute() {
      events?.push?.(["core", "network-route"]);
      return networkRoute();
    },
    async createRemoteComputerSession(_serviceToken, input) {
      events.push(["core", "session-create"]);
      assert.equal(input.clientToken, clientToken);
      return { sessionId: "session-fdn-1", mobileToken };
    },
    async reconcileRemoteComputerSession() {
      throw new Error("reconcile must not run after successful create");
    },
    async createRemoteComputerOperation(_serviceToken, input) {
      events.push(["core", "operation-create"]);
      return {
        requestId: input.requestId,
        sessionId: input.sessionId,
        clientId: input.clientId,
        toolName: input.toolName,
        requestSha256: input.requestSha256,
        state: "pending",
      };
    },
    async queryRemoteComputerOperation(_serviceToken, input) {
      events.push(["core", "operation-query"]);
      return {
        requestId: input.requestId,
        sessionId: input.sessionId,
        clientId: input.clientId,
        state: "completed",
        resultSha256: "b".repeat(64),
        result: { structuredContent: { activeApp: "Fabushi" } },
      };
    },
    async markRemoteComputerOperationOutcomeUnknown() {
      throw new Error("outcome unknown must not be used for confirmed success");
    },
  };
  const transport = createCoreDeviceTransport({ accountClient, privateTransport, now: () => 1_800_000_000 });
  const result = await transport.callDevice(baseInput());
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.structuredContent, { activeApp: "Fabushi" });
  assert.deepEqual(events, [
    ["core", "network-route"],
    ["private", "grantController"],
    ["core", "session-create"],
    ["core", "network-route"],
    ["private", "authorizeTool"],
    ["core", "operation-create"],
    ["core", "network-route"],
    ["private", "operation"],
    ["core", "operation-query"],
  ]);
});

test("Core device transport never replays an operation after dispatch uncertainty", async () => {
  const seen = [];
  let operationDispatches = 0;
  let outcomeUnknownMarks = 0;
  const privateTransport = {
    async request({ payload, deviceId, networkGeneration }) {
      seen.push(payload.type);
      if (payload.type === "grantController") {
        return {
          type: "controllerGranted",
          deviceId,
          clientId: "client-fdn-1",
          clientToken: "c".repeat(64),
          connectionId: payload.connectionId,
          delegationId: payload.delegationId,
          requestId: payload.requestId,
          networkGeneration,
        };
      }
      if (payload.type === "authorizeTool") {
        return {
          type: "toolAuthorized",
          deviceId,
          sessionId: payload.sessionId,
          clientId: payload.clientId,
          toolName: payload.toolName,
          expiresAt: payload.expiresAt,
          grantGeneration: 12,
          networkGeneration,
        };
      }
      operationDispatches += 1;
      throw new Error("response lost after dispatch");
    },
  };
  const accountClient = {
    async getRemoteComputerNetworkRoute() {
      return networkRoute();
    },
    async createRemoteComputerSession() {
      return { sessionId: "session-fdn-2", mobileToken: "m".repeat(64) };
    },
    async reconcileRemoteComputerSession() {
      throw new Error("unused");
    },
    async createRemoteComputerOperation(_serviceToken, input) {
      return {
        requestId: input.requestId,
        sessionId: input.sessionId,
        clientId: input.clientId,
        toolName: input.toolName,
        requestSha256: input.requestSha256,
      };
    },
    async queryRemoteComputerOperation() {
      throw new Error("must not query as completed after uncertain dispatch");
    },
    async markRemoteComputerOperationOutcomeUnknown(_serviceToken, input) {
      outcomeUnknownMarks += 1;
      assert.equal(input.requestId, "operation-request-00000001");
      return { state: "outcome_unknown" };
    },
  };
  const transport = createCoreDeviceTransport({ accountClient, privateTransport, now: () => 1_800_000_000 });
  await assert.rejects(
    () => transport.callDevice(baseInput()),
    (error) => error instanceof CoreDeviceTransportOutcomeUnknownError
      && error.outcomeUnknown === true
      && error.requestId === "operation-request-00000001",
  );
  assert.equal(operationDispatches, 1);
  assert.equal(outcomeUnknownMarks, 1);
  assert.deepEqual(seen, ["grantController", "authorizeTool", "operation"]);
});


test("Core device transport describes a target-owned schema without consulting the legacy registry", async () => {
  const seen = [];
  const privateTransport = {
    async request({ accountId, deviceId, networkGeneration, payload }) {
      seen.push({ accountId, deviceId, networkGeneration, payload });
      assert.equal(payload.type, "describeTool");
      assert.equal(payload.toolName, "Computer");
      return {
        type: "toolDescription",
        deviceId,
        connectionId: payload.connectionId,
        delegationId: payload.delegationId,
        requestId: payload.requestId,
        toolName: payload.toolName,
        available: true,
        schemaVersion: "d".repeat(64),
        tool: {
          name: "Computer",
          title: "Computer",
          description: "Host-owned Computer tool",
          inputSchema: {
            type: "object",
            required: ["action"],
            properties: { action: { type: "string" } },
          },
          outputSchema: {
            type: "object",
            required: ["content", "screenshotPath"],
          },
        },
        networkGeneration,
      };
    },
  };
  const accountClient = {
    async getRemoteComputerNetworkRoute() {
      return networkRoute();
    },
    async createRemoteComputerSession() { throw new Error("describe must not create a session"); },
    async reconcileRemoteComputerSession() { throw new Error("describe must not reconcile a session"); },
    async createRemoteComputerOperation() { throw new Error("describe must not create an operation"); },
    async queryRemoteComputerOperation() { throw new Error("describe must not query an operation"); },
    async markRemoteComputerOperationOutcomeUnknown() { throw new Error("describe must not mutate operation state"); },
  };
  const transport = createCoreDeviceTransport({ accountClient, privateTransport });
  const result = await transport.describeDeviceTool({
    accountId: "user:fdn",
    deviceId: "device-fdn-1",
    toolName: "Computer",
    computer: { online: true, networkBound: true, networkGeneration: 7 },
    connectionId: "official-mcp:connection-0001",
    delegationId: "delegation-0001",
  });
  assert.equal(result.available, true);
  assert.equal(result.schemaVersion, "d".repeat(64));
  assert.equal(result.tool.name, "Computer");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].accountId, "user:fdn");
  assert.equal(seen[0].networkGeneration, 9);
});

test("Core device transport rejects mismatched target schema identity", async () => {
  const privateTransport = {
    async request({ deviceId, networkGeneration, payload }) {
      return {
        type: "toolDescription",
        deviceId,
        connectionId: payload.connectionId,
        delegationId: payload.delegationId,
        requestId: payload.requestId,
        toolName: "Screenshot",
        available: true,
        schemaVersion: "e".repeat(64),
        tool: { name: "Screenshot" },
        networkGeneration,
      };
    },
  };
  const unavailable = async () => { throw new Error("unused"); };
  const transport = createCoreDeviceTransport({
    accountClient: {
      getRemoteComputerNetworkRoute: async () => networkRoute(),
      createRemoteComputerSession: unavailable,
      reconcileRemoteComputerSession: unavailable,
      createRemoteComputerOperation: unavailable,
      queryRemoteComputerOperation: unavailable,
      markRemoteComputerOperationOutcomeUnknown: unavailable,
    },
    privateTransport,
  });
  await assert.rejects(
    () => transport.describeDeviceTool({
      accountId: "user:fdn",
      deviceId: "device-fdn-1",
      toolName: "Computer",
      computer: { online: true, networkBound: true, networkGeneration: 7 },
      connectionId: "official-mcp:connection-0001",
      delegationId: "delegation-0001",
    }),
    /failed identity correlation/u,
  );
});


test("Core device transport passes only the service-bound Core peer route to private transport", async () => {
  let received;
  const privateTransport = {
    async request(input) {
      received = input;
      const payload = input.payload;
      return {
        type: "toolDescription",
        deviceId: input.deviceId,
        connectionId: payload.connectionId,
        delegationId: payload.delegationId,
        requestId: payload.requestId,
        toolName: payload.toolName,
        available: false,
        schemaVersion: "",
        tool: null,
        networkGeneration: input.networkGeneration,
      };
    },
  };
  const unavailable = async () => { throw new Error("unused"); };
  const transport = createCoreDeviceTransport({
    accountClient: {
      getRemoteComputerNetworkRoute: async () => networkRoute(13),
      createRemoteComputerSession: unavailable,
      reconcileRemoteComputerSession: unavailable,
      createRemoteComputerOperation: unavailable,
      queryRemoteComputerOperation: unavailable,
      markRemoteComputerOperationOutcomeUnknown: unavailable,
    },
    privateTransport,
  });
  const result = await transport.describeDeviceTool({
    ...baseInput(),
    toolName: "Computer",
    // Intentionally stale public generation: the private route must use Core's service-only generation.
    computer: { online: true, networkBound: true, networkGeneration: 2 },
  });
  assert.equal(result.available, false);
  assert.equal(received.cellId, "cell-fdn-account-a");
  assert.equal(received.nodeId, "100.64.0.10");
  assert.equal(received.networkGeneration, 13);
  assert.equal(received.networkExpiresAt, 1_900_000_000);
  assert.equal(received.payload.networkGeneration, 13);
  assert.equal(Object.hasOwn(received, "proofSha256"), false);
  assert.equal(Object.hasOwn(received, "deviceSecret"), false);
});


test("Core device transport rejects an expired Core route before private dispatch", async () => {
  let privateDispatches = 0;
  const unavailable = async () => { throw new Error("must not run"); };
  const transport = createCoreDeviceTransport({
    accountClient: {
      getRemoteComputerNetworkRoute: async () => networkRoute(9),
      createRemoteComputerSession: unavailable,
      reconcileRemoteComputerSession: unavailable,
      createRemoteComputerOperation: unavailable,
      queryRemoteComputerOperation: unavailable,
      markRemoteComputerOperationOutcomeUnknown: unavailable,
    },
    privateTransport: {
      async request() {
        privateDispatches += 1;
        throw new Error("expired route must not dispatch");
      },
    },
    now: () => 2_000_000_000,
  });
  await assert.rejects(
    () => transport.describeDeviceTool({
      ...baseInput(),
      toolName: "Computer",
    }),
    /network route failed identity correlation/u,
  );
  assert.equal(privateDispatches, 0);
});

test("Core device transport fails closed if network generation rotates during one device_call", async () => {
  let routeReads = 0;
  const privatePayloads = [];
  const clientToken = "c".repeat(64);
  const mobileToken = "m".repeat(64);
  const transport = createCoreDeviceTransport({
    accountClient: {
      async getRemoteComputerNetworkRoute() {
        routeReads += 1;
        return networkRoute(routeReads === 1 ? 9 : 10);
      },
      async createRemoteComputerSession() {
        return { sessionId: "session-fdn-rotation", mobileToken };
      },
      async reconcileRemoteComputerSession() {
        throw new Error("unused");
      },
      async createRemoteComputerOperation() {
        throw new Error("operation must not be created after route generation rotates");
      },
      async queryRemoteComputerOperation() {
        throw new Error("unused");
      },
      async markRemoteComputerOperationOutcomeUnknown() {
        throw new Error("unused");
      },
    },
    privateTransport: {
      async request({ payload, deviceId, networkGeneration }) {
        privatePayloads.push(payload.type);
        if (payload.type !== "grantController") throw new Error("only the initial grant may dispatch");
        return {
          type: "controllerGranted",
          deviceId,
          clientId: "client-fdn-rotation",
          clientToken,
          connectionId: payload.connectionId,
          delegationId: payload.delegationId,
          requestId: payload.requestId,
          networkGeneration,
        };
      },
    },
    now: () => 1_800_000_000,
  });
  await assert.rejects(
    () => transport.callDevice(baseInput()),
    /network generation changed during the request/u,
  );
  assert.equal(routeReads, 2);
  assert.deepEqual(privatePayloads, ["grantController"]);
});
