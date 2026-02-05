# D1迁移快速参考

## 🚀 一键迁移

```bash
./migrate-to-d1.sh production
```

## 📋 常用命令

### 数据库操作

```bash
# 创建数据库
wrangler d1 create fabushi-db

# 执行SQL
wrangler d1 execute fabushi-db --file=schema.sql --remote

# 查询数据
wrangler d1 execute fabushi-db --command="SELECT * FROM users LIMIT 10;" --remote

# 导出备份
wrangler d1 export fabushi-db --output=backup.sql --remote
```

### 数据验证

```bash
# 用户数量
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM users;" --remote

# 订单数量
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM orders;" --remote

# 兑换码数量
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM redeem_codes;" --remote
```

### 部署操作

```bash
# 部署到生产环境
wrangler deploy --env production

# 部署到开发环境
wrangler deploy --env development

# 查看日志
wrangler tail
```

## 🔄 代码迁移速查

### 插入数据

```javascript
// KV
await env.USERS_KV.put(key, JSON.stringify(data));

// D1
await env.DB.prepare('INSERT INTO users (...) VALUES (...)').bind(...).run();
```

### 查询数据

```javascript
// KV
const data = JSON.parse(await env.USERS_KV.get(key));

// D1
const data = await env.DB.prepare('SELECT * FROM users WHERE ...').bind(...).first();
```

### 更新数据

```javascript
// KV
const data = JSON.parse(await env.USERS_KV.get(key));
data.field = value;
await env.USERS_KV.put(key, JSON.stringify(data));

// D1
await env.DB.prepare('UPDATE users SET field = ? WHERE ...').bind(value, ...).run();
```

### 删除数据

```javascript
// KV
await env.USERS_KV.delete(key);

// D1
await env.DB.prepare('DELETE FROM users WHERE ...').bind(...).run();
```

## 🔍 调试技巧

### 查看表结构

```bash
wrangler d1 execute fabushi-db --command="PRAGMA table_info(users);" --remote
```

### 查看索引

```bash
wrangler d1 execute fabushi-db --command="SELECT * FROM sqlite_master WHERE type='index';" --remote
```

### 查看最近记录

```bash
wrangler d1 execute fabushi-db --command="SELECT * FROM users ORDER BY created_at DESC LIMIT 5;" --remote
```

## ⚠️ 注意事项

1. **备份优先**: 迁移前务必备份KV数据
2. **测试环境**: 先在开发环境测试
3. **监控性能**: 关注Cloudflare Dashboard
4. **保留KV**: 临时数据继续使用KV
5. **索引优化**: 为常用查询添加索引

## 🆘 紧急回滚

```bash
# 1. 恢复备份
cp worker-kv-backup.js worker.js

# 2. 重新部署
wrangler deploy

# 3. 验证
curl https://flutter.ombhrum.com/health
```

## 📞 获取帮助

- 文档: `D1_DEPLOYMENT_GUIDE.md`
- 邮箱: support@fabushi.com
- 日志: `wrangler tail`
