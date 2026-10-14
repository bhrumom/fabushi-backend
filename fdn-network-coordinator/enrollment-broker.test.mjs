import assert from "node:assert/strict";
import test from "node:test";

import {
  EnrollmentBroker,
  EnrollmentError,
  constantTimeHexEqual,
  decryptAuthKey,
  encryptAuthKey,
  enrollmentSecretDigest,
  proofSha256,
  resolveNodeForPreAuthKey,
  resolvePreAuthKeyId,
  selectNodeAddress,
} from "./enrollment-broker.mjs";

const GRANT_ID = "network-enroll-0123456789abcdef0123456789abcdef";
const GRANT_SECRET = "fne_" + "a".repeat(90);
const CELL = "cell-abcdefghijklmnopqrstuvwx12345678";
const KEY = "hskey-auth-AbCdEfGh1234-" + "Z".repeat(64);
const STATE_KEY = Buffer.alloc(32, 7).toString("base64");

class MemoryStore {
  constructor() { this.state = { version: 1, enrollments: {} }; }
  read() { return structuredClone(this.state); }
  write(value) { this.state = structuredClone(value); }
}

function projection(now = 1_800_000_000) {
  return {
    userId: "user:account-one",
    deviceId: "desktop-device-1",
    cellId: CELL,
    generation: 3,
    expiresAt: now + 240,
  };
}

function preauthListing() {
  return [{
    id: 77,
    key: "hskey-auth-AbCdEfGh1234-***",
    user: { id: 9, name: CELL },
    used: false,
  }];
}

function nodeListing() {
  return [{
    id: 55,
    user: { id: 9, name: CELL },
    preAuthKey: { id: 77, key: "hskey-auth-AbCdEfGh1234-***" },
    ipAddresses: ["100.64.0.10", "fd7a:115c:a1e0::10"],
    machineKey: "mkey:machine-public",
    nodeKey: "nodekey:node-public",
    expiry: "2027-01-15T00:00:00Z",
  }];
}

test("secret digest is stable, domain separated, and constant-time comparable", () => {
  const a = enrollmentSecretDigest(GRANT_SECRET);
  const b = enrollmentSecretDigest(GRANT_SECRET);
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(constantTimeHexEqual(a, b), true);
  assert.equal(constantTimeHexEqual(a, "0".repeat(64)), false);
});

test("AES-GCM envelope authenticates enrollment identity and rejects tamper", () => {
  const row = {
    grantId: GRANT_ID,
    userId: "user:account-one",
    deviceId: "desktop-device-1",
    cellId: CELL,
    generation: 3,
    preAuthKeyId: 77,
  };
  const envelope = encryptAuthKey(KEY, row, STATE_KEY);
  assert.equal(decryptAuthKey(envelope, row, STATE_KEY), KEY);
  const tamperedBytes = Buffer.from(envelope.ciphertext, "base64url");
  tamperedBytes[0] ^= 0x01;
  const tampered = { ...envelope, ciphertext: tamperedBytes.toString("base64url") };
  assert.throws(() => decryptAuthKey(tampered, row, STATE_KEY), (error) => error instanceof EnrollmentError && error.code === "auth_key_decrypt_failed");
  assert.throws(() => decryptAuthKey(envelope, { ...row, generation: 4 }, STATE_KEY), (error) => error.code === "auth_key_decrypt_failed");
});

test("pre-auth key correlation requires exact masked prefix and Core-derived cell", () => {
  assert.equal(resolvePreAuthKeyId(preauthListing(), KEY, CELL), 77);
  assert.throws(() => resolvePreAuthKeyId(preauthListing(), KEY, "cell-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"), (error) => error.code === "preauth_key_correlation_failed");
  assert.throws(() => resolvePreAuthKeyId([...preauthListing(), ...preauthListing()], KEY, CELL), (error) => error.code === "preauth_key_correlation_failed");
});

test("node correlation uses exact preAuthKey id and trusted Tailscale address", () => {
  const node = resolveNodeForPreAuthKey(nodeListing(), 77, CELL);
  assert.equal(node.nodeId, "100.64.0.10");
  assert.equal(selectNodeAddress(["fd7a:115c:a1e0::1234"]), "fd7a:115c:a1e0::1234");
  assert.throws(() => selectNodeAddress(["192.168.1.5", "fd00::1"]), (error) => error.code === "node_address_invalid");
  assert.throws(() => resolveNodeForPreAuthKey(nodeListing(), 78, CELL), (error) => error.code === "node_correlation_failed");
});

test("node proof is deterministic and changes with coordinator-observed identity", () => {
  const row = { ...projection(), preAuthKeyId: 77 };
  const node = resolveNodeForPreAuthKey(nodeListing(), 77, CELL);
  const a = proofSha256(row, node);
  const b = proofSha256(row, node);
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, proofSha256(row, { ...node, nodeKey: "nodekey:other" }));
});

test("start redeems Core exactly once, mints one key, and reconciles retry", async () => {
  const now = 1_800_000_000;
  const store = new MemoryStore();
  let redeems = 0;
  let mints = 0;
  const broker = new EnrollmentBroker({
    store,
    stateKeyB64: STATE_KEY,
    cellId: CELL,
    now: () => now,
    core: {
      async redeem(grantId, grantSecret) {
        redeems += 1;
        assert.equal(grantId, GRANT_ID);
        assert.equal(grantSecret, GRANT_SECRET);
        return projection(now);
      },
    },
    headscale: {
      async mint(cellId, ttl) {
        mints += 1;
        assert.equal(cellId, CELL);
        assert.equal(ttl, 240);
        return KEY;
      },
      async preAuthKeys() { return preauthListing(); },
    },
  });
  const first = await broker.start({ grantId: GRANT_ID, grantSecret: GRANT_SECRET });
  const second = await broker.start({ grantId: GRANT_ID, grantSecret: GRANT_SECRET });
  assert.equal(first.authKey, KEY);
  assert.equal(second.authKey, KEY);
  assert.equal(second.reconciled, true);
  assert.equal(redeems, 1);
  assert.equal(mints, 1);
  assert.equal(store.state.enrollments[GRANT_ID].status, "key_ready");
  assert.ok(store.state.enrollments[GRANT_ID].authKeyEnvelope);
  assert.equal(JSON.stringify(store.state).includes(GRANT_SECRET), false);
  assert.equal(JSON.stringify(store.state).includes(KEY), false);
});

