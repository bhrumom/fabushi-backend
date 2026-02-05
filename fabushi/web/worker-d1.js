// 这是worker.js的D1版本
// 将KV存储迁移到D1数据库
// 保留临时数据（验证码、频率限制等）在KV中

import { EmailMessage } from 'cloudflare:email';
import { STRIPE_CONFIG, createStripeClient, checkMembershipStatus, calculateTrialEndDate } from './stripe-config.js';
import { base64UrlEncode, base64UrlDecodeToArray, randomBytes, derivePbkdf2, createPasswordHash, verifyPassword, upgradePasswordIfNeeded, generateToken, verifyToken, jsonResponse } from './auth-utils.js';
import { generateAlipayLoginUrl, handleAlipayLogin, registerAlipayUser, checkEmailAvailability, sendRegistrationCaptcha, handleAlipayCallback, handleMacOSAlipayCallback } from './alipay-login-functions.js';

// 管理员配置
const ADMIN_EMAIL = '1315518325@qq.com';
const ADMIN_PRICES = {
  'monthly': '0.01',
  'quarterly': '0.01',
  'yearly': '0.01'
};

// 会员计划配置
const WORKER_MEMBERSHIP_PLANS = {
  'monthly': {
    name: '月度会员',
    duration: 30 * 24 * 60 * 60 * 1000,
    price: '21.00',
    adminPrice: '0.01',
    features: ['基础功能访问', '每日10次使用额度', '邮件支持']
  },
  'quarterly': {
    name: '季度会员',
    duration: 90 * 24 * 60 * 60 * 1000,
    price: '63.00',
    adminPrice: '0.01',
    features: ['基础功能访问', '每日30次使用额度', '邮件支持', '优先客服']
  },
  'yearly': {
    name: '年度会员',
    duration: 365 * 24 * 60 * 60 * 1000,
    price: '252.00',
    adminPrice: '0.01',
    features: ['基础功能访问', '每日100次使用额度', '邮件支持', '优先客服', '专属功能']
  }
};

// 兑换码类型配置
const REDEEM_CODE_TYPES = {
  'trial_7': { name: '7天试用', days: 7, type: 'trial' },
  'monthly': { name: '月度会员', days: 30, type: 'premium' },
  'quarterly': { name: '季度会员', days: 90, type: 'premium' },
  'yearly': { name: '年度会员', days: 365, type: 'premium' }
};

const APP_VERSION = Date.now().toString();
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
  'Content-Type': 'application/json',
  'X-App-Version': APP_VERSION
};

