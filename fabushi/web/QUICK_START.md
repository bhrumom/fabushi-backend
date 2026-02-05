# 快速开始 - D1迁移

## 一键迁移 🚀

```bash
cd web
./migrate-now.sh
```

就这么简单！

## 详细步骤

### 1. 迁移数据（10-15分钟）

```bash
cd web

# 开发环境
./migrate-now.sh

# 生产环境
./migrate-now.sh production
```

### 2. 添加点赞表（5秒）

```bash
./migrate-add-likes.sh
```

### 3. 部署Worker（30秒）

```bash
wrangler deploy
```

### 4. 运行应用

```bash
cd ..
flutter run
```

## 验证

```bash
# 查看数据
wrangler d1 execute fabushi-db --command="SELECT category, COUNT(*) FROM text_contents GROUP BY category;"

# 测试搜索
curl "http://localhost:8787/api/search?q=心经"
```

## 预期结果

```
category        count
经文            4
咒语            3
乾隆大藏经      1778
```

## 故障排除

### 执行超时？
```javascript
// 编辑 migrate-direct-to-d1.js
const BATCH_SIZE = 5; // 减小批次
```

### 网络中断？
```bash
./migrate-now.sh  # 重新运行
```

### 数据不完整？
```bash
# 查看数量
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM text_contents;"

# 重新导入
./migrate-now.sh
```

## 后续更新

### 增量更新（推荐）
```bash
# 添加新文件后，只导入新文件
node migrate-incremental.js
```

### 完全重新导入
```bash
# 清空并重新导入所有文件
./migrate-now.sh
```

详见 [UPDATE_TEXTS.md](UPDATE_TEXTS.md)

## 文档

- 📖 [UPDATE_TEXTS.md](UPDATE_TEXTS.md) - 更新文本指南（新）
- 📖 [D1_DIRECT_MIGRATION.md](D1_DIRECT_MIGRATION.md) - 详细指南
- 📖 [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md) - 完整部署
- 📖 [D1_MIGRATION_COMPLETE.md](../D1_MIGRATION_COMPLETE.md) - 技术总结

---

**简单、快速、可靠！** ✨
