const BUILTIN_SUPER_ADMIN_USERNAMES = Object.freeze(['bhrum108']);

function normalizedUsernames(env = process.env) {
  const configured = String(env?.SUPER_ADMIN_USERNAMES || env?.ADMIN_USERNAMES || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BUILTIN_SUPER_ADMIN_USERNAMES, ...configured]);
}

export function resolveAccountEntitlements(account, env = process.env) {
  const username = String(account?.username || '').trim().toLowerCase();
  const superAdmin = Boolean(username && normalizedUsernames(env).has(username));
  return {
    role: superAdmin ? 'super_admin' : 'user',
    isAdmin: superAdmin,
    unlimitedUsage: superAdmin,
  };
}

export function hasUnlimitedUsage(account, env = process.env) {
  return resolveAccountEntitlements(account, env).unlimitedUsage;
}
