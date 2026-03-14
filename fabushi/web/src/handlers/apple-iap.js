import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { APPLE_IAP_PRODUCTS } from '../config/constants.js';

/**
 * 将 Base64Url 转换为 Uint8Array
 */
function base64UrlToUint8Array(base64Url) {
  const padding = '='.repeat((4 - base64Url.length % 4) % 4);
  const base64 = (base64Url + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * 将 PEM 格式的私钥转换为 CryptoKey
 */
async function importPrivateKey(pemContent) {
  // 移除 PEM 头尾和换行符
  const pemHeader = '-----BEGIN PRIVATE KEY-----';
  const pemFooter = '-----END PRIVATE KEY-----';
  const pemContents = pemContent
    .replace(pemHeader, '')
    .replace(pemFooter, '')
    .replace(/\s+/g, '');

  const binaryDer = base64UrlToUint8Array(pemContents);

  return await crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    false,
    ['sign']
  );
}

/**
 * 将 Buffer 转换为 Base64Url 字符串
 */
function bufferToBase64Url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // 转换为 Base64
  const base64 = btoa(binary);
  // 转换为 Base64Url
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/={1,2}$/, '');
}

/**
 * 生成 App Store Server API 所需的 ES256 JWT
 */
async function generateAppleJWT(env) {
  const { APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY, APPLE_BUNDLE_ID } = env;

  if (!APPLE_ISSUER_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY || !APPLE_BUNDLE_ID) {
    throw new Error('Missing Apple IAP configuration in environment variables');
  }

  const header = {
    alg: 'ES256',
    kid: APPLE_KEY_ID,
    typ: 'JWT'
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: APPLE_ISSUER_ID,
    iat: now,
    exp: now + 3000, // Token validity is 50 minutes (max allowed by Apple)
    aud: 'appstoreconnect-v1',
    bid: APPLE_BUNDLE_ID
  };

  const encodedHeader = bufferToBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = bufferToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const privateKey = await importPrivateKey(APPLE_PRIVATE_KEY);
  
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    new TextEncoder().encode(dataToSign)
  );

  const signature = bufferToBase64Url(signatureBuffer);

  return `${dataToSign}.${signature}`;
}

/**
 * 解析和验证 Apple 返回的 JWS 数据
 * 注意：在生产环境中，应严格验证 JWS Header 里的 x5c 证书链，确保数据确实来自苹果。
 * 此处作为轻量级实现，仅提取有效载荷。
 */
function decodeAppStoreJWS(jwsToken) {
  try {
    const parts = jwsToken.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWS format');
    }
    
    // 解析 payload (Middle part)
    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));

    return JSON.parse(jsonPayload);
  } catch (e) {
    throw new Error(`Failed to decode JWS payload: ${e.message}`);
  }
}

/**
 * 请求 App Store Server API 获取交易信息
 */
async function fetchTransactionInfo(transactionId, env) {
  const jwt = await generateAppleJWT(env);
  
  // 按照苹果的建议，首先尝试 Production (除非你知道是 Sandbox 凭据)
  const prodUrl = `https://api.storekit.apple.com/inApps/v1/transactions/${transactionId}`;
  const sandboxUrl = `https://api.storekit-sandbox.itunes.apple.com/inApps/v1/transactions/${transactionId}`;
  
  const headers = {
    'Authorization': `Bearer ${jwt}`,
    'Accept': 'application/json'
  };

  let response = await fetch(prodUrl, { method: 'GET', headers });
  
  // 如果 Production 返回 404 (TransactionNotFound)，则可能是 Sandbox 凭据
  if (response.status === 404) {
    console.log(`Transaction ${transactionId} not found in Production, trying Sandbox...`);
    response = await fetch(sandboxUrl, { method: 'GET', headers });
  }

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`App Store Server API error: ${response.status} - ${errorBody}`);
    throw new Error(`Apple API rejected the request with status ${response.status}`);
  }

  const responseData = await response.json();
  if (!responseData.signedTransactionInfo) {
    throw new Error('Missing signedTransactionInfo in Apple API response');
  }

  // 解码 JWS 获取详细的 transaction 数据
  const transactionInfo = decodeAppStoreJWS(responseData.signedTransactionInfo);
  return transactionInfo;
}


/**
 * 验证 Apple IAP 收据的主处理器
 */
