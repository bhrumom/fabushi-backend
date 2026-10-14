import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CoreClient,
  EnrollmentBroker,
  EnrollmentError,
  HeadscaleClient,
  JsonStateStore,
} from "./enrollment-broker.mjs";

const MAX_BODY_BYTES = 64 * 1024;

function safeText(value, max = 512) {
  const text = String(value ?? "").trim();
  return text.length > 0 && text.length <= max ? text : "";
}

function constantTimeTokenEqual(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length === b.length && a.length >= 48 && crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const raw = safeText(req.headers.authorization, 2048);
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(raw);
  return match?.[1] ?? "";
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      throw new EnrollmentError("request_too_large", "request exceeds size bound");
    }
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not object");
    }
    return parsed;
  } catch {
    throw new EnrollmentError("invalid_json", "request body must be one JSON object");
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body) + "\n";
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function publicError(error) {
  const code = error instanceof EnrollmentError ? error.code : "enrollment_failed";
  const recoverable = ![
    "invalid_request",
    "invalid_json",
    "invalid_grant_id",
    "invalid_grant_secret",
    "grant_secret_mismatch",
    "cell_mismatch",
    "core_projection_invalid",
    "core_bind_mismatch",
  ].includes(code);
  return { ok: false, error: { code, recoverable } };
}

function internalTarget(store, grantId) {
  const row = store.read().enrollments?.[grantId];
  if (!row || !row.userId || !row.deviceId || !row.cellId || !Number.isSafeInteger(Number(row.generation))) {
    throw new EnrollmentError("target_identity_unavailable", "enrollment target identity is unavailable");
  }
  return {
    userId: row.userId,
    deviceId: row.deviceId,
    cellId: row.cellId,
    generation: Number(row.generation),
  };
}

export function createEnrollmentService({ broker, store, serviceToken }) {
  if (String(serviceToken ?? "").length < 48) {
    throw new EnrollmentError("invalid_service_token", "FABUSHI_FDN_ENROLLMENT_BROKER_TOKEN is invalid");
  }

  return http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST") {
        return json(res, 405, { ok: false, error: { code: "method_not_allowed", recoverable: false } });
      }
      if (!constantTimeTokenEqual(bearerToken(req), serviceToken)) {
        return json(res, 401, { ok: false, error: { code: "unauthorized", recoverable: false } });
      }

      if (req.url === "/v1/internal/fdn/enrollment/start") {
        const input = await readJson(req);
        const result = await broker.start(input);
        const target = internalTarget(store, input.grantId);
        return json(res, 200, {
          ok: true,
          enrollment: result,
          target,
        });
      }

      if (req.url === "/v1/internal/fdn/enrollment/complete") {
        const input = await readJson(req);
        const result = await broker.complete(input);
        const target = internalTarget(store, input.grantId);
        return json(res, 200, {
          ok: true,
          enrollment: result,
          target,
        });
      }

      return json(res, 404, { ok: false, error: { code: "not_found", recoverable: false } });
    } catch (error) {
      const status = error instanceof EnrollmentError
        ? (String(error.code).includes("invalid") ? 400 : 409)
        : 500;
      return json(res, status, publicError(error));
    }
  });
}

function parsePort(raw) {
  const value = Number(raw ?? 8793);
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) {
    throw new EnrollmentError("invalid_listen_port", "FABUSHI_FDN_ENROLLMENT_PORT is invalid");
  }
  return value;
}

async function main() {
  const host = process.env.FABUSHI_FDN_ENROLLMENT_LISTEN_HOST?.trim() || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new EnrollmentError(
      "non_loopback_forbidden",
      "enrollment service must remain loopback-only behind approved authenticated ingress",
    );
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const store = new JsonStateStore(
    process.env.FABUSHI_FDN_ENROLLMENT_STATE_PATH ||
      path.join(here, "runtime", "enrollment-state.json"),
  );
  const core = new CoreClient({
    baseUrl: process.env.FABUSHI_PLATFORM_CORE_URL,
    authorityToken: process.env.FDN_NETWORK_AUTHORITY_TOKEN,
  });
  const broker = new EnrollmentBroker({
    store,
    core,
    headscale: new HeadscaleClient({ cwd: here }),
    stateKeyB64: process.env.FABUSHI_FDN_ENROLLMENT_STATE_KEY_B64,
    cellId: process.env.FABUSHI_FDN_CELL_ID,
  });
  const service = createEnrollmentService({
    broker,
    store,
    serviceToken: process.env.FABUSHI_FDN_ENROLLMENT_BROKER_TOKEN,
  });
  const port = parsePort(process.env.FABUSHI_FDN_ENROLLMENT_PORT);
  await new Promise((resolve, reject) => {
    service.once("error", reject);
    service.listen(port, host, resolve);
  });
  process.stdout.write(JSON.stringify({ ready: true, host, port }) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error instanceof EnrollmentError ? error.code : "enrollment_service_failed";
    process.stderr.write(JSON.stringify({ error: code }) + "\n");
    process.exitCode = 1;
  });
}
