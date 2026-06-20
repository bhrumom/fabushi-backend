import { CORS_HEADERS } from '../config/constants.js';
import { jsonResponse } from '../utils/response.js';

const CBETA_PUBLIC_API_ROOT = 'https://api.ombhrum.com/api/cbeta';
const CBETA_SELF_HOSTED_API_ROOT = CBETA_PUBLIC_API_ROOT;
const CBETA_API_ROOTS = [CBETA_SELF_HOSTED_API_ROOT];
const DEFAULT_SEND_WORKS = [
  'T0365',
  'T0251',
  'T0235',
  'T0262',
  'T0279',
  'T0366',
  'T0001',
  'T0099',
  'T0220',
  'T0374',
  'T0261',
  'T0278',
];
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_TIMEOUT_MS = 10000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildCbetaUrl(path, params = {}, apiRoot = CBETA_SELF_HOSTED_API_ROOT) {
  const url = new URL(path.replace(/^\/+/, ''), `${apiRoot}/`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && `${value}` !== '') {
      url.searchParams.set(key, `${value}`);
    }
  }
  return url;
}

function summarizeBody(body) {
  if (!body) return '';
  return body.length > 600 ? `${body.slice(0, 600)}...` : body;
}

function hasUsableCbetaPayload(path, data) {
  if (!data || typeof data !== 'object') return true;
  if (data.error) return false;

  const normalizedPath = path.replace(/^\/+/, '');
  if (normalizedPath.startsWith('juans')) {
    const results = Array.isArray(data.results) ? data.results : [];
    return results.some(item => {
      if (typeof item === 'string') return item.trim() !== '';
      if (item && typeof item === 'object' && typeof item.html === 'string') {
        return item.html.trim() !== '';
      }
      return false;
    });
  }

  return true;
}

function describeUnusablePayload(path, data) {
  if (data?.error) return `CBETA payload error: ${data.error}`;
  if (path.replace(/^\/+/, '').startsWith('juans')) return 'CBETA returned empty juan content';
  return 'CBETA returned unusable payload';
}

async function fetchJsonWithRetry(path, params = {}, options = {}) {
  const retries = options.retries ?? DEFAULT_RETRY_COUNT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const apiRoots = options.apiRoots ?? CBETA_API_ROOTS;
  const attempts = [];

  for (const apiRoot of apiRoots) {
    const url = buildCbetaUrl(path, params, apiRoot);

    for (let attempt = 1; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();

      try {
        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
        const bodyText = await response.text();
        const detail = {
          attempt,
          apiRoot,
          url: url.toString(),
          status: response.status,
          statusText: response.statusText,
          durationMs: Date.now() - startedAt,
        };

        if (!response.ok) {
          attempts.push({
            ...detail,
            body: summarizeBody(bodyText),
          });
          if (attempt < retries) await sleep(250 * attempt);
          continue;
        }

        try {
          const data = JSON.parse(bodyText);
          if (!hasUsableCbetaPayload(path, data)) {
            attempts.push({
              ...detail,
              error: describeUnusablePayload(path, data),
              body: summarizeBody(bodyText),
            });
            if (attempt < retries) await sleep(250 * attempt);
            continue;
          }

          return {
            data,
            attempts: [...attempts, detail],
            apiRoot,
          };
        } catch (error) {
          attempts.push({
            ...detail,
            error: `JSON parse failed: ${error.message}`,
            body: summarizeBody(bodyText),
          });
          if (attempt < retries) await sleep(250 * attempt);
        }
      } catch (error) {
        attempts.push({
          attempt,
          apiRoot,
          url: url.toString(),
          durationMs: Date.now() - startedAt,
          error: error?.name === 'AbortError'
            ? `Request timed out after ${timeoutMs}ms`
            : error?.message || String(error),
        });
        if (attempt < retries) await sleep(250 * attempt);
      } finally {
        clearTimeout(timeoutId);
      }
    }
  }

  const error = new Error(`CBETA request failed after ${attempts.length} attempts`);
  error.details = attempts;
  throw error;
}

function decodeHtmlEntities(value) {
  const namedEntities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };

  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, code) => {
    if (code[0] === '#') {
      const radix = code[1]?.toLowerCase() === 'x' ? 16 : 10;
      const raw = code[1]?.toLowerCase() === 'x' ? code.slice(2) : code.slice(1);
      const parsed = parseInt(raw, radix);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : entity;
    }
    return namedEntities[code] ?? entity;
  });
}

