// 完整模块化Worker - 包含所有功能并使用D1数据库
import { DatabaseService } from './src/services/database.js';
import { route } from './src/router.js';
import { CORS_HEADERS } from './src/config/constants.js';

const APP_VERSION = Date.now().toString();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    // CORS预检
    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // 初始化D1数据库服务
      const db = new DatabaseService(env.DB);
      
      // 路由到模块化处理器
      const response = await route(request, env, db, ctx);
      if (response) return response;

      // 静态文件服务
      if (env.ASSETS) {
        let assetResponse = await env.ASSETS.fetch(request);

        // SPA fallback
        if (assetResponse.status === 404 && !pathname.startsWith('/api/') && !/\.[^/]+$/.test(pathname)) {
          const spaRequest = new Request(new URL('/index.html', request.url), request);
          assetResponse = await env.ASSETS.fetch(spaRequest);
        }

        // 添加CORS和版本头
        const newResponse = new Response(
          method === 'HEAD' ? null : assetResponse.body,
          {
            status: assetResponse.status,
            statusText: assetResponse.statusText,
            headers: assetResponse.headers
          }
        );

        newResponse.headers.set('Access-Control-Allow-Origin', '*');
        newResponse.headers.set('X-App-Version', APP_VERSION);

        // 缓存策略
        const noCacheList = ['/', '/index.html', '/flutter_service_worker.js', '/main.dart.js'];
        if (noCacheList.includes(pathname)) {
          newResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|json|wasm)$/i.test(pathname)) {
          if (!newResponse.headers.has('Cache-Control')) {
            newResponse.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
          }
        }

        return newResponse;
      }

      return new Response('Not Found', { status: 404, headers: CORS_HEADERS });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response('Internal Server Error', { 
        status: 500, 
        headers: CORS_HEADERS 
      });
    }
  }
};
