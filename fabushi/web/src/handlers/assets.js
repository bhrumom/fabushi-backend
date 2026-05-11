import { jsonResponse } from '../utils/response.js';

// 获取资源列表
export async function handleGetAssetsList(request, env) {
  let r2Files = [];
  if (env.R2_BUCKET) {
    const r2Objects = await env.R2_BUCKET.list();
    if (r2Objects?.objects) {
      r2Files = r2Objects.objects.map(obj => ({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded,
        source: 'r2'
      }));
    }
  }

  let staticFiles = [];
  if (env.ASSETS) {
    const manifestUrl = new URL('/asset-manifest.json', request.url);
    const manifestResponse = await env.ASSETS.fetch(new Request(manifestUrl));
    if (manifestResponse.ok) {
      try {
        staticFiles = await manifestResponse.json();
      } catch (e) {}
    }
  }

  const finalFiles = [...r2Files, ...staticFiles];
  return jsonResponse({ files: finalFiles, count: finalFiles.length });
}

// R2文件列表
export async function handleR2List(request, env) {
  if (!env.R2_BUCKET) {
    return jsonResponse({ error: 'R2存储桶未绑定' }, 500);
  }

  const objects = await env.R2_BUCKET.list();
  const fileList = objects.objects.map(obj => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded
  }));

  return jsonResponse({
    objects: fileList,
    files: fileList,
    count: fileList.length,
    truncated: objects.truncated
  });
}

// R2文件代理
export async function handleR2Proxy(request, env) {
  const url = new URL(request.url);
  const fileKey = url.searchParams.get('file')?.trim();
  
  if (!fileKey) return new Response('错误：未指定文件参数', { status: 400 });
  if (!env.R2_BUCKET) return new Response('错误：R2存储桶未绑定', { status: 500 });

  const method = request.method;
  
  if (method === 'HEAD') {
    const headObject = await env.R2_BUCKET.head(fileKey);
    if (!headObject) return new Response('错误：文件不存在', { status: 404 });

    const headers = new Headers();
    headers.set('etag', headObject.httpEtag);
    headers.set('Content-Length', String(headObject.size));
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Access-Control-Allow-Origin', '*');
    
    return new Response(null, { status: 200, headers });
  }

  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const match = /bytes\s*=\s*(\d+)-(\d+)?/.exec(rangeHeader);
    if (match) {
      const start = Number(match[1]);
      const headObject = await env.R2_BUCKET.head(fileKey);
      if (!headObject) return new Response('错误：文件不存在', { status: 404 });
      
      const size = headObject.size;
      const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || end < start) {
        const headers = new Headers();
        headers.set('Content-Range', `bytes */${size}`);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response('请求范围不满足', { status: 416, headers });
      }

      const length = end - start + 1;

      const rangedObject = await env.R2_BUCKET.get(fileKey, { range: { offset: start, length } });
      if (!rangedObject) return new Response('错误：文件不存在', { status: 404 });

      const headers = new Headers();
      headers.set('Content-Length', String(length));
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Access-Control-Allow-Origin', '*');
      
      return new Response(rangedObject.body, { status: 206, headers });
    }
  }

  const object = await env.R2_BUCKET.get(fileKey);
  if (!object) return new Response('错误：文件不存在', { status: 404 });

  const headers = new Headers();
  headers.set('Content-Length', String(object.size));
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Allow-Origin', '*');
  
  return new Response(object.body, { status: 200, headers });
}
