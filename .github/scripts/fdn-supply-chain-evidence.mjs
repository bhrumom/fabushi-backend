import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ALLOWED = new Set([
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Apache-2.0",
  "MPL-2.0",
  "0BSD",
  "CC0-1.0",
  "Boost-1.0",
]);
const DENIED_IDS = new Set([
  "GPL",
  "LGPL",
  "AGPL",
  "SSPL",
  "Commons-Clause",
  "Elastic-License",
  "BUSL",
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("arguments must be --name value pairs");
    }
    out[key.slice(2)] = value;
  }
  return out;
}

function exactSemver(version) {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}

function exactGoVersion(version) {
  return /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

function npmNameFromLockPath(lockPath) {
  const marker = "node_modules/";
  const index = lockPath.lastIndexOf(marker);
  return index >= 0 ? lockPath.slice(index + marker.length) : lockPath;
}

function npmPurl(name, version) {
  const encoded = name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return "pkg:npm/" + encoded + "@" + version;
}

function goPurl(name, version) {
  return "pkg:golang/" + name + "@" + version;
}

function detectLicense(text) {
  const lower = text.toLowerCase();
  const normalized = lower.replace(/\s+/g, " ");
  const allowed = new Set();
  const denied = new Set();

  if (normalized.includes("gnu affero general public license")) denied.add("AGPL");
  if (normalized.includes("gnu lesser general public license")) denied.add("LGPL");
  if (
    normalized.includes("gnu general public license") &&
    !normalized.includes("gnu affero general public license") &&
    !normalized.includes("gnu lesser general public license")
  ) {
    denied.add("GPL");
  }
  if (normalized.includes("server side public license")) denied.add("SSPL");
  if (normalized.includes("commons clause")) denied.add("Commons-Clause");
  if (normalized.includes("elastic license")) denied.add("Elastic-License");
  if (normalized.includes("business source license")) denied.add("BUSL");

  if (
    normalized.includes("apache license") &&
    normalized.includes("version 2.0")
  ) {
    allowed.add("Apache-2.0");
  }
  if (normalized.includes("mozilla public license version 2.0")) {
    allowed.add("MPL-2.0");
  }
  if (normalized.includes("boost software license")) {
    allowed.add("Boost-1.0");
  }
  if (
    normalized.includes("creative commons zero") ||
    normalized.includes("cc0 1.0 universal")
  ) {
    allowed.add("CC0-1.0");
  }
  if (
    normalized.includes("permission is hereby granted, free of charge") &&
    normalized.includes("the software")
  ) {
    allowed.add("MIT");
  }
  if (
    normalized.includes("permission to use, copy, modify, and/or distribute this software") &&
    normalized.includes("with or without fee")
  ) {
    allowed.add("ISC");
  }
  if (
    normalized.includes("redistribution and use in source and binary forms") &&
    normalized.includes("with or without modification")
  ) {
    if (normalized.includes("neither the name")) {
      allowed.add("BSD-3-Clause");
    } else {
      allowed.add("BSD-2-Clause");
    }
  }
  if (
    normalized.includes("zero-clause bsd") ||
    normalized.includes("0bsd")
  ) {
    allowed.add("0BSD");
  }

  return {
    allowed: [...allowed].sort(),
    denied: [...denied].sort(),
  };
}

async function sha256(file) {
  const bytes = await readFile(file);
  return createHash("sha256").update(bytes).digest("hex");
}

async function scanGoLicense(moduleDir) {
  const entries = await readdir(moduleDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(licen[sc]e|copying|copyright)([._-].*)?$/i.test(name))
    .sort();

  if (names.length === 0) {
    return { files: [], allowed: [], denied: [], unknown: true };
  }

  const allowed = new Set();
  const denied = new Set();
  for (const name of names) {
    const content = await readFile(path.join(moduleDir, name), "utf8");
    const detected = detectLicense(content);
    for (const id of detected.allowed) allowed.add(id);
    for (const id of detected.denied) denied.add(id);
  }
  return {
    files: names,
    allowed: [...allowed].sort(),
    denied: [...denied].sort(),
    unknown: allowed.size === 0 && denied.size === 0,
  };
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key];
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function stableUuid(seed) {
  const chars = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = "8";
  const value = chars.join("");
  return (
    value.slice(0, 8) + "-" +
    value.slice(8, 12) + "-" +
    value.slice(12, 16) + "-" +
    value.slice(16, 20) + "-" +
    value.slice(20)
  );
}

const args = parseArgs(process.argv.slice(2));
for (const required of [
  "out",
  "npm-lock",
  "npm-audit",
  "npm-tree",
  "go-mod",
  "go-sum",
  "go-modules",
  "go-packages",
  "compose",
  "tool-versions",
  "workflow",
]) {
  if (!args[required]) throw new Error("missing --" + required);
}

const sourceSha = process.env.SOURCE_SHA || "";
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error("SOURCE_SHA must be an exact 40-hex commit");
}

