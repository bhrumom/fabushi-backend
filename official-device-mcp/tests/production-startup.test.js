import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { assertOfficialDeviceMcpProductionStartup } from "../lib/production-startup.js";

const vaultKey = () => randomBytes(32).toString("base64url");

test("shipping startup requires Core service-bound state", () => {
  assert.throws(
    () => assertOfficialDeviceMcpProductionStartup({
      FABUSHI_OFFICIAL_MCP_SERVICE_VAULT_KEY: vaultKey(),
      FABUSHI_FDN_NETWORK_WORKER_ENDPOINT: "http://127.0.0.1:8791/v1/fdn/private-request",
    }),
    /FABUSHI_CORE_SERVICE_STATE_REQUIRED=1/,
  );
});

test("shipping startup validates the encrypted service credential vault key", () => {
  assert.throws(
    () => assertOfficialDeviceMcpProductionStartup({
      FABUSHI_CORE_SERVICE_STATE_REQUIRED: "1",
      FABUSHI_OFFICIAL_MCP_SERVICE_VAULT_KEY: "not-a-32-byte-key",
      FABUSHI_FDN_NETWORK_WORKER_ENDPOINT: "http://127.0.0.1:8791/v1/fdn/private-request",
    }),
    /32 bytes/,
  );
});

test("shipping startup requires a bounded first-party private transport", () => {
  assert.throws(
    () => assertOfficialDeviceMcpProductionStartup({
      FABUSHI_CORE_SERVICE_STATE_REQUIRED: "1",
      FABUSHI_OFFICIAL_MCP_SERVICE_VAULT_KEY: vaultKey(),
    }),
    /network worker|reverse-WebSocket/i,
  );
});

test("shipping startup rejects a non-loopback network worker endpoint", () => {
  assert.throws(
    () => assertOfficialDeviceMcpProductionStartup({
      FABUSHI_CORE_SERVICE_STATE_REQUIRED: "1",
      FABUSHI_OFFICIAL_MCP_SERVICE_VAULT_KEY: vaultKey(),
      FABUSHI_FDN_NETWORK_WORKER_ENDPOINT: "http://203.0.113.10:8791/v1/fdn/private-request",
    }),
    /loopback/i,
  );
});

test("shipping startup accepts the loopback worker and explicit authenticated fallback", () => {
  assert.deepEqual(
    assertOfficialDeviceMcpProductionStartup({
      FABUSHI_CORE_SERVICE_STATE_REQUIRED: "1",
      FABUSHI_OFFICIAL_MCP_SERVICE_VAULT_KEY: vaultKey(),
      FABUSHI_FDN_NETWORK_WORKER_ENDPOINT: "http://127.0.0.1:8791/v1/fdn/private-request",
      FABUSHI_FDN_REMOTE_TARGET_PORT: "8792",
    }),
    { coreServiceStateRequired: true, privateTransport: "network-worker" },
  );
  assert.deepEqual(
    assertOfficialDeviceMcpProductionStartup({
      FABUSHI_CORE_SERVICE_STATE_REQUIRED: "1",
      FABUSHI_OFFICIAL_MCP_SERVICE_VAULT_KEY: vaultKey(),
      FABUSHI_FDN_AUTHENTICATED_REVERSE_WS_FALLBACK: "1",
    }),
    { coreServiceStateRequired: true, privateTransport: "authenticated-reverse-websocket" },
  );
});
