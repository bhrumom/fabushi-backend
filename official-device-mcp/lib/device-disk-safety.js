import { statfs } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const ONE_GIB = 1024 ** 3;
export const DEFAULT_RESERVE_FRACTION = 0.05;

export const DEVICE_DISK_SAFETY_INSTRUCTIONS = `
Disk space is a hard safety constraint for every connected device.

Before every device operation, classify whether it can materially increase persistent or temporary storage. Read-only operations may be classified as no disk impact only when that is genuinely true. Downloads, writes, copies, extraction, installs, builds, tests, packaging, updates, deployments, logs/traces, caches, databases, containers/images, browser downloads, and similar actions must be treated as writes.

When a tool exposes a diskPreflight parameter:
- Always provide it.
- Use impact="none" only when the operation cannot materially grow storage, and state why.
- For impact="writes", list every affected filesystem path and the worst reasonable peakAdditionalBytes for that path, including temporary/staging data, simultaneous old/new copies, extraction expansion, caches, logs, journals/WAL, retries, rollback copies, and other peak overhead.
- Never understate peak usage merely to make an operation pass.

The runtime preserves a minimum safety reserve on each affected filesystem. Unless a larger reserve is requested, at least max(1 GiB, 5% of total filesystem capacity) must remain after estimated peak usage. If free space, affected paths, or peak usage cannot be determined confidently, fail closed: do not perform the operation. Split the work, stream it, use another volume/device, or move heavy work to GitHub Actions/a disposable runner.

For long-running or variable-growth work, use bounded steps and re-check space at safe checkpoints; stop before crossing the reserve. Never wait for ENOSPC or zero free bytes. Never delete user/service data, databases, source, backups, credentials, or unrelated files merely to make an operation fit without explicit authorization.

Persistent user devices, VPS hosts, MCP hosts, and production/service machines are control/edit/deployment surfaces, not build-cache dumping grounds. Heavy builds and dependency/cache-producing validation belong on GitHub Actions or an explicitly designated disposable build runner.
`.trim();

const byteCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const diskTargetSchema = z.object({
  path: z.string().min(1).max(4096).describe("Affected filesystem path. Prefer an absolute path."),
  peakAdditionalBytes: byteCountSchema.describe("Worst reasonable peak additional bytes on this filesystem."),
  reserveBytes: byteCountSchema.optional().describe("Optional larger reserve. The runtime never allows this to reduce the default reserve."),
});

export const diskPreflightSchema = z.object({
  impact: z.enum(["none", "writes"]).describe("Whether this operation can materially grow persistent or temporary storage."),
  reason: z.string().min(3).max(2000).describe("Why this disk-impact classification and estimate are appropriate."),
  targets: z.array(diskTargetSchema).max(32).default([]).describe("Affected filesystem paths and peak usage estimates. Required when impact is writes."),
});

export const diskPreflightJsonSchema = {
  type: "object",
  properties: {
    impact: { type: "string", enum: ["none", "writes"], description: "Whether this operation can materially grow persistent or temporary storage." },
    reason: { type: "string", minLength: 3, maxLength: 2000, description: "Why this disk-impact classification and estimate are appropriate." },
    targets: {
      type: "array",
      maxItems: 32,
      default: [],
      description: "Affected filesystem paths and peak usage estimates. Required when impact is writes.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1, maxLength: 4096, description: "Affected filesystem path. Prefer an absolute path." },
          peakAdditionalBytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Worst reasonable peak additional bytes on this filesystem." },
          reserveBytes: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Optional larger reserve; cannot lower the default reserve." },
        },
        required: ["path", "peakAdditionalBytes"],
        additionalProperties: false,
      },
    },
  },
  required: ["impact", "reason"],
  additionalProperties: false,
};

export function minimumDiskReserveBytes(totalBytes) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) throw new Error("Filesystem total size is invalid.");
  return Math.max(ONE_GIB, Math.ceil(totalBytes * DEFAULT_RESERVE_FRACTION));
}

export function normalizeDiskPreflight(value) {
  const parsed = diskPreflightSchema.parse(value);
  if (parsed.impact === "none" && parsed.targets.length) throw new Error("diskPreflight.targets must be empty when impact is none.");
  if (parsed.impact === "writes" && !parsed.targets.length) throw new Error("diskPreflight.targets must contain every affected filesystem when impact is writes.");
  return parsed;
}

async function statFsForTarget(path, statfsFn) {
  let probe = path;
  for (;;) {
    try {
      return { probePath: probe, stats: await statfsFn(probe) };
    } catch (error) {
      if (!error || !["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      const parent = dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
}

export async function enforceDiskPreflight(value, options = {}) {
  const parsed = normalizeDiskPreflight(value);
  if (parsed.impact === "none") return { impact: "none", reason: parsed.reason, checks: [] };

  const cwd = String(options.cwd || process.cwd());
  const statfsFn = options.statfsFn || statfs;
  const checks = [];
  for (const target of parsed.targets) {
    const targetPath = isAbsolute(target.path) ? target.path : resolve(cwd, target.path);
    let measured;
    try {
      measured = await statFsForTarget(targetPath, statfsFn);
    } catch (error) {
      throw new Error(`Disk safety preflight could not measure ${targetPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const blockSize = Number(measured.stats.bsize);
    const totalBytes = Number(measured.stats.blocks) * blockSize;
    const availableBlocks = measured.stats.bavail ?? measured.stats.bfree;
    const availableBytes = Number(availableBlocks) * blockSize;
    if (![blockSize, totalBytes, availableBytes].every(Number.isFinite) || blockSize <= 0 || totalBytes <= 0 || availableBytes < 0) {
      throw new Error(`Disk safety preflight returned invalid filesystem statistics for ${targetPath}.`);
    }
    const requiredReserveBytes = Math.max(minimumDiskReserveBytes(totalBytes), Number(target.reserveBytes || 0));
    const peakAdditionalBytes = Number(target.peakAdditionalBytes);
    const projectedRemainingBytes = availableBytes - peakAdditionalBytes;
    if (projectedRemainingBytes < requiredReserveBytes) {
      throw new Error(`Disk safety preflight rejected ${targetPath}: available=${availableBytes} bytes, peakAdditional=${peakAdditionalBytes} bytes, requiredReserve=${requiredReserveBytes} bytes, projectedRemaining=${projectedRemainingBytes} bytes.`);
    }
    checks.push({ path: targetPath, probePath: measured.probePath, totalBytes, availableBytes, peakAdditionalBytes, requiredReserveBytes, projectedRemainingBytes });
  }
  return { impact: "writes", reason: parsed.reason, checks };
}
