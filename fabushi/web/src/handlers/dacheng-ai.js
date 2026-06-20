import { CORS_HEADERS } from '../config/constants.js';
import { jsonResponse } from '../utils/response.js';

const DEFAULT_DACHENG_AI_BACKEND_URL = 'https://ai.ombhrum.com';
const DEFAULT_DACHENG_AI_BACKEND_TIMEOUT_MS = 8000;

export function isDachengAiPath(pathname) {
  return (
    pathname.startsWith('/api/ai/') ||
    pathname.startsWith('/api/agent/') ||
    pathname.startsWith('/api/resources/') ||
    pathname === '/api/codex/resource-task'
  );
}

export async function handleDachengAiProxy(request, env) {
  const origin = (env.DACHENG_AI_BACKEND_URL || DEFAULT_DACHENG_AI_BACKEND_URL).replace(/\/+$/, '');
  const timeoutMs = Number(env.DACHENG_AI_BACKEND_TIMEOUT_MS || DEFAULT_DACHENG_AI_BACKEND_TIMEOUT_MS);
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, origin);

  const headers = new Headers(request.headers);
  headers.delete('Host');
  headers.set('X-Forwarded-Host', incomingUrl.host);
  headers.set('X-Forwarded-Proto', incomingUrl.protocol.replace(':', ''));

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(request.method)) {
    init.body = request.body;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;

  try {
    const upstream = await fetch(targetUrl, init);
    const responseHeaders = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      responseHeaders.set(key, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Dacheng AI proxy failed:', error);
    return jsonResponse(
      {
        success: false,
        error: 'Dacheng AI backend unavailable',
        message: '大乘 AI 后端暂时不可用，请稍后重试。',
      },
      502,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}
