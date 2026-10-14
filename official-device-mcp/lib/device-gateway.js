import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { diskPreflightJsonSchema, diskPreflightSchema, normalizeDiskPreflight } from "./device-disk-safety.js";

const DEFAULT_AGENT_PATH = "/agent";
const DEFAULT_BROWSER_AGENT_PATH = "/browser-agent";
const BROWSER_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_BROWSER_REAUTH_SECONDS = 10 * 60;
const DEFAULT_CALL_TIMEOUT_SECONDS = 120;
const MAX_CALL_TIMEOUT_SECONDS = 600;
const MAX_ARGUMENTS_JSON_CHARS = 20 * 1024 * 1024;
const MAX_RESULT_BYTES = 32 * 1024 * 1024;
const STALE_AFTER_MS = 70_000;
const DEFAULT_DEVICE_LEASE_SECONDS = 2 * 60 * 60;
const MIN_DEVICE_LEASE_SECONDS = 30;
const MAX_DEVICE_LEASE_SECONDS = 4 * 60 * 60;
const MAX_TOOL_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_TOOL_CATALOG_BYTES = 512 * 1024;
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_DEVICES_PER_ACCOUNT = 50;
const MAX_TOTAL_DEVICES = 500;
const MAX_PENDING_CALLS_PER_DEVICE = 16;
const MAX_PENDING_CALLS_TOTAL = 256;

const devices = new Map();
const pendingCalls = new Map();
const attachedServers = new WeakSet();

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = String(req.headers.authorization ?? "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function registryKey(accountId, deviceId) {
  return `${accountId}\0${deviceId}`;
}

function publicToolDescriptor(tool) {
  const name = String(tool?.name ?? "");
  if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(name) || name === "secure_input_submit") return null;
  const descriptor = {
    name,
    ...(tool.title ? { title: String(tool.title).slice(0, 300) } : {}),
    ...(tool.description ? { description: String(tool.description).slice(0, 12_000) } : {}),
    ...(tool.inputSchema && typeof tool.inputSchema === "object" ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.outputSchema && typeof tool.outputSchema === "object" ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations && typeof tool.annotations === "object" ? { annotations: tool.annotations } : {}),
  };
  return Buffer.byteLength(JSON.stringify(descriptor)) <= MAX_TOOL_DESCRIPTOR_BYTES ? descriptor : null;
}

function normalizeToolCatalog(tools, capabilities) {
  const allowed = new Set((Array.isArray(capabilities) ? capabilities : []).map(String));
  const result = [];
  let totalBytes = 0;
  for (const raw of Array.isArray(tools) ? tools.slice(0, 100) : []) {
    const descriptor = publicToolDescriptor(raw);
    if (!descriptor || !allowed.has(descriptor.name)) continue;
    const bytes = Buffer.byteLength(JSON.stringify(descriptor));
    if (totalBytes + bytes > MAX_TOOL_CATALOG_BYTES) break;
    totalBytes += bytes;
    result.push(descriptor);
  }
  return result;
}

function toolCatalogVersion(tools) {
  return tools.length ? createHash("sha256").update(JSON.stringify(tools)).digest("hex") : "";
}

function safeSecureInputPublicKey(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = {
    kty: String(value.kty || ""),
    crv: String(value.crv || ""),
    x: String(value.x || ""),
    y: String(value.y || ""),
  };
  if (key.kty !== "EC" || key.crv !== "P-256") return null;
  if (![key.x, key.y].every((part) => /^[A-Za-z0-9_-]{40,128}$/u.test(part))) return null;
  return key;
}

function safeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = ["kind", "repository", "workflow", "job", "runId", "runAttempt", "sha", "runnerName", "runnerOs", "runnerArch"];
  const output = {};
  for (const key of allowed) {
    const text = String(value[key] ?? "").trim();
    if (text) output[key] = text.slice(0, 300);
  }
  return Buffer.byteLength(JSON.stringify(output)) <= MAX_METADATA_BYTES ? output : {};
}

