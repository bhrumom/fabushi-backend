// 模块化Worker入口
import { DatabaseService } from './src/services/database.js';
import { route } from './src/router.js';
import { OnlineCounter } from './src/durable-objects/OnlineCounter.js';

// 导出Durable Object类
export { OnlineCounter };

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // 全局请求日志 - 用于调试 WebSocket 连接问题
      console.log(`📥 Request: ${request.method} ${url.pathname}${url.search}`);

      // WebSocket 升级请求 - 转发到 Durable Object
      if (url.pathname === '/api/online/ws') {
        const upgradeHeader = request.headers.get('Upgrade');
        const activityType = url.searchParams.get('activityType');

        console.log('WebSocket request received:', {
          path: url.pathname,
          upgrade: upgradeHeader,
          activityType: activityType,
          method: request.method,
          headers: Object.fromEntries(request.headers.entries())
        });

        if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
          if (!activityType || !['global_sending', 'zen_room'].includes(activityType)) {
            console.log('❌ Invalid activityType:', activityType);
            return new Response('Invalid activityType', { status: 400 });
          }

          console.log('✅ WebSocket upgrade - forwarding to Durable Object:', activityType);
          try {
            const id = env.ONLINE_COUNTER.idFromName(activityType);
            const stub = env.ONLINE_COUNTER.get(id);
            const response = await stub.fetch(request);
            console.log('📡 Durable Object response status:', response.status);
            return response;
          } catch (error) {
            console.error('❌ Error forwarding to Durable Object:', error);
            return new Response('WebSocket upgrade failed: ' + error.message, { status: 500 });
          }
        } else {
          console.log('⚠️ Not a WebSocket upgrade request, upgrade header:', upgradeHeader);
        }
      }

      // 初始化数据库服务
      const db = new DatabaseService(env.DB);

      // 尝试路由到模块化处理器
      const response = await route(request, env, db);
      if (response) return response;

      // /support 支持页面路由
      if (url.pathname === '/support' || url.pathname === '/support/') {
        try {
          // 尝试从静态资源提供
          if (env.ASSETS) {
            const supportRequest = new Request(new URL('/support/index.html', request.url), request);
            const assetResponse = await env.ASSETS.fetch(supportRequest);
            if (assetResponse.status === 200) {
              const newResponse = new Response(assetResponse.body, {
                status: 200,
                headers: {
                  'Content-Type': 'text/html; charset=utf-8',
                  'Access-Control-Allow-Origin': '*',
                  'Cache-Control': 'public, max-age=3600',
                },
              });
              return newResponse;
            }
          }
        } catch (e) {
          console.error('Error serving support page from assets:', e);
        }
        // 回退：返回307重定向到静态文件
        return Response.redirect(new URL('/support/index.html', request.url).href, 307);
      }

      // 静态文件服务
      if (env.ASSETS) {
        const url = new URL(request.url);
        const pathname = url.pathname;

        let assetResponse = await env.ASSETS.fetch(request);

        // SPA fallback: 如果是 404 且不是 API 请求，也不是带扩展名的文件，或者是 /support 路径，尝试返回 index.html
        if (assetResponse.status === 404 && !pathname.startsWith('/api/')) {
          // 特殊处理 /support 路径，回退到 /support/index.html
          if (pathname === '/support' || pathname === '/support/') {
            const supportRequest = new Request(new URL('/support/index.html', request.url), request);
            const supportResponse = await env.ASSETS.fetch(supportRequest);
            if (supportResponse.status === 200) {
              assetResponse = supportResponse;
            }
          }
          // 普通 SPA 回退 (排除 /support/ 开头的其他路径，只处理根路径或未匹配路径)
          else if (!/\.[^/]+$/.test(pathname) && !pathname.startsWith('/support/')) {
            const spaRequest = new Request(new URL('/index.html', request.url), request);
            assetResponse = await env.ASSETS.fetch(spaRequest);
          }
        }

        // 添加CORS和版本头
        const newResponse = new Response(
          request.method === 'HEAD' ? null : assetResponse.body,
          {
            status: assetResponse.status,
            statusText: assetResponse.statusText,
            headers: assetResponse.headers
          }
        );

        newResponse.headers.set('Access-Control-Allow-Origin', '*');

        // 缓存策略
        const noCacheList = ['/', '/index.html', '/support/', '/support/index.html', '/flutter_service_worker.js', '/main.dart.js'];
        if (noCacheList.includes(pathname)) {
          newResponse.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|json|wasm)$/i.test(pathname)) {
          if (!newResponse.headers.has('Cache-Control')) {
            newResponse.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
          }
        }

        return newResponse;
      }

      // 最后的兜底
      return new Response('Not Found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
    }
  }
};
