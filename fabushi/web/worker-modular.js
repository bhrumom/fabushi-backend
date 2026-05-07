// 模块化Worker入口
import { DatabaseService } from './src/services/database.js';
import { route } from './src/router.js';
import { OnlineCounter } from './src/durable-objects/OnlineCounter.js';
import { jsonResponse } from './src/utils/response.js';

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
      const response = await route(request, env, db, ctx);
      if (response) return response;

      return jsonResponse({
        success: false,
        error: 'Not Found',
        message: 'This Cloudflare Worker is an API backend only.',
        path: url.pathname
      }, 404);

    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({ success: false, error: 'Internal Server Error' }, 500);
    }
  }
};
