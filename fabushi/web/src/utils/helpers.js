let runtimeAdminEmails = Object.freeze([]);

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
  return runtimeAdminEmails.length;
}

export function isAdmin(email, env) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  const configured = env ? parseAdminEmails(env) : runtimeAdminEmails;
  return configured.length > 0 && configured.includes(normalized);
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
