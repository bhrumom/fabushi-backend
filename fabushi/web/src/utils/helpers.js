const BUILTIN_SUPER_ADMIN_USERNAMES = Object.freeze(["bhrum108"]);

let runtimeAdminEmails = Object.freeze([]);
let runtimeAdminUsernames = BUILTIN_SUPER_ADMIN_USERNAMES;

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

export function configureRuntimeAdminEmails(env) {
  runtimeAdminEmails = parseAdminEmails(env);
  runtimeAdminUsernames = parseAdminUsernames(env);
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
  const username = String(user.username || '').trim().toLowerCase();
  if (!username) return false;
  const configured = env ? parseAdminUsernames(env) : runtimeAdminUsernames;
  return configured.includes(username);
}

export function hasUnlimitedUsage(user, env) {
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
