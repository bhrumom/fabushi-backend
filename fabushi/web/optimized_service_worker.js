/**
 * 全球法布施 - 优化版 Service Worker
 * 
 * 智能分层缓存策略：
 * - P0 核心层：index.html, main.dart.js, 关键字体（立即缓存）
 * - P1 重要层：CanvasKit, 常用图片（后台缓存）
 * - P2 可选层：Three.js, 佛像模型（按需缓存）
 */

// 缓存版本号 - 更新此值将清除旧缓存
const CACHE_VERSION = 'v2.0.0';

// 缓存名称
const CACHE_NAMES = {
    CORE: `fabushi-core-${CACHE_VERSION}`,      // P0: 核心资源
    IMPORTANT: `fabushi-important-${CACHE_VERSION}`, // P1: 重要资源
    OPTIONAL: `fabushi-optional-${CACHE_VERSION}`,   // P2: 可选资源
    RUNTIME: `fabushi-runtime-${CACHE_VERSION}`,     // 运行时缓存
};

// P0 核心资源 - 必须预缓存，首屏必需
const CORE_RESOURCES = [
    '/',
    '/index.html',
    '/main.dart.js',
    '/flutter.js',
    '/manifest.json',
    // 子集化后的字体（约4.5MB）
    '/assets/fonts/subset/NotoSansSC-Regular-subset.woff2',
    '/assets/fonts/subset/NotoSerifSC-Regular-subset.woff2',
];

// P1 重要资源 - 后台缓存，提升体验
const IMPORTANT_RESOURCES = [
    // Bold字体（非首屏必需）
    '/assets/fonts/subset/NotoSansSC-Bold-subset.woff2',
    '/assets/fonts/subset/NotoSerifSC-Bold-subset.woff2',
    '/canvaskit/canvaskit.wasm',
    '/canvaskit/canvaskit.js',
];

// P2 可选资源 - 按需缓存
const OPTIONAL_PATTERNS = [
    /three\.js/,
    /three\.module\.js/,
    /models\//,
    /\.glb$/,
    /\.gltf$/,
];

// 安装事件 - 预缓存核心资源
self.addEventListener('install', (event) => {
    console.log('🚀 Service Worker 安装中...');

    // 跳过等待，立即激活
    self.skipWaiting();

    event.waitUntil(
        (async () => {
            // 预缓存核心资源
            const coreCache = await caches.open(CACHE_NAMES.CORE);
            console.log('📦 预缓存核心资源...');

            for (const url of CORE_RESOURCES) {
                try {
                    await coreCache.add(url);
                    console.log(`✅ 已缓存: ${url}`);
                } catch (e) {
                    console.warn(`⚠️ 缓存失败: ${url}`, e);
                }
            }

            // 后台预取重要资源（不阻塞安装）
            prefetchImportantResources();
        })()
    );
});

// 后台预取重要资源
async function prefetchImportantResources() {
    try {
        const importantCache = await caches.open(CACHE_NAMES.IMPORTANT);
        console.log('📦 后台预取重要资源...');

        for (const url of IMPORTANT_RESOURCES) {
            try {
                const response = await fetch(url);
                if (response.ok) {
                    await importantCache.put(url, response);
                    console.log(`✅ 后台缓存: ${url}`);
                }
            } catch (e) {
                // 静默失败，不影响用户体验
                console.debug(`⚠️ 后台缓存失败: ${url}`);
            }
        }
    } catch (e) {
        console.debug('后台预取失败:', e);
    }
}

// 激活事件 - 清理旧缓存
self.addEventListener('activate', (event) => {
    console.log('✅ Service Worker 已激活');

    // 立即接管所有客户端
    event.waitUntil(clients.claim());

    // 清理旧版本缓存
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => {
                        // 删除不匹配当前版本的缓存
                        return !Object.values(CACHE_NAMES).includes(name);
                    })
                    .map((name) => {
                        console.log('🗑️ 删除旧缓存:', name);
                        return caches.delete(name);
                    })
            );
        })
    );
});

