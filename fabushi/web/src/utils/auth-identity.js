import { verifyToken } from '../../auth-utils.js';

export function normalizeUserId(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasStableUserId(auth) {
  return Number.isFinite(auth?.userId);
}

export function isMissingUserIdColumnError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('no such column') ||
    message.includes('has no column named');
}

export async function resolveUserIdByUsername(db, username) {
  if (!username) return null;
  try {
    const row = await db.prepare(`
      SELECT id
      FROM users
      WHERE username = ?
    `).bind(username).first();
    return normalizeUserId(row?.id);
  } catch (_) {
    return null;
  }
}

export async function authIdentityFromToken(token, env, db = null) {
  if (!token) return null;
  const decoded = await verifyToken(token, env);
  const username = decoded?.username || decoded?.sub || null;
  if (!username) return null;

  const tokenUserId = normalizeUserId(decoded.userId ?? decoded.user_id ?? decoded.id);
  const userId = tokenUserId ?? (db ? await resolveUserIdByUsername(db, username) : null);
  return { username, userId };
}

export async function requireAuthIdentity(request, env, db = null) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : authHeader?.replace('Bearer ', '') || null;

  const auth = await authIdentityFromToken(token, env, db);
  if (!auth?.username) {
    return { error: '认证失败', status: 401 };
  }

  return auth;
}

export async function optionalAuthIdentity(request, env, db = null) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.substring(7)
    : authHeader?.replace('Bearer ', '') || null;
  return await authIdentityFromToken(token, env, db);
}

export function ownerScope(auth, {
  idColumn = 'user_id',
  usernameColumn = 'username',
  tableAlias = '',
} = {}) {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  if (hasStableUserId(auth)) {
    return {
      where: `(${prefix}${idColumn} = ? OR (${prefix}${idColumn} IS NULL AND ${prefix}${usernameColumn} = ?))`,
      params: [auth.userId, auth.username],
      stable: true,
    };
  }
  return {
    where: `${prefix}${usernameColumn} = ?`,
    params: [auth.username],
    stable: false,
  };
}

export function usernameOwnerScope(auth, {
  usernameColumn = 'username',
  tableAlias = '',
} = {}) {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  return {
    where: `${prefix}${usernameColumn} = ?`,
    params: [auth.username],
    stable: false,
  };
}

export async function withOwnerScope(db, auth, build, {
  mode = 'all',
  idColumn = 'user_id',
  usernameColumn = 'username',
  tableAlias = '',
} = {}) {
  const run = async (scope) => {
    const { sql, params } = build(scope);
    const statement = db.prepare(sql).bind(...params);
    if (mode === 'first') return await statement.first();
    if (mode === 'run') return await statement.run();
    return await statement.all();
  };

  const scope = ownerScope(auth, { idColumn, usernameColumn, tableAlias });
  try {
    return await run(scope);
  } catch (error) {
    if (!scope.stable || !isMissingUserIdColumnError(error)) {
      throw error;
    }
    return await run(usernameOwnerScope(auth, { usernameColumn, tableAlias }));
  }
}

export async function backfillOwnerUserId(db, auth, specs) {
  if (!hasStableUserId(auth)) return;

  await Promise.all(specs.map(async ({
    table,
    idColumn = 'user_id',
    usernameColumn = 'username',
  }) => {
    try {
      await db.prepare(`
        UPDATE ${table}
        SET ${idColumn} = ?
        WHERE ${idColumn} IS NULL AND ${usernameColumn} = ?
      `).bind(auth.userId, auth.username).run();
    } catch (error) {
      if (!isMissingUserIdColumnError(error)) {
        console.warn(`${table} user_id backfill skipped:`, error?.message || error);
      }
    }
  }));
}
