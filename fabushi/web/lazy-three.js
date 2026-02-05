/**
 * Three.js 延迟加载模块
 * 
 * 避免在页面加载时同步加载 Three.js 库,只在需要时才动态加载
 * 减少首屏加载时间约 500KB - 1MB
 */

let threeLoaded = false;
let threeLoadingPromise = null;

/**
 * 动态加载 Three.js 及其依赖
 * @returns {Promise<void>}
 */
window.loadThreeJS = async function () {
    // 如果已经加载,直接返回
    if (threeLoaded) {
        console.log('✅ Three.js already loaded');
        return Promise.resolve();
    }

    // 如果正在加载,返回现有的 Promise
    if (threeLoadingPromise) {
        console.log('⏳ Three.js loading in progress...');
        return threeLoadingPromise;
    }

    console.log('📦 Loading Three.js dynamically...');

    // 创建加载 Promise
    threeLoadingPromise = (async () => {
        try {
            // 1. 加载主库
            await loadScript(
                'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js',
                'three-core'
            );
            console.log('✅ Three.js core loaded');

            // 2. 加载控制器
            await loadScript(
                'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/js/controls/OrbitControls.js',
                'three-orbit-controls'
            );
            console.log('✅ OrbitControls loaded');

            // 3. 加载 GLTF 加载器
            await loadScript(
                'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/js/loaders/GLTFLoader.js',
                'three-gltf-loader'
            );
            console.log('✅ GLTFLoader loaded');

            threeLoaded = true;
            console.log('🎉 Three.js fully loaded');
        } catch (error) {
            console.error('❌ Failed to load Three.js:', error);
            threeLoadingPromise = null; // 重置以允许重试
            throw error;
        }
    })();

    return threeLoadingPromise;
};

/**
 * 动态加载单个脚本
 * @param {string} src - 脚本 URL
 * @param {string} id - 脚本 ID (用于防止重复加载)
 * @returns {Promise<void>}
 */
function loadScript(src, id) {
    return new Promise((resolve, reject) => {
        // 检查是否已经加载
        if (document.getElementById(id)) {
            resolve();
            return;
        }

        const script = document.createElement('script');
        script.id = id;
        script.src = src;
        script.async = true;

        script.onload = () => {
            console.log(`✅ Loaded: ${id}`);
            resolve();
        };

        script.onerror = (error) => {
            console.error(`❌ Failed to load: ${id}`, error);
            reject(new Error(`Failed to load script: ${src}`));
        };

        document.head.appendChild(script);
    });
}

/**
 * 检查 Three.js 是否已加载
 * @returns {boolean}
 */
window.isThreeJSLoaded = function () {
    return threeLoaded;
};

/**
 * 预加载 Three.js (在空闲时)
 * 使用 requestIdleCallback 在浏览器空闲时预加载
 */
window.preloadThreeJS = function () {
    if (threeLoaded || threeLoadingPromise) return;

    // 使用 requestIdleCallback (如果可用)
    if ('requestIdleCallback' in window) {
        requestIdleCallback(() => {
            console.log('🔮 Preloading Three.js during idle time...');
            window.loadThreeJS();
        }, { timeout: 2000 });
    } else {
        // 降级: 使用 setTimeout
        setTimeout(() => {
            console.log('🔮 Preloading Three.js...');
            window.loadThreeJS();
        }, 2000);
    }
};

// 导出到全局
window.ThreeJSLoader = {
    load: window.loadThreeJS,
    isLoaded: window.isThreeJSLoaded,
    preload: window.preloadThreeJS
};

console.log('📝 Lazy Three.js loader initialized');
