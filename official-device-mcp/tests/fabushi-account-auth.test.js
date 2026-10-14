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
