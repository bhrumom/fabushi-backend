import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_BINDINGS,
  REMOTE_TARGET_PORT,
  buildHeadscalePolicy,
  fetchCoreCellSnapshot,
  validateCellSnapshot,
} from "./project-core-policy.mjs";

const NOW = 2_000_000_000;
const CELL = "cell-fdn-account-a";

function row(overrides = {}) {
  return {
    userId: "user:account-a",
    deviceId: "device-a",
    cellId: CELL,
    nodeId: "100.64.0.10",
    generation: 7,
    expiresAt: NOW + 3600,
    ...overrides,
  };
}

function snapshot(bindings = [row()]) {
  return { cellId: CELL, generatedAt: NOW, bindings };
}

test("empty live snapshot stays deny-all", () => {
  const bindings = validateCellSnapshot(snapshot([]), CELL, NOW);
  assert.deepEqual(buildHeadscalePolicy(bindings), { grants: [] });
});

test("single-account live nodes project only Remote Computer TCP port", () => {
  const bindings = validateCellSnapshot(snapshot([
    row({ deviceId: "device-b", nodeId: "100.64.0.11" }),
    row(),
  ]), CELL, NOW);
  assert.deepEqual(buildHeadscalePolicy(bindings), {
    grants: [{
      src: ["*"],
      dst: ["100.64.0.10", "100.64.0.11"],
      ip: [`tcp:${REMOTE_TARGET_PORT}`],
    }],
  });
});

test("mixed Fabushi accounts fail closed", () => {
  assert.throws(
    () => validateCellSnapshot(snapshot([
      row(),
      row({ userId: "user:account-b", deviceId: "device-b", nodeId: "100.64.0.11" }),
    ]), CELL, NOW),
    /mixed Fabushi accounts/u,
  );
});

test("stale, public, duplicate and foreign-cell bindings fail closed", () => {
  for (const bindings of [
    [row({ expiresAt: NOW })],
    [row({ nodeId: "8.8.8.8" })],
    [row(), row({ deviceId: "device-b" })],
    [row({ cellId: "cell-fdn-account-b" })],
  ]) {
    assert.throws(() => validateCellSnapshot(snapshot(bindings), CELL, NOW));
  }
});

test("unexpected fields and oversized snapshots fail closed", () => {
  assert.throws(() => validateCellSnapshot({
    ...snapshot(),
    proofSha256: "a".repeat(64),
  }, CELL, NOW));
  assert.throws(() => validateCellSnapshot(snapshot([{
    ...row(),
    deviceSecret: "must-not-be-accepted",
  }]), CELL, NOW));

  const bindings = Array.from({ length: MAX_BINDINGS + 1 }, (_, index) => row({
    deviceId: `device-${index}`,
    nodeId: `100.64.${Math.floor(index / 250)}.${(index % 250) + 1}`,
  }));
  assert.throws(() => validateCellSnapshot(snapshot(bindings), CELL, NOW));
});

test("Core snapshot call uses only dedicated network authority header", async () => {
  const token = "n".repeat(64);
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url: String(url), options };
    return { ok: true, status: 200, json: async () => snapshot([]) };
  };
  await fetchCoreCellSnapshot({
    fetchImpl,
    coreBaseUrl: "https://api.ombhrum.com",
    authorityToken: token,
    cellId: CELL,
  });
  assert.match(captured.url, /\/v1\/internal\/computers\/network-bindings\/cell-snapshot$/u);
  assert.equal(captured.options.headers["X-Fabushi-Network-Authority"], token);
  assert.equal(captured.options.headers.authorization, undefined);
  assert.equal(captured.options.body, JSON.stringify({ cellId: CELL }));
});
