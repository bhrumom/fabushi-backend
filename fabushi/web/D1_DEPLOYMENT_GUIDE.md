# D1数据库迁移部署指南

## 概述

本指南将帮助你将现有的KV存储迁移到D1数据库，提高查询性能和数据管理能力。

## 迁移步骤

### 1. 创建D1数据库

```bash
# 创建生产环境数据库
wrangler d1 create fabushi-db

# 创建开发环境数据库
wrangler d1 create fabushi-db-dev
```

记录返回的database_id，更新到wrangler.toml中。

### 2. 更新wrangler.toml配置

编辑`wrangler.toml`，更新D1数据库ID：

```toml
[[d1_databases]]
binding = "DB"
database_name = "fabushi-db"
database_id = "你的数据库ID"  # 替换为实际ID

[env.production.d1_databases]]
binding = "DB"
database_name = "fabushi-db"
database_id = "你的生产数据库ID"

[env.development.d1_databases]]
binding = "DB"
database_name = "fabushi-db-dev"
database_id = "你的开发数据库ID"
```

### 3. 初始化数据库Schema

```bash
# 生产环境
wrangler d1 execute fabushi-db --file=schema.sql --remote

# 开发环境
wrangler d1 execute fabushi-db-dev --file=schema.sql --local
```

### 4. 验证数据库结构

```bash
# 查看表结构
wrangler d1 execute fabushi-db --command="SELECT name FROM sqlite_master WHERE type='table';" --remote

# 查看users表结构
wrangler d1 execute fabushi-db --command="PRAGMA table_info(users);" --remote
```

### 5. 数据迁移

#### 方法一：使用迁移脚本（推荐）

```bash
# 1. 临时部署迁移worker
cp migrate-kv-to-d1.js worker.js

# 2. 部署到Cloudflare
wrangler deploy

# 3. 访问迁移端点
curl https://flutter.ombhrum.com/migrate-data

# 4. 检查迁移结果
# 查看用户数量
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) as count FROM users;" --remote

# 查看订单数量
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) as count FROM orders;" --remote

# 查看兑换码数量
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) as count FROM redeem_codes;" --remote
```

#### 方法二：手动迁移（小数据量）

```bash
# 导出KV数据
wrangler kv:key list --namespace-id=20bc68276a0345ab9b5cbf17c1bd51c5 > kv-users.json

# 编写自定义脚本导入到D1
# 参考migrate-kv-to-d1.js的实现
```

### 6. 切换到D1版本

```bash
# 1. 备份当前worker.js
cp worker.js worker-kv-backup.js

# 2. 使用D1版本
cp worker-d1.js worker.js

# 3. 部署
wrangler deploy
```

### 7. 验证功能

测试以下功能确保正常工作：

```bash
# 1. 测试注册
curl -X POST https://flutter.ombhrum.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","email":"test@example.com","password":"Test123456","verificationCode":"123456"}'

# 2. 测试登录
curl -X POST https://flutter.ombhrum.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"testuser","password":"Test123456"}'

# 3. 测试获取用户信息
curl -X GET https://flutter.ombhrum.com/api/auth/user-info \
  -H "Authorization: Bearer YOUR_TOKEN"

# 4. 测试创建订单
curl -X POST https://flutter.ombhrum.com/api/alipay/create-order \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"plan":"monthly"}'

# 5. 测试兑换码
curl -X POST https://flutter.ombhrum.com/api/admin/use-redeem-code \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"code":"TEST123456"}'
```

## 数据对比

### 迁移前后数据验证

```bash
# KV中的用户数量
wrangler kv:key list --namespace-id=20bc68276a0345ab9b5cbf17c1bd51c5 --prefix="user:" | jq '. | length'

# D1中的用户数量
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM users;" --remote

# 对比订单数量
wrangler kv:key list --namespace-id=94534f35a0a34023a428a065f77f1911 | jq '. | length'
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM orders;" --remote

# 对比兑换码数量
wrangler kv:key list --namespace-id=59c5263942b4436191e6dffbaacc5957 --prefix="code:" | jq '. | length'
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM redeem_codes;" --remote
```

