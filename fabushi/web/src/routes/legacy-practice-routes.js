// Temporary compatibility boundary for the Buddhist practice feature.
// New platform code must not import this module. It exists only until the legacy
// practice data is migrated into workspace/peer primitives.
import { routeMeditationRequest } from './meditation-routes.js';
import { verifyToken } from '../../auth-utils.js';
import { jsonResponse } from '../utils/response.js';

function jsonStringifyAscii(value) {
  return JSON.stringify(value).replace(/[\u0080-\uffff]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

function createCompatibilityToken(username, userId = null) {
  const payload = btoa(jsonStringifyAscii({ username, userId }));
  return `compat.${payload}.verified`;
}

async function normalizeVerifiedAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return { request };
  try {
    const claims = await verifyToken(authHeader.slice(7), env);
    const username = claims?.username || claims?.sub;
    if (!username) return { response: jsonResponse({ success: false, error: 'Token无效或已过期' }, 401) };
    const userId = claims?.userId ?? claims?.user_id ?? claims?.id ?? null;
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${createCompatibilityToken(username, userId)}`);
    return { request: new Request(request, { headers }) };
  } catch (error) {
    console.warn('legacy practice auth bridge rejected request:', error?.message || error);
    return { response: jsonResponse({ success: false, error: 'Token无效或已过期' }, 401) };
  }
}

export async function routeLegacyPracticeRequest({ pathname, method, request, env, db, ctx }) {
  if (!pathname.startsWith('/api/meditation/')) return null;
  const normalized = await normalizeVerifiedAuth(request, env);
  if (normalized.response) return normalized.response;
  return routeMeditationRequest({ pathname, method, request: normalized.request, env, db, ctx });
}
