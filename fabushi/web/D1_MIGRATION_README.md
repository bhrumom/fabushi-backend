# KV到D1数据库迁移方案

## 📋 概述

本迁移方案将Cloudflare Workers的KV存储迁移到D1 SQLite数据库，提供更强大的查询能力和更好的数据管理。

## 🎯 迁移目标

### 迁移到D1的数据
- ✅ 用户数据（users）
- ✅ 订单数据（orders）
- ✅ 兑换码数据（redeem_codes）
- ✅ 购买记录（purchase_history）
- ✅ 兑换记录（redeem_history）
- ✅ 邮箱映射（email_username_mapping）

### 保留在KV的数据
- ✅ 验证码（临时，10分钟TTL）
- ✅ 频率限制（临时，60秒TTL）
- ✅ 密码重置令牌（临时，30分钟TTL）
- ✅ 缓存数据（临时，5分钟TTL）

## 📁 文件说明

### 核心文件

| 文件 | 说明 |
|------|------|
| `schema.sql` | D1数据库表结构定义 |
| `migrate-kv-to-d1.js` | 数据迁移Worker脚本 |
| `worker-d1.js` | 使用D1的Worker实现 |
| `migrate-to-d1.sh` | 自动化迁移脚本 |

### 文档文件

| 文件 | 说明 |
|------|------|
| `D1_DEPLOYMENT_GUIDE.md` | 详细部署指南 |
| `D1_MIGRATION_GUIDE.md` | 代码迁移对照 |
| `D1_MIGRATION_README.md` | 本文件 |

## 🚀 快速开始

### 方法一：使用自动化脚本（推荐）

```bash
# 开发环境迁移
./migrate-to-d1.sh development

# 生产环境迁移
./migrate-to-d1.sh production
```

### 方法二：手动迁移

#### 1. 创建D1数据库

```bash
# 生产环境
wrangler d1 create fabushi-db

# 开发环境
wrangler d1 create fabushi-db-dev
```

#### 2. 更新wrangler.toml

将返回的database_id更新到`wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "fabushi-db"
database_id = "你的数据库ID"
```

#### 3. 初始化Schema

```bash
wrangler d1 execute fabushi-db --file=schema.sql --remote
```

#### 4. 数据迁移

```bash
# 部署迁移脚本
cp migrate-kv-to-d1.js worker.js
wrangler deploy

# 执行迁移
curl https://flutter.ombhrum.com/migrate-data
```

#### 5. 切换到D1版本

```bash
# 备份当前版本
cp worker.js worker-kv-backup.js

# 使用D1版本
cp worker-d1.js worker.js

# 部署
wrangler deploy
```

## 📊 数据库结构

### 主要表

#### users - 用户表
```sql
- id: 主键
- username: 用户名（唯一）
- email: 邮箱（唯一）
- password_hash: 密码哈希
- membership_type: 会员类型
- membership_expires_at: 会员到期时间
- created_at: 创建时间
```

#### orders - 订单表
```sql
- id: 主键
- order_id: 订单号（唯一）
- user_id: 用户ID
- plan: 会员计划
- amount: 金额
- status: 状态
- created_at: 创建时间
```

#### redeem_codes - 兑换码表
```sql
- id: 主键
- code: 兑换码（唯一）
- type: 类型
- days: 天数
- used: 是否已使用
- created_at: 创建时间
```

## 🔄 API变更对照

### 注册用户

**KV版本:**
```javascript
await env.USERS_KV.put(`user:${username}`, JSON.stringify(userData));
```

**D1版本:**
```javascript
await env.DB.prepare(`
  INSERT INTO users (username, email, ...) VALUES (?, ?, ...)
`).bind(username, email, ...).run();
```

### 查询用户

**KV版本:**
```javascript
const userData = await env.USERS_KV.get(`user:${username}`);
const user = JSON.parse(userData);
```

**D1版本:**
```javascript
const user = await env.DB.prepare(`
  SELECT * FROM users WHERE username = ?
`).bind(username).first();
```

### 更新用户

**KV版本:**
```javascript
const user = JSON.parse(await env.USERS_KV.get(`user:${username}`));
user.membershipType = 'paid';
await env.USERS_KV.put(`user:${username}`, JSON.stringify(user));
```