function htmlToText(html) {
  if (!html) return '';

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const source = bodyMatch ? bodyMatch[1] : html;
  const withoutBackMatter = source
    .replace(/<div[^>]+id=['"]back['"][\s\S]*?<\/div>\s*<div[^>]+id=['"]cbeta-copyright['"]/i, '<div id="cbeta-copyright"')
    .replace(/<div[^>]+id=['"]cbeta-copyright['"][\s\S]*?<\/div>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<span[^>]+class=['"][^'"]*\blb\b[^'"]*['"][^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<span[^>]+class=['"][^'"]*\blineInfo\b[^'"]*['"][^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<a[^>]+class=['"][^'"]*\bnoteAnchor\b[^'"]*['"][^>]*>[\s\S]*?<\/a>/gi, '')
    .replace(/<a[^>]+class=['"][^'"]*\bfacsimile\b[^'"]*['"][^>]*>[\s\S]*?<\/a>/gi, '')
    .replace(/<(p|div|br|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeHtmlEntities(withoutBackMatter)
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeFileName(value) {
  return value
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '')
    .slice(0, 80);
}

function extractTitleFromHtml(html) {
  const match = html?.match(/<title>([\s\S]*?)<\/title>/i);
  return match ? decodeHtmlEntities(match[1].replace(/<[^>]+>/g, '')).trim() : '';
}

function parseWorksParam(value) {
  if (!value) return DEFAULT_SEND_WORKS;

  const works = value
    .split(',')
    .map(item => item.trim().toUpperCase())
    .filter(item => /^[A-Z][A-Z0-9]?\d{4}[A-Z]?$/.test(item));

  return works.length > 0 ? works : DEFAULT_SEND_WORKS;
}

function parseLimit(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 24);
}

function toCbetaItem(work, juan, payload, attempts, apiRoot) {
  const html = Array.isArray(payload?.results) ? payload.results[0] : '';
  const workInfo = payload?.work_info || {};
  const title = workInfo.title || extractTitleFromHtml(html) || work;
  const content = htmlToText(html);

  if (!content) {
    throw new Error(`CBETA returned empty content for ${work} juan ${juan}`);
  }

  return {
    work: workInfo.work || work,
    juan,
    title,
    byline: workInfo.byline || '',
    category: workInfo.category || workInfo.orig_category || '',
    fileName: `${workInfo.work || work}_${juan}_${safeFileName(title)}.txt`,
    content,
    contentLength: content.length,
    source: 'CBETA',
    sourceApi: apiRoot,
    sourceUrl: buildCbetaUrl('juans', {
      work: workInfo.work || work,
      juan,
      work_info: 1,
      toc: 1,
    }, apiRoot).toString(),
    fetchAttempts: attempts,
  };
}

function normalizeError(work, juan, error) {
  return {
    work,
    juan,
    message: error?.message || String(error),
    attempts: error?.details || [],
    stack: error?.stack || '',
  };
}

export async function handleGetCbetaSendTexts(request) {
  const url = new URL(request.url);
  const works = parseWorksParam(url.searchParams.get('works'));
  const limit = parseLimit(url.searchParams.get('limit'), DEFAULT_SEND_WORKS.length);
  const juan = parseLimit(url.searchParams.get('juan'), 1);
  const selectedWorks = works.slice(0, limit);
  const items = [];
  const errors = [];

  for (const work of selectedWorks) {
    try {
      const { data, attempts, apiRoot } = await fetchJsonWithRetry('juans', {
        work,
        juan,
        work_info: 1,
        toc: 1,
      });
      items.push(toCbetaItem(work, juan, data, attempts, apiRoot));
    } catch (error) {
      errors.push(normalizeError(work, juan, error));
    }
  }

  const payload = {
    success: items.length > 0,
    source: 'CBETA',
    api: CBETA_PUBLIC_API_ROOT,
    primaryApi: CBETA_SELF_HOSTED_API_ROOT,
    fallbackApi: null,
    requested: selectedWorks.length,
    count: items.length,
    items,
    errors,
  };

  return jsonResponse(payload, items.length > 0 ? 200 : 502);
}

function canUseProxyResponse(path, method, bodyText, contentType) {
  if (method === 'HEAD') return true;
  if (!contentType?.toLowerCase().includes('application/json')) return true;

  try {
    return hasUsableCbetaPayload(path, JSON.parse(bodyText));
  } catch {
    return false;
  }
}

export async function handleProxyCbetaRequest(request) {
  const sourceUrl = new URL(request.url);
  const cbetaPath = sourceUrl.pathname.replace(/^\/api\/cbeta\/?/, '');
  const params = Object.fromEntries(sourceUrl.searchParams);
  const attempts = [];
  let lastOkResponse = null;

  for (const apiRoot of CBETA_API_ROOTS) {
    const targetUrl = buildCbetaUrl(cbetaPath || '/', params, apiRoot);
    const startedAt = Date.now();

    try {
      const response = await fetch(targetUrl.toString(), {
        method: request.method,
        headers: {
          Accept: request.headers.get('Accept') || 'application/json',
        },
      });
      const bodyText = request.method === 'HEAD' ? '' : await response.text();
      const contentType = response.headers.get('Content-Type');
      const detail = {
        apiRoot,
        url: targetUrl.toString(),
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - startedAt,
      };

      if (response.ok && canUseProxyResponse(cbetaPath, request.method, bodyText, contentType)) {
        const headers = new Headers(CORS_HEADERS);
        if (contentType) headers.set('Content-Type', contentType);
        headers.set('X-CBETA-Upstream', apiRoot);

        return new Response(request.method === 'HEAD' ? null : bodyText, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      if (response.ok) {
        lastOkResponse = {
          bodyText,
          contentType,
          status: response.status,
          statusText: response.statusText,
        };
      }

      attempts.push({
        ...detail,
        body: summarizeBody(bodyText),
      });
    } catch (error) {
      attempts.push({
        apiRoot,
        url: targetUrl.toString(),
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error),
      });
    }
  }

  if (lastOkResponse) {
    const headers = new Headers(CORS_HEADERS);
    if (lastOkResponse.contentType) headers.set('Content-Type', lastOkResponse.contentType);

    return new Response(request.method === 'HEAD' ? null : lastOkResponse.bodyText, {
      status: lastOkResponse.status,
      statusText: lastOkResponse.statusText,
      headers,
    });
  }

  return jsonResponse({
    success: false,
    error: 'CBETA upstream unavailable',
    attempts,
  }, 502);
}
