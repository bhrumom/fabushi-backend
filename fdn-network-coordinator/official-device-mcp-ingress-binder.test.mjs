import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadState,
  loopbackWorkerStatusUrl,
  readWorkerStatus,
  reconcileIngress,
  revokeIngress,
  validateTailnetNode,
} from "./official-device-mcp-ingress-binder.mjs";

const TOKEN = "network-authority-token-that-is-definitely-long-enough";
const USER = "fabushi-user-account-a";
const CELL = "cell-fdn-account-a";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("worker status origin is exact loopback and node is private tailnet", () => {
  assert.equal(
    loopbackWorkerStatusUrl("http://127.0.0.1:8791").toString(),
    "http://127.0.0.1:8791/v1/fdn/status",
  );
  for (const bad of [
    "https://127.0.0.1:8791",
    "http://localhost:8791",
    "http://0.0.0.0:8791",
    "http://127.0.0.1:8791/path",
    "http://user:pass@127.0.0.1:8791",
  ]) {
    assert.throws(() => loopbackWorkerStatusUrl(bad));
  }
  assert.equal(validateTailnetNode("100.64.0.8"), "100.64.0.8");
  assert.equal(validateTailnetNode("fd7a:115c:a1e0::8"), "fd7a:115c:a1e0::8");
  assert.throws(() => validateTailnetNode("8.8.8.8"));
});

test("worker status accepts only minimal no-secret shape", async () => {
  const good = await readWorkerStatus(
    async () => jsonResponse({ cellId: CELL, nodeId: "100.64.0.8", ready: true }),
    "http://127.0.0.1:8791",
  );
  assert.deepEqual(good, { cellId: CELL, nodeId: "100.64.0.8" });

  await assert.rejects(
    readWorkerStatus(
      async () =>
        jsonResponse({
          cellId: CELL,
          nodeId: "100.64.0.8",
          ready: true,
          authKey: "forbidden",
        }),
      "http://127.0.0.1:8791",
    ),
  );
});

test("reconcile persists identity before bind and retries uncertain outcome without generation drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "fdn-ingress-"));
  const statePath = join(root, "state", "ingress.json");
  const calls = [];
  let loseFirstBindResponse = true;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/fdn/status") {
      return jsonResponse({ cellId: CELL, nodeId: "100.64.0.9", ready: true });
    }
    calls.push({
      path: parsed.pathname,
      body: JSON.parse(init.body),
      authority: init.headers["x-fabushi-network-authority"],
    });
    if (loseFirstBindResponse) {
      loseFirstBindResponse = false;
      throw new Error("response lost after dispatch");
    }
    const body = JSON.parse(init.body);
    return jsonResponse({ ok: true, ...body, reconciled: true });
  };

  try {
    await assert.rejects(
      reconcileIngress({
        fetchImpl,
        workerOrigin: "http://127.0.0.1:8791",
        coreOrigin: "https://core.example.test",
        authorityToken: TOKEN,
        userId: USER,
        cellId: CELL,
        statePath,
        now: 2_000_000_000,
      }),
      /response lost/,
    );
    const uncertain = await loadState(statePath);
    assert.equal(uncertain.phase, "bind_outcome_unknown");
    assert.equal(uncertain.generation, 1);
    assert.equal(uncertain.nodeId, "100.64.0.9");

    const recovered = await reconcileIngress({
      fetchImpl,
      workerOrigin: "http://127.0.0.1:8791",
      coreOrigin: "https://core.example.test",
      authorityToken: TOKEN,
      userId: USER,
      cellId: CELL,
      statePath,
      now: 2_000_000_005,
    });
    assert.equal(recovered.phase, "bound");
    assert.equal(recovered.generation, 1);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, calls[1].body);
    assert.equal(calls[0].authority, TOKEN);

    const raw = await readFile(statePath, "utf8");
    assert.equal(raw.includes(TOKEN), false);
    assert.equal(raw.includes("authKey"), false);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node rotation advances one durable generation and fixed service id", async () => {
  const root = await mkdtemp(join(tmpdir(), "fdn-ingress-"));
  const statePath = join(root, "ingress.json");
  let node = "100.64.0.10";
  const binds = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/fdn/status") {
      return jsonResponse({ cellId: CELL, nodeId: node, ready: true });
    }
    const body = JSON.parse(init.body);
    binds.push(body);
    return jsonResponse({ ok: true, ...body, reconciled: false });
  };
  try {
    const first = await reconcileIngress({
      fetchImpl,
      workerOrigin: "http://127.0.0.1:8791",
      coreOrigin: "https://core.example.test",
      authorityToken: TOKEN,
      userId: USER,
      cellId: CELL,
      statePath,
      now: 2_100_000_000,
    });
    assert.equal(first.generation, 1);
    node = "100.64.0.11";
    const second = await reconcileIngress({
      fetchImpl,
      workerOrigin: "http://127.0.0.1:8791",
      coreOrigin: "https://core.example.test",
      authorityToken: TOKEN,
      userId: USER,
      cellId: CELL,
      statePath,
      now: 2_100_000_010,
    });
    assert.equal(second.generation, 2);
    assert.equal(binds[1].serviceId, "official-device-mcp");
    assert.equal(binds[1].nodeId, "100.64.0.11");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cell mismatch fails before Core bind and revoke uses durable exact generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "fdn-ingress-"));
  const statePath = join(root, "ingress.json");
  let coreCalls = 0;
  const mismatchFetch = async () =>
    jsonResponse({ cellId: "cell-fdn-other-a", nodeId: "100.64.0.12", ready: true });
  try {
    await assert.rejects(
      reconcileIngress({
        fetchImpl: mismatchFetch,
        workerOrigin: "http://127.0.0.1:8791",
        coreOrigin: "https://core.example.test",
        authorityToken: TOKEN,
        userId: USER,
        cellId: CELL,
        statePath,
      }),
      /cell mismatch/,
    );

    const fetchImpl = async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v1/fdn/status") {
        return jsonResponse({ cellId: CELL, nodeId: "100.64.0.12", ready: true });
      }
      coreCalls++;
      const body = JSON.parse(init.body);
      return jsonResponse({ ok: true, ...body, reconciled: false, revokedAt: 2_200_000_100 });
    };
    const bound = await reconcileIngress({
      fetchImpl,
      workerOrigin: "http://127.0.0.1:8791",
      coreOrigin: "https://core.example.test",
      authorityToken: TOKEN,
      userId: USER,
      cellId: CELL,
      statePath,
      now: 2_200_000_000,
    });
    const revoked = await revokeIngress({
      fetchImpl,
      coreOrigin: "https://core.example.test",
      authorityToken: TOKEN,
      statePath,
    });
    assert.equal(bound.generation, 1);
    assert.equal(revoked.generation, 1);
    assert.equal(revoked.phase, "revoked");
    assert.equal(coreCalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