// 判断资源是否为可选资源
function isOptionalResource(url) {
    return OPTIONAL_PATTERNS.some(pattern => pattern.test(url));
}

// 判断资源是否为API请求
function isApiRequest(url) {
    return url.pathname.startsWith('/api/');
}

// 判断资源是否可缓存
function isCacheableRequest(request) {
    const url = new URL(request.url);

    // 只缓存GET请求
    if (request.method !== 'GET') return false;

    // 不缓存API请求
    if (isApiRequest(url)) return false;

    // 不缓存WebSocket
    if (url.protocol === 'ws:' || url.protocol === 'wss:') return false;

    return true;
}

// 拦截网络请求
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);

    // 只处理同源请求
    if (url.origin !== location.origin) {
        return;
    }

    // 处理API请求 - 网络优先
    if (isApiRequest(url)) {
        event.respondWith(networkFirst(request));
        return;
    }

    // 处理可选资源（Three.js等）- 缓存优先，按需加载
    if (isOptionalResource(url.pathname)) {
        event.respondWith(cacheFirstWithOptional(request));
        return;
    }

    // 处理其他资源 - 缓存优先
    if (isCacheableRequest(request)) {
        event.respondWith(cacheFirst(request));
        return;
    }
});

// 缓存优先策略
async function cacheFirst(request) {
    // 检查所有缓存
    for (const cacheName of Object.values(CACHE_NAMES)) {
        const cache = await caches.open(cacheName);
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
            // 后台更新缓存（stale-while-revalidate）
            updateCache(request, cacheName);
            return cachedResponse;
        }
    }

    // 缓存未命中，从网络获取并缓存
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_NAMES.RUNTIME);
            cache.put(request, response.clone());
        }
        return response;
    } catch (e) {
        console.error('获取资源失败:', request.url, e);
        // 返回离线页面或错误响应
        return new Response('离线', { status: 503 });
    }
}

// 可选资源的缓存优先策略
async function cacheFirstWithOptional(request) {
    const cache = await caches.open(CACHE_NAMES.OPTIONAL);
    const cachedResponse = await cache.match(request);

    if (cachedResponse) {
        return cachedResponse;
    }

    // 从网络获取并缓存到可选缓存
    try {
        const response = await fetch(request);
        if (response.ok) {
            cache.put(request, response.clone());
            console.log(`📦 按需缓存: ${request.url}`);
        }
        return response;
    } catch (e) {
        console.error('获取可选资源失败:', request.url, e);
        throw e;
    }
}

// 网络优先策略（用于API）
async function networkFirst(request) {
    try {
        const response = await fetch(request);
        return response;
    } catch (e) {
        // API请求不使用缓存
        throw e;
    }
}

// 后台更新缓存
async function updateCache(request, cacheName) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(cacheName);
            await cache.put(request, response);
        }
    } catch (e) {
        // 静默失败
    }
}

// 消息处理
self.addEventListener('message', (event) => {
    const { type, data } = event.data || {};

    switch (type) {
        case 'SKIP_WAITING':
            self.skipWaiting();
            break;

        case 'GET_CACHE_STATS':
            getCacheStats().then(stats => {
                event.source.postMessage({
                    type: 'CACHE_STATS',
                    stats
                });
            });
            break;

        case 'CLEAR_OPTIONAL_CACHE':
            caches.delete(CACHE_NAMES.OPTIONAL).then(() => {
                event.source.postMessage({ type: 'CACHE_CLEARED' });
            });
            break;
    }
});

// 获取缓存统计
async function getCacheStats() {
    const stats = {};

    for (const [name, cacheName] of Object.entries(CACHE_NAMES)) {
        try {
            const cache = await caches.open(cacheName);
            const keys = await cache.keys();
            stats[name] = {
                count: keys.length,
                urls: keys.map(r => r.url)
            };
        } catch (e) {
            stats[name] = { count: 0, urls: [] };
        }
    }

    return stats;
}

console.log('🙏 全球法布施 Service Worker 已加载（优化版 ' + CACHE_VERSION + '）');