await mkdir(args.out, { recursive: true });

const workflowText = await readFile(args.workflow, "utf8");
const actionLines = workflowText
  .split("\n")
  .filter((line) => /^\s*-?\s*uses:\s*/.test(line));
if (actionLines.length === 0) throw new Error("workflow has no actions to pin");
for (const line of actionLines) {
  if (!/@[0-9a-f]{40}(?:\s+#.*)?\s*$/.test(line)) {
    throw new Error("workflow action is not commit-pinned: " + line.trim());
  }
}

const lock = JSON.parse(await readFile(args["npm-lock"], "utf8"));
if (lock.lockfileVersion !== 3) {
  throw new Error("npm lockfileVersion must remain exactly 3");
}

const npmRows = [];
for (const [lockPath, entry] of Object.entries(lock.packages || {})) {
  if (!lockPath || entry.dev === true) continue;
  const name = npmNameFromLockPath(lockPath);
  const version = String(entry.version || "");
  const license = String(entry.license || "");
  const integrity = String(entry.integrity || "");
  const resolved = String(entry.resolved || "");

  if (!exactSemver(version)) {
    throw new Error("npm package is not exactly versioned: " + name + " " + version);
  }
  if (!/^sha(256|384|512)-/.test(integrity)) {
    throw new Error("npm package lacks integrity digest: " + name + "@" + version);
  }
  if (!resolved.startsWith("https://")) {
    throw new Error("npm package resolved source must be HTTPS: " + name + "@" + version);
  }
  if (DENIED_IDS.has(license) || /(?:^|[-(])(A?GPL|LGPL|SSPL)(?:[-0-9.)]|$)/i.test(license)) {
    throw new Error("npm package has denied license: " + name + " " + license);
  }
  if (!ALLOWED.has(license)) {
    throw new Error("npm package has unknown/unapproved license: " + name + " " + license);
  }
  npmRows.push({ name, version, license, integrity, resolved });
}

const npmTree = JSON.parse(await readFile(args["npm-tree"], "utf8"));
if (!npmTree.name || !npmTree.version) {
  throw new Error("npm installed production graph is missing root identity");
}

const audit = JSON.parse(await readFile(args["npm-audit"], "utf8"));
const vulnerabilities = audit?.metadata?.vulnerabilities;
if (!vulnerabilities || typeof vulnerabilities.total !== "number") {
  throw new Error("npm audit output is missing vulnerability metadata");
}
if (vulnerabilities.total !== 0) {
  throw new Error("npm production audit must report zero vulnerabilities");
}

const goMod = await readFile(args["go-mod"], "utf8");
const goSum = await readFile(args["go-sum"], "utf8");
if (!/^go 1\.27\.1$/m.test(goMod)) {
  throw new Error("Go worker toolchain must remain exactly go 1.27.1");
}
if (/^replace\s|^replace\s*\(/m.test(goMod)) {
  throw new Error("Go worker must not use replace directives");
}
if (!/^require tailscale\.com v1\.104\.1$/m.test(goMod)) {
  throw new Error("tailscale.com must remain exactly v1.104.1");
}
for (const required of [
  "tailscale.com v1.104.1 h1:",
  "tailscale.com v1.104.1/go.mod h1:",
]) {
  if (!goSum.includes(required)) {
    throw new Error("go.sum missing exact Tailscale checksum: " + required);
  }
}

const requiredVersions = [];
for (const line of goMod.split("\n")) {
  const match = line.match(/^\s*([^\s()]+)\s+(v[^\s]+)(?:\s+\/\/ indirect)?\s*$/);
  if (!match) continue;
  const modulePath = match[1];
  const version = match[2];
  if (!exactGoVersion(version)) {
    throw new Error("Go requirement is not exactly versioned: " + modulePath + " " + version);
  }
  requiredVersions.push({ modulePath, version });
}
if (requiredVersions.length === 0) {
  throw new Error("Go requirement inventory is empty");
}

const goRows = [];
for (const line of (await readFile(args["go-modules"], "utf8")).trim().split("\n")) {
  if (!line) continue;
  const fields = line.split("|");
  if (fields.length < 3) throw new Error("malformed Go module row: " + line);
  const [modulePath, version, moduleDir] = fields;
  if (version === "MAIN") continue;
  if (!exactGoVersion(version)) {
    throw new Error("resolved Go module is not exactly versioned: " + modulePath + " " + version);
  }
  if (!moduleDir) {
    throw new Error("resolved Go module has no module cache directory: " + modulePath);
  }
  const license = await scanGoLicense(moduleDir);
  if (license.unknown || license.allowed.length === 0) {
    throw new Error("Go module license is unknown or denied-only: " + modulePath + "@" + version);
  }
  goRows.push({ modulePath, version, moduleDir, license });
}

const goPackageLines = (await readFile(args["go-packages"], "utf8"))
  .split("\n")
  .filter(Boolean);
if (goPackageLines.length === 0) {
  throw new Error("readonly Go package graph is empty");
}

const compose = await readFile(args.compose, "utf8");
if (!compose.includes("image: docker.io/headscale/headscale:0.29.5")) {
  throw new Error("Headscale must remain exactly 0.29.5");
}
if (/headscale:(?:latest|stable|main)\b/i.test(compose)) {
  throw new Error("floating Headscale tag is forbidden");
}

const npmLicenseReport = {
  schema: "fabushi.fdn.g15.npm-licenses.v1",
  sourceSha,
  packages: npmRows.length,
  counts: countBy(npmRows, "license"),
  entries: npmRows.map(({ name, version, license, resolved }) => ({
    name,
    version,
    license,
    resolved,
  })),
};
await writeFile(
  path.join(args.out, "npm-license-report.json"),
  JSON.stringify(npmLicenseReport, null, 2) + "\n",
);

const goLicenseReport = {
  schema: "fabushi.fdn.g15.go-licenses.v1",
  sourceSha,
  modules: goRows.length,
  entries: goRows.map((row) => ({
    modulePath: row.modulePath,
    version: row.version,
    licenseFiles: row.license.files,
    allowed: row.license.allowed,
    deniedAlternatives: row.license.denied,
  })),
};
await writeFile(
  path.join(args.out, "go-license-report.json"),
  JSON.stringify(goLicenseReport, null, 2) + "\n",
);

const components = [];
for (const row of npmRows) {
  const purl = npmPurl(row.name, row.version);
  components.push({
    type: "library",
    "bom-ref": purl,
    name: row.name,
    version: row.version,
    purl,
    hashes: [{
      alg: "SHA-512",
      content: Buffer.from(row.integrity.replace(/^sha512-/, ""), "base64").toString("hex"),
    }],
    licenses: [{ license: { id: row.license } }],
    properties: [
      { name: "fabushi:ecosystem", value: "npm" },
      { name: "fabushi:resolved", value: row.resolved },
    ],
  });
}
for (const row of goRows) {
  const purl = goPurl(row.modulePath, row.version);
  components.push({
    type: "library",
    "bom-ref": purl,
    name: row.modulePath,
    version: row.version,
    purl,
    licenses: row.license.allowed.map((id) => ({ license: { id } })),
    properties: [{ name: "fabushi:ecosystem", value: "go" }],
  });
}
components.sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));

