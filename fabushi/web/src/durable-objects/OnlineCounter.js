/**
 * OnlineCounter Durable Object - WebSocket Version
 * 管理特定活动类型的在线用户计数
 * 
 * 功能：
 * - WebSocket 实时推送在线人数变化
 * - 追踪用户会话和最后心跳时间
 * - 自动清理超时用户（90秒未心跳）
 * - 向所有连接的客户端广播更新
 */
export class OnlineCounter {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        // 存储格式: sessionId -> { lastHeartbeat: timestamp, ws: WebSocket }
        this.sessions = new Map();
        // WebSocket 连接: ws -> sessionId
        this.webSockets = new Map();
        // 临时存储未验证的 WebSocket 连接，防止 GC
        this.pendingSockets = new Set();
        this.TIMEOUT_MS = 90 * 1000; // 90秒超时
        this.CLEANUP_INTERVAL_MS = 30 * 1000; // 30秒检查一次
    }

    /**
     * 处理HTTP请求（包括 WebSocket 升级）
     */
    async fetch(request) {
        const url = new URL(request.url);
        const upgradeHeader = request.headers.get('Upgrade');

        console.log('DO received request:', {
            upgrade: upgradeHeader,
            path: url.pathname
        });

        // WebSocket 升级请求
        if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
            console.log('DO handling WebSocket');
            return this.handleWebSocket(request);
        }

        // 保留 HTTP 端点作为降级方案
        const action = url.searchParams.get('action');
        try {
            switch (action) {
                case 'join':
                    return await this.handleJoin(request);
                case 'heartbeat':
                    return await this.handleHeartbeat(request);
                case 'leave':
                    return await this.handleLeave(request);
                case 'count':
                    return await this.handleCount();
                default:
                    return this.jsonResponse({ error: 'Invalid action' }, 400);
            }
        } catch (error) {
            console.error('OnlineCounter error:', error);
            return this.jsonResponse({ error: error.message }, 500);
        }
    }

    /**
     * 处理 WebSocket 连接
     */
    async handleWebSocket(request) {
        try {
            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);

            console.log('Creating WebSocket pair');

            // 接受 WebSocket 连接
            // 使用 Standard WebSocket API (server.accept()) 而不是 Hibernatable API (state.acceptWebSocket())
            // 因为我们使用的是 event listeners 模式
            server.accept();
            console.log('WebSocket accepted (Standard API)');

            // 添加到 pendingSockets 防止 GC
            this.pendingSockets.add(server);

            // 设置 WebSocket 事件处理器
            server.addEventListener('message', async (event) => {
                try {
                    const message = JSON.parse(event.data);
                    await this.handleWebSocketMessage(server, message);
                } catch (error) {
                    console.error('WebSocket message error:', error);
                    server.send(JSON.stringify({ type: 'error', message: error.message }));
                }
            });

            server.addEventListener('close', () => {
                this.pendingSockets.delete(server);
                this.handleWebSocketClose(server);
            });

            server.addEventListener('error', (error) => {
                console.error('WebSocket error:', error);
                this.pendingSockets.delete(server);
                this.handleWebSocketClose(server);
            });

            console.log('Returning 101 response');
            return new Response(null, { status: 101, webSocket: client });
        } catch (error) {
            console.error('handleWebSocket error:', error);
            return new Response('WebSocket upgrade failed: ' + error.message, { status: 500 });
        }
    }

    /**
     * 处理 WebSocket 消息
     */
    async handleWebSocketMessage(ws, message) {
        const { action, sessionId, activityType } = message;

        switch (action) {
            case 'join':
                if (!sessionId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'sessionId required' }));
                    return;
                }

                const now = Date.now();
                this.sessions.set(sessionId, { lastHeartbeat: now, ws });
                this.webSockets.set(ws, sessionId);

                await this.ensureAlarm();

                console.log(`Session ${sessionId} joined via WebSocket. Total: ${this.sessions.size}`);

                // 广播给所有客户端
                this.broadcastCount();
                break;

            case 'heartbeat':
                if (!sessionId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'sessionId required' }));
                    return;
                }

                const session = this.sessions.get(sessionId);
                if (!session) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Session not found',
                        shouldRejoin: true
                    }));
                    return;
                }

                session.lastHeartbeat = Date.now();
                break;

            case 'leave':
                if (!sessionId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'sessionId required' }));
                    return;
                }

                this.sessions.delete(sessionId);
                this.webSockets.delete(ws);

                console.log(`Session ${sessionId} left. Total: ${this.sessions.size}`);

                // 广播更新
                this.broadcastCount();
                break;

            default:
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid action' }));
        }
    }

    /**
     * 处理 WebSocket 断开
     */
    handleWebSocketClose(ws) {
        const sessionId = this.webSockets.get(ws);
        if (sessionId) {
            this.sessions.delete(sessionId);
            this.webSockets.delete(ws);
            console.log(`WebSocket closed for session ${sessionId}. Total: ${this.sessions.size}`);

            // 广播更新
            this.broadcastCount();
        }
    }

    /**
     * 向所有连接的客户端广播在线人数
     */
    broadcastCount() {
        const count = this.sessions.size;
        const message = JSON.stringify({
            type: 'count_update',
            count,
            timestamp: Date.now()
        });

        console.log(`Broadcasting count ${count} to ${this.webSockets.size} clients`);

        for (const [ws, sessionId] of this.webSockets.entries()) {
            try {
                ws.send(message);
                console.log(`Sent update to session ${sessionId}`);
            } catch (error) {
                console.error(`Failed to send to session ${sessionId}:`, error);
                // 清理失败的连接
                this.webSockets.delete(ws);
                this.sessions.delete(sessionId);
            }
        }
    }

    /**
     * HTTP 降级方案：用户加入活动
     */
    async handleJoin(request) {
        const { sessionId } = await request.json();

        if (!sessionId) {
            return this.jsonResponse({ error: 'sessionId required' }, 400);
        }

        const now = Date.now();
        this.sessions.set(sessionId, { lastHeartbeat: now, ws: null });

        await this.ensureAlarm();

        console.log(`Session ${sessionId} joined via HTTP. Total: ${this.sessions.size}`);

        return this.jsonResponse({
            success: true,
            sessionId,
            count: this.sessions.size
        });
    }

    /**
     * HTTP 降级方案：用户心跳保活
     */
    async handleHeartbeat(request) {
        const { sessionId } = await request.json();

        if (!sessionId) {
            return this.jsonResponse({ error: 'sessionId required' }, 400);
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
            return this.jsonResponse({
                error: 'Session not found',
                shouldRejoin: true
            }, 404);
        }

        session.lastHeartbeat = Date.now();

        return this.jsonResponse({
            success: true,
            count: this.sessions.size
        });
    }

    /**
     * HTTP 降级方案：用户主动离开
     */
    async handleLeave(request) {
        const { sessionId } = await request.json();

        if (!sessionId) {
            return this.jsonResponse({ error: 'sessionId required' }, 400);
        }

        const existed = this.sessions.delete(sessionId);

        console.log(`Session ${sessionId} left via HTTP. Total: ${this.sessions.size}`);

        return this.jsonResponse({
            success: true,
            existed,
            count: this.sessions.size
        });
    }

    /**
     * 获取当前在线人数
     */
    async handleCount() {
        await this.cleanupTimeoutSessions();

        return this.jsonResponse({
            count: this.sessions.size
        });
    }

    /**
     * 清理超时的会话
     */
    async cleanupTimeoutSessions() {
        const now = Date.now();
        let cleanedCount = 0;

        for (const [sessionId, session] of this.sessions.entries()) {
            if (now - session.lastHeartbeat > this.TIMEOUT_MS) {
                this.sessions.delete(sessionId);
                if (session.ws) {
                    this.webSockets.delete(session.ws);
                    try {
                        session.ws.close(1000, 'Session timeout');
                    } catch (e) {
                        console.error('Error closing WebSocket:', e);
                    }
                }
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            console.log(`Cleaned ${cleanedCount} timeout sessions. Remaining: ${this.sessions.size}`);
            // 广播更新后的计数
            this.broadcastCount();
        }

        return cleanedCount;
    }

    /**
     * 确保设置了定时清理alarm
     */
    async ensureAlarm() {
        const currentAlarm = await this.state.storage.getAlarm();
        if (currentAlarm === null) {
            await this.state.storage.setAlarm(Date.now() + this.CLEANUP_INTERVAL_MS);
        }
    }

    /**
     * Alarm处理器 - 定期清理超时会话
     */
    async alarm() {
        await this.cleanupTimeoutSessions();

        // 如果还有活跃会话，继续设置下一次alarm
        if (this.sessions.size > 0) {
            await this.state.storage.setAlarm(Date.now() + this.CLEANUP_INTERVAL_MS);
        }
    }

    /**
     * 辅助方法：返回JSON响应
     */
    jsonResponse(data, status = 200) {
        return new Response(JSON.stringify(data), {
            status,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            }
        });
    }
}
