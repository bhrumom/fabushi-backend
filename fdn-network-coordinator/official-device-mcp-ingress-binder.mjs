import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const SERVICE_ID = "official-device-mcp";
const STATUS_PATH = "/v1/fdn/status";
const BIND_PATH = "/v1/internal/computers/network-ingress/bind";
const REVOKE_PATH = "/v1/internal/computers/network-ingress/revoke";
const STATE_VERSION = 1;
const DEFAULT_BIND_LIFETIME_SECONDS = 60 * 60;
const DEFAULT_RENEW_BEFORE_SECONDS = 10 * 60;

function boundedId(value, min, max) {
  const text = String(value ?? "").trim();
  if (
    text.length < min ||
    text.length > max ||
    !/^[A-Za-z0-9._:-]+$/.test(text)
  ) {
    throw new Error("invalid bounded identifier");
  }
  return text;
}

export function validateTailnetNode(value) {
  const node = boundedId(value, 7, 160);
  const ipv4 = node.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.every((part) => part >= 0 && part <= 255)) {
      const [a, b] = parts;
      if (a === 100 && b >= 64 && b <= 127) return node;
    }
  }
  if (node.toLowerCase().startsWith("fd7a:115c:a1e0:")) return node.toLowerCase();
  throw new Error("network worker node is outside the Fabushi tailnet ranges");
}

export function loopbackWorkerStatusUrl(raw) {
  const url = new URL(String(raw ?? ""));
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("controller worker URL must be an exact loopback HTTP origin");
  }
  url.pathname = STATUS_PATH;
  return url;
}

export function coreBaseUrl(raw) {
  const url = new URL(String(raw ?? ""));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Core base URL must be an HTTPS origin");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function validateState(value) {
  if (!value || value.version !== STATE_VERSION) throw new Error("invalid ingress state");
  const userId = boundedId(value.userId, 1, 160);
  const cellId = boundedId(value.cellId, 8, 128);
  const nodeId = validateTailnetNode(value.nodeId);
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw new Error("invalid ingress generation");
  }
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1) {
    throw new Error("invalid ingress expiry");
  }
  if (!["bind_outcome_unknown", "bound", "revoked"].includes(value.phase)) {
    throw new Error("invalid ingress phase");
  }
  return {
    version: STATE_VERSION,
    userId,
    cellId,
    serviceId: SERVICE_ID,
    nodeId,
    generation: value.generation,
    expiresAt: value.expiresAt,
    phase: value.phase,
  };
}

