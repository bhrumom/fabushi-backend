import crypto from 'node:crypto';

const AGENT_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,80}$/;
const HEX_64_PATTERN = /^[a-f0-9]{64}$/i;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const CRITICAL_COMMANDS = new Set([
  '/bin/sh',
  '/bin/bash',
  'sh',
  'bash',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);

const SUPPORTED_ENTRY_MODES = new Set(['cli', 'python', 'node', 'http']);
const SUPPORTED_TRANSPORTS = new Set(['stdio', 'http', 'websocket', 'mcp']);
const SUPPORTED_PACKAGE_TYPES = new Set(['zip', 'tar', 'tgz', 'bundled']);
const SUPPORTED_PRICING_MODELS = new Set(['free', 'one_time', 'pay_per_run', 'subscription']);
const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);

function readText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function pushIssue(list, path, code, message, severity = 'error') {
  list.push({ path, code, message, severity });
}

function validateUrl(value, path, issues, { httpsOnly = true } = {}) {
  const raw = readText(value);
  if (!raw) {
    pushIssue(issues, path, 'required', `${path} is required`);
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (httpsOnly && parsed.protocol !== 'https:') {
      pushIssue(issues, path, 'https_required', `${path} must use https`);
    }
    return parsed;
  } catch {
    pushIssue(issues, path, 'invalid_url', `${path} must be a valid URL`);
    return null;
  }
}

function validateIdentity(manifest, issues) {
  if (Number(manifest.schemaVersion) !== 1) {
    pushIssue(issues, 'schemaVersion', 'unsupported_schema_version', 'schemaVersion must be 1');
  }
  const agentId = readText(manifest.agentId);
  if (!AGENT_ID_PATTERN.test(agentId)) {
    pushIssue(issues, 'agentId', 'invalid_agent_id', 'agentId must match ^[a-z][a-z0-9_.-]{2,80}$');
  }
  if (!readText(manifest.name)) pushIssue(issues, 'name', 'required', 'name is required');
  if (!SEMVER_PATTERN.test(readText(manifest.version))) {
    pushIssue(issues, 'version', 'invalid_semver', 'version must follow SemVer');
  }
  if (!readText(manifest.developerId)) {
    pushIssue(issues, 'developerId', 'required', 'developerId is required');
  }
}

function validateEntry(manifest, issues) {
  const entry = manifest.entry && typeof manifest.entry === 'object' ? manifest.entry : null;
  if (!entry) {
    pushIssue(issues, 'entry', 'required', 'entry is required');
    return;
  }
  const mode = readText(entry.mode);
  const transport = readText(entry.transport || (mode === 'http' ? 'http' : 'stdio'));
  if (!SUPPORTED_ENTRY_MODES.has(mode)) {
    pushIssue(issues, 'entry.mode', 'unsupported_entry_mode', 'entry.mode must be cli, python, node, or http');
  }
  if (!SUPPORTED_TRANSPORTS.has(transport)) {
    pushIssue(issues, 'entry.transport', 'unsupported_transport', 'entry.transport is unsupported');
  }
  const command = readText(entry.command);
  if (mode !== 'http' && !command) {
    pushIssue(issues, 'entry.command', 'required', 'entry.command is required for cli/python/node agents');
  }
  const commandLower = command.toLowerCase();
  if (CRITICAL_COMMANDS.has(commandLower)) {
    pushIssue(issues, 'entry.command', 'blocked_command', 'shell commands require a special official allowlist');
  }
  if (entry.runInShell === true) {
    pushIssue(issues, 'entry.runInShell', 'run_in_shell_forbidden', 'third-party agents must use runInShell=false');
  }
  if (readText(entry.workingDirectory).startsWith('/')) {
    pushIssue(issues, 'entry.workingDirectory', 'absolute_workdir_forbidden', 'workingDirectory must be package-relative or a scoped grant');
  }
}