function isAdmin(email) {
  return email && email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

function generateRedeemCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// 发送邮件函数（保持不变，使用原worker.js的实现）
async function sendEmail(to, subject, body, env) {
  // ... 保持原有实现
}

// ============ D1版本的处理函数 ============

// 注册用户 - D1版本
async function handleRegister(request, env) {
  try {
    let { username, email, password, verificationCode } = await request.json();
    
    if (!username || !email || !password || !verificationCode) {
      return jsonResponse({ error: '缺少必要字段' }, 400);
    }

    username = String(username).trim();
    email = String(email).trim().toLowerCase();

    // 验证码验证（仍使用KV）
    const verifyData = await env.USERS_KV.get(`verify:${email}`);
    if (!verifyData) {
      return jsonResponse({ error: '验证码不存在或已过期' }, 400);
    }

    const { code: storedCode, expiry } = JSON.parse(verifyData);
    if (Date.now() > expiry) {
      await env.USERS_KV.delete(`verify:${email}`);
      return jsonResponse({ error: '验证码已过期' }, 400);
    }

    if (verificationCode !== storedCode) {
      return jsonResponse({ error: '验证码错误' }, 400);
    }

    // 检查用户名是否存在
    const existingUser = await env.DB.prepare(`
      SELECT username FROM users WHERE username = ?
    `).bind(username).first();
    
    if (existingUser) {
      return jsonResponse({ error: '用户名已存在' }, 400);
    }

    // 检查邮箱是否存在
    const existingEmail = await env.DB.prepare(`
      SELECT email FROM users WHERE email = ?
    `).bind(email).first();
    
    if (existingEmail) {
      return jsonResponse({ error: '该邮箱已被注册' }, 400);
    }

    // 创建密码哈希
    const creds = await createPasswordHash(password);
    const trialEndDate = calculateTrialEndDate();

    // 插入用户到D1
    await env.DB.prepare(`
      INSERT INTO users (
        username, email, password_hash, salt, iterations, algo,
        email_verified, membership_type, free_trial_end_date, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      username, email, creds.passwordHash, creds.salt,
      creds.iterations, creds.algo, 1, 'trial',
      trialEndDate.toISOString(), new Date().toISOString()
    ).run();

    // 插入邮箱映射
    await env.DB.prepare(`
      INSERT INTO email_username_mapping (email, username) VALUES (?, ?)
    `).bind(email, username).run();

    // 清理验证码
    await env.USERS_KV.delete(`verify:${email}`);

    return jsonResponse({ message: '注册成功' }, 201);
  } catch (error) {
    console.error('注册失败:', error);
    return jsonResponse({ error: `注册失败: ${error.message}` }, 500);
  }
}

// 登录 - D1版本
async function handleLogin(request, env) {
  try {
    const { username: loginIdentifier, password } = await request.json();
    
    if (!loginIdentifier || !password) {
      return jsonResponse({ error: '用户名或邮箱和密码不能为空' }, 400);
    }

    let username = loginIdentifier.trim();
    
    // 如果是邮箱登录
    if (username.includes('@')) {
      const email = username.toLowerCase();
      const mapping = await env.DB.prepare(`
        SELECT username FROM email_username_mapping WHERE email = ?
      `).bind(email).first();
      
      if (!mapping) {
        return jsonResponse({ error: '用户不存在' }, 401);
      }
      username = mapping.username;
    }

    // 查询用户
    const user = await env.DB.prepare(`
      SELECT * FROM users WHERE username = ?
    `).bind(username).first();
    
    if (!user) {
      return jsonResponse({ error: '用户不存在' }, 401);
    }

    // 验证密码
    const ok = await verifyPassword(password, {
      passwordHash: user.password_hash,
      salt: user.salt,
      iterations: user.iterations,
      algo: user.algo
    });
    
    if (!ok) {
      return jsonResponse({ error: '密码错误' }, 401);
    }

    const token = await generateToken(username, env);
    return jsonResponse({ token, username });
  } catch (error) {
    console.error('登录失败:', error);
    return jsonResponse({ error: '登录失败' }, 500);
  }
}

// 获取用户信息 - D1版本
async function handleGetUserInfo(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: '未提供认证信息' }, 401);
    }

    const token = authHeader.substring(7);
    const tokenData = await verifyToken(token, env);
    if (!tokenData) {
      return jsonResponse({ error: '认证失败' }, 401);
    }

    const user = await env.DB.prepare(`
      SELECT * FROM users WHERE username = ?
    `).bind(tokenData.username).first();
    
    if (!user) {
      return jsonResponse({ error: '用户不存在' }, 404);
    }

    // 检查会员状态
    const membershipStatus = checkMembershipStatus({
      membershipType: user.membership_type,
      membershipExpiresAt: user.membership_expires_at,
      freeTrialEndDate: user.free_trial_end_date
    });

    return jsonResponse({
      username: user.username,
      email: user.email,
      wechatOpenid: user.wechat_openid,
      wechatNickname: user.wechat_nickname,
      alipayUserId: user.alipay_user_id,
      alipayNickname: user.alipay_nickname,
      createdAt: user.created_at,
      emailVerified: user.email_verified === 1,
      membership: membershipStatus
    });
  } catch (error) {
    console.error('获取用户信息失败:', error);
    return jsonResponse({ error: '获取用户信息失败' }, 500);
  }
}

// 创建支付宝订单 - D1版本
async function handleCreateAlipayOrder(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: '未提供认证信息' }, 401);
    }

    const token = authHeader.substring(7);
    const tokenData = await verifyToken(token, env);
    if (!tokenData) {
      return jsonResponse({ error: '认证失败' }, 401);
    }

    const { plan = 'monthly' } = await request.json();
    const planDetails = WORKER_MEMBERSHIP_PLANS[plan];
    if (!planDetails) {
      return jsonResponse({ error: '无效的会员计划' }, 400);
    }

    // 查询用户
    const user = await env.DB.prepare(`
      SELECT * FROM users WHERE username = ?
    `).bind(tokenData.username).first();
    
    if (!user) {
      return jsonResponse({ error: '用户不存在' }, 404);
    }

    const isAdminUser = isAdmin(user.email);
    let finalAmount = isAdminUser ? planDetails.adminPrice : planDetails.price;

    const outTradeNo = `MEMBER_${tokenData.username}_${Date.now()}`;

    // 保存订单到D1
    await env.DB.prepare(`
      INSERT INTO orders (
        order_id, user_id, plan, amount, original_amount,
        is_admin_order, status, platform, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      outTradeNo, tokenData.username, plan, finalAmount, planDetails.price,
      isAdminUser ? 1 : 0, 'PENDING', 'alipay', new Date().toISOString()
    ).run();

    // ... 支付宝API调用（保持原有实现）
    
    return jsonResponse({
      orderId: outTradeNo,
      amount: finalAmount,
      plan: plan
    });
  } catch (error) {
    console.error('创建订单失败:', error);
    return jsonResponse({ error: '创建订单失败' }, 500);
  }
}

// 查询订单 - D1版本
async function handleQueryAlipayOrder(request, env) {
  try {
    const url = new URL(request.url);
    const orderId = url.searchParams.get('orderId');
    
    if (!orderId) {
      return jsonResponse({ error: '订单ID不能为空' }, 400);
    }

    const order = await env.DB.prepare(`
      SELECT * FROM orders WHERE order_id = ?
    `).bind(orderId).first();
    
    if (!order) {
      return jsonResponse({ error: '订单不存在' }, 404);
    }

    return jsonResponse({
      orderId: order.order_id,
      userId: order.user_id,
      plan: order.plan,
      amount: order.amount,
      status: order.status,
      createdAt: order.created_at,
      paidAt: order.paid_at
    });
  } catch (error) {
    console.error('查询订单失败:', error);
    return jsonResponse({ error: '查询订单失败' }, 500);
  }
}

// 支付宝回调 - D1版本
async function handleAlipayNotify(request, env) {
  try {
    // ... 验证签名（保持原有实现）
    
    const formData = await request.formData();
    const params = {};
    for (const [key, value] of formData.entries()) {
      params[key] = value;
    }

    if (params.trade_status === 'TRADE_SUCCESS' || params.trade_status === 'TRADE_FINISHED') {
      const outTradeNo = params.out_trade_no;
      
      // 查询订单
      const order = await env.DB.prepare(`
        SELECT * FROM orders WHERE order_id = ?
      `).bind(outTradeNo).first();
      
      if (!order) {
        return new Response('failure', { status: 404 });
      }

      if (order.status === 'PAID') {
        return new Response('success', { status: 200 });
      }

      // 更新订单状态
      await env.DB.prepare(`
        UPDATE orders 
        SET status = ?, paid_at = ?, trade_no = ?
        WHERE order_id = ?
      `).bind('PAID', new Date().toISOString(), params.trade_no, outTradeNo).run();

      // 查询用户
      const user = await env.DB.prepare(`
        SELECT * FROM users WHERE username = ?
      `).bind(order.user_id).first();
      
      const planDetails = WORKER_MEMBERSHIP_PLANS[order.plan];
      const now = new Date();
      
      // 计算到期时间
      let startDate = now;
      if (user.membership_expires_at && new Date(user.membership_expires_at) > now) {
        startDate = new Date(user.membership_expires_at);
      }
      
      const endDate = new Date(startDate.getTime() + planDetails.duration);

      // 更新用户会员状态
      await env.DB.prepare(`
        UPDATE users 
        SET membership_type = ?, membership_expires_at = ?, updated_at = ?
        WHERE username = ?
      `).bind('paid', endDate.toISOString(), now.toISOString(), order.user_id).run();

      // 添加购买记录
      await env.DB.prepare(`
        INSERT INTO purchase_history (
          username, order_id, plan, amount, currency, status,
          payment_method, purchased_at, valid_from, valid_to
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        order.user_id, outTradeNo, order.plan, planDetails.price, 'CNY',
        'completed', 'alipay', now.toISOString(),
        startDate.toISOString(), endDate.toISOString()
      ).run();
    }

    return new Response('success', { status: 200 });
  } catch (error) {
    console.error('处理支付宝通知失败:', error);
    return new Response('failure', { status: 500 });
  }
}

// 生成兑换码 - D1版本
async function handleCreateRedeemCode(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: '未提供认证信息' }, 401);
    }

    const token = authHeader.substring(7);
    const tokenData = await verifyToken(token, env);
    if (!tokenData) {
      return jsonResponse({ error: '认证失败' }, 401);
    }

    // 检查管理员权限
    const user = await env.DB.prepare(`
      SELECT * FROM users WHERE username = ?
    `).bind(tokenData.username).first();
    
    if (!isAdmin(user.email)) {
      return jsonResponse({ error: '权限不足' }, 403);
    }

    const { type, quantity = 1, description = '' } = await request.json();
    const codeType = REDEEM_CODE_TYPES[type];
    
    if (!codeType) {
      return jsonResponse({ error: '无效的兑换码类型' }, 400);
    }

    const codes = [];
    for (let i = 0; i < quantity; i++) {
      const code = generateRedeemCode();
      
      await env.DB.prepare(`
        INSERT INTO redeem_codes (
          code, type, days, name, description, created_by, created_at, used
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).bind(
        code, codeType.type, codeType.days, codeType.name,
        description, tokenData.username, new Date().toISOString()
      ).run();
      
      codes.push(code);
    }

    return jsonResponse({
      message: `成功生成${quantity}个兑换码`,
      codes,
      type: codeType.name
    });
  } catch (error) {
    console.error('生成兑换码失败:', error);
    return jsonResponse({ error: '生成兑换码失败' }, 500);
  }
}

// 使用兑换码 - D1版本
async function handleUseRedeemCode(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: '未提供认证信息' }, 401);
    }

    const token = authHeader.substring(7);
    const tokenData = await verifyToken(token, env);
    if (!tokenData) {
      return jsonResponse({ error: '认证失败' }, 401);
    }

    const { code } = await request.json();
    if (!code) {
      return jsonResponse({ error: '兑换码不能为空' }, 400);
    }

    // 查询兑换码
    const redeemCode = await env.DB.prepare(`
      SELECT * FROM redeem_codes WHERE code = ? AND used = 0
    `).bind(code.toUpperCase()).first();
    
    if (!redeemCode) {
      return jsonResponse({ error: '兑换码不存在或已使用' }, 400);
    }

    // 查询用户
    const user = await env.DB.prepare(`
      SELECT * FROM users WHERE username = ?
    `).bind(tokenData.username).first();
    
    const now = new Date();
    let newExpiryDate = new Date(now);
    
    // 如果用户有有效会员，在现有基础上延长
    if (user.membership_expires_at && new Date(user.membership_expires_at) > now) {
      newExpiryDate = new Date(user.membership_expires_at);
    }
    
    newExpiryDate.setDate(newExpiryDate.getDate() + redeemCode.days);

    // 更新用户会员
    await env.DB.prepare(`
      UPDATE users 
      SET membership_type = ?, membership_expires_at = ?, updated_at = ?
      WHERE username = ?
    `).bind(redeemCode.type, newExpiryDate.toISOString(), now.toISOString(), tokenData.username).run();

    // 标记兑换码为已使用
    await env.DB.prepare(`
      UPDATE redeem_codes 
      SET used = 1, used_by = ?, used_at = ?
      WHERE code = ?
    `).bind(tokenData.username, now.toISOString(), code.toUpperCase()).run();

    // 添加兑换记录
    await env.DB.prepare(`
      INSERT INTO redeem_history (
        username, code, type, days, redeemed_at, valid_from, valid_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      tokenData.username, code.toUpperCase(), redeemCode.type, redeemCode.days,
      now.toISOString(), now.toISOString(), newExpiryDate.toISOString()
    ).run();

    return jsonResponse({
      message: `兑换成功！获得${redeemCode.name}`,
      expiresAt: newExpiryDate.toISOString(),
      daysAdded: redeemCode.days
    });
  } catch (error) {
    console.error('使用兑换码失败:', error);
    return jsonResponse({ error: '使用兑换码失败' }, 500);
  }
}

// 获取购买记录 - D1版本
async function handleGetPurchaseHistory(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: '未提供认证信息' }, 401);
    }

    const token = authHeader.substring(7);
    const tokenData = await verifyToken(token, env);
    if (!tokenData) {
      return jsonResponse({ error: '认证失败' }, 401);
    }

    const result = await env.DB.prepare(`
      SELECT * FROM purchase_history 
      WHERE username = ? 
      ORDER BY purchased_at DESC
    `).bind(tokenData.username).all();

    return jsonResponse({
      purchases: result.results,
      total: result.results.length
    });
  } catch (error) {
    console.error('获取购买记录失败:', error);
    return jsonResponse({ error: '获取购买记录失败' }, 500);
  }
}

// 获取兑换记录 - D1版本
async function handleGetRedeemHistory(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: '未提供认证信息' }, 401);
    }

    const token = authHeader.substring(7);
    const tokenData = await verifyToken(token, env);
    if (!tokenData) {
      return jsonResponse({ error: '认证失败' }, 401);
    }

    const result = await env.DB.prepare(`
      SELECT * FROM redeem_history 
      WHERE username = ? 
      ORDER BY redeemed_at DESC
    `).bind(tokenData.username).all();

    return jsonResponse({
      redeems: result.results,
      total: result.results.length
    });
  } catch (error) {
    console.error('获取兑换记录失败:', error);
    return jsonResponse({ error: '获取兑换记录失败' }, 500);
  }
}

// 主请求处理函数
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // API路由
      if (pathname === '/api/auth/register' && method === 'POST') {
        return await handleRegister(request, env);
      }
      if (pathname === '/api/auth/login' && method === 'POST') {
        return await handleLogin(request, env);
      }
      if (pathname === '/api/auth/user-info' && method === 'GET') {
        return await handleGetUserInfo(request, env);
      }
      
      // 支付宝订单API
      if (pathname === '/api/alipay/create-order' && method === 'POST') {
        return await handleCreateAlipayOrder(request, env);
      }
      if (pathname === '/api/alipay/query-order' && method === 'GET') {
        return await handleQueryAlipayOrder(request, env);
      }
      if (pathname === '/api/alipay/notify' && method === 'POST') {
        return await handleAlipayNotify(request, env);
      }
      
      // 兑换码API
      if (pathname === '/api/admin/create-redeem-code' && method === 'POST') {
        return await handleCreateRedeemCode(request, env);
      }
      if (pathname === '/api/admin/use-redeem-code' && method === 'POST') {
        return await handleUseRedeemCode(request, env);
      }
      
      // 记录API
      if (pathname === '/api/admin/purchase-history' && method === 'GET') {
        return await handleGetPurchaseHistory(request, env);
      }
      if (pathname === '/api/admin/redeem-history' && method === 'GET') {
        return await handleGetRedeemHistory(request, env);
      }

      // 其他路由保持原有实现...
      
      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('Worker error:', error);
      return new Response('Internal Server Error', { status: 500, headers: corsHeaders });
    }
  }
};
