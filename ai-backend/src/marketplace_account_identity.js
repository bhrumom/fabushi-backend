import crypto from 'node:crypto';
import process from 'node:process';

function bearerToken(req) {
  const header = String(req.get?.('authorization') ?? req.headers?.authorization ?? '').trim();
  return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function firstText(values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

function immutableAccountId(values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(text)) return text;
    }
  }
  return '';
}

function accountAuthorityOrigin(raw) {
  const url = new URL(String(raw));
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const firstParty = ['https://api.ombhrum.com', 'https://fabushi-ci-isolated-auth.bhrumom.workers.dev'].includes(url.origin);
  if ((!firstParty && !loopback) || !['http:', 'https:'].includes(url.protocol)
      || (!loopback && url.protocol !== 'https:') || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') throw new Error('Native account origin is not approved.');
  return url.origin;
}

function accountAuthError(status = 401) {
  const error = new Error(status === 503
    ? 'Fabushi account authority is unavailable.'
    : 'A valid Fabushi account session is required for synchronized account state.');
  error.code = status === 503 ? 'ACCOUNT_AUTH_UNAVAILABLE' : 'ACCOUNT_AUTH_REQUIRED';
  error.statusCode = status;
  return error;
}

async function boundedAccountProfile(response) {
  const limit = 64 * 1024;
  if (Number(response.headers.get('content-length')) > limit || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw accountAuthError(503);
  }
  const reader = response.body.getReader();
  const parts = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); throw accountAuthError(503); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function remoteAccount(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload ?? {};
  const user = data?.user && typeof data.user === 'object' ? data.user : {};
  const id = immutableAccountId([
    data.userId,
    data.user_id,
    data.userNo,
    data.user_no,
    data.id,
    user.userId,
    user.user_id,
    user.userNo,
    user.user_no,
    user.id,
  ]);
  const username = firstText([data.username, data.name, user.username, user.name]);
  const email = firstText([data.email, user.email]);
  return { id, username, email };
}

function localIdentity(req) {
  const device = String(req.get?.('x-fabushi-device-id') ?? req.headers?.['x-fabushi-device-id'] ?? '').trim();
  const forwarded = String(req.get?.('x-forwarded-for') ?? req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
  const remote = String(req.ip ?? req.socket?.remoteAddress ?? forwarded ?? 'anonymous');
  const agent = String(req.get?.('user-agent') ?? req.headers?.['user-agent'] ?? 'unknown');
  const material = device ? `device:${device}` : `anonymous:${remote}:${agent}`;
  const hash = digest(material);
  return {
    accountId: null,
    scopeId: `scope-${hash}`,
    publisherId: `publisher-${hash.slice(0, 24)}`,
    authenticated: false,
    localOnly: true,
  };
}

function stableIdentity(accountId, profile = {}) {
  const normalized = String(accountId ?? '').trim();
  if (!normalized) return null;
  const canonical = normalized.startsWith('user:') ? normalized : `user:${normalized}`;
  const hash = digest(`account:${canonical}`);
  return {
    accountId: canonical,
    scopeId: `account-${hash}`,
    publisherId: `publisher-${hash.slice(0, 24)}`,
    authenticated: true,
    localOnly: false,
    username: String(profile.username ?? '').trim(),
    email: String(profile.email ?? '').trim(),
  };
}

/**
 * Resolve one canonical Fabushi account independently of the concrete session token.
 *
 * A bearer token is deliberately never used as the account namespace. Different
 * devices receive different session tokens, but /api/auth/user-info resolves all
 * valid sessions to the same durable user id.
 *
 * Public marketplace discovery may fall back to a device-local scope. Mutating or
 * private account operations pass requireAuthenticated=true and fail closed when a
 * supplied/required session cannot be resolved.
 */
export async function resolveMarketplaceAccountIdentity(
  req,
  {
    requireAuthenticated = false,
    resolveUser = null,
    fetchImpl = globalThis.fetch,
    apiBaseUrl = String(process.env.FABUSHI_API_BASE_URL ?? 'https://api.ombhrum.com').replace(/\/$/, ''),
  } = {},
) {
  const token = bearerToken(req);

  if (typeof resolveUser === 'function') {
    try {
      const user = await resolveUser(req, req.body ?? {});
      const account = stableIdentity(user?.userId ?? user?.id, user ?? {});
      if (account && user?.isAuthenticated !== false) return account;
    } catch (error) {
      if (requireAuthenticated) throw error;
    }
  }

  const testToken = String(process.env.TEST_ACCOUNT_TOKEN ?? '').trim();
  if (token && testToken && token === testToken) {
    return stableIdentity('user:test_account', { username: 'TestAccount' });
  }

  if (token && apiBaseUrl && typeof fetchImpl === 'function') {
    try {
      const origin = accountAuthorityOrigin(apiBaseUrl);
      const response = await fetchImpl(`${origin}/api/auth/user-info`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) {
        const profile = remoteAccount(await boundedAccountProfile(response));
        const account = stableIdentity(profile.id, profile);
        if (account) return account;
      }
      if (requireAuthenticated) {
        throw accountAuthError(response.status === 401 || response.status === 403 ? response.status : response.ok ? 401 : 503);
      }
    } catch (error) {
      if (requireAuthenticated) throw error?.code === 'ACCOUNT_AUTH_REQUIRED' ? error : accountAuthError(503);
    }
  }

  if (requireAuthenticated) {
    throw accountAuthError();
  }
  return localIdentity(req);
}

export function legacySessionScope(req) {
  const token = bearerToken(req);
  if (!token) return null;
  return `scope-${digest(`token:${token}`)}`;
}