function humanCallVoIPToken(value) {
  const token = String(value ?? '').trim().toLowerCase();
  if (token.length < 32 || token.length > 512 || token.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(token)) {
    throw new Error('invalid humanCallVoIPToken');
  }
  return token;
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    status: device.status,
    lastSeen: new Date(device.lastSeen).toISOString(),
    expiresAt: device.central ? null : new Date(device.expiresAt).toISOString(),
    capabilities: device.capabilities,
    toolSchemaCount: Array.isArray(device.tools) ? device.tools.length : 0,
    toolSchemaVersion: device.toolSchemaVersion || "",
    metadata: device.metadata,
    secureInputPublicKey: device.secureInputPublicKey,
  };
}

function rejectPendingForSocket(socket, reason) {
  for (const [requestId, pending] of pendingCalls) {
    if (pending.socket !== socket) continue;
    pendingCalls.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
}

function markDisconnected(socket) {
  rejectPendingForSocket(socket, `Device ${socket.deviceId || "unknown"} disconnected before the call completed.`);
  if (!socket.registryKey) return;
  const device = devices.get(socket.registryKey);
  if (!device || device.socket !== socket) return;
  if (device.metadata?.kind === "github-actions") {
    devices.delete(socket.registryKey);
    return;
  }
  device.status = "offline";
  device.socket = null;
  device.lastSeen = Date.now();
}

function rejectSocket(socket, code, reason) {
  try {
    socket.close(code, reason);
  } catch {
    socket.terminate();
  }
}

function rejectUpgrade(socket, status = 401, reason = "Unauthorized") {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } finally {
    socket.destroy();
  }
}

function audit(options, record) {
  try {
    void Promise.resolve(options.audit?.({ at: new Date().toISOString(), ...record })).catch(() => {});
  } catch {
    // Auditing must never break the control channel.
  }
}

async function handleAgentMessage(socket, raw, options) {
  let message;
  try {
    message = JSON.parse(raw.toString("utf8"));
  } catch {
    rejectSocket(socket, 1007, "invalid JSON");
    return;
  }

  if (message.type === "register") {
    const id = String(message.deviceId ?? "").trim();
    const name = String(message.name ?? id).trim();
    const platform = String(message.platform ?? "unknown").trim().slice(0, 80);
    let voipToken = null;
    if (platform === "ios" && Object.prototype.hasOwnProperty.call(message.metadata ?? {}, "humanCallVoIPToken")) {
      try {
        voipToken = humanCallVoIPToken(message.metadata?.humanCallVoIPToken);
      } catch {
        rejectSocket(socket, 1008, "invalid VoIP device registration");
        return;
      }
    }
    const capabilities = Array.isArray(message.capabilities)
      ? [...new Set(message.capabilities.map(String))].slice(0, 100)
      : [];
    if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(id) || !name || name.length > 200 || !socket.accountId) {
      rejectSocket(socket, 1008, "invalid device registration");
      return;
    }

    const tools = normalizeToolCatalog(message.tools, capabilities);
    const toolSchemaVersion = toolCatalogVersion(tools);
    const leaseSeconds = Math.min(
      Math.max(Number(message.leaseSeconds) || Number(options.defaultLeaseSeconds) || DEFAULT_DEVICE_LEASE_SECONDS, MIN_DEVICE_LEASE_SECONDS),
      Number(socket.maxLeaseSeconds) || Number(options.maxLeaseSeconds) || MAX_DEVICE_LEASE_SECONDS,
    );
    const now = Date.now();
    const expiresAt = now + leaseSeconds * 1000;
    const key = registryKey(socket.accountId, id);
    const previous = devices.get(key);
    if (!previous) {
      const accountDeviceCount = [...devices.values()].filter((device) => device.accountId === socket.accountId).length;
      if (accountDeviceCount >= MAX_DEVICES_PER_ACCOUNT || devices.size >= MAX_TOTAL_DEVICES) {
        rejectSocket(socket, 1013, "device registry capacity reached");
        return;
      }
    }
    if (previous?.socket && previous.socket !== socket) {
      rejectPendingForSocket(previous.socket, `Device ${id} reconnected before the call completed.`);
      rejectSocket(previous.socket, 4001, "device reconnected");
    }
    const metadata = safeMetadata(message.metadata);
    const secureInputPublicKey = safeSecureInputPublicKey(message.secureInputPublicKey);
    if (platform === "ios" && typeof options.syncHumanCallVoIPDevice === "function") {
      try {
        await options.syncHumanCallVoIPDevice({
          accountId: socket.accountId,
          deviceId: id,
          accessToken: socket.accountAccessToken || "",
          token: voipToken,
        });
      } catch {
        rejectSocket(socket, 1011, "VoIP device registration unavailable");
        return;
      }
    }
    devices.set(key, {
      accountId: socket.accountId,
      id,
      name,
      platform,
      capabilities,
      tools,
      toolSchemaVersion,
      metadata,
      secureInputPublicKey,
      status: "online",
      lastSeen: now,
      expiresAt,
      socket,
    });
    socket.deviceId = id;
    socket.registryKey = key;
    socket.send(JSON.stringify({ type: "registered", deviceId: id, expiresAt: new Date(expiresAt).toISOString() }));
    audit(options, { type: "device.registered", accountId: socket.accountId, deviceId: id, metadata });
    return;
  }

  if (message.type === "unregister") {
    if (!socket.registryKey || !socket.deviceId) return;
    const current = devices.get(socket.registryKey);
    if (!current || current.socket !== socket) return;
    if (current.platform === "ios" && typeof options.syncHumanCallVoIPDevice === "function") {
      try {
        await options.syncHumanCallVoIPDevice({
          accountId: socket.accountId,
          deviceId: socket.deviceId,
          accessToken: socket.accountAccessToken || "",
          token: null,
        });
      } catch {
        rejectSocket(socket, 1011, "VoIP device revocation unavailable");
        return;
      }
    }
    devices.delete(socket.registryKey);
    socket.send(JSON.stringify({ type: "unregistered", deviceId: socket.deviceId }));
    audit(options, { type: "device.unregistered", accountId: socket.accountId, deviceId: socket.deviceId });
    return;
  }

  if (message.type === "heartbeat") {
    const device = devices.get(socket.registryKey);
    if (device && device.socket === socket) {
      device.lastSeen = Date.now();
      device.status = device.expiresAt > Date.now() ? "online" : "offline";
      if (device.status === "offline") rejectSocket(socket, 4003, "device lease expired");
    }
    return;
  }

  if (message.type === "result") {
    const requestId = String(message.requestId ?? "");
    const pending = pendingCalls.get(requestId);
    if (!pending || pending.registryKey !== socket.registryKey || pending.socket !== socket) return;
    pendingCalls.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }
}