const refs = new Set();
for (const component of components) {
  if (refs.has(component["bom-ref"])) {
    throw new Error("duplicate SBOM component: " + component["bom-ref"]);
  }
  refs.add(component["bom-ref"]);
  if (!component.name || !component.version || !component.purl) {
    throw new Error("invalid SBOM component");
  }
}
if (components.length !== npmRows.length + goRows.length) {
  throw new Error("SBOM component count does not match dependency inventories");
}

const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  serialNumber: "urn:uuid:" + stableUuid(sourceSha),
  version: 1,
  metadata: {
    component: {
      type: "application",
      name: "fabushi-backend-fdn-supply-chain",
      version: sourceSha,
      properties: [
        { name: "fabushi:source-sha", value: sourceSha },
        { name: "fabushi:tailscale", value: "v1.104.1" },
        { name: "fabushi:headscale", value: "0.29.5" },
      ],
    },
  },
  components,
};
if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6") {
  throw new Error("CycloneDX metadata validation failed");
}
const sbomPath = path.join(args.out, "fdn-sbom.cdx.json");
await writeFile(sbomPath, JSON.stringify(sbom, null, 2) + "\n");

const summary = {
  schema: "fabushi.fdn.g15.summary.v1",
  sourceSha,
  npmProductionPackages: npmRows.length,
  npmLicenseCounts: npmLicenseReport.counts,
  npmAuditVulnerabilities: vulnerabilities,
  goModules: goRows.length,
  goPackages: goPackageLines.length,
  tailscale: "v1.104.1",
  headscale: "0.29.5",
  sbomComponents: components.length,
  actionPins: actionLines.map((line) => line.trim()),
};
const summaryPath = path.join(args.out, "summary.json");
await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n");

