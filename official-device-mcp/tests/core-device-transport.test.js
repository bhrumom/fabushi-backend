import assert from "node:assert/strict";
import test from "node:test";
import {
  CoreDeviceTransportOutcomeUnknownError,
  createCoreDeviceTransport,
} from "../lib/core-device-transport.js";

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
      assert.equal(networkGeneration, 7);
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
    ["private", "grantController"],
    ["core", "session-create"],
    ["private", "authorizeTool"],
    ["core", "operation-create"],
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