export function attachDeviceGateway(httpServer, options = {}) {
  if (attachedServers.has(httpServer)) return null;
  const path = options.path ?? process.env.DEVICE_GATEWAY_PATH ?? DEFAULT_AGENT_PATH;
  const browserPath = options.browserPath ?? process.env.DEVICE_BROWSER_GATEWAY_PATH ?? DEFAULT_BROWSER_AGENT_PATH;
  const browserExtensionId = String(options.browserExtensionId ?? process.env.FABUSHI_CHROME_EXTENSION_ID ?? "").trim();
  const browserReauthSeconds = Math.max(MIN_DEVICE_LEASE_SECONDS, Math.min(Number(options.browserReauthSeconds) || DEFAULT_BROWSER_REAUTH_SECONDS, MAX_DEVICE_LEASE_SECONDS));
  const browserOrigin = /^[a-p]{32}$/u.test(browserExtensionId) ? `chrome-extension://${browserExtensionId}` : "";
  const resolveAccount = options.resolveAccount;
  const legacyToken = String(options.token ?? process.env.DEVICE_GATEWAY_TOKEN ?? "");
  const legacyAccountId = String(options.legacyAccountId ?? process.env.DEVICE_GATEWAY_LEGACY_ACCOUNT_ID ?? "legacy");
  if (typeof resolveAccount !== "function" && legacyToken.length < 32) return null;
  attachedServers.add(httpServer);

  const centralId = options.centralId ?? process.env.DEVICE_CENTRAL_ID ?? hostname();
  if (options.centralAccountId && Array.isArray(options.centralCapabilities)) {
    const centralTools = normalizeToolCatalog(options.centralTools, options.centralCapabilities);
    devices.set(registryKey(options.centralAccountId, centralId), {
      accountId: options.centralAccountId,
      id: centralId,
      name: options.centralName ?? process.env.DEVICE_CENTRAL_NAME ?? centralId,
      platform: process.platform,
      capabilities: options.centralCapabilities,
      tools: centralTools,
      toolSchemaVersion: toolCatalogVersion(centralTools),
      metadata: { kind: "central" },
      secureInputPublicKey: null,
      status: "online",
      lastSeen: Date.now(),
      expiresAt: Number.MAX_SAFE_INTEGER,
      socket: null,
      central: true,
    });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_RESULT_BYTES });
  const browserWss = new WebSocketServer({ noServer: true, maxPayload: MAX_RESULT_BYTES });
  const onUpgrade = async (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === browserPath) {
      if (typeof resolveAccount !== "function" || !browserOrigin || String(req.headers.origin || "") !== browserOrigin) return rejectUpgrade(socket, 403, "Forbidden");
      browserWss.handleUpgrade(req, socket, head, (ws) => browserWss.emit("connection", ws, req));
      return;
    }
    if (pathname !== path) return;
    const token = bearerToken(req);
    try {
      let account;
      if (typeof resolveAccount === "function") account = await resolveAccount(token, req);
      else if (legacyToken.length >= 32 && safeEqual(token, legacyToken)) account = { userId: legacyAccountId };
      if (!account?.userId) return rejectUpgrade(socket);
      req.fabushiAccount = account;
      req.fabushiAccessToken = token;
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } catch {
      rejectUpgrade(socket);
    }
  };
  httpServer.on("upgrade", onUpgrade);

  wss.on("connection", (socket, req) => {
    socket.accountId = String(req.fabushiAccount?.userId || "");
    socket.accountAccessToken = String(req.fabushiAccessToken || "");
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
      const device = devices.get(socket.registryKey);
      if (device && device.socket === socket) device.lastSeen = Date.now();
    });
    socket.on("message", (raw) => {
      void handleAgentMessage(socket, raw, options).catch(() => rejectSocket(socket, 1011, "device message failed"));
    });
    socket.on("close", () => {
      audit(options, { type: "device.disconnected", accountId: socket.accountId, deviceId: socket.deviceId || "" });
      markDisconnected(socket);
    });
    socket.on("error", () => markDisconnected(socket));
  });

  browserWss.on("connection", (socket) => {
    socket.accountId = "";
    socket.isAlive = true;
    socket.authenticated = false;
    const authTimer = setTimeout(() => rejectSocket(socket, 4003, "browser authentication timed out"), BROWSER_AUTH_TIMEOUT_MS);
    authTimer.unref?.();
    socket.once("message", async (raw) => {
      let message;
      try { message = JSON.parse(raw.toString("utf8")); } catch { return rejectSocket(socket, 1007, "invalid JSON"); }
      if (message?.type !== "authenticate") return rejectSocket(socket, 1008, "browser authentication required");
      try {
        const account = await resolveAccount(String(message.accessToken || ""));
        if (!account?.userId) throw new Error("invalid account");
        socket.accountId = String(account.userId);
        socket.maxLeaseSeconds = browserReauthSeconds;
        socket.authenticated = true;
        clearTimeout(authTimer);
        socket.send(JSON.stringify({ type: "authenticated", accountLabel: String(account.label || "Fabushi").slice(0, 200) }));
        audit(options, { type: "browser.authenticated", accountId: socket.accountId });
        socket.on("message", (nextRaw) => {
          void handleAgentMessage(socket, nextRaw, options).catch(() => rejectSocket(socket, 1011, "device message failed"));
        });
      } catch {
        clearTimeout(authTimer);
        rejectSocket(socket, 4003, "browser authentication failed");
      }
    });
    socket.on("close", () => {
      clearTimeout(authTimer);
      audit(options, { type: "browser.disconnected", accountId: socket.accountId, deviceId: socket.deviceId || "" });
      markDisconnected(socket);
    });
    socket.on("error", () => markDisconnected(socket));
  });

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const socket of [...wss.clients, ...browserWss.clients]) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
    for (const device of devices.values()) {
      if (device.central) continue;
      if (now - device.lastSeen > STALE_AFTER_MS || device.expiresAt <= now) {
        device.status = "offline";
        if (device.socket && device.expiresAt <= now) rejectSocket(device.socket, 4003, "device lease expired");
      }
      if (!device.socket && device.expiresAt + 5 * 60_000 <= now) devices.delete(registryKey(device.accountId, device.id));
    }
  }, 25_000);
  heartbeatTimer.unref();

  return {
    path,
    browserPath,
    close: async () => {
      clearInterval(heartbeatTimer);
      httpServer.off("upgrade", onUpgrade);
      for (const socket of wss.clients) socket.close(1001, "gateway closing");
      for (const socket of browserWss.clients) socket.close(1001, "gateway closing");
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => browserWss.close(resolve));
    },
  };
}

