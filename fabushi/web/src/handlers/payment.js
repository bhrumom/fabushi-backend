import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { ASSET_PRODUCTS, MEMBERSHIP_PLANS } from '../config/constants.js';
import { isAdminUser } from '../utils/helpers.js';
import { importPrivateKey, importPublicKey, generateSign, verifySign } from '../../alipay-utils.js';

const PERMANENT_ENTITLEMENT_VALID_TO = '9999-12-31T23:59:59.999Z';

function getPaidProduct(plan) {
  if (MEMBERSHIP_PLANS[plan]) return { ...MEMBERSHIP_PLANS[plan], productType: 'membership' };
  if (ASSET_PRODUCTS[plan]) return ASSET_PRODUCTS[plan];
  return null;
}

function normalizeMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return number.toFixed(2);
}

function normalizePublicKey(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('ALIPAY_PUBLIC_KEY is missing');
  if (raw.includes('BEGIN PUBLIC KEY')) return raw;
  return `-----BEGIN PUBLIC KEY-----\n${raw.replace(/\s+/g, '')}\n-----END PUBLIC KEY-----`;
}

async function resolveTokenUser(db, tokenData) {
  if (tokenData?.userId !== undefined && tokenData?.userId !== null && db.getUserById) {
    const user = await db.getUserById(tokenData.userId);
    if (user) return user;
  }
  if (tokenData?.username) return await db.getUser(tokenData.username);
  return null;
}

async function requireUser(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return { response: jsonResponse({ error: '未提供认证信息' }, 401) };
  const tokenData = await verifyToken(authHeader.substring(7), env);
  if (!tokenData) return { response: jsonResponse({ error: '认证失败' }, 401) };
  const user = await resolveTokenUser(db, tokenData);
  if (!user) return { response: jsonResponse({ error: '用户不存在' }, 404) };
  return { user, tokenData };
}

function timestampText() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

async function paymentConfig(env) {
  if (!env.ALIPAY_APP_ID || !env.ALIPAY_PRIVATE_KEY || !env.ALIPAY_PUBLIC_KEY) {
    throw new Error('Alipay is not fully configured');
  }
  return {
    backendUrl: env.WORKER_URL || 'https://api.ombhrum.com',
    frontendUrl: env.FRONTEND_URL || 'https://flutter.ombhrum.com',
    privateKey: await importPrivateKey(env.ALIPAY_PRIVATE_KEY),
  };
}

