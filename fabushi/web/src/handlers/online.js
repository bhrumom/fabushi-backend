import { jsonResponse } from '../utils/response.js';

/**
 * 获取Durable Object实例
 * 根据活动类型返回对应的DO实例
 */
function getCounterInstance(env, activityType) {
    // 使用活动类型作为ID，确保每个活动类型有独立的DO实例
    const id = env.ONLINE_COUNTER.idFromName(activityType);
    return env.ONLINE_COUNTER.get(id);
}

/**
 * 用户加入活动
 * POST /api/online/join
 * Body: { activityType: 'global_sending' | 'zen_room', sessionId: string }
 */
export async function handleOnlineJoin(request, env) {
    try {
        const { activityType, sessionId } = await request.json();

        if (!activityType || !sessionId) {
            return jsonResponse({ error: 'activityType and sessionId required' }, 400);
        }

        // 验证活动类型
        if (!['global_sending', 'zen_room'].includes(activityType)) {
            return jsonResponse({ error: 'Invalid activityType' }, 400);
        }

        const counter = getCounterInstance(env, activityType);
        const url = new URL(request.url);
        url.searchParams.set('action', 'join');

        const response = await counter.fetch(new Request(url.toString(), {
            method: 'POST',
            body: JSON.stringify({ sessionId }),
            headers: { 'Content-Type': 'application/json' }
        }));

        return response;
    } catch (error) {
        console.error('handleOnlineJoin error:', error);
        return jsonResponse({ error: error.message }, 500);
    }
}

/**
 * 用户心跳保活
 * POST /api/online/heartbeat
 * Body: { activityType: 'global_sending' | 'zen_room', sessionId: string }
 */
export async function handleOnlineHeartbeat(request, env) {
    try {
        const { activityType, sessionId } = await request.json();

        if (!activityType || !sessionId) {
            return jsonResponse({ error: 'activityType and sessionId required' }, 400);
        }

        if (!['global_sending', 'zen_room'].includes(activityType)) {
            return jsonResponse({ error: 'Invalid activityType' }, 400);
        }

        const counter = getCounterInstance(env, activityType);
        const url = new URL(request.url);
        url.searchParams.set('action', 'heartbeat');

        const response = await counter.fetch(new Request(url.toString(), {
            method: 'POST',
            body: JSON.stringify({ sessionId }),
            headers: { 'Content-Type': 'application/json' }
        }));

        return response;
    } catch (error) {
        console.error('handleOnlineHeartbeat error:', error);
        return jsonResponse({ error: error.message }, 500);
    }
}

/**
 * 用户离开活动
 * POST /api/online/leave
 * Body: { activityType: 'global_sending' | 'zen_room', sessionId: string }
 */
export async function handleOnlineLeave(request, env) {
    try {
        const { activityType, sessionId } = await request.json();

        if (!activityType || !sessionId) {
            return jsonResponse({ error: 'activityType and sessionId required' }, 400);
        }

        if (!['global_sending', 'zen_room'].includes(activityType)) {
            return jsonResponse({ error: 'Invalid activityType' }, 400);
        }

        const counter = getCounterInstance(env, activityType);
        const url = new URL(request.url);
        url.searchParams.set('action', 'leave');

        const response = await counter.fetch(new Request(url.toString(), {
            method: 'POST',
            body: JSON.stringify({ sessionId }),
            headers: { 'Content-Type': 'application/json' }
        }));

        return response;
    } catch (error) {
        console.error('handleOnlineLeave error:', error);
        return jsonResponse({ error: error.message }, 500);
    }
}

/**
 * 获取当前在线人数
 * GET /api/online/count?activityType=global_sending
 */
export async function handleOnlineCount(request, env) {
    try {
        const url = new URL(request.url);
        const activityType = url.searchParams.get('activityType');

        if (!activityType) {
            return jsonResponse({ error: 'activityType required' }, 400);
        }

        if (!['global_sending', 'zen_room'].includes(activityType)) {
            return jsonResponse({ error: 'Invalid activityType' }, 400);
        }

        const counter = getCounterInstance(env, activityType);
        const doUrl = new URL(request.url);
        doUrl.searchParams.set('action', 'count');

        const response = await counter.fetch(new Request(doUrl.toString(), {
            method: 'GET'
        }));

        return response;
    } catch (error) {
        console.error('handleOnlineCount error:', error);
        return jsonResponse({ error: error.message }, 500);
    }
}
