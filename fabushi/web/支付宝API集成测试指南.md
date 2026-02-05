# 支付宝API集成测试指南

## 概述

支付宝登录功能已经集成了真实的支付宝API，支持通过支付宝授权码获取用户信息和详细资料。

## API集成详情

### 1. 支付宝登录流程

1. **生成授权URL** → `/api/auth/alipay/login-url`
2. **用户授权** → 跳转到支付宝授权页面
3. **回调处理** → `/api/auth/alipay/callback`
4. **获取access_token** → 调用 `alipay.system.oauth.token`
5. **获取用户信息** → 调用 `alipay.user.info.share`

### 2. 集成的支付宝API

#### alipay.system.oauth.token
- **用途**: 使用授权码换取access_token和用户ID
- **文档**: https://opendocs.alipay.com/open/01emu5
- **参数**:
  - `grant_type`: authorization_code
  - `code`: 支付宝授权码
- **响应**: access_token, user_id, expires_in等

#### alipay.user.info.share
- **用途**: 使用access_token获取用户详细信息
- **文档**: https://opendocs.alipay.com/open/01emu5
- **参数**:
  - `auth_token`: access_token
- **响应**: nick_name, avatar, province, city, gender等

### 3. 环境变量配置

```bash
# 支付宝应用配置
ALIPAY_APP_ID=你的支付宝应用ID
ALIPAY_PRIVATE_KEY=你的应用私钥（PKCS#8格式）
ALIPAY_PUBLIC_KEY=支付宝公钥

# 环境配置
ALIPAY_USE_SANDBOX=true  # 使用沙箱环境测试，生产环境设为false
WORKER_URL=https://your-worker.workers.dev
USERS_KV=你的KV命名空间
```

### 4. 密钥格式要求

#### 应用私钥格式（PKCS#8）
```
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
-----END PRIVATE KEY-----
```

如果私钥是PKCS#1格式，需要转换：
```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in pkcs1.pem -out pkcs8.pem
```

#### 支付宝公钥格式
```
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
-----END PUBLIC KEY-----
```

### 5. 沙箱环境测试

#### 沙箱环境配置
- 网关地址: `https://openapi-sandbox.dl.alipaydev.com/gateway.do`
- 沙箱应用ID: 在支付宝开放平台获取
- 沙箱私钥/公钥: 在沙箱环境配置

#### 沙箱测试账号
在支付宝开放平台可以获取沙箱测试账号，用于模拟用户授权流程。

### 6. 测试步骤

#### 步骤1: 配置环境变量
```bash
wrangler secret put ALIPAY_APP_ID
wrangler secret put ALIPAY_PRIVATE_KEY
wrangler secret put ALIPAY_PUBLIC_KEY
wrangler secret put ALIPAY_USE_SANDBOX
```

#### 步骤2: 部署Worker
```bash
npm run deploy
```

#### 步骤3: 测试授权流程
1. 访问登录页面
2. 点击"支付宝登录"按钮
3. 跳转到支付宝授权页面（沙箱环境）
4. 使用沙箱测试账号授权
5. 返回应用并查看用户信息

#### 步骤4: 验证API调用
查看Worker日志，确认API调用成功：
```
获取支付宝用户信息，授权码: [auth_code]
支付宝配置检查: { hasAppId: true, hasPrivateKey: true, hasAlipayPublicKey: true }
开始调用支付宝API获取access_token...
获取access_token请求参数: { app_id: "...", method: "alipay.system.oauth.token", ... }
成功获取access_token和user_id: { access_token: "...", user_id: "..." }
开始获取用户详细信息...
获取用户信息请求参数: { app_id: "...", method: "alipay.user.info.share", ... }
成功获取支付宝用户信息: { user_id: "...", nick_name: "...", avatar: "..." }
```

### 7. 常见问题排查

#### 签名错误
- 检查私钥格式是否为PKCS#8
- 确认签名算法为RSA2
- 验证时间戳格式是否正确

#### 授权失败
- 检查授权码是否过期（有效期较短）
- 确认回调地址配置正确
- 验证应用权限是否包含"获取会员信息"

#### 沙箱环境无法访问
- 确认使用正确的沙箱网关地址
- 检查沙箱应用配置
- 使用沙箱测试账号进行授权

### 8. 生产环境部署

1. **切换生产环境**
   ```bash
   wrangler secret put ALIPAY_USE_SANDBOX false
   ```

2. **更新应用配置**
   - 使用生产环境的应用ID
   - 配置生产环境的私钥和公钥
   - 确保回调地址为生产域名

3. **验证生产环境**
   - 使用真实支付宝账号测试
   - 确认所有功能正常工作

### 9. 安全注意事项

- 私钥必须妥善保管，不要暴露在客户端代码中
- 使用HTTPS协议进行所有通信
- 定期更新密钥
- 监控异常登录行为

### 10. 相关文档

- [支付宝开放平台文档](https://opendocs.alipay.com/)
- [用户登录授权接口](https://opendocs.alipay.com/open/02aile)
- [换取授权访问令牌](https://opendocs.alipay.com/open/01emu5)
- [获取用户信息](https://opendocs.alipay.com/open/01emu5)