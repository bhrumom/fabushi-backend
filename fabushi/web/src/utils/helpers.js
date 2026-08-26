const BUILTIN_SUPER_ADMIN_USERNAMES = Object.freeze(["bhrum108"]);
const BUILTIN_SUPER_ADMIN_ACCOUNT_IDS = Object.freeze(["22"]);

let runtimeAdminEmails = Object.freeze([]);
let runtimeAdminUsernames = BUILTIN_SUPER_ADMIN_USERNAMES;
let runtimeAdminAccountIds = BUILTIN_SUPER_ADMIN_ACCOUNT_IDS;

function parseAdminUsernames(env) {
  const configured = String(env?.ADMIN_USERNAMES || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return Object.freeze([...new Set([...BUILTIN_SUPER_ADMIN_USERNAMES, ...configured])]);
}

function parseAdminEmails(env) {
  return Object.freeze(
    String(env?.ADMIN_EMAILS || env?.ADMIN_EMAIL || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function parseAdminAccountIds(env) {
  const configured = String(env?.SUPER_ADMIN_ACCOUNT_IDS || env?.ADMIN_ACCOUNT_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return Object.freeze([...new Set([...BUILTIN_SUPER_ADMIN_ACCOUNT_IDS, ...configured])]);
}

function userAccountId(user) {
  return String(user?.id ?? user?.userId ?? user?.user_id ?? "").trim();
}

export function configureRuntimeAdminEmails(env) {
  runtimeAdminEmails = parseAdminEmails(env);
  runtimeAdminUsernames = parseAdminUsernames(env);
  runtimeAdminAccountIds = parseAdminAccountIds(env);
  return runtimeAdminEmails.length;
}

export function isAdmin(email, env) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  const configured = env ? parseAdminEmails(env) : runtimeAdminEmails;
  return configured.length > 0 && configured.includes(normalized);
}

export function isAdminUser(user, env) {
  if (!user || typeof user !== 'object') return false;
  if (isAdmin(user.email, env)) return true;
  const stableId = userAccountId(user);
  const configuredIds = env ? parseAdminAccountIds(env) : runtimeAdminAccountIds;
  if (stableId && configuredIds.includes(stableId)) return true;
  const username = String(user.username || '').trim().toLowerCase();
  if (!username) return false;
  const configured = env ? parseAdminUsernames(env) : runtimeAdminUsernames;
  return configured.includes(username);
}

export function hasUnlimitedUsage(user, env) {
  const stableId = userAccountId(user);
  const configuredIds = env ? parseAdminAccountIds(env) : runtimeAdminAccountIds;
  if (stableId && configuredIds.includes(stableId)) return true;
  const username = String(user?.username || '').trim().toLowerCase();
  if (!username) return false;
  const configured = env ? parseAdminUsernames(env) : runtimeAdminUsernames;
  return configured.includes(username);
}

export function generateRedeemCode(length = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const size = Math.min(64, Math.max(12, Number(length) || 16));
  let result = '';
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  // chars.length is exactly 32, which divides 256, so modulo mapping is uniform.
  for (let i = 0; i < size; i += 1) result += chars[bytes[i] % chars.length];
  return result;
}
