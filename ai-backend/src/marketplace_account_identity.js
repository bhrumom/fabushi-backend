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

function remoteAccount(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload ?? {};
  const user = data?.user && typeof data.user === 'object' ? data.user : {};
  const id = firstText([
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
      const response = await fetchImpl(`${apiBaseUrl}/api/auth/user-info`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) {
        const profile = remoteAccount(await response.json());
        const account = stableIdentity(profile.id || profile.username || profile.email, profile);
        if (account) return account;
      }
      if (requireAuthenticated) {
        const error = new Error('A valid Fabushi account session is required for synchronized account state.');
        error.code = 'ACCOUNT_AUTH_REQUIRED';
        error.statusCode = response.status === 401 || response.status === 403 ? response.status : 401;
        throw error;
      }
    } catch (error) {
      if (requireAuthenticated) throw error;
    }
  }

  if (requireAuthenticated) {
    const error = new Error('A valid Fabushi account session is required for synchronized account state.');
    error.code = 'ACCOUNT_AUTH_REQUIRED';
    error.statusCode = 401;
    throw error;
  }
  return localIdentity(req);
}

export function legacySessionScope(req) {
  const token = bearerToken(req);
  if (!token) return null;
  return `scope-${digest(`token:${token}`)}`;
}
