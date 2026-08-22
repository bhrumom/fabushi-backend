import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { isAdmin } from '../utils/helpers.js';

async function resolveUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = await verifyToken(auth.slice(7), env);
  if (!token) return null;
  if (token.userId !== undefined && env.DB?.prepare) {
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(Number(token.userId)).first();
    if (user) return user;
  }
  if (token.username && env.DB?.prepare) {
    return await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(token.username).first();
  }
  return null;
}

async function requireAdmin(request, env) {
  const user = await resolveUser(request, env);
  if (!user) return jsonResponse({ error: '认证失败' }, 401);
  if (!isAdmin(user.email, env)) return jsonResponse({ error: '权限不足' }, 403);
  return null;
}

function publicPrefixes(env) {
  return String(env.R2_PUBLIC_PREFIXES || 'public/,assets/,builtin/')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function validKey(key) {
  return Boolean(key)
    && key.length <= 1024
    && !key.includes('\0')
    && !key.startsWith('/')
    && !key.split('/').includes('..');
}

async function canReadKey(request, env, key) {
  if (publicPrefixes(env).some((prefix) => key.startsWith(prefix))) return true;
  return Boolean(await resolveUser(request, env));
}

function objectHeaders(object) {
  const headers = new Headers();
  headers.set('Content-Length', String(object.size));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, max-age=300');
  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  if (object.httpMetadata?.contentType) headers.set('Content-Type', object.httpMetadata.contentType);
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

export async function handleGetAssetsList(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  let r2Files = [];
  if (env.R2_BUCKET) {
    const r2Objects = await env.R2_BUCKET.list({ limit: 1000 });
    if (r2Objects?.objects) {
      r2Files = r2Objects.objects.map((obj) => ({ key: obj.key, size: obj.size, uploaded: obj.uploaded, source: 'r2' }));
    }
  }

  let staticFiles = [];
  if (env.ASSETS) {
    const manifestUrl = new URL('/asset-manifest.json', request.url);
    const manifestResponse = await env.ASSETS.fetch(new Request(manifestUrl));
    if (manifestResponse.ok) {
      try { staticFiles = await manifestResponse.json(); } catch { staticFiles = []; }
    }
  }

  const finalFiles = [...r2Files, ...(Array.isArray(staticFiles) ? staticFiles : [])];
  return jsonResponse({ files: finalFiles, count: finalFiles.length });
}

export async function handleR2List(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.R2_BUCKET) return jsonResponse({ error: 'R2存储桶未绑定' }, 500);

  const objects = await env.R2_BUCKET.list({ limit: 1000 });
  const fileList = (objects.objects || []).map((obj) => ({ key: obj.key, size: obj.size, uploaded: obj.uploaded }));
  return jsonResponse({ objects: fileList, files: fileList, count: fileList.length, truncated: objects.truncated });
}

export async function handleR2Proxy(request, env) {
  const url = new URL(request.url);
  const fileKey = url.searchParams.get('file')?.trim();
  if (!validKey(fileKey)) return new Response('错误：文件参数无效', { status: 400 });
  if (!env.R2_BUCKET) return new Response('错误：R2存储桶未绑定', { status: 500 });
  if (!(await canReadKey(request, env, fileKey))) return new Response('Unauthorized', { status: 401 });

  const method = request.method;
  if (!['GET', 'HEAD'].includes(method)) return new Response('Method Not Allowed', { status: 405 });

  const headObject = await env.R2_BUCKET.head(fileKey);
  if (!headObject) return new Response('错误：文件不存在', { status: 404 });
  const baseHeaders = objectHeaders(headObject);
  if (method === 'HEAD') return new Response(null, { status: 200, headers: baseHeaders });

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const match = /^bytes\s*=\s*(\d+)-(\d+)?$/i.exec(rangeHeader.trim());
    if (!match) return new Response('请求范围格式无效', { status: 416, headers: baseHeaders });
    const start = Number(match[1]);
    const size = headObject.size;
    const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      baseHeaders.set('Content-Range', `bytes */${size}`);
      return new Response('请求范围不满足', { status: 416, headers: baseHeaders });
    }
    const length = end - start + 1;
    const rangedObject = await env.R2_BUCKET.get(fileKey, { range: { offset: start, length } });
    if (!rangedObject) return new Response('错误：文件不存在', { status: 404 });
    const headers = objectHeaders(rangedObject);
    headers.set('Content-Length', String(length));
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
    return new Response(rangedObject.body, { status: 206, headers });
  }

  const object = await env.R2_BUCKET.get(fileKey);
  if (!object) return new Response('错误：文件不存在', { status: 404 });
  return new Response(object.body, { status: 200, headers: objectHeaders(object) });
}
