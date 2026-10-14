import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DOMAIN_SECRET = "fabushi-fdn-enrollment-broker-secret-v1\0";
const DOMAIN_PROOF = "fabushi-fdn-headscale-node-proof-v1\0";
const MAX_STATE_BYTES = 1024 * 1024;

export class EnrollmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EnrollmentError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new EnrollmentError(code, message);
}

function text(value, max = 256) {
  const v = String(value ?? "").trim();
  if (!v || v.length > max) return "";
  return v;
}

function exactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === allowed.length && keys.every((key, index) => key === [...allowed].sort()[index]);
}

function sha256Hex(parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(String(part));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function enrollmentSecretDigest(secret) {
  const v = text(secret, 512);
  if (v.length < 80) fail("invalid_grant_secret", "grantSecret is invalid");
  return sha256Hex([DOMAIN_SECRET, v]);
}

export function constantTimeHexEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseStateKey(raw) {
  const key = Buffer.from(String(raw ?? ""), "base64");
  if (key.length !== 32) fail("invalid_state_key", "FABUSHI_FDN_ENROLLMENT_STATE_KEY_B64 must decode to 32 bytes");
  return key;
}

function aadFor(row) {
  return Buffer.from(
    [row.grantId, row.userId, row.deviceId, row.cellId, row.generation, row.preAuthKeyId].join("\0"),
    "utf8",
  );
}

export function encryptAuthKey(rawKey, row, stateKeyB64) {
  const key = parseStateKey(stateKeyB64);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aadFor(row));
  const ciphertext = Buffer.concat([cipher.update(String(rawKey), "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptAuthKey(envelope, row, stateKeyB64) {
  if (!envelope || typeof envelope !== "object") fail("missing_auth_key", "encrypted enrollment key is unavailable");
  try {
    const key = parseStateKey(stateKeyB64);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(aadFor(row));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    fail("auth_key_decrypt_failed", "encrypted enrollment key failed authentication");
  }
}

export class JsonStateStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  read() {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.size > MAX_STATE_BYTES) fail("state_too_large", "enrollment state exceeds size bound");
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || parsed.version !== 1 || typeof parsed.enrollments !== "object") {
        fail("state_invalid", "enrollment state is invalid");
      }
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, enrollments: {} };
      if (error instanceof EnrollmentError) throw error;
      fail("state_read_failed", "unable to read enrollment state");
    }
  }

  write(state) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const payload = JSON.stringify(state, null, 2) + "\n";
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) fail("state_too_large", "enrollment state exceeds size bound");
    try {
      fs.writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
}

function validateGrantId(value) {
  const v = text(value, 96);
  if (!/^network-enroll-[a-f0-9]{32}$/.test(v)) fail("invalid_grant_id", "grantId is invalid");
  return v;
}

function validateCell(value) {
  const v = text(value, 128);
  if (!/^cell-[A-Za-z0-9_-]{16,96}$/.test(v)) fail("invalid_cell_id", "Core cellId is invalid");
  return v;
}

function validateCoreProjection(value) {
  if (!exactKeys(value, ["userId", "deviceId", "cellId", "generation", "expiresAt"])) {
    fail("core_projection_invalid", "Core enrollment projection shape is invalid");
  }
  const userId = text(value.userId, 160);
  const deviceId = text(value.deviceId, 128);
  const cellId = validateCell(value.cellId);
  const generation = Number(value.generation);
  const expiresAt = Number(value.expiresAt);
  if (!userId || !deviceId || !Number.isSafeInteger(generation) || generation < 1 ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    fail("core_projection_invalid", "Core enrollment projection identity is invalid");
  }
  return { userId, deviceId, cellId, generation, expiresAt };
}

function authKeyPrefix(rawKey) {
  const match = /^hskey-auth-([A-Za-z0-9_-]{12})-[A-Za-z0-9_-]{64}$/.exec(String(rawKey));
  if (!match) fail("headscale_key_invalid", "Headscale returned an invalid pre-auth key");
  return `hskey-auth-${match[1]}-***`;
}

function normalizeArray(value, property) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value[property])) return value[property];
  return [];
}

export function resolvePreAuthKeyId(listing, rawKey, cellId) {
  const masked = authKeyPrefix(rawKey);
  const rows = normalizeArray(listing, "preAuthKeys");
  const matches = rows.filter((row) => {
    if (!row || row.key !== masked) return false;
    const ownerName = text(row.user?.name, 128);
    return ownerName === cellId;
  });
  if (matches.length !== 1) fail("preauth_key_correlation_failed", "minted Headscale key did not resolve uniquely");
  const id = Number(matches[0].id);
  if (!Number.isSafeInteger(id) || id < 1) fail("preauth_key_correlation_failed", "Headscale pre-auth key id is invalid");
  return id;
}