test("redeem transport uncertainty is durable and never re-redeemed", async () => {
  const store = new MemoryStore();
  let redeems = 0;
  let mints = 0;
  const broker = new EnrollmentBroker({
    store,
    stateKeyB64: STATE_KEY,
    cellId: CELL,
    now: () => 1_800_000_000,
    core: {
      async redeem() {
        redeems += 1;
        throw new EnrollmentError("network_outcome_unknown", "lost response");
      },
    },
    headscale: { async mint() { mints += 1; return KEY; } },
  });
  await assert.rejects(() => broker.start({ grantId: GRANT_ID, grantSecret: GRANT_SECRET }), (error) => error.code === "network_outcome_unknown");
  await assert.rejects(() => broker.start({ grantId: GRANT_ID, grantSecret: GRANT_SECRET }), (error) => error.code === "redeem_outcome_unknown");
  assert.equal(redeems, 1);
  assert.equal(mints, 0);
  assert.equal(store.state.enrollments[GRANT_ID].status, "redeem_outcome_unknown");
});

test("caller cannot supply authority fields", async () => {
  const broker = new EnrollmentBroker({
    store: new MemoryStore(),
    stateKeyB64: STATE_KEY,
    cellId: CELL,
    now: () => 1_800_000_000,
    core: { async redeem() { throw new Error("must not be called"); } },
    headscale: {},
  });
  await assert.rejects(
    () => broker.start({ grantId: GRANT_ID, grantSecret: GRANT_SECRET, cellId: CELL }),
    (error) => error.code === "invalid_request",
  );
});

async function readyBroker({ bindMode = "success", snapshotMatches = false } = {}) {
  const now = 1_800_000_000;
  const store = new MemoryStore();
  let binds = 0;
  let snapshots = 0;
  const core = {
    async redeem() { return projection(now); },
    async bind(body) {
      binds += 1;
      if (bindMode === "unknown") throw new EnrollmentError("network_outcome_unknown", "lost bind response");
      return { ok: true, userId: body.userId, deviceId: body.deviceId, generation: body.generation, expiresAt: body.expiresAt };
    },
    async snapshot(cellId) {
      snapshots += 1;
      const row = store.state.enrollments[GRANT_ID];
      return {
        cellId,
        generatedAt: now,
        bindings: snapshotMatches ? [{
          userId: row.userId,
          deviceId: row.deviceId,
          cellId: row.cellId,
          nodeId: row.nodeId,
          generation: row.generation,
          expiresAt: row.bindingExpiresAt,
        }] : [],
      };
    },
  };
  const broker = new EnrollmentBroker({
    store,
    core,
    stateKeyB64: STATE_KEY,
    cellId: CELL,
    now: () => now,
    headscale: {
      async mint() { return KEY; },
      async preAuthKeys() { return preauthListing(); },
      async nodes() { return nodeListing(); },
    },
  });
  await broker.start({ grantId: GRANT_ID, grantSecret: GRANT_SECRET });
  return { broker, store, counts: () => ({ binds, snapshots }) };
}

test("complete binds exact coordinator-observed node and erases encrypted key", async () => {
  const { broker, store, counts } = await readyBroker();
  const result = await broker.complete({ grantId: GRANT_ID });
  assert.equal(result.completed, true);
  assert.equal(result.nodeId, "100.64.0.10");
  assert.equal(store.state.enrollments[GRANT_ID].status, "completed");
  assert.equal("authKeyEnvelope" in store.state.enrollments[GRANT_ID], false);
  assert.equal(counts().binds, 1);
});

test("bind outcome_unknown reconciles only exact Core snapshot and never blindly rebinds", async () => {
  const setup = await readyBroker({ bindMode: "unknown", snapshotMatches: true });
  await assert.rejects(() => setup.broker.complete({ grantId: GRANT_ID }), (error) => error.code === "network_outcome_unknown");
  assert.equal(setup.store.state.enrollments[GRANT_ID].status, "bind_outcome_unknown");
  const result = await setup.broker.complete({ grantId: GRANT_ID });
  assert.equal(result.completed, true);
  assert.equal(result.reconciled, true);
  assert.equal(setup.counts().binds, 1);
  assert.equal(setup.counts().snapshots, 1);
  assert.equal("authKeyEnvelope" in setup.store.state.enrollments[GRANT_ID], false);
});

test("bind outcome_unknown remains unknown when Core snapshot does not prove exact tuple", async () => {
  const setup = await readyBroker({ bindMode: "unknown", snapshotMatches: false });
  await assert.rejects(() => setup.broker.complete({ grantId: GRANT_ID }), (error) => error.code === "network_outcome_unknown");
  await assert.rejects(() => setup.broker.complete({ grantId: GRANT_ID }), (error) => error.code === "bind_outcome_unknown");
  assert.equal(setup.counts().binds, 1);
  assert.equal(setup.counts().snapshots, 1);
});