const evidenceFiles = [
  args["npm-lock"],
  args["npm-audit"],
  args["npm-tree"],
  args["go-mod"],
  args["go-sum"],
  args["go-modules"],
  args["go-packages"],
  args.compose,
  args["tool-versions"],
  args.workflow,
  path.join(args.out, "npm-license-report.json"),
  path.join(args.out, "go-license-report.json"),
  sbomPath,
  summaryPath,
];
const digests = {};
for (const file of evidenceFiles) {
  digests[file] = await sha256(file);
}
const provenance = {
  schema: "fabushi.fdn.g15.provenance.v1",
  sourceSha,
  repository: process.env.GITHUB_REPOSITORY || "",
  event: process.env.GITHUB_EVENT_NAME || "",
  workflow: process.env.GITHUB_WORKFLOW || "",
  runId: process.env.GITHUB_RUN_ID || "",
  runAttempt: process.env.GITHUB_RUN_ATTEMPT || "",
  toolVersions: (await readFile(args["tool-versions"], "utf8")).trim().split("\n"),
  sourceAndEvidenceSha256: digests,
  boundedGate: "G15-supply-chain",
  fullGateClaim: false,
};
await writeFile(
  path.join(args.out, "provenance.json"),
  JSON.stringify(provenance, null, 2) + "\n",
);

console.log("FDN_G15 source_sha=" + sourceSha);
console.log("FDN_G15 npm_production_packages=" + npmRows.length);
console.log("FDN_G15 npm_audit_total=" + vulnerabilities.total);
console.log("FDN_G15 go_modules=" + goRows.length);
console.log("FDN_G15 go_packages=" + goPackageLines.length);
console.log("FDN_G15 tailscale=v1.104.1");
console.log("FDN_G15 headscale=0.29.5");
console.log("FDN_G15 sbom_components=" + components.length);
console.log("FDN_G15 action_pins=" + actionLines.length);
