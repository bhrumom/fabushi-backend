# Worker模块化结构说明

## 📁 目录结构

```
web/
├── src/
│   ├── config/
│   │   └── constants.js          # 配置常量
│   ├── services/
│   │   └── database.js            # D1数据库服务
│   ├── handlers/
│   │   ├── auth.js                # 认证处理
│   │   ├── payment.js             # 支付处理
│   │   └── redeem.js              # 兑换码处理
│   ├── utils/
│   │   ├── helpers.js             # 工具函数
│   │   └── response.js            # 响应工具
│   └── router.js                  # 路由分发
├── worker-modular.js              # 模块化入口
├── worker.js                      # 原完整版本（保留）
└── auth-utils.js                  # 认证工具（共享）
```

## 🎯 模块说明

### 1. config/constants.js
- 管理员配置
- 会员计划配置
- 兑换码类型
- CORS头配置

### 2. services/database.js
**DatabaseService类** - 封装所有D1数据库操作：
- `getUser(username)` - 获取用户
- `getUserByEmail(email)` - 通过邮箱获取用户
- `createUser(userData)` - 创建用户
- `updateUser(username, updates)` - 更新用户
- `createOrder(orderData)` - 创建订单
- `getOrder(orderId)` - 获取订单
- `updateOrder(orderId, updates)` - 更新订单
- `createRedeemCode(codeData)` - 创建兑换码
- `getRedeemCode(code)` - 获取兑换码
- `useRedeemCode(code, username)` - 使用兑换码
- `addPurchaseHistory(data)` - 添加购买记录
- `getPurchaseHistory(username)` - 获取购买记录
- `addRedeemHistory(data)` - 添加兑换记录
- `getRedeemHistory(username)` - 获取兑换记录

### 3. handlers/auth.js
认证相关处理器：
- `handleRegister` - 用户注册
- `handleLogin` - 用户登录
- `handleGetUserInfo` - 获取用户信息

### 4. handlers/payment.js
支付相关处理器：
- `handleCreateAlipayOrder` - 创建支付宝订单
- `handleQueryAlipayOrder` - 查询订单
- `handleAlipayNotify` - 支付宝回调

### 5. handlers/redeem.js
兑换码相关处理器：
- `handleCreateRedeemCode` - 生成兑换码
- `handleUseRedeemCode` - 使用兑换码
- `handleGetPurchaseHistory` - 获取购买记录
- `handleGetRedeemHistory` - 获取兑换记录

### 6. utils/helpers.js
工具函数：
- `isAdmin(email)` - 检查管理员
- `generateRedeemCode()` - 生成兑换码

### 7. utils/response.js
响应工具：
- `jsonResponse(data, status)` - JSON响应

### 8. router.js
路由分发器 - 将请求路由到对应的处理器

### 9. worker-modular.js
模块化Worker入口 - 初始化服务并分发请求

## 🚀 使用方式

### 方式1: 完全切换到模块化版本

```bash
# 备份原版本
cp worker.js worker-original-backup.js

# 使用模块化版本
cp worker-modular.js worker.js

# 部署
wrangler deploy
```

### 方式2: 渐进式迁移（推荐）

保留原worker.js，在其中逐步引入模块：

```javascript
// 在原worker.js中
import { DatabaseService } from './src/services/database.js';
import { route } from './src/router.js';

export default {
  async fetch(request, env, ctx) {
    const db = new DatabaseService(env.DB);
    
    // 先尝试模块化路由
    const response = await route(request, env, db);
    if (response) return response;
    
    // 未匹配则使用原有逻辑
    // ... 原有代码
  }
}
```

## ✅ 优势

### 1. 可维护性
- 代码按功能分模块
- 每个文件职责单一
- 易于定位和修改

### 2. 可测试性
- 每个模块可独立测试
- 依赖注入便于mock

### 3. 可扩展性
- 新增功能只需添加新handler
- 不影响现有代码

### 4. 代码复用
- DatabaseService可在多处使用
- 工具函数统一管理

## 📝 添加新功能

### 示例：添加新的API端点

1. **创建handler**
```javascript
// src/handlers/newfeature.js
export async function handleNewFeature(request, env, db) {
  // 实现逻辑
}
```

2. **添加路由**
```javascript
// src/router.js
import { handleNewFeature } from './handlers/newfeature.js';

if (pathname === '/api/new-feature' && method === 'POST') {
  return await handleNewFeature(request, env, db);
}
```

3. **部署**
```bash
wrangler deploy
```

## 🔄 迁移计划

### 阶段1: 核心功能模块化 ✅
- [x] 认证模块
- [x] 支付模块
- [x] 兑换码模块
- [x] 数据库服务

### 阶段2: 其他功能迁移
- [ ] 邮件服务
- [ ] 文件上传
- [ ] 搜索功能
- [ ] 排行榜

### 阶段3: 完全切换
- [ ] 测试所有功能
- [ ] 性能对比
- [ ] 完全替换worker.js

## 📞 技术支持

如有问题，请查看：
- [D1迁移指南](D1_DEPLOYMENT_GUIDE.md)
- 邮箱: support@fabushi.com

---

**模块化让代码更清晰，维护更简单！** 🎉