export function listRegisteredDevices(accountId) {
  const normalizedAccountId = String(accountId || "").trim();
  if (!normalizedAccountId) return [];
  const now = Date.now();
  return [...devices.values()]
    .filter((device) => device.accountId === normalizedAccountId)
    .filter((device) => {
      if (device.central) return true;
      const live = device.expiresAt > now
        && now - device.lastSeen <= STALE_AFTER_MS
        && device.status === "online"
        && device.socket
        && device.socket.readyState === 1;
      if (!live) device.status = "offline";
      return live;
    })
    .map(publicDevice)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function describeRegisteredDeviceTool(accountId, deviceId, toolName) {
  const device = devices.get(registryKey(accountId, deviceId));
  if (!device) throw new Error(`Unknown device: ${deviceId}. Call list_devices first.`);
  const tool = Array.isArray(device.tools) ? device.tools.find((entry) => entry.name === toolName) ?? null : null;
  return {
    deviceId,
    toolName,
    available: Boolean(tool),
    schemaVersion: device.toolSchemaVersion || "",
    tool,
    message: tool
      ? `Returned the current schema for ${toolName} on ${deviceId}.`
      : `No schema is registered for ${toolName} on ${deviceId}.`,
  };
}

export async function callRegisteredDevice(accountId, deviceId, toolName, args, timeoutSeconds = DEFAULT_CALL_TIMEOUT_SECONDS, diskPreflight = { impact: "none", reason: "Internal low-level caller classified this operation as no material disk growth.", targets: [] }) {
  const key = registryKey(accountId, deviceId);
  const device = devices.get(key);
  if (!device) throw new Error(`Unknown device: ${deviceId}. Call list_devices first.`);
  if (device.central) throw new Error(`Device ${deviceId} is the central server; use its existing MCP tools directly.`);
  if (device.expiresAt <= Date.now()) throw new Error(`Device ${deviceId} lease has expired.`);
  if (device.status !== "online" || !device.socket || device.socket.readyState !== 1) throw new Error(`Device ${deviceId} is offline.`);
  if (!device.capabilities.includes(toolName)) throw new Error(`Device ${deviceId} does not expose tool ${toolName}.`);

  const pendingForDevice = [...pendingCalls.values()].filter((pending) => pending.registryKey === key).length;
  if (pendingCalls.size >= MAX_PENDING_CALLS_TOTAL || pendingForDevice >= MAX_PENDING_CALLS_PER_DEVICE) {
    throw new Error(`Device ${deviceId} already has too many pending calls.`);
  }
  const requestId = randomBytes(16).toString("hex");
  const timeoutMs = Math.min(Math.max(Number(timeoutSeconds) || DEFAULT_CALL_TIMEOUT_SECONDS, 1), MAX_CALL_TIMEOUT_SECONDS) * 1000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(requestId);
      reject(new Error(`Device call timed out after ${timeoutMs / 1000} seconds.`));
    }, timeoutMs);
    pendingCalls.set(requestId, { registryKey: key, socket: device.socket, resolve, reject, timer });
    device.socket.send(JSON.stringify({ type: "call", requestId, toolName, arguments: args, diskPreflight: normalizeDiskPreflight(diskPreflight) }), (error) => {
      if (!error) return;
      pendingCalls.delete(requestId);
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function resetDeviceGatewayStateForTests() {
  for (const pending of pendingCalls.values()) clearTimeout(pending.timer);
  pendingCalls.clear();
  devices.clear();
}

const deviceShape = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  status: z.enum(["online", "offline"]),
  lastSeen: z.string(),
  expiresAt: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  secureInputPublicKey: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string(), y: z.string() }).nullable(),
  capabilities: z.array(z.string()),
  toolSchemaCount: z.number().int().nonnegative(),
  toolSchemaVersion: z.string(),
});

