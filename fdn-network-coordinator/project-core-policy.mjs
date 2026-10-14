import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

export const MAX_BINDINGS = 256;
export const REMOTE_TARGET_PORT = 8792;
const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/u;
const TOP_LEVEL_FIELDS = new Set(["cellId", "generatedAt", "bindings"]);
const BINDING_FIELDS = new Set([
  "userId",
  "deviceId",
  "cellId",
  "nodeId",
  "generation",
  "expiresAt",
]);

function exactFields(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function validIdentifier(value, min, max) {
  return typeof value === "string"
    && value.length >= min
    && value.length <= max
    && ID_PATTERN.test(value);
}

function validTailnetNode(value) {
  if (typeof value !== "string" || value.length > 160) return false;
  const kind = isIP(value);
  if (kind === 4) {
    const parts = value.split(".").map(Number);
    const number = (((parts[0] << 24) >>> 0)
      + (parts[1] << 16)
      + (parts[2] << 8)
      + parts[3]) >>> 0;
    const start = ((100 << 24) + (64 << 16)) >>> 0;
    const end = ((100 << 24) + (127 << 16) + (255 << 8) + 255) >>> 0;
    return number >= start && number <= end;
  }
  if (kind === 6) {
    return value.toLowerCase().startsWith("fd7a:115c:a1e0:");
  }
  return false;
}

export function validateCellSnapshot(snapshot, expectedCellId, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!validIdentifier(expectedCellId, 8, 128)) {
    throw new Error("invalid cell id");
  }
  if (!exactFields(snapshot, TOP_LEVEL_FIELDS)
      || snapshot.cellId !== expectedCellId
      || !Number.isSafeInteger(snapshot.generatedAt)
      || !Array.isArray(snapshot.bindings)
      || snapshot.bindings.length > MAX_BINDINGS) {
    throw new Error("invalid Core cell snapshot");
  }

  const users = new Set();
  const nodes = new Set();
  const normalized = [];
  for (const row of snapshot.bindings) {
    if (!exactFields(row, BINDING_FIELDS)
        || !validIdentifier(row.userId, 1, 160)
        || !validIdentifier(row.deviceId, 1, 128)
        || row.cellId !== expectedCellId
        || !validTailnetNode(row.nodeId)
        || !Number.isSafeInteger(row.generation)
        || row.generation <= 0
        || !Number.isSafeInteger(row.expiresAt)
        || row.expiresAt <= nowSeconds) {
      throw new Error("invalid Core network binding");
    }
    if (nodes.has(row.nodeId)) {
      throw new Error("duplicate Core network node");
    }
    nodes.add(row.nodeId);
    users.add(row.userId);
    normalized.push({ ...row });
  }
  if (users.size > 1) {
    throw new Error("mixed Fabushi accounts in one FDN cell");
  }
  normalized.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  return normalized;
}

export function buildHeadscalePolicy(bindings) {
  if (!Array.isArray(bindings) || bindings.length === 0) {
    return { grants: [] };
  }
  const destinations = bindings.map((row) => row.nodeId);
  return {
    grants: [{
      src: ["*"],
      dst: destinations,
      ip: [`tcp:${REMOTE_TARGET_PORT}`],
    }],
  };
}

export async function fetchCoreCellSnapshot({
  fetchImpl = fetch,
  coreBaseUrl,
  authorityToken,
  cellId,
}) {
  const base = new URL(String(coreBaseUrl || ""));
  const isLoopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(base.hostname);
  if ((!isLoopback && base.protocol !== "https:")
      || (isLoopback && !["http:", "https:"].includes(base.protocol))
      || base.username || base.password || base.search || base.hash) {
    throw new Error("invalid Core API base URL");
  }
  if (typeof authorityToken !== "string"
      || authorityToken.length < 48
      || authorityToken.length > 16 * 1024
      || /[\r\n]/u.test(authorityToken)) {
    throw new Error("invalid network authority credential");
  }
  if (!validIdentifier(cellId, 8, 128)) {
    throw new Error("invalid cell id");
  }
  const endpoint = new URL("/v1/internal/computers/network-bindings/cell-snapshot", base);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Fabushi-Network-Authority": authorityToken,
    },
    body: JSON.stringify({ cellId }),
  });
  if (!response?.ok) {
    throw new Error(`Core cell snapshot failed: HTTP ${response?.status || 0}`);
  }
  return response.json();
}

export async function writePolicyAtomically(outputPath, policy) {
  const text = `${JSON.stringify(policy, null, 2)}\n`;
  const temporary = join(
    dirname(outputPath),
    `.${outputPath.split("/").pop()}.${randomBytes(8).toString("hex")}.tmp`,
  );
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, outputPath);
}

export async function projectPolicy({
  fetchImpl = fetch,
  coreBaseUrl,
  authorityToken,
  cellId,
  outputPath,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const snapshot = await fetchCoreCellSnapshot({
    fetchImpl,
    coreBaseUrl,
    authorityToken,
    cellId,
  });
  const bindings = validateCellSnapshot(snapshot, cellId, nowSeconds);
  const policy = buildHeadscalePolicy(bindings);
  await writePolicyAtomically(outputPath, policy);
  return {
    cellId,
    bindingCount: bindings.length,
    policy,
  };
}

async function main() {
  const result = await projectPolicy({
    coreBaseUrl: process.env.FABUSHI_CORE_API_BASE_URL,
    authorityToken: process.env.FDN_NETWORK_AUTHORITY_TOKEN,
    cellId: process.env.FABUSHI_FDN_CELL_ID,
    outputPath: process.env.FABUSHI_FDN_POLICY_PATH || "/etc/headscale/policy.hujson",
  });
  process.stdout.write(`Projected FDN policy for one cell with ${result.bindingCount} live bindings.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`FDN policy projection failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
