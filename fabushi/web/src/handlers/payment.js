import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { MEMBERSHIP_PLANS } from '../config/constants.js';
import { isAdmin } from '../utils/helpers.js';
import { importPrivateKey, generateSign } from '../../alipay-utils.js';

// 创建支付宝订单
export async function handleCreateAlipayOrder(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) {
    return jsonResponse({ error: '认证失败' }, 401);
  }

  const { plan = 'monthly', platform = 'app' } = await request.json();
  const planDetails = MEMBERSHIP_PLANS[plan];
  if (!planDetails) {
    return jsonResponse({ error: '无效的会员计划' }, 400);
  }

  const user = await db.getUser(tokenData.username);
  if (!user) {
    return jsonResponse({ error: '用户不存在' }, 404);
  }

  const isAdminUser = isAdmin(user.email);
  const finalAmount = isAdminUser ? planDetails.adminPrice : planDetails.price;
  const outTradeNo = platform === 'web' ? `WEB_${tokenData.username}_${Date.now()}` : `MEMBER_${tokenData.username}_${Date.now()}`;

  await db.createOrder({
    orderId: outTradeNo,
    userId: tokenData.username,
    plan,
    amount: finalAmount,
    originalAmount: planDetails.price,
    isAdminOrder: isAdminUser,
    status: 'PENDING',
    platform: platform || 'app',
    createdAt: new Date().toISOString()
  });

  // Web平台：电脑网站支付
  if (platform === 'web') {
    const backendUrl = env.WORKER_URL || 'https://api.ombhrum.com';
    const frontendUrl = env.FRONTEND_URL || 'https://flutter.ombhrum.com';
    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const bizContent = {
      out_trade_no: outTradeNo,
      total_amount: finalAmount,
      subject: `全球法布施 - ${planDetails.name}`,
      product_code: 'FAST_INSTANT_TRADE_PAY',
      timeout_express: '30m',
      quit_url: frontendUrl
    };

    const params = {
      app_id: env.ALIPAY_APP_ID,
      method: 'alipay.trade.page.pay',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp,
      version: '1.0',
      notify_url: `${backendUrl}/api/alipay/notify`,
      return_url: env.ALIPAY_RETURN_URL || `${frontendUrl}/payment-success.html`,
      biz_content: JSON.stringify(bizContent)
    };

    const privateKey = await importPrivateKey(env.ALIPAY_PRIVATE_KEY);
    params.sign = await generateSign(params, privateKey);

    const gateway = env.ALIPAY_SANDBOX === 'true' ? 'https://openapi-sandbox.dl.alipaydev.com/gateway.do' : 'https://openapi.alipay.com/gateway.do';
    const queryString = new URLSearchParams(params).toString();
    const paymentUrl = `${gateway}?${queryString}`;

    return jsonResponse({
      success: true,
      orderId: outTradeNo,
      amount: finalAmount,
      plan,
      paymentUrl
    });
  }

  // APP支付：生成 orderString 供客户端调用支付宝 SDK
  const backendUrl = env.WORKER_URL || 'https://api.ombhrum.com';
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

  const appBizContent = {
    out_trade_no: outTradeNo,
    total_amount: finalAmount.toString(),
    subject: `全球法布施 - ${planDetails.name}`,
    product_code: 'QUICK_MSECURITY_PAY',
    timeout_express: '30m'
  };

  const appParams = {
    app_id: env.ALIPAY_APP_ID,
    method: 'alipay.trade.app.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp,
    version: '1.0',
    notify_url: `${backendUrl}/api/alipay/notify`,
    biz_content: JSON.stringify(appBizContent)
  };

  const privateKey = await importPrivateKey(env.ALIPAY_PRIVATE_KEY);
  appParams.sign = await generateSign(appParams, privateKey);

  // 生成 orderString：将参数拼接成 key=value&key=value 格式，值需要 URL 编码
  const orderString = Object.keys(appParams)
    .sort()
    .map(key => `${key}=${encodeURIComponent(appParams[key])}`)
    .join('&');

  return jsonResponse({
    success: true,
    orderId: outTradeNo,
    amount: finalAmount,
    plan,
    orderString
  });
}

// 查询订单
export async function handleQueryAlipayOrder(request, env, db) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get('orderId');

  if (!orderId) {
    return jsonResponse({ error: '订单ID不能为空' }, 400);
  }

  const order = await db.getOrder(orderId);
  if (!order) {
    return jsonResponse({ error: '订单不存在' }, 404);
  }

  return jsonResponse({
    orderId: order.order_id,
    userId: order.user_id,
    plan: order.plan,
    amount: order.amount,
    status: order.status,
    createdAt: order.created_at
  });
}

// 支付宝回调
export async function handleAlipayNotify(request, env, db) {
  const formData = await request.formData();
  const params = {};
  for (const [key, value] of formData.entries()) {
    params[key] = value;
  }

  if (params.trade_status === 'TRADE_SUCCESS' || params.trade_status === 'TRADE_FINISHED') {
    const outTradeNo = params.out_trade_no;
    const order = await db.getOrder(outTradeNo);

    if (!order) {
      return new Response('failure', { status: 404 });
    }

    if (order.status === 'PAID') {
      return new Response('success', { status: 200 });
    }

    await db.updateOrder(outTradeNo, {
      status: 'PAID',
      paid_at: new Date().toISOString(),
      trade_no: params.trade_no
    });

    const user = await db.getUser(order.user_id);
    const planDetails = MEMBERSHIP_PLANS[order.plan];
    const now = new Date();

    let startDate = now;
    if (user.membership_expires_at && new Date(user.membership_expires_at) > now) {
      startDate = new Date(user.membership_expires_at);
    }

    const endDate = new Date(startDate.getTime() + planDetails.duration);

    await db.updateUser(order.user_id, {
      membership_type: 'paid',
      membership_expires_at: endDate.toISOString()
    });

    await db.addPurchaseHistory({
      username: order.user_id,
      orderId: outTradeNo,
      plan: order.plan,
      amount: planDetails.price,
      currency: 'CNY',
      status: 'completed',
      paymentMethod: 'alipay',
      purchasedAt: now.toISOString(),
      validFrom: startDate.toISOString(),
      validTo: endDate.toISOString()
    });
  }

  return new Response('success', { status: 200 });
}