export async function handleCreateAlipayOrder(request, env, db) {
  try {
    const auth = await requireUser(request, env, db);
    if (auth.response) return auth.response;
    const { plan = 'monthly', platform = 'app' } = await request.json();
    if (!['app', 'web'].includes(platform)) return jsonResponse({ error: '无效的支付平台' }, 400);
    const planDetails = getPaidProduct(plan);
    if (!planDetails) return jsonResponse({ error: '无效的付费项目' }, 400);

    const { user } = auth;
    const adminActor = isAdminUser(user, env);
    const finalAmount = adminActor ? planDetails.adminPrice : planDetails.price;
    const normalizedAmount = normalizeMoney(finalAmount);
    if (normalizedAmount === null || normalizedAmount === '0.00') return jsonResponse({ error: '订单金额无效' }, 500);
    const outTradeNo = `${platform === 'web' ? 'WEB' : 'MEMBER'}_${user.id}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;

    await db.createOrder({
      orderId: outTradeNo,
      username: user.username,
      accountUserId: user.id,
      plan,
      amount: normalizedAmount,
      originalAmount: normalizeMoney(planDetails.price),
      isAdminOrder: adminActor,
      status: 'PENDING',
      platform,
      createdAt: new Date().toISOString()
    });

    const config = await paymentConfig(env);
    const common = {
      app_id: env.ALIPAY_APP_ID,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: timestampText(),
      version: '1.0',
      notify_url: `${config.backendUrl}/api/alipay/notify`,
    };

    if (platform === 'web') {
      const params = {
        ...common,
        method: 'alipay.trade.page.pay',
        return_url: env.ALIPAY_RETURN_URL || `${config.frontendUrl}/payment-success.html`,
        biz_content: JSON.stringify({
          out_trade_no: outTradeNo,
          total_amount: normalizedAmount,
          subject: `全球法布施 - ${planDetails.name}`,
          product_code: 'FAST_INSTANT_TRADE_PAY',
          timeout_express: '30m',
          quit_url: config.frontendUrl,
        }),
      };
      params.sign = await generateSign(params, config.privateKey);
      const gateway = env.ALIPAY_SANDBOX === 'true'
        ? 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'
        : 'https://openapi.alipay.com/gateway.do';
      return jsonResponse({
        success: true,
        orderId: outTradeNo,
        amount: normalizedAmount,
        plan,
        productType: planDetails.productType,
        paymentUrl: `${gateway}?${new URLSearchParams(params).toString()}`,
      });
    }

    const params = {
      ...common,
      method: 'alipay.trade.app.pay',
      biz_content: JSON.stringify({
        out_trade_no: outTradeNo,
        total_amount: normalizedAmount,
        subject: `全球法布施 - ${planDetails.name}`,
        product_code: 'QUICK_MSECURITY_PAY',
        timeout_express: '30m',
      }),
    };
    params.sign = await generateSign(params, config.privateKey);
    const orderString = Object.keys(params).sort().map((key) => `${key}=${encodeURIComponent(params[key])}`).join('&');
    return jsonResponse({
      success: true,
      orderId: outTradeNo,
      amount: normalizedAmount,
      plan,
      productType: planDetails.productType,
      orderString,
    });
  } catch (error) {
    console.error('创建支付宝订单失败:', error?.message || error);
    return jsonResponse({ error: '创建支付宝订单失败' }, 500);
  }
}

export async function handleQueryAlipayOrder(request, env, db) {
  const auth = await requireUser(request, env, db);
  if (auth.response) return auth.response;
  const orderId = new URL(request.url).searchParams.get('orderId');
  if (!orderId || orderId.length > 160) return jsonResponse({ error: '订单ID不能为空或无效' }, 400);
  const order = await db.getOrder(orderId);
  if (!order) return jsonResponse({ error: '订单不存在' }, 404);
  if (Number(order.account_user_id) !== Number(auth.user.id) && order.username !== auth.user.username) {
    return jsonResponse({ error: '无权查看该订单' }, 403);
  }
  return jsonResponse({
    success: true,
    orderId: order.order_id,
    plan: order.plan,
    amount: order.amount,
    status: order.status,
    productType: getPaidProduct(order.plan)?.productType || 'unknown',
    createdAt: order.created_at
  });
}

export async function handleCheckPurchaseEntitlement(request, env, db) {
  const auth = await requireUser(request, env, db);
  if (auth.response) return auth.response;
  const product = new URL(request.url).searchParams.get('product');
  if (!product || !ASSET_PRODUCTS[product]) return jsonResponse({ error: '无效的付费项目' }, 400);
  const unlocked = await db.hasCompletedPurchase(auth.user.username, product, auth.user.id);
  return jsonResponse({ success: true, product, unlocked });
}

async function verifyAlipayNotification(params, env) {
  if (!params.sign || params.sign_type !== 'RSA2') return false;
  if (!env.ALIPAY_APP_ID || params.app_id !== env.ALIPAY_APP_ID) return false;
  if (env.ALIPAY_SELLER_ID && params.seller_id !== env.ALIPAY_SELLER_ID) return false;
  const signedParams = { ...params };
  const sign = signedParams.sign;
  delete signedParams.sign;
  delete signedParams.sign_type;
  const publicKey = await importPublicKey(normalizePublicKey(env.ALIPAY_PUBLIC_KEY));
  return await verifySign(signedParams, sign, publicKey);
}

async function ensurePaymentReceiptTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS payment_receipts (
      order_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_trade_no TEXT,
      amount TEXT NOT NULL,
      received_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_receipts_provider_trade_no
    ON payment_receipts(provider, provider_trade_no)
    WHERE provider_trade_no IS NOT NULL
  `).run();
}

