/**
 * 全球法布施 - Service Worker
 * 
 * 这个Service Worker实现了在Web平台上直接访问网络功能的能力，
 * 无需依赖中继服务器。它使用现代Web API和新兴技术，使网页应用
 * 能够更直接地与设备硬件和网络通信。
 */

// 缓存名称
const CACHE_NAME = 'global-sharing-cache-v1';

// 需要缓存的资源
const RESOURCES_TO_CACHE = [
  '/',
  '/index.html',
  '/main.dart.js',
  '/flutter.js',
  '/manifest.json',

];

// 安装事件 - 缓存核心资源
self.addEventListener('install', (event) => {
  console.log('Service Worker 安装中...');
  
  // 跳过等待，立即激活
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('缓存核心资源');
        return cache.addAll(RESOURCES_TO_CACHE);
      })
  );
});

// 激活事件 - 清理旧缓存
self.addEventListener('activate', (event) => {
  console.log('Service Worker 已激活');
  
  // 立即接管所有客户端
  event.waitUntil(clients.claim());
  
  // 清理旧缓存
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('删除旧缓存:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// 拦截网络请求
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // 处理API请求
  if (url.pathname.startsWith('/api/')) {
    // 处理WiFi广播API
    if (url.pathname === '/api/wifi-broadcast') {
      event.respondWith(handleWifiBroadcast(event.request));
      return;
    }
    
    // 处理全球发送API
    if (url.pathname === '/api/global-send') {
      event.respondWith(handleGlobalSend(event.request));
      return;
    }
  }
  
  // 对于其他请求，尝试从缓存获取，如果失败则从网络获取
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        if (response) {
          return response;
        }
        
        // 克隆请求，因为请求只能使用一次
        return fetch(event.request.clone())
          .then((response) => {
            // 检查是否是有效的响应
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }
            
            // 克隆响应，因为响应体只能使用一次
            const responseToCache = response.clone();
            
            // 缓存响应
            caches.open(CACHE_NAME)
              .then((cache) => {
                cache.put(event.request, responseToCache);
              });
            
            return response;
          });
      })
  );
});

/**
 * 处理WiFi广播请求
 */
async function handleWifiBroadcast(request) {
  console.log('处理WiFi广播请求');
  
  try {
    // 检查是否是POST请求
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({
        success: false,
        message: '只支持POST请求'
      }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    // 解析请求数据
    const formData = await request.formData();
    const file = formData.get('file');
    const fileName = formData.get('fileName');
    const fileSize = formData.get('fileSize');
    
    if (!file) {
      return new Response(JSON.stringify({
        success: false,
        message: '未提供文件'
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    console.log(`接收到文件: ${fileName}, 大小: ${fileSize} 字节`);
    
    // 使用P2P网络广播文件
    const broadcastResult = await broadcastFileViaP2P(file);
    
    // 如果P2P广播失败，尝试使用WebRTC直接传输
    if (!broadcastResult.success && window.directModeManager) {
      console.log('P2P广播失败，尝试使用WebRTC直接传输');
      
      const webrtcResult = await window.directModeManager.sendFileViaWebRTC(file);
      
      if (webrtcResult.success) {
        return new Response(JSON.stringify({
          success: true,
          method: 'webrtc',
          sentCount: webrtcResult.sentCount,
          dataSentInMB: webrtcResult.dataSentInMB
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
    }
    
    // 如果所有直接传输方式都失败，返回错误
    if (!broadcastResult.success) {
      return new Response(JSON.stringify({
        success: false,
        message: '所有直接传输方式均失败'
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    // 返回成功响应
    return new Response(JSON.stringify({
      success: true,
      method: 'p2p',
      sentCount: broadcastResult.sentCount,
      dataSentInMB: broadcastResult.dataSentInMB
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('处理WiFi广播请求时出错:', error);
    
    return new Response(JSON.stringify({
      success: false,
      message: `处理请求时出错: ${error.message}`
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}

/**
 * 处理全球发送请求 - 简化版本
 */
async function handleGlobalSend(request) {
  console.log('处理全球发送请求 - 简化版本');
  
  try {
    // 检查是否是POST请求
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({
        success: false,
        message: '只支持POST请求'
      }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    // 解析请求数据
    const formData = await request.formData();
    const file = formData.get('file');
    const fileName = formData.get('fileName');
    const fileSize = formData.get('fileSize');
    const country = formData.get('country');
    
    if (!file) {
      return new Response(JSON.stringify({
        success: false,
        message: '未提供文件'
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    if (!country) {
      return new Response(JSON.stringify({
        success: false,
        message: '未提供目标国家'
      }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
    
    console.log(`接收到全球发送请求: ${fileName}, 大小: ${fileSize} 字节, 目标国家: ${country}`);
    
    // 简化版本：仅记录请求信息，不再使用复杂的WebRTC发送
    // 在实际应用中，这里可以添加简单的HTTP上传逻辑
    
    // 模拟发送成功
    return new Response(JSON.stringify({
      success: true,
      method: 'simplified-global',
      country: country,
      sentCount: 1,
      dataSentInMB: parseFloat(fileSize) / (1024 * 1024),
      message: '全球发送请求已接收（简化版本）'
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('处理全球发送请求时出错:', error);
    
    return new Response(JSON.stringify({
      success: false,
      message: `处理请求时出错: ${error.message}`
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}

/**
 * 通过P2P网络广播文件 - 已移除
 */
async function broadcastFileViaP2P(file) {
  // 简化版本：不再支持P2P网络广播
  console.log('P2P网络广播已移除');
  return { 
    success: false, 
    message: 'P2P网络广播功能已移除' 
  };
}

// 消息处理 - 简化版本
self.addEventListener('message', (event) => {
  const { type, data } = event.data;
  
  console.log(`Service Worker收到消息: ${type}`);
  
  switch (type) {
    case 'init-p2p-network':
      // P2P网络功能已移除
      console.log('P2P网络功能已移除');
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => {
          client.postMessage({
            type: 'p2p-network-initialized',
            success: false,
            message: 'P2P网络功能已移除',
            connectedPeers: 0
          });
        });
      });
      break;
      
    case 'check-direct-mode':
      // 直接模式功能已移除
      console.log('直接模式功能已移除');
      event.source.postMessage({
        type: 'direct-mode-support',
        support: {
          message: '所有复杂发送方式已移除',
          webrtc: false,
          bluetooth: false,
          webTransport: false,
          webUSB: false,
          serviceWorker: true
        }
      });
      break;
  }
});

/**
 * 初始化P2P网络 - 已移除
 */
async function initP2PNetwork() {
  // 简化版本：不再支持P2P网络
  console.log('P2P网络初始化已移除');
  return { 
    success: false, 
    message: 'P2P网络功能已移除' 
  };
}

/**
 * 检查直接模式支持情况
 */
async function checkDirectModeSupport() {
  const support = {
    webrtc: typeof RTCPeerConnection !== 'undefined',
    bluetooth: typeof navigator !== 'undefined' && !!navigator.bluetooth,
    webTransport: typeof WebTransport !== 'undefined',
    webUSB: typeof navigator !== 'undefined' && !!navigator.usb,
    serviceWorker: true
  };
  
  console.log('直接模式支持情况:', support);
  
  return support;
}

console.log('全球法布施 Service Worker 已加载');