import { randomBytes } from "node:crypto";

const DEFAULT_WORKER_ENDPOINT = "http://127.0.0.1:8791/v1/fdn/private-request";
const DEFAULT_REMOTE_PORT = 8792;
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 600;

function loopbackEndpoint(value) {
  const url = new URL(String(value || DEFAULT_WORKER_ENDPOINT));
  if (url.protocol !== "http:"
      || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase())
      || url.username || url.password || url.search || url.hash
      || url.pathname !== "/v1/fdn/private-request") {
    throw new TypeError("FDN network worker endpoint must be the fixed loopback HTTP path.");
  }
  return url.toString();
}

function boundedRoute(input) {
  const cellId = String(input?.networkRoute?.cellId || input?.cellId || "").trim();
  const nodeId = String(input?.networkRoute?.nodeId || input?.nodeId || "").trim();
  const generation = Number(input?.networkRoute?.generation ?? input?.networkGeneration);
  const expiresAt = Number(input?.networkRoute?.expiresAt ?? input?.networkExpiresAt);
  if (!/^[A-Za-z0-9._:-]{8,160}$/u.test(cellId)
      || !/^[A-Za-z0-9._:-]{3,160}$/u.test(nodeId)
      || !Number.isSafeInteger(generation) || generation <= 0
      || !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new Error("FDN network worker route is invalid or expired.");
  }
  return { cellId, nodeId, generation, expiresAt };
}

async function boundedJsonResponse(response, expected) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("FDN network worker response exceeded the bounded result size.");
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("FDN network worker returned invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("FDN network worker returned an invalid envelope.");
  }
  if (String(parsed.requestId || "") !== expected.requestId
      || String(parsed.deviceId || "") !== expected.deviceId
      || String(parsed.nodeId || "") !== expected.nodeId
      || Number(parsed.generation) !== expected.generation) {
    throw new Error("FDN network worker response failed route/request correlation.");
  }
  if (!response.ok) {
    const dispatchState = String(parsed.dispatchState || "outcome_unknown");
    const error = new Error(`FDN network worker rejected the request with HTTP ${response.status}.`);
    error.dispatchState = dispatchState;
    error.notDispatched = response.status === 503
      && parsed.ok === false
      && dispatchState === "not_dispatched";
    throw error;
  }
  if (parsed.dispatchState != null && parsed.dispatchState !== "completed") {
    throw new Error("FDN network worker returned an uncertain dispatch state.");
  }
  return parsed;
}

export function createLocalNetworkWorkerPrivateTransport(options = {}) {
  const endpoint = loopbackEndpoint(options.endpoint ?? process.env.FABUSHI_FDN_NETWORK_WORKER_ENDPOINT);
  const fetchImpl = options.fetchImpl ?? fetch;
  const remotePort = Number(options.remotePort ?? process.env.FABUSHI_FDN_REMOTE_TARGET_PORT ?? DEFAULT_REMOTE_PORT);
  if (!Number.isSafeInteger(remotePort) || remotePort < 1024 || remotePort > 65535) {
    throw new TypeError("FDN Remote Computer target port is invalid.");
  }

  return {
    async request(input = {}) {
      const accountId = String(input.accountId || "").trim();
      const deviceId = String(input.deviceId || "").trim();
      if (!accountId || accountId.length > 200 || !/^[A-Za-z0-9._:-]{1,128}$/u.test(deviceId)) {
        throw new Error("FDN network worker request identity is invalid.");
      }
      const route = boundedRoute(input);
      const timeoutSeconds = Math.min(
        Math.max(Number(input.timeoutSeconds) || 30, MIN_TIMEOUT_SECONDS),
        MAX_TIMEOUT_SECONDS,
      );
      const payload = input.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new TypeError("FDN private payload must be an object.");
      }
      const frame = `${JSON.stringify(payload)}\n`;
      if (Buffer.byteLength(frame) > MAX_REQUEST_BYTES) {
        throw new Error("FDN private request exceeded the target frame limit.");
      }
      const requestId = randomBytes(16).toString("hex");
      const body = JSON.stringify({
        requestId,
        accountId,
        deviceId,
        cellId: route.cellId,
        nodeId: route.nodeId,
        generation: route.generation,
        expiresAt: route.expiresAt,
        targetPort: remotePort,
        timeoutMs: Math.floor(timeoutSeconds * 1000),
        frame,
      });
      const timeoutSignal = AbortSignal.timeout(Math.floor(timeoutSeconds * 1000) + 2_000);
      const requestSignal = input.signal && typeof input.signal.aborted === "boolean"
        ? AbortSignal.any([timeoutSignal, input.signal])
        : timeoutSignal;
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        signal: requestSignal,
      });
      const envelope = await boundedJsonResponse(response, {
        requestId,
        deviceId,
        nodeId: route.nodeId,
        generation: route.generation,
      });
      if (envelope.ok !== true
          || !envelope.result || typeof envelope.result !== "object" || Array.isArray(envelope.result)) {
        throw new Error("FDN network worker response failed route/request correlation.");
      }
      return envelope.result;
    },
  };
}