function ipv4Number(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255 || String(n) !== String(Number(p))) return null;
    out = (out * 256) + n;
  }
  return out >>> 0;
}

function isCgnat(value) {
  const n = ipv4Number(value);
  if (n === null) return false;
  const start = ipv4Number("100.64.0.0");
  const end = ipv4Number("100.127.255.255");
  return n >= start && n <= end;
}

function expandIpv6(value) {
  if (net.isIP(value) !== 6) return null;
  const [leftRaw, rightRaw = ""] = String(value).toLowerCase().split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if (!String(value).includes("::") && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((word) => {
    if (!/^[0-9a-f]{1,4}$/.test(word)) return null;
    return Number.parseInt(word, 16);
  });
  if (words.some((word) => word === null) || words.length !== 8) return null;
  return words;
}

function isTailscaleUla(value) {
  const words = expandIpv6(value);
  return Boolean(words && words[0] === 0xfd7a && words[1] === 0x115c && words[2] === 0xa1e0);
}

export function selectNodeAddress(addresses) {
  if (!Array.isArray(addresses)) fail("node_address_invalid", "Headscale node addresses are invalid");
  const clean = addresses.map((item) => text(item, 128)).filter(Boolean);
  const v4 = clean.find((item) => net.isIP(item) === 4 && isCgnat(item));
  if (v4) return v4;
  const v6 = clean.find((item) => isTailscaleUla(item));
  if (v6) return v6.toLowerCase();
  fail("node_address_invalid", "Headscale node has no trusted Tailscale address");
}

export function resolveNodeForPreAuthKey(listing, preAuthKeyId, cellId) {
  const rows = normalizeArray(listing, "nodes");
  const matches = rows.filter((row) => {
    if (!row || Number(row.preAuthKey?.id) !== Number(preAuthKeyId)) return false;
    const owner = text(row.user?.name, 128);
    return owner === cellId;
  });
  if (matches.length !== 1) fail("node_correlation_failed", "Headscale node did not resolve uniquely from pre-auth key");
  const row = matches[0];
  const machineKey = text(row.machineKey, 256);
  const nodeKey = text(row.nodeKey, 256);
  if (!machineKey || !nodeKey) fail("node_correlation_failed", "Headscale node identity is incomplete");
  return {
    nodeId: selectNodeAddress(row.ipAddresses),
    machineKey,
    nodeKey,
    expiry: row.expiry ? Date.parse(row.expiry) : null,
  };
}

export function proofSha256(row, node) {
  return sha256Hex([
    DOMAIN_PROOF,
    row.cellId,
    row.userId,
    row.deviceId,
    row.generation,
    row.preAuthKeyId,
    node.nodeId,
    node.machineKey,
    node.nodeKey,
  ]);
}

function bindingExpirySeconds(node, nowSeconds) {
  const max = nowSeconds + (24 * 60 * 60) - 60;
  if (Number.isFinite(node.expiry)) {
    const seconds = Math.floor(node.expiry / 1000);
    if (seconds > nowSeconds) return Math.min(seconds, max);
  }
  return max;
}

function validateBindResponse(value, expected) {
  if (!value || value.ok !== true ||
      value.userId !== expected.userId ||
      value.deviceId !== expected.deviceId ||
      Number(value.generation) !== expected.generation ||
      Number(value.expiresAt) !== expected.bindingExpiresAt) {
    fail("core_bind_mismatch", "Core network bind response identity mismatch");
  }
}

function validateSnapshot(value, expected) {
  if (!value || value.cellId !== expected.cellId || !Array.isArray(value.bindings)) return false;
  return value.bindings.some((row) =>
    row?.userId === expected.userId &&
    row?.deviceId === expected.deviceId &&
    row?.cellId === expected.cellId &&
    Number(row?.generation) === expected.generation &&
    row?.nodeId === expected.nodeId
  );
}

export class CoreClient {
  constructor({ baseUrl, authorityToken, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
    this.baseUrl = String(baseUrl ?? "").replace(/\/+$/, "");
    this.authorityToken = String(authorityToken ?? "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    if (!/^https:\/\//.test(this.baseUrl) && !/^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(this.baseUrl)) {
      fail("invalid_core_url", "FABUSHI_PLATFORM_CORE_URL must be HTTPS");
    }
    if (this.authorityToken.length < 48) fail("invalid_network_authority", "FDN_NETWORK_AUTHORITY_TOKEN is invalid");
  }

  async post(route, body) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${route}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fabushi-network-authority": this.authorityToken,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new EnrollmentError("network_outcome_unknown", "Core request outcome is unknown");
    }
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const error = new EnrollmentError("core_rejected", `Core rejected request with status ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  redeem(grantId, grantSecret) {
    return this.post("/v1/internal/computers/network-enrollment-grants/redeem", { grantId, grantSecret });
  }

  bind(body) {
    return this.post("/v1/internal/computers/network-bindings/bind", body);
  }

  snapshot(cellId) {
    return this.post("/v1/internal/computers/network-bindings/cell-snapshot", { cellId });
  }
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 1024 * 1024) child.kill(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 1024 * 1024) child.kill(); });
    child.on("error", () => reject(new EnrollmentError("command_outcome_unknown", "coordinator command outcome is unknown")));
    child.on("close", (code) => {
      if (code !== 0) {
        const err = new EnrollmentError("command_failed", "coordinator command failed");
        err.exitCode = code;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

export class HeadscaleClient {
  constructor({ cwd }) {
    this.cwd = cwd;
  }

  async mint(cellId, ttlSeconds) {
    const stdout = await spawnCapture("bash", ["./mint-enrollment-key.sh"], {
      cwd: this.cwd,
      env: {
        ...process.env,
        FABUSHI_FDN_CELL_ID: cellId,
        FABUSHI_FDN_ENROLLMENT_TTL_SECONDS: String(ttlSeconds),
      },
    });
    return stdout.replace(/\r|\n/g, "");
  }

  async json(args) {
    const stdout = await spawnCapture("docker", ["compose", "exec", "-T", "headscale", "headscale", ...args, "--output", "json"], { cwd: this.cwd, env: process.env });
    try { return JSON.parse(stdout); } catch { fail("headscale_json_invalid", "Headscale returned invalid JSON"); }
  }

  preAuthKeys() {
    return this.json(["preauthkeys", "list"]);
  }

  nodes() {
    return this.json(["nodes", "list"]);
  }
}

export class EnrollmentBroker {
  constructor({ store, core, headscale, stateKeyB64, cellId, now = () => Math.floor(Date.now() / 1000) }) {
    this.store = store;
    this.core = core;
    this.headscale = headscale;
    this.stateKeyB64 = stateKeyB64;
    this.cellId = validateCell(cellId);
    this.now = now;
  }

  async start(input) {
    if (!exactKeys(input, ["grantId", "grantSecret"])) fail("invalid_request", "start request shape is invalid");
    const grantId = validateGrantId(input.grantId);
    const secretDigest = enrollmentSecretDigest(input.grantSecret);
    const state = this.store.read();
    const existing = state.enrollments[grantId];
    if (existing) {
      if (!constantTimeHexEqual(existing.secretDigest, secretDigest)) fail("grant_secret_mismatch", "grantSecret does not match existing enrollment");
      if (existing.status === "key_ready") {
        if (existing.expiresAt <= this.now()) fail("enrollment_expired", "enrollment key expired");
        return {
          grantId,
          authKey: decryptAuthKey(existing.authKeyEnvelope, existing, this.stateKeyB64),
          cellId: existing.cellId,
          generation: existing.generation,
          expiresAt: existing.expiresAt,
          reconciled: true,
        };
      }
      if (existing.status === "completed") {
        return { grantId, completed: true, nodeId: existing.nodeId, generation: existing.generation, reconciled: true };
      }
      if (String(existing.status).endsWith("_outcome_unknown")) {
        fail(existing.status, "enrollment has an uncertain prior outcome");
      }
      fail("enrollment_state_conflict", "enrollment cannot be restarted in its current state");
    }

    state.enrollments[grantId] = { grantId, secretDigest, status: "redeeming", createdAt: this.now() };
    this.store.write(state);

    let projection;
    try {
      projection = validateCoreProjection(await this.core.redeem(grantId, input.grantSecret));
    } catch (error) {
      if (error?.code === "network_outcome_unknown") {
        state.enrollments[grantId].status = "redeem_outcome_unknown";
        this.store.write(state);
      } else {
        state.enrollments[grantId].status = "redeem_rejected";
        this.store.write(state);
      }
      throw error;
    }
    if (projection.cellId !== this.cellId) {
      state.enrollments[grantId].status = "cell_mismatch";
      this.store.write(state);
      fail("cell_mismatch", "Core enrollment grant belongs to another cell");
    }
    Object.assign(state.enrollments[grantId], projection, { status: "redeemed" });
    this.store.write(state);

    const ttl = Math.min(300, projection.expiresAt - this.now());
    if (ttl < 15) {
      state.enrollments[grantId].status = "enrollment_expired";
      this.store.write(state);
      fail("enrollment_expired", "Core enrollment grant has insufficient remaining lifetime");
    }

    let rawKey;
    try {
      rawKey = await this.headscale.mint(projection.cellId, ttl);
    } catch (error) {
      state.enrollments[grantId].status = "mint_outcome_unknown";
      this.store.write(state);
      throw error;
    }

    let preAuthKeyId;
    try {
      preAuthKeyId = resolvePreAuthKeyId(await this.headscale.preAuthKeys(), rawKey, projection.cellId);
    } catch (error) {
      state.enrollments[grantId].status = "mint_outcome_unknown";
      this.store.write(state);
      throw error;
    }

    const row = {
      ...state.enrollments[grantId],
      preAuthKeyId,
      status: "key_ready",
    };
    row.authKeyEnvelope = encryptAuthKey(rawKey, row, this.stateKeyB64);
    state.enrollments[grantId] = row;
    this.store.write(state);
    return {
      grantId,
      authKey: rawKey,
      cellId: row.cellId,
      generation: row.generation,
      expiresAt: row.expiresAt,
      reconciled: false,
    };
  }

  async complete(input) {
    if (!exactKeys(input, ["grantId"])) fail("invalid_request", "complete request shape is invalid");
    const grantId = validateGrantId(input.grantId);
    const state = this.store.read();
    const row = state.enrollments[grantId];
    if (!row) fail("enrollment_not_found", "enrollment state was not found");
    if (row.status === "completed") {
      return { grantId, completed: true, nodeId: row.nodeId, generation: row.generation, reconciled: true };
    }
    if (row.status === "bind_outcome_unknown") {
      const snapshot = await this.core.snapshot(row.cellId);
      if (!validateSnapshot(snapshot, row)) fail("bind_outcome_unknown", "Core bind outcome remains unknown");
      row.status = "completed";
      delete row.authKeyEnvelope;
      row.completedAt = this.now();
      state.enrollments[grantId] = row;
      this.store.write(state);
      return { grantId, completed: true, nodeId: row.nodeId, generation: row.generation, reconciled: true };
    }
    if (row.status !== "key_ready") fail("enrollment_state_conflict", "enrollment is not ready for completion");

    const node = resolveNodeForPreAuthKey(await this.headscale.nodes(), row.preAuthKeyId, row.cellId);
    const now = this.now();
    const bindingExpiresAt = bindingExpirySeconds(node, now);
    const proof = proofSha256(row, node);
    Object.assign(row, {
      nodeId: node.nodeId,
      proofSha256: proof,
      bindingExpiresAt,
      machineKeySha256: sha256Hex([node.machineKey]),
      nodeKeySha256: sha256Hex([node.nodeKey]),
      status: "binding",
    });
    state.enrollments[grantId] = row;
    this.store.write(state);

    const body = {
      userId: row.userId,
      deviceId: row.deviceId,
      cellId: row.cellId,
      nodeId: row.nodeId,
      proofSha256: row.proofSha256,
      generation: row.generation,
      expiresAt: row.bindingExpiresAt,
    };
    let response;
    try {
      response = await this.core.bind(body);
    } catch (error) {
      if (error?.code === "network_outcome_unknown") {
        row.status = "bind_outcome_unknown";
        state.enrollments[grantId] = row;
        this.store.write(state);
      } else {
        row.status = "bind_rejected";
        state.enrollments[grantId] = row;
        this.store.write(state);
      }
      throw error;
    }
    validateBindResponse(response, row);
    row.status = "completed";
    row.completedAt = this.now();
    delete row.authKeyEnvelope;
    state.enrollments[grantId] = row;
    this.store.write(state);
    return { grantId, completed: true, nodeId: row.nodeId, generation: row.generation, reconciled: false };
  }
}

async function readStdinJson() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (data.length > 64 * 1024) fail("request_too_large", "request exceeds size bound");
  }
  try { return JSON.parse(data); } catch { fail("invalid_json", "stdin must contain one JSON object"); }
}

async function main() {
  const action = process.argv[2];
  if (!["start", "complete"].includes(action)) fail("invalid_action", "expected start or complete");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const store = new JsonStateStore(process.env.FABUSHI_FDN_ENROLLMENT_STATE_PATH || path.join(here, "runtime", "enrollment-state.json"));
  const core = new CoreClient({
    baseUrl: process.env.FABUSHI_PLATFORM_CORE_URL,
    authorityToken: process.env.FDN_NETWORK_AUTHORITY_TOKEN,
  });
  const headscale = new HeadscaleClient({ cwd: here });
  const broker = new EnrollmentBroker({
    store,
    core,
    headscale,
    stateKeyB64: process.env.FABUSHI_FDN_ENROLLMENT_STATE_KEY_B64,
    cellId: process.env.FABUSHI_FDN_CELL_ID,
  });
  const result = action === "start" ? await broker.start(await readStdinJson()) : await broker.complete(await readStdinJson());
  process.stdout.write(JSON.stringify(result) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = error?.code || "enrollment_failed";
    process.stderr.write(JSON.stringify({ error: code, message: String(error?.message || "enrollment failed") }) + "\n");
    process.exitCode = 1;
  });
}