function validatePackage(manifest, issues) {
  const pkg = manifest.package && typeof manifest.package === 'object' ? manifest.package : null;
  if (!pkg) {
    pushIssue(issues, 'package', 'required', 'package is required');
    return;
  }
  const type = readText(pkg.type);
  if (!SUPPORTED_PACKAGE_TYPES.has(type)) {
    pushIssue(issues, 'package.type', 'unsupported_package_type', 'package.type must be zip, tar, tgz, or bundled');
  }
  if (type === 'bundled') {
    if (!readText(pkg.source)) pushIssue(issues, 'package.source', 'required', 'bundled packages require source');
    return;
  }
  validateUrl(pkg.url, 'package.url', issues);
  if (!HEX_64_PATTERN.test(readText(pkg.sha256))) {
    pushIssue(issues, 'package.sha256', 'invalid_sha256', 'package.sha256 must be a 64-character hex digest');
  }
  if (!readText(pkg.signature)) {
    pushIssue(issues, 'package.signature', 'signature_required', 'package.signature is required before review');
  }
}

function validateCompanion(manifest, issues, verifiedOrigins = []) {
  const companion = manifest.companionMiniApp;
  if (!companion) return;
  if (typeof companion !== 'object') {
    pushIssue(issues, 'companionMiniApp', 'invalid_object', 'companionMiniApp must be an object');
    return;
  }
  const parsed = validateUrl(companion.entryUrl, 'companionMiniApp.entryUrl', issues);
  if (!parsed) return;
  const declaredOrigin = readText(companion.origin) || parsed.origin;
  if (declaredOrigin !== parsed.origin) {
    pushIssue(issues, 'companionMiniApp.origin', 'origin_mismatch', 'origin must match entryUrl origin');
  }
  if (verifiedOrigins.length > 0 && !verifiedOrigins.includes(parsed.origin)) {
    pushIssue(issues, 'companionMiniApp.origin', 'unverified_origin', 'origin must be one of the developer verified domains');
  }
}

function validateSecrets(manifest, issues) {
  const secrets = Array.isArray(manifest.secrets) ? manifest.secrets : [];
  for (const [index, secret] of secrets.entries()) {
    const path = `secrets[${index}]`;
    if (!secret || typeof secret !== 'object') {
      pushIssue(issues, path, 'invalid_object', 'secret must be an object');
      continue;
    }
    const key = readText(secret.key);
    if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(key)) {
      pushIssue(issues, `${path}.key`, 'invalid_secret_key', 'secret key must be upper snake case');
    }
    if (secret.value || secret.defaultValue) {
      pushIssue(issues, path, 'secret_plaintext_forbidden', 'secret definitions must not include plaintext values');
    }
    if (!['device_keychain', 'credential_manager', 'libsecret', 'secure_storage'].includes(readText(secret.storage))) {
      pushIssue(issues, `${path}.storage`, 'unsupported_secret_storage', 'secret storage must be device secure storage');
    }
    if (!['env', 'file', 'stdin'].includes(readText(secret.injectAs || 'env'))) {
      pushIssue(issues, `${path}.injectAs`, 'unsupported_secret_injection', 'injectAs must be env, file, or stdin');
    }
  }
}

function validatePermissions(manifest, issues) {
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const [index, permission] of permissions.entries()) {
    const path = `permissions[${index}]`;
    if (!permission || typeof permission !== 'object') {
      pushIssue(issues, path, 'invalid_object', 'permission must be an object');
      continue;
    }
    const name = readText(permission.name);
    const riskLevel = readText(permission.riskLevel || 'low');
    if (!/^[a-z][A-Za-z0-9_.:-]{1,100}$/.test(name)) {
      pushIssue(issues, `${path}.name`, 'invalid_permission_name', 'permission name is invalid');
    }
    if (!RISK_LEVELS.has(riskLevel)) {
      pushIssue(issues, `${path}.riskLevel`, 'invalid_risk_level', 'riskLevel must be low, medium, high, or critical');
    }
    if (!readText(permission.reason)) {
      pushIssue(issues, `${path}.reason`, 'reason_required', 'permission reason is required for user and reviewer display');
    }
    if (riskLevel === 'critical') {
      pushIssue(issues, path, 'critical_permission_requires_security_review', 'critical permissions require security review', 'warning');
    }
    if ((riskLevel === 'high' || riskLevel === 'critical') && !readText(permission.confirmationPolicy)) {
      pushIssue(issues, `${path}.confirmationPolicy`, 'confirmation_required', 'high/critical permissions require confirmationPolicy', 'warning');
    }
  }
}

