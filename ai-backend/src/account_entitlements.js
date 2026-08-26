const BUILTIN_SUPER_ADMIN_USERNAMES = Object.freeze(['bhrum108']);
const BUILTIN_SUPER_ADMIN_ACCOUNT_IDS = Object.freeze(['22']);

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
    unlimitedUsage: superAdmin,
  };
}

export function hasUnlimitedUsage(account, env = process.env) {
  return resolveAccountEntitlements(account, env).unlimitedUsage;
}