export async function handleVerifyAppleReceipt(request, env, db) {
  // 1. 验证用户认证信息
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) {
    return jsonResponse({ error: '认证失败' }, 401);
  }

  // 2. 解析请求参数
  const requestData = await request.json();
  const { transactionId, productId } = requestData;

  if (!transactionId || !productId) {
    return jsonResponse({ error: '参数不完整 (transactionId / productId required)' }, 400);
  }

  // 检查系统环境变量是否已配置 Apple credentials
  if (!env.APPLE_PRIVATE_KEY) {
     console.error('Apple Server API isn\'t configured in Cloudflare Worker.');
     return jsonResponse({ error: '服务器 IAP 验证暂未配置，请联系客服' }, 500);
  }

  // 获取该商品对应的系统会员套餐类型
  const planInfo = APPLE_IAP_PRODUCTS[productId];
  if (!planInfo) {
    return jsonResponse({ error: '未知的苹果内购商品ID' }, 400);
  }
  const { plan } = planInfo;

  try {
    // 3. 请求苹果服务器验证并获取解码后的详细交易信息
    const transactionInfo = await fetchTransactionInfo(transactionId, env);
    
    // 4. 验证交易真实性
    // 首先确认这是我们的内购项，并且交易是扣款成功的
    if (transactionInfo.bundleId !== env.APPLE_BUNDLE_ID) {
        return jsonResponse({ error: 'Bundle ID 不匹配，非法凭证' }, 403);
    }
    
    if (transactionInfo.productId !== productId) {
        return jsonResponse({ error: '凭证记录的商品ID与请求不符' }, 403);
    }
    
    // App Store StoreKit 2 的 transaction_reason / inAppOwnershipType 可以用来辅助判断。
    // 但是对于最基础的校验，主要看 revocationDate。如果它存在，说明这笔交易已经被苹果退款或撤销。
    if (transactionInfo.revocationDate) {
        return jsonResponse({ error: '该交易已被苹果撤销或退款' }, 403);
    }
    
    // 5. 判断此订单是否已经给发过货 (防重放)
    // 根据苹果的特性：普通内购是唯一的 transactionId。
    // 但订阅会有 originalTransactionId 且续订有新的 transactionId。
    // 我们检查此 transactionId 是否已被处理：
    const existingPurchase = await db.prepare('SELECT * FROM purchase_history WHERE order_id = ?').bind(transactionId).first();
    if (existingPurchase) {
       // 重复验证，直接返回当前状态但不走充值逻辑
       return jsonResponse({ 
           success: true, 
           message: '交易已处理', 
           membershipType: 'paid', // 简化处理，实际要查 user 表
           alreadyProcessed: true 
       });
    }

    // 6. 验证成功，为用户发货 (延长会员时长)
    const user = await db.getUser(tokenData.username);
    if (!user) {
      return jsonResponse({ error: '用户不存在' }, 404);
    }

    const now = new Date();
    let startDate = now;
    
    // 如果用户已有剩余付费会员，则从原有到期日叠加时间
    if (user.membership_type === 'paid' && user.membership_expires_at) {
        const currentExp = new Date(user.membership_expires_at);
        if (currentExp > now) {
            startDate = currentExp;
        }
    }
    
    // V2 响应中如果有 expiresDate，那是真实的结束时间。
    // 如果没有，这只是普通内购，我们自己算结束时间。
    let endDate;
    if (transactionInfo.expiresDate) {
        endDate = new Date(transactionInfo.expiresDate);
    } else {
        // 如果我们用买断型的非消耗品模式来充值会员：
        endDate = new Date(startDate.getTime() + planInfo.duration);
    }
    
    // 确保我们不落后于 Apple 这个交易记录里写的时间
    if (endDate < now) {
        return jsonResponse({ error: '该订阅凭据已过期失效' }, 403);
    }

    // 更新用户表
    await db.updateUser(user.username, {
      membership_type: 'paid',
      membership_expires_at: endDate.toISOString()
    });

    // 插入购买记录历史。这里的 order_id 我们存为 transactionId。
    // Apple 价格是本地化和分层的，这里我们可以固定按套餐原价登记或仅标识来源
    await db.addPurchaseHistory({
      username: user.username,
      orderId: transactionId,         // App Store 交易号
      plan: plan,
      amount: planInfo.price,        // 我们记账按套餐预设，具体结算看苹果后台
      currency: 'CNY',
      status: 'completed',
      paymentMethod: 'apple_iap',
      purchasedAt: new Date(transactionInfo.purchaseDate).toISOString(),
      validFrom: startDate.toISOString(),
      validTo: endDate.toISOString()
    });

    return jsonResponse({
        success: true,
        message: '会员激活成功',
        membershipType: 'paid',
        expiresAt: endDate.toISOString()
    });

  } catch (e) {
    console.error(`Apple Verify Receipt Failed: `, e);
    return jsonResponse({ error: `Apple IAP 验证失败: ${e.message}` }, 500);
  }
}