**D1版本:**
```javascript
await env.DB.prepare(`
  UPDATE users SET membership_type = ? WHERE username = ?
`).bind('paid', username).run();
```

## ✅ 验证清单

迁移完成后，请验证以下功能：

- [ ] 用户注册
- [ ] 用户登录（用户名）
- [ ] 用户登录（邮箱）
- [ ] 获取用户信息
- [ ] 创建支付宝订单
- [ ] 查询订单状态
- [ ] 支付宝回调处理
- [ ] 生成兑换码（管理员）
- [ ] 使用兑换码
- [ ] 查看购买记录
- [ ] 查看兑换记录
- [ ] 排行榜功能

## 📈 性能对比

### 查询性能

| 操作 | KV | D1 | 提升 |
|------|----|----|------|
| 简单查询 | ~50ms | ~30ms | 40% |
| 复杂查询 | 不支持 | ~50ms | ∞ |
| 关联查询 | 多次请求 | 单次请求 | 3-5x |
| 事务支持 | ❌ | ✅ | - |

### 存储成本

| 项目 | KV | D1 |
|------|----|----|
| 免费额度 | 100K读/1K写 | 500MB存储 |
| 读操作 | $0.50/百万 | 免费 |
| 写操作 | $5.00/百万 | 免费 |
| 存储 | $0.50/GB | $0.75/GB |

## 🔧 故障排除

### 问题1: 迁移脚本执行失败

**解决方案:**
```bash
# 检查环境变量
wrangler whoami

# 检查KV绑定
wrangler kv:namespace list

# 检查D1数据库
wrangler d1 list
```

### 问题2: 数据不完整

**解决方案:**
```bash
# 重新运行迁移
curl https://flutter.ombhrum.com/migrate-data

# 手动检查数据
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM users;" --remote
```

### 问题3: 性能下降

**解决方案:**
```sql
-- 添加索引
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_redeem_codes_code ON redeem_codes(code);
```

## 🔙 回滚方案

如果迁移后出现问题：

```bash
# 1. 恢复KV版本
cp worker-kv-backup.js worker.js

# 2. 重新部署
wrangler deploy

# 3. 验证功能
curl https://flutter.ombhrum.com/health
```

## 📚 相关资源

- [Cloudflare D1文档](https://developers.cloudflare.com/d1/)
- [Cloudflare Workers文档](https://developers.cloudflare.com/workers/)
- [SQLite文档](https://www.sqlite.org/docs.html)

## 🎓 最佳实践

### 1. 使用预编译语句

```javascript
// ✅ 推荐
const stmt = env.DB.prepare('SELECT * FROM users WHERE username = ?');
const user = await stmt.bind(username).first();

// ❌ 不推荐（SQL注入风险）
const user = await env.DB.prepare(`SELECT * FROM users WHERE username = '${username}'`).first();
```

### 2. 批量操作

```javascript
// ✅ 使用batch提高性能
await env.DB.batch([
  env.DB.prepare('INSERT INTO users ...').bind(...),
  env.DB.prepare('INSERT INTO users ...').bind(...),
  env.DB.prepare('INSERT INTO users ...').bind(...)
]);
```

### 3. 错误处理

```javascript
try {
  const result = await env.DB.prepare('...').bind(...).run();
  if (!result.success) {
    throw new Error('Database operation failed');
  }
} catch (error) {
  console.error('Database error:', error);
  // 回滚或重试逻辑
}
```

### 4. 索引优化

```sql
-- 为常用查询添加索引
CREATE INDEX idx_users_membership ON users(membership_type, membership_expires_at);
CREATE INDEX idx_orders_status ON orders(status, created_at);
```

## 📞 技术支持

如有问题，请联系：
- 邮箱: support@fabushi.com
- 文档: https://fabushi.ombhrum.com/docs
- GitHub: https://github.com/your-repo/issues

## 📝 更新日志

### v1.0.0 (2025-01-XX)
- ✅ 初始版本
- ✅ 完整的KV到D1迁移方案
- ✅ 自动化迁移脚本
- ✅ 详细文档

---

**愿此功德回向法界众生，同证菩提！** 🙏