function validateCommands(manifest, issues) {
  const commands = Array.isArray(manifest.commands) ? manifest.commands : [];
  if (commands.length > 100) {
    pushIssue(issues, 'commands', 'too_many_commands', 'commands cannot exceed 100');
  }
  for (const [index, command] of commands.entries()) {
    const path = `commands[${index}]`;
    const value = readText(command?.command);
    if (!/^\/[a-z][a-z0-9_-]{0,32}$/.test(value)) {
      pushIssue(issues, `${path}.command`, 'invalid_command', 'command must be lowercase slash command');
    }
    if (!readText(command?.description)) {
      pushIssue(issues, `${path}.description`, 'required', 'command description is required');
    }
  }
}

function validatePricing(manifest, issues) {
  const pricing = manifest.pricing || { model: 'free' };
  if (!pricing || typeof pricing !== 'object') {
    pushIssue(issues, 'pricing', 'invalid_object', 'pricing must be an object');
    return;
  }
  const model = readText(pricing.model || 'free');
  if (!SUPPORTED_PRICING_MODELS.has(model)) {
    pushIssue(issues, 'pricing.model', 'unsupported_pricing_model', 'pricing.model is unsupported');
  }
  if (model !== 'free') {
    const amount = Number(pricing.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      pushIssue(issues, 'pricing.amount', 'invalid_amount', 'paid pricing requires positive integer amount');
    }
    if (readText(pricing.currency || 'FUDE_JIN') !== 'FUDE_JIN') {
      pushIssue(issues, 'pricing.currency', 'unsupported_currency', 'Agent digital goods must use FUDE_JIN');
    }
  }
  if (model === 'pay_per_run' && !readText(pricing.refundPolicy)) {
    pushIssue(issues, 'pricing.refundPolicy', 'refund_policy_required', 'pay_per_run agents must declare refundPolicy');
  }
}

export function validateAgentManifest(manifest, options = {}) {
  const issues = [];
  const doc = manifest && typeof manifest === 'object' ? manifest : null;
  if (!doc || Array.isArray(doc)) {
    return {
      valid: false,
      errors: [{ path: '$', code: 'invalid_manifest', message: 'manifest must be an object', severity: 'error' }],
      warnings: [],
      manifestHash: '',
    };
  }

  validateIdentity(doc, issues);
  validateEntry(doc, issues);
  validatePackage(doc, issues);
  validateCompanion(doc, issues, options.verifiedOrigins || []);
  validateSecrets(doc, issues);
  validatePermissions(doc, issues);
  validateCommands(doc, issues);
  validatePricing(doc, issues);

  const errors = issues.filter((issue) => issue.severity !== 'warning');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const manifestJson = JSON.stringify(doc);
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    manifestHash: crypto.createHash('sha256').update(manifestJson).digest('hex'),
  };
}

export function publicManifestSummary(manifest) {
  return {
    schemaVersion: Number(manifest.schemaVersion || 1),
    agentId: readText(manifest.agentId),
    name: readText(manifest.name),
    version: readText(manifest.version),
    developerId: readText(manifest.developerId),
    permissionCount: Array.isArray(manifest.permissions) ? manifest.permissions.length : 0,
    secretCount: Array.isArray(manifest.secrets) ? manifest.secrets.length : 0,
    commandCount: Array.isArray(manifest.commands) ? manifest.commands.length : 0,
    pricingModel: readText(manifest.pricing?.model || 'free'),
  };
}