export async function handleAlipayNotify(request, env, db) {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded') && !contentType.toLowerCase().includes('multipart/form-data')) {
      return new Response('failure', { status: 415 });
    }
    const formData = await request.formData();
    const params = {};
    let fieldCount = 0;
    for (const [key, value] of formData.entries()) {
      fieldCount += 1;
      if (fieldCount > 80 || String(key).length > 128 || String(value).length > 8192) return new Response('failure', { status: 400 });
      params[key] = String(value);
    }

    if (!(await verifyAlipayNotification(params, env))) {
      console.warn('Rejected Alipay callback with invalid signature or merchant identity');
      return new Response('failure', { status: 400 });
    }
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(params.trade_status)) return new Response('success', { status: 200 });

    const outTradeNo = String(params.out_trade_no || '');
    if (!outTradeNo || outTradeNo.length > 160) return new Response('failure', { status: 400 });
    const order = await db.getOrder(outTradeNo);
    if (!order) return new Response('failure', { status: 404 });
    // Historical orders that were already fulfilled before the receipt ledger
    // existed must never be fulfilled a second time when Alipay retries them.
    if (order.status === 'PAID') return new Response('success', { status: 200 });
    if (normalizeMoney(params.total_amount) !== normalizeMoney(order.amount)) {
      console.warn('Rejected Alipay callback with amount mismatch', outTradeNo);
      return new Response('failure', { status: 400 });
    }

    const planDetails = getPaidProduct(order.plan);
    if (!planDetails) return new Response('failure', { status: 400 });
    let user = order.account_user_id && db.getUserById ? await db.getUserById(order.account_user_id) : null;
    if (!user) user = await db.getUser(order.username || order.user_id);
    if (!user) return new Response('failure', { status: 400 });

    await ensurePaymentReceiptTable(env);
    const existing = await env.DB.prepare('SELECT order_id FROM payment_receipts WHERE order_id = ?').bind(outTradeNo).first();
    if (existing) return new Response('success', { status: 200 });
    if (params.trade_no) {
      const reusedTrade = await env.DB.prepare('SELECT order_id FROM payment_receipts WHERE provider = ? AND provider_trade_no = ?')
        .bind('alipay', params.trade_no).first();
      if (reusedTrade && reusedTrade.order_id !== outTradeNo) {
        console.warn('Rejected Alipay trade number replay across orders');
        return new Response('failure', { status: 409 });
      }
    }

    const now = new Date();
    const statements = [
      env.DB.prepare(`INSERT INTO payment_receipts (order_id, provider, provider_trade_no, amount, received_at) VALUES (?, 'alipay', ?, ?, ?)`)
        .bind(outTradeNo, params.trade_no || null, normalizeMoney(params.total_amount), now.toISOString()),
    ];

    let validFrom = now.toISOString();
    let validTo = PERMANENT_ENTITLEMENT_VALID_TO;
    if (planDetails.productType === 'membership') {
      const currentExpiry = user.membership_expires_at ? new Date(user.membership_expires_at) : null;
      const startDate = currentExpiry && currentExpiry > now ? currentExpiry : now;
      const endDate = new Date(startDate.getTime() + planDetails.duration);
      validFrom = startDate.toISOString();
      validTo = endDate.toISOString();
      statements.push(
        env.DB.prepare(`UPDATE users SET membership_type = 'paid', membership_expires_at = ?, updated_at = ? WHERE id = ?`)
          .bind(validTo, now.toISOString(), user.id)
      );
    }

    statements.push(
      env.DB.prepare(`
        INSERT INTO purchase_history (username, user_id, order_id, plan, amount, currency, status, payment_method, purchased_at, valid_from, valid_to)
        VALUES (?, ?, ?, ?, ?, 'CNY', 'completed', 'alipay', ?, ?, ?)
      `).bind(user.username, user.id, outTradeNo, order.plan, normalizeMoney(order.amount), now.toISOString(), validFrom, validTo),
      env.DB.prepare(`UPDATE orders SET status = 'PAID', paid_at = ?, trade_no = ? WHERE order_id = ? AND status <> 'PAID'`)
        .bind(now.toISOString(), params.trade_no || null, outTradeNo)
    );

    try {
      await env.DB.batch(statements);
    } catch (error) {
      const receipt = await env.DB.prepare('SELECT order_id FROM payment_receipts WHERE order_id = ?').bind(outTradeNo).first();
      if (receipt) return new Response('success', { status: 200 });
      throw error;
    }

    return new Response('success', { status: 200 });
  } catch (error) {
    console.error('支付宝回调处理失败:', error?.message || error);
    return new Response('failure', { status: 500 });
  }
}
