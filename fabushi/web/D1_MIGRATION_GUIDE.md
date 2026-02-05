# Worker.js D1迁移指南

## 主要修改点

### 1. 注册用户 (handleRegister)

**KV版本:**
```javascript
await env.USERS_KV.put(`user:${username}`, JSON.stringify(userData));
await env.USERS_KV.put(`email_to_username:${email}`, username);
```

**D1版本:**
```javascript
await env.DB.prepare(`
  INSERT INTO users (username, email, password_hash, salt, iterations, algo, email_verified, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).bind(
  username, email, creds.passwordHash, creds.salt, 
  creds.iterations, creds.algo, 1, new Date().toISOString()
).run();

await env.DB.prepare(`
  INSERT INTO email_username_mapping (email, username) VALUES (?, ?)
`).bind(email, username).run();
```

### 2. 登录验证 (handleLogin)

**KV版本:**
```javascript
const userData = await env.USERS_KV.get(`user:${username}`);
const user = JSON.parse(userData);
```

**D1版本:**
```javascript
const result = await env.DB.prepare(`
  SELECT * FROM users WHERE username = ?
`).bind(username).first();
const user = result;
```

### 3. 创建订单 (handleCreateAlipayOrder)

**KV版本:**
```javascript
await env.ORDERS_KV.put(outTradeNo, JSON.stringify(orderData));
```

**D1版本:**
```javascript
await env.DB.prepare(`
  INSERT INTO orders (order_id, user_id, plan, amount, status, platform, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).bind(
  outTradeNo, tokenData.username, plan, finalAmount, 
  'PENDING', 'alipay', new Date().toISOString()
).run();
```

### 4. 查询订单 (handleQueryAlipayOrder)

**KV版本:**
```javascript
const orderData = await env.ORDERS_KV.get(orderId);
return jsonResponse(JSON.parse(orderData));
```

**D1版本:**
```javascript
const order = await env.DB.prepare(`
  SELECT * FROM orders WHERE order_id = ?
`).bind(orderId).first();
return jsonResponse(order);
```

### 5. 会员状态更新 (handleAlipayNotify)

**KV版本:**
```javascript
const userDataStr = await env.USERS_KV.get(`user:${orderData.userId}`);
const user = JSON.parse(userDataStr);
user.membershipType = 'paid';
user.membershipExpiresAt = endDate.toISOString();
await env.USERS_KV.put(`user:${orderData.userId}`, JSON.stringify(user));
```

**D1版本:**
```javascript
await env.DB.prepare(`
  UPDATE users 
  SET membership_type = ?, membership_expires_at = ?, updated_at = ?
  WHERE username = ?
`).bind('paid', endDate.toISOString(), new Date().toISOString(), orderData.userId).run();

// 同时更新memberships表
await env.DB.prepare(`
  INSERT INTO memberships (username, type, expires_at, created_at)
  VALUES (?, ?, ?, ?)
`).bind(orderData.userId, 'paid', endDate.toISOString(), new Date().toISOString()).run();
```

### 6. 购买记录 (handleAlipayNotify)

**KV版本:**
```javascript
const existingPurchases = await env.USERS_KV.get(`purchases:${orderData.userId}`);
const purchases = existingPurchases ? JSON.parse(existingPurchases) : [];
purchases.unshift(purchaseRecord);
await env.USERS_KV.put(`purchases:${orderData.userId}`, JSON.stringify(purchases));
```

**D1版本:**
```javascript
await env.DB.prepare(`
  INSERT INTO purchase_history (username, order_id, plan, amount, payment_method, purchased_at, valid_from, valid_to)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).bind(
  orderData.userId, outTradeNo, orderData.plan, planDetails.price,
  'alipay', new Date().toISOString(), startDate.toISOString(), endDate.toISOString()
).run();
```

### 7. 兑换码生成 (handleCreateRedeemCode)

**KV版本:**
```javascript
await env.REDEEM_CODES_KV.put(`code:${code}`, JSON.stringify(codeData));
```

**D1版本:**
```javascript
await env.DB.prepare(`
  INSERT INTO redeem_codes (code, type, days, name, description, created_by, created_at, used)
  VALUES (?, ?, ?, ?, ?, ?, ?, 0)
`).bind(
  code, codeType.type, codeType.days, codeType.name,
  description, tokenData.username, new Date().toISOString()
).run();
```

### 8. 使用兑换码 (handleUseRedeemCode)

**KV版本:**
```javascript
const codeData = await env.REDEEM_CODES_KV.get(`code:${code.toUpperCase()}`);
const redeemCode = JSON.parse(codeData);
// 更新
redeemCode.used = true;
await env.REDEEM_CODES_KV.put(`code:${code.toUpperCase()}`, JSON.stringify(redeemCode));
```

**D1版本:**
```javascript
const redeemCode = await env.DB.prepare(`
  SELECT * FROM redeem_codes WHERE code = ? AND used = 0
`).bind(code.toUpperCase()).first();

// 标记为已使用
await env.DB.prepare(`
  UPDATE redeem_codes SET used = 1, used_by = ?, used_at = ? WHERE code = ?
`).bind(tokenData.username, new Date().toISOString(), code.toUpperCase()).run();

// 添加兑换记录
await env.DB.prepare(`
  INSERT INTO redeem_history (username, code, type, days, redeemed_at, valid_from, valid_to)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).bind(
  tokenData.username, code.toUpperCase(), redeemCode.type, redeemCode.days,
  now.toISOString(), validFrom, validTo
).run();
```

## 保留在KV的数据

以下数据应该继续使用KV（临时数据，带TTL）:

1. **验证码** - `verify:${email}` (10分钟过期)
2. **频率限制** - `rate:verify:${email}` (60秒过期)
3. **密码重置令牌** - `reset:${email}` (30分钟过期)
4. **排行榜缓存** - `leaderboard:cache` (5分钟过期)
5. **微信state** - `wechat_state:${state}` (10分钟过期)

## 完整修改步骤

1. 确保wrangler.toml已添加D1绑定
2. 修改所有用户相关操作使用D1
3. 修改所有订单相关操作使用D1
4. 修改所有兑换码相关操作使用D1
5. 保留临时数据在KV中
6. 测试所有API端点
7. 部署到生产环境
