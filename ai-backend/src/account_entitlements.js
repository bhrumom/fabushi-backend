const BUILTIN_SUPER_ADMIN_USERNAMES = Object.freeze(['bhrum108']);
const BUILTIN_SUPER_ADMIN_ACCOUNT_IDS = Object.freeze(['22']);
const BUILTIN_UNLIMITED_ACCOUNT_USERNAMES = Object.freeze(['fabushi_mcp_ci_test']);
const BUILTIN_UNLIMITED_ACCOUNT_IDS = Object.freeze(['197915874789377', 'user:197915874789377']);

function normalizedUsernames(env = process.env) {
  const configured = String(env?.SUPER_ADMIN_USERNAMES || env?.ADMIN_USERNAMES || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BUILTIN_SUPER_ADMIN_USERNAMES, ...configured]);
}

function normalizedAccountIds(env = process.env) {
  const configured = String(env?.SUPER_ADMIN_ACCOUNT_IDS || env?.ADMIN_ACCOUNT_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...BUILTIN_SUPER_ADMIN_ACCOUNT_IDS, ...configured]);
}

function unlimitedAccountUsername(username) {
  return BUILTIN_UNLIMITED_ACCOUNT_USERNAMES.includes(username);
}

function unlimitedAccountId(id) {
  return BUILTIN_UNLIMITED_ACCOUNT_IDS.includes(id);
}

function accountId(account) {
  return String(account?.id ?? account?.userId ?? account?.user_id ?? '').trim();
}

export function resolveAccountEntitlements(account, env = process.env) {
  const username = String(account?.username || '').trim().toLowerCase();
  const stableId = accountId(account);
  const superAdmin = Boolean(
    (username && normalizedUsernames(env).has(username)) ||
    (stableId && normalizedAccountIds(env).has(stableId)),
  );
  return {
    role: superAdmin ? 'super_admin' : 'user',
    isAdmin: superAdmin,
    unlimitedUsage: superAdmin || unlimitedAccountUsername(username) || unlimitedAccountId(stableId),
  };
}

export function hasUnlimitedUsage(account, env = process.env) {
  return resolveAccountEntitlements(account, env).unlimitedUsage;
}