const toolDescriptorShape = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  annotations: z.unknown().optional(),
});

const describeDeviceToolShape = {
  deviceId: z.string(),
  toolName: z.string(),
  available: z.boolean(),
  schemaVersion: z.string(),
  tool: toolDescriptorShape.nullable(),
  message: z.string(),
};

export const deviceToolOutputShape = {
  deviceId: z.string(),
  toolName: z.string(),
  status: z.enum(["completed", "failed"]),
  resultJson: z.string(),
};

export function registerDeviceTools(server, options = {}) {
  const canRead = options.canRead ?? (() => true);
  const canWrite = options.canWrite ?? (() => true);
  const readAuthError = options.readAuthError ?? (() => ({ isError: true, content: [{ type: "text", text: "Read authorization required." }] }));
  const writeAuthError = options.writeAuthError ?? (() => ({ isError: true, content: [{ type: "text", text: "Write authorization required." }] }));
  const readSecuritySchemes = options.readSecuritySchemes ?? [{ type: "noauth" }];
  const writeSecuritySchemes = options.writeSecuritySchemes ?? [{ type: "oauth2", scopes: ["vps.write"] }];
  const accountId = options.accountId ?? (() => "");
  const requiredAccountId = () => String(typeof accountId === "function" ? accountId() : accountId || "").trim();

  server.registerTool(
    "list_devices",
    {
      title: "List controllable devices",
      description: "Return only the live computers registered to the authenticated Fabushi account. Call this before selecting a device.",
      inputSchema: {},
      outputSchema: { devices: z.array(deviceShape) },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
    },
    async () => {
      if (!canRead()) return readAuthError();
      const accountId = requiredAccountId();
      if (!accountId) return readAuthError();
      const result = { devices: listRegisteredDevices(accountId) };
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );

  server.registerTool(
    "describe_device_tool",
    {
      title: "Describe a device tool",
      description: "Return the latest MCP title, description, input schema, output schema, and annotations for one tool advertised by a selected device.",
      inputSchema: { deviceId: z.string().min(1).max(128), toolName: z.string().min(1).max(128) },
      outputSchema: describeDeviceToolShape,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
    },
    async ({ deviceId, toolName }) => {
      if (!canRead()) return readAuthError();
      const accountId = requiredAccountId();
      if (!accountId) return readAuthError();
      const result = describeRegisteredDeviceTool(accountId, deviceId, toolName);
      return { structuredContent: result, content: [{ type: "text", text: result.message }] };
    }
  );

  server.registerTool(
    "device_call",
    {
      title: "Call a tool on a device",
      description: "Call one advertised MCP tool on a dynamically connected device. Obtain deviceId and toolName from list_devices; use describe_device_tool when the schema is unfamiliar or may have changed; argumentsJson must be a JSON object. diskPreflight is mandatory for every call: impact=none only for operations with no material disk growth; otherwise impact=writes with every affected path and worst-case peak bytes.",
      inputSchema: {
        deviceId: z.string().min(1).max(128),
        toolName: z.string().min(1).max(128),
        argumentsJson: z.string().max(MAX_ARGUMENTS_JSON_CHARS).default("{}"),
        timeoutSeconds: z.number().int().min(1).max(MAX_CALL_TIMEOUT_SECONDS).optional(),
        diskPreflight: diskPreflightSchema,
      },
      outputSchema: deviceToolOutputShape,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      securitySchemes: writeSecuritySchemes,
    },
    async ({ deviceId, toolName, argumentsJson, timeoutSeconds, diskPreflight }) => {
      if (!canWrite()) return writeAuthError();
      let args;
      try {
        args = JSON.parse(argumentsJson || "{}");
        if (!args || Array.isArray(args) || typeof args !== "object") throw new Error("not an object");
      } catch (error) {
        const result = { deviceId, toolName, status: "failed", resultJson: JSON.stringify({ error: `Invalid argumentsJson: ${error.message}` }) };
        return { isError: true, structuredContent: result, content: [{ type: "text", text: result.resultJson }] };
      }

      try {
        const accountId = requiredAccountId();
        if (!accountId) return writeAuthError();
        const response = await callRegisteredDevice(accountId, deviceId, toolName, args, timeoutSeconds, normalizeDiskPreflight(diskPreflight));
        const result = {
          deviceId,
          toolName,
          status: response.ok === false ? "failed" : "completed",
          resultJson: JSON.stringify(response.result?.structuredContent ?? response.result ?? { error: response.error }),
        };
        const content = Array.isArray(response.result?.content) ? response.result.content : [{ type: "text", text: result.resultJson }];
        return { isError: response.ok === false, structuredContent: result, content };
      } catch (error) {
        const result = { deviceId, toolName, status: "failed", resultJson: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) };
        return { isError: true, structuredContent: result, content: [{ type: "text", text: result.resultJson }] };
      }
    }
  );
}