export async function loadState(path) {
  try {
    return validateState(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeState(path, value) {
  const state = validateState(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(state) + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function decodeJson(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  return value;
}

export async function readWorkerStatus(fetchImpl, workerOrigin) {
  const response = await fetchImpl(loopbackWorkerStatusUrl(workerOrigin), {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  const value = await decodeJson(response, "controller worker status");
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "cellId,nodeId,ready" ||
    value.ready !== true
  ) {
    throw new Error("controller worker status shape is invalid");
  }
  return {
    cellId: boundedId(value.cellId, 8, 128),
    nodeId: validateTailnetNode(value.nodeId),
  };
}

function desiredBinding({ existing, userId, cellId, nodeId, now, lifetime, renewBefore }) {
  if (
    existing &&
    existing.userId === userId &&
    existing.cellId === cellId &&
    existing.nodeId === nodeId &&
    existing.phase === "bind_outcome_unknown"
  ) {
    return existing;
  }
  const reusable =
    existing &&
    existing.userId === userId &&
    existing.cellId === cellId &&
    existing.nodeId === nodeId &&
    existing.phase === "bound" &&
    existing.expiresAt > now + renewBefore;
  if (reusable) return existing;
  const generation = existing ? existing.generation + 1 : 1;
  return {
    version: STATE_VERSION,
    userId,
    cellId,
    serviceId: SERVICE_ID,
    nodeId,
    generation,
    expiresAt: now + lifetime,
    phase: "bind_outcome_unknown",
  };
}

export async function reconcileIngress({
  fetchImpl = fetch,
  workerOrigin,
  coreOrigin,
  authorityToken,
  userId,
  cellId,
  statePath,
  now = Math.floor(Date.now() / 1000),
  lifetimeSeconds = DEFAULT_BIND_LIFETIME_SECONDS,
  renewBeforeSeconds = DEFAULT_RENEW_BEFORE_SECONDS,
}) {
  if (!authorityToken || authorityToken.length < 32) {
    throw new Error("FDN network authority credential is missing");
  }
  const normalizedUser = boundedId(userId, 1, 160);
  const normalizedCell = boundedId(cellId, 8, 128);
  const worker = await readWorkerStatus(fetchImpl, workerOrigin);
  if (worker.cellId !== normalizedCell) throw new Error("controller worker cell mismatch");
  const existing = await loadState(statePath);
  if (
    existing &&
    (existing.userId !== normalizedUser || existing.cellId !== normalizedCell)
  ) {
    throw new Error("persisted ingress owner does not match configured account/cell");
  }
  const desired = desiredBinding({
    existing,
    userId: normalizedUser,
    cellId: normalizedCell,
    nodeId: worker.nodeId,
    now,
    lifetime: lifetimeSeconds,
    renewBefore: renewBeforeSeconds,
  });
  if (desired.phase === "bound" && desired.expiresAt > now + renewBeforeSeconds) {
    return { ...desired, reconciled: true };
  }

  await writeState(statePath, { ...desired, phase: "bind_outcome_unknown" });
  const base = coreBaseUrl(coreOrigin);
  const bindUrl = new URL(base.toString());
  bindUrl.pathname = `${base.pathname}${BIND_PATH}`.replace(/\/+/g, "/");
  const response = await fetchImpl(bindUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-fabushi-network-authority": authorityToken,
    },
    redirect: "error",
    body: JSON.stringify({
      userId: desired.userId,
      cellId: desired.cellId,
      serviceId: SERVICE_ID,
      nodeId: desired.nodeId,
      generation: desired.generation,
      expiresAt: desired.expiresAt,
    }),
  });
  const value = await decodeJson(response, "Core network ingress bind");
  if (
    value?.ok !== true ||
    value.userId !== desired.userId ||
    value.cellId !== desired.cellId ||
    value.serviceId !== SERVICE_ID ||
    value.nodeId !== desired.nodeId ||
    value.generation !== desired.generation ||
    value.expiresAt !== desired.expiresAt
  ) {
    throw new Error("Core network ingress bind identity mismatch");
  }
  const bound = { ...desired, phase: "bound" };
  await writeState(statePath, bound);
  return { ...bound, reconciled: Boolean(value.reconciled) };
}

export async function revokeIngress({
  fetchImpl = fetch,
  coreOrigin,
  authorityToken,
  statePath,
}) {
  if (!authorityToken || authorityToken.length < 32) {
    throw new Error("FDN network authority credential is missing");
  }
  const existing = await loadState(statePath);
  if (!existing) return { revoked: false, absent: true };
  if (existing.phase === "revoked") return { ...existing, revoked: true, reconciled: true };
  const base = coreBaseUrl(coreOrigin);
  const revokeUrl = new URL(base.toString());
  revokeUrl.pathname = `${base.pathname}${REVOKE_PATH}`.replace(/\/+/g, "/");
  const response = await fetchImpl(revokeUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-fabushi-network-authority": authorityToken,
    },
    redirect: "error",
    body: JSON.stringify({
      userId: existing.userId,
      cellId: existing.cellId,
      serviceId: SERVICE_ID,
      generation: existing.generation,
    }),
  });
  const value = await decodeJson(response, "Core network ingress revoke");
  if (
    value?.ok !== true ||
    value.userId !== existing.userId ||
    value.cellId !== existing.cellId ||
    value.serviceId !== SERVICE_ID ||
    value.generation !== existing.generation
  ) {
    throw new Error("Core network ingress revoke identity mismatch");
  }
  const revoked = { ...existing, phase: "revoked" };
  await writeState(statePath, revoked);
  return { ...revoked, revoked: true };
}

async function main() {
  const statePath = process.env.FABUSHI_FDN_INGRESS_STATE_FILE;
  if (!statePath) throw new Error("FABUSHI_FDN_INGRESS_STATE_FILE is required");
  const common = {
    coreOrigin: process.env.FABUSHI_PLATFORM_CORE_URL,
    authorityToken: process.env.FDN_NETWORK_AUTHORITY_TOKEN,
    statePath,
  };
  if (process.argv.includes("--revoke")) {
    const result = await revokeIngress(common);
    process.stdout.write(JSON.stringify({ revoked: Boolean(result.revoked) }) + "\n");
    return;
  }
  const result = await reconcileIngress({
    ...common,
    workerOrigin: process.env.FABUSHI_FDN_CONTROLLER_WORKER_URL,
    userId: process.env.FABUSHI_FDN_INGRESS_USER_ID,
    cellId: process.env.FABUSHI_FDN_CELL_ID,
  });
  process.stdout.write(
    JSON.stringify({
      cellId: result.cellId,
      nodeId: result.nodeId,
      generation: result.generation,
      expiresAt: result.expiresAt,
      bound: result.phase === "bound",
    }) + "\n",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`FDN ingress binder failed: ${error.message}`);
    process.exitCode = 1;
  });
}
