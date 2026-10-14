import assert from "node:assert/strict";
import test from "node:test";
import { createLocalNetworkWorkerPrivateTransport } from "../lib/local-network-worker-transport.js";

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("local network worker transport sends only the bounded Core route to loopback", async () => {
  let seen;
  const transport = createLocalNetworkWorkerPrivateTransport({
    endpoint: "http://127.0.0.1:8791/v1/fdn/private-request",
    remotePort: 8792,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      seen = { url, method: init.method, body };
      return response({
        requestId: body.requestId,
        deviceId: body.deviceId,
        nodeId: body.nodeId,
        generation: body.generation,
        ok: true,
        result: {
          type: "toolDescription",
          deviceId: body.deviceId,
          networkGeneration: body.generation,
          available: false,
        },
      });
    },
  });
  const result = await transport.request({
    accountId: "user:fdn",
    deviceId: "device-fdn-1",
    networkRoute: {
      cellId: "cell-fdn-account-a",
      nodeId: "100.64.0.10",
      generation: 17,
      expiresAt: 4_000_000_000,
    },
    timeoutSeconds: 30,
    payload: { type: "describeTool", toolName: "Computer" },
  });
  assert.equal(seen.url, "http://127.0.0.1:8791/v1/fdn/private-request");
  assert.equal(seen.method, "POST");
  assert.equal(seen.body.cellId, "cell-fdn-account-a");
  assert.equal(seen.body.nodeId, "100.64.0.10");
  assert.equal(seen.body.generation, 17);
  assert.equal(seen.body.targetPort, 8792);
  assert.equal(seen.body.frame, '{"type":"describeTool","toolName":"Computer"}\n');
  assert.equal(Object.hasOwn(seen.body, "deviceSecret"), false);
  assert.equal(Object.hasOwn(seen.body, "proofSha256"), false);
  assert.equal(result.type, "toolDescription");
});

test("local network worker transport rejects non-loopback endpoints", () => {
  assert.throws(
    () => createLocalNetworkWorkerPrivateTransport({
      endpoint: "https://attacker.example/v1/fdn/private-request",
    }),
    /fixed loopback HTTP path/u,
  );
});

test("local network worker transport rejects expired routes before IPC dispatch", async () => {
  let calls = 0;
  const transport = createLocalNetworkWorkerPrivateTransport({
    fetchImpl: async () => {
      calls += 1;
      throw new Error("must not dispatch");
    },
  });
  await assert.rejects(
    () => transport.request({
      accountId: "user:fdn",
      deviceId: "device-fdn-1",
      networkRoute: {
        cellId: "cell-fdn-account-a",
        nodeId: "100.64.0.10",
        generation: 17,
        expiresAt: 1,
      },
      payload: { type: "operation" },
    }),
    /invalid or expired/u,
  );
  assert.equal(calls, 0);
});

test("local network worker transport rejects mismatched worker correlation", async () => {
  const transport = createLocalNetworkWorkerPrivateTransport({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return response({
        requestId: body.requestId,
        deviceId: body.deviceId,
        nodeId: "100.64.0.99",
        generation: body.generation,
        ok: true,
        result: { type: "operationResult" },
      });
    },
  });
  await assert.rejects(
    () => transport.request({
      accountId: "user:fdn",
      deviceId: "device-fdn-1",
      networkRoute: {
        cellId: "cell-fdn-account-a",
        nodeId: "100.64.0.10",
        generation: 17,
        expiresAt: 4_000_000_000,
      },
      payload: { type: "operation" },
    }),
    /failed route\/request correlation/u,
  );
});