export function buildDeviceToolDescriptors(options = {}) {
  const readSecuritySchemes = options.readSecuritySchemes ?? [{ type: "noauth" }];
  const writeSecuritySchemes = options.writeSecuritySchemes ?? [{ type: "oauth2", scopes: ["vps.write"] }];
  return [
    {
      name: "list_devices",
      title: "List controllable devices",
      description: "Return only the live computers registered to the authenticated Fabushi account. Call this before selecting a device.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: {
          devices: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" }, name: { type: "string" }, platform: { type: "string" },
                status: { type: "string", enum: ["online", "offline"] }, lastSeen: { type: "string" },
                expiresAt: { type: ["string", "null"] }, metadata: { type: "object", additionalProperties: { type: "string" } },
                secureInputPublicKey: { anyOf: [{ type: "object", required: ["kty", "crv", "x", "y"], properties: { kty: { const: "EC" }, crv: { const: "P-256" }, x: { type: "string" }, y: { type: "string" } }, additionalProperties: false }, { type: "null" }] },
                capabilities: { type: "array", items: { type: "string" } },
                toolSchemaCount: { type: "integer", minimum: 0 }, toolSchemaVersion: { type: "string" },
              },
              required: ["id", "name", "platform", "status", "lastSeen", "expiresAt", "metadata", "secureInputPublicKey", "capabilities", "toolSchemaCount", "toolSchemaVersion"],
              additionalProperties: false,
            },
          },
        },
        required: ["devices"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
    },
    {
      name: "describe_device_tool",
      title: "Describe a device tool",
      description: "Return the latest MCP title, description, input schema, output schema, and annotations for one tool advertised by a selected device.",
      inputSchema: {
        type: "object",
        properties: { deviceId: { type: "string", minLength: 1, maxLength: 128 }, toolName: { type: "string", minLength: 1, maxLength: 128 } },
        required: ["deviceId", "toolName"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" }, toolName: { type: "string" }, available: { type: "boolean" }, schemaVersion: { type: "string" },
          tool: { type: ["object", "null"] }, message: { type: "string" },
        },
        required: ["deviceId", "toolName", "available", "schemaVersion", "tool", "message"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: true },
      securitySchemes: readSecuritySchemes,
    },
    {
      name: "device_call",
      title: "Call a tool on a device",
      description: "Call one advertised MCP tool on a dynamically connected device. Obtain deviceId and toolName from list_devices; use describe_device_tool when the schema is unfamiliar or may have changed; argumentsJson must be a JSON object. diskPreflight is mandatory for every call: impact=none only for operations with no material disk growth; otherwise impact=writes with every affected path and worst-case peak bytes.",
      inputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string", minLength: 1, maxLength: 128 },
          toolName: { type: "string", minLength: 1, maxLength: 128 },
          argumentsJson: { type: "string", maxLength: MAX_ARGUMENTS_JSON_CHARS, default: "{}" },
          timeoutSeconds: { type: "integer", minimum: 1, maximum: MAX_CALL_TIMEOUT_SECONDS },
          diskPreflight: diskPreflightJsonSchema,
        },
        required: ["deviceId", "toolName", "diskPreflight"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          deviceId: { type: "string" }, toolName: { type: "string" },
          status: { type: "string", enum: ["completed", "failed"] }, resultJson: { type: "string" },
        },
        required: ["deviceId", "toolName", "status", "resultJson"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      securitySchemes: writeSecuritySchemes,
    },
  ];
}