## 性能优化

### 1. 添加索引

```sql
-- 用户查询优化
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_membership ON users(membership_type, membership_expires_at);

-- 订单查询优化
CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

-- 兑换码查询优化
CREATE INDEX IF NOT EXISTS idx_redeem_codes_used ON redeem_codes(used, code);
```

### 2. 查询优化示例

```javascript
// 使用索引查询活跃会员
const activeMembers = await env.DB.prepare(`
  SELECT username, email, membership_expires_at 
  FROM users 
  WHERE membership_type = 'paid' 
    AND membership_expires_at > datetime('now')
  ORDER BY membership_expires_at DESC
  LIMIT 100
`).all();

// 使用索引查询用户订单
const userOrders = await env.DB.prepare(`
  SELECT * FROM orders 
  WHERE user_id = ? 
  ORDER BY created_at DESC 
  LIMIT 20
`).bind(username).all();
```

## 回滚方案

如果迁移后出现问题，可以快速回滚：

```bash
# 1. 恢复KV版本的worker
cp worker-kv-backup.js worker.js

# 2. 重新部署
wrangler deploy

# 3. 验证功能正常
curl https://flutter.ombhrum.com/health
```

## 数据保留策略

### KV数据保留

迁移完成后，建议保留KV数据30天：

1. **临时数据**（继续使用KV）：
   - 验证码
   - 频率限制
   - 密码重置令牌
   - 缓存数据

2. **历史数据**（可以删除）：
   - 用户数据（已迁移到D1）
   - 订单数据（已迁移到D1）
   - 兑换码数据（已迁移到D1）

### 清理KV数据

```bash
# 30天后，确认D1运行正常，清理KV中的历史数据
# 注意：不要删除临时数据的namespace

# 清理用户数据
wrangler kv:key list --namespace-id=20bc68276a0345ab9b5cbf17c1bd51c5 --prefix="user:" | \
  jq -r '.[].name' | \
  xargs -I {} wrangler kv:key delete --namespace-id=20bc68276a0345ab9b5cbf17c1bd51c5 {}

# 清理订单数据
wrangler kv:key list --namespace-id=94534f35a0a34023a428a065f77f1911 | \
  jq -r '.[].name' | \
  xargs -I {} wrangler kv:key delete --namespace-id=94534f35a0a34023a428a065f77f1911 {}
```

## 监控和维护

### 1. 数据库大小监控

```bash
# 查看数据库大小
wrangler d1 execute fabushi-db --command="SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size();" --remote
```

### 2. 定期备份

```bash
# 导出数据库备份
wrangler d1 export fabushi-db --output=backup-$(date +%Y%m%d).sql --remote

# 恢复备份
wrangler d1 execute fabushi-db --file=backup-20250101.sql --remote
```

### 3. 性能监控

在Cloudflare Dashboard中监控：
- D1查询延迟
- 查询错误率
- 数据库大小增长
- 读写操作频率

## 常见问题

### Q1: 迁移过程中服务会中断吗？

A: 不会。迁移脚本在后台运行，不影响现有服务。切换到D1版本时会有短暂的部署时间（通常<1分钟）。

### Q2: D1和KV的性能差异？

A: 
- **D1优势**：复杂查询、关联查询、事务支持
- **KV优势**：简单键值查询、TTL支持、全球分布

### Q3: 如何处理并发写入？

A: D1支持事务，可以使用BEGIN/COMMIT确保数据一致性：

```javascript
await env.DB.batch([
  env.DB.prepare('UPDATE users SET ... WHERE username = ?').bind(username),
  env.DB.prepare('INSERT INTO purchase_history ...').bind(...)
]);
```

### Q4: D1有大小限制吗？

A: 
- 免费版：500MB
- 付费版：10GB+
- 单次查询结果：最多1000行

## 技术支持

如遇到问题，请：
1. 查看Cloudflare Workers日志
2. 检查D1数据库状态
3. 参考官方文档：https://developers.cloudflare.com/d1/
4. 联系技术支持：support@fabushi.com
