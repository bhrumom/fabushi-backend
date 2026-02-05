// D1版本的关键函数示例

// 注册用户 - D1版本
async function handleRegister(request, env) {
  const { username, email, password, verificationCode } = await request.json();
  
  // 验证验证码（仍使用KV - 临时数据）
  const verifyData = await env.USERS_KV.get(`verify:${email}`);
  // ... 验证逻辑
  
  // 创建密码哈希
  const creds = await createPasswordHash(password);
  
  // 保存到D1
  await env.DB.prepare(`
    INSERT INTO users (username, email, password_hash, salt, iterations, algo, email_verified, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    username, email, creds.passwordHash, creds.salt,
    creds.iterations, creds.algo, 1, new Date().toISOString()
  ).run();
  
  // 保存邮箱映射
  await env.DB.prepare(`
    INSERT INTO email_username_mapping (email, username) VALUES (?, ?)
  `).bind(email, username).run();
  
  // 清理验证码（KV）
  await env.USERS_KV.delete(`verify:${email}`);
  
  return jsonResponse({ message: '注册成功' }, 201);
}

// 登录 - D1版本
async function handleLogin(request, env) {
  const { username: loginIdentifier, password } = await request.json();
  
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
  const ok = await verifyPassword(password, user);
  if (!ok) {
    return jsonResponse({ error: '密码错误' }, 401);
  }
  
  const token = await generateToken(username, env);
  return jsonResponse({ token, username });
}

// 创建支付宝订单 - D1版本
async function handleCreateAlipayOrder(request, env) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  
  const { plan = 'monthly' } = await request.json();
  const planDetails = WORKER_MEMBERSHIP_PLANS[plan];
  
  // 查询用户
  const user = await env.DB.prepare(`
    SELECT * FROM users WHERE username = ?
  `).bind(tokenData.username).first();
  
  const isAdminUser = isAdmin(user.email);
  let finalAmount = isAdminUser ? planDetails.adminPrice : planDetails.price;
  
  const outTradeNo = `MEMBER_${tokenData.username}_${Date.now()}`;
  
  // 保存订单到D1
  await env.DB.prepare(`
    INSERT INTO orders (order_id, user_id, plan, amount, original_amount, is_admin_order, status, platform, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    outTradeNo, tokenData.username, plan, finalAmount, planDetails.price,
    isAdminUser ? 1 : 0, 'PENDING', 'alipay', new Date().toISOString()
  ).run();
  
  // ... 支付宝API调用
  
  return jsonResponse({ orderId: outTradeNo, qrCode: '...' });
}

// 查询订单 - D1版本
async function handleQueryAlipayOrder(request, env) {
  const url = new URL(request.url);
  const orderId = url.searchParams.get('orderId');
  
  const order = await env.DB.prepare(`
    SELECT * FROM orders WHERE order_id = ?
  `).bind(orderId).first();
  
  if (!order) {
    return jsonResponse({ error: '订单不存在' }, 404);
  }
  
  return jsonResponse(order);
}

// 支付宝回调 - D1版本
async function handleAlipayNotify(request, env) {
  // ... 验证签名
  
  if (params.trade_status === 'TRADE_SUCCESS') {
    const outTradeNo = params.out_trade_no;
    
    // 查询订单
    const order = await env.DB.prepare(`
      SELECT * FROM orders WHERE order_id = ?
    `).bind(outTradeNo).first();
    
    if (order.status === 'PAID') {
      return new Response('success', { status: 200 });
    }
    
    // 更新订单状态
    await env.DB.prepare(`
      UPDATE orders SET status = ?, paid_at = ?, trade_no = ? WHERE order_id = ?
    `).bind('PAID', new Date().toISOString(), params.trade_no, outTradeNo).run();
    
    // 查询用户
    const user = await env.DB.prepare(`
      SELECT * FROM users WHERE username = ?
    `).bind(order.user_id).first();
    
    const planDetails = WORKER_MEMBERSHIP_PLANS[order.plan];
    
    // 计算到期时间
    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + planDetails.duration);
    
    // 更新用户会员状态
    await env.DB.prepare(`
      UPDATE users 
      SET membership_type = ?, membership_expires_at = ?, updated_at = ?
      WHERE username = ?
    `).bind('paid', endDate.toISOString(), new Date().toISOString(), order.user_id).run();
    
    // 添加会员记录
    await env.DB.prepare(`
      INSERT INTO memberships (username, type, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(order.user_id, 'paid', endDate.toISOString(), new Date().toISOString()).run();
    
    // 添加购买记录
    await env.DB.prepare(`
      INSERT INTO purchase_history (username, order_id, plan, amount, currency, status, payment_method, purchased_at, valid_from, valid_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      order.user_id, outTradeNo, order.plan, planDetails.price, 'CNY',
      'completed', 'alipay', new Date().toISOString(),
      startDate.toISOString(), endDate.toISOString()
    ).run();
  }
  
  return new Response('success', { status: 200 });
}

// 生成兑换码 - D1版本
async function handleCreateRedeemCode(request, env) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  
  // 检查管理员权限
  const user = await env.DB.prepare(`
    SELECT * FROM users WHERE username = ?
  `).bind(tokenData.username).first();
  
  if (!isAdmin(user.email)) {
    return jsonResponse({ error: '权限不足' }, 403);
  }
  
  const { type, quantity = 1, description = '' } = await request.json();
  const codeType = REDEEM_CODE_TYPES[type];
  const codes = [];
  
  for (let i = 0; i < quantity; i++) {
    const code = generateRedeemCode();
    
    await env.DB.prepare(`
      INSERT INTO redeem_codes (code, type, days, name, description, created_by, created_at, used)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).bind(
      code, codeType.type, codeType.days, codeType.name,
      description, tokenData.username, new Date().toISOString()
    ).run();
    
    codes.push(code);
  }
  
  return jsonResponse({ message: `成功生成${quantity}个兑换码`, codes });
}

// 使用兑换码 - D1版本
async function handleUseRedeemCode(request, env) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  
  const { code } = await request.json();
  
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
  
  // 计算新的到期时间
  const now = new Date();
  let newExpiryDate = new Date(now);
  
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
    UPDATE redeem_codes SET used = 1, used_by = ?, used_at = ? WHERE code = ?
  `).bind(tokenData.username, now.toISOString(), code.toUpperCase()).run();
  
  // 添加兑换记录
  await env.DB.prepare(`
    INSERT INTO redeem_history (username, code, type, days, redeemed_at, valid_from, valid_to)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    tokenData.username, code.toUpperCase(), redeemCode.type, redeemCode.days,
    now.toISOString(), now.toISOString(), newExpiryDate.toISOString()
  ).run();
  
  return jsonResponse({
    message: `兑换成功！获得${redeemCode.name}`,
    expiresAt: newExpiryDate.toISOString()
  });
}

// 获取购买记录 - D1版本
async function handleGetPurchaseHistory(request, env) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  
  const purchases = await env.DB.prepare(`
    SELECT * FROM purchase_history WHERE username = ? ORDER BY purchased_at DESC
  `).bind(tokenData.username).all();
  
  return jsonResponse({
    purchases: purchases.results,
    total: purchases.results.length
  });
}

// 获取兑换记录 - D1版本
async function handleGetRedeemHistory(request, env) {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  
  const redeems = await env.DB.prepare(`
    SELECT * FROM redeem_history WHERE username = ? ORDER BY redeemed_at DESC
  `).bind(tokenData.username).all();
  
  return jsonResponse({
    redeems: redeems.results,
    total: redeems.results.length
  });
}
