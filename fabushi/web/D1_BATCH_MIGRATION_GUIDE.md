# D1批量迁移指南

## 概述

本指南帮助你将部署在Cloudflare上的静态文本资源（1785个文件）批量迁移到D1数据库。

## 为什么需要迁移？

### 当前问题
- ❌ 静态文件分散在R2和本地
- ❌ 搜索需要下载多个文件
- ❌ 性能差，用户体验不好
- ❌ 无法实现高级搜索功能

### 迁移后优势
- ✅ 所有文本集中在D1数据库
- ✅ 使用FTS5全文搜索，速度提升10-100倍
- ✅ 支持分类、分页、排序
- ✅ 支持搜索结果预览和高亮
- ✅ 降低网络流量和存储成本

## 迁移步骤

### 第一步：准备工作

确保已安装Wrangler CLI：

```bash
npm install -g wrangler
wrangler login
```

### 第二步：生成批量迁移文件

```bash
cd web
node migrate-texts-batch.js
```

这将：
1. 扫描所有文本文件（经文、咒语、乾隆大藏经）
2. 生成多个批次SQL文件（每批50个文件）
3. 创建自动执行脚本
4. 生成详细的README文档

输出示例：
```
🚀 开始批量迁移准备...

📂 扫描文本文件...
✓ 找到 1785 个文本文件

📊 总共 1785 个文件需要迁移

📝 已处理: 100/1785 (6%)
📝 已处理: 200/1785 (11%)
...

📦 生成 36 个批次文件...

✓ batch-000.sql (50 条记录, 234KB)
✓ batch-001.sql (50 条记录, 245KB)
...

✅ 批量迁移文件生成完成！
```

### 第三步：执行迁移

#### 方式1：自动执行（推荐）

```bash
# 开发环境
./migrate-execute-all.sh

# 生产环境
./migrate-execute-all.sh production
```

脚本会：
1. 清空现有数据
2. 按顺序执行所有批次
3. 显示进度
4. 验证结果

#### 方式2：手动执行

如果自动脚本失败，可以手动执行：

```bash
# 1. 清空数据
wrangler d1 execute fabushi-db --command="DELETE FROM text_contents;"

# 2. 执行批次（逐个执行）
wrangler d1 execute fabushi-db --file=migrations/batch-000.sql
wrangler d1 execute fabushi-db --file=migrations/batch-001.sql
# ... 继续执行所有批次

# 或使用循环
for file in migrations/batch-*.sql; do
  echo "执行 $file..."
  wrangler d1 execute fabushi-db --file="$file"
done
```

### 第四步：验证数据

```bash
# 查看总数
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) as total FROM text_contents;"

# 按分类统计
wrangler d1 execute fabushi-db --command="SELECT category, COUNT(*) as count FROM text_contents GROUP BY category;"

# 测试搜索
wrangler d1 execute fabushi-db --command="SELECT title FROM text_contents WHERE title LIKE '%心经%' LIMIT 5;"

# 测试FTS5搜索
wrangler d1 execute fabushi-db --command="SELECT title FROM text_contents_fts WHERE text_contents_fts MATCH '心经' LIMIT 5;"
```

预期结果：
```
category        count
经文            4
咒语            3
乾隆大藏经      1778
```

### 第五步：更新Worker代码

迁移完成后，Worker会自动使用D1数据库进行搜索。无需修改代码。

### 第六步：测试搜索功能

```bash
# 启动本地测试
wrangler dev

# 在另一个终端测试
curl "http://localhost:8787/api/search?q=心经"
curl "http://localhost:8787/api/search?q=佛&category=经文"
curl "http://localhost:8787/api/search?q=大藏经&category=乾隆大藏经&limit=10"
```

### 第七步：部署到生产环境

```bash
# 部署Worker
wrangler deploy --env=production

# 测试生产环境
curl "https://flutter.ombhrum.com/api/search?q=心经"
```

## 文件结构

```
web/
├── migrate-texts-batch.js          # 批量迁移生成脚本
├── migrate-execute-all.sh          # 自动执行脚本
├── migrations/                     # 批次SQL文件目录
│   ├── README.md                   # 详细说明
│   ├── batch-000.sql               # 第1批
│   ├── batch-001.sql               # 第2批
│   ├── ...
│   └── batch-035.sql               # 第36批
└── D1_BATCH_MIGRATION_GUIDE.md     # 本文档
```

## 性能优化

### 批次大小
- 默认每批50个文件
- 每个SQL文件不超过900KB
- 可根据网络情况调整

### 执行时间
- 每批约5-10秒
- 总共约4-7分钟
- 建议在低峰期执行

### 并发执行
不建议并发执行，因为：
1. D1有并发限制
2. 可能导致数据不一致
3. 难以追踪错误

## 故障排除

### 问题1：执行超时

**症状**：某个批次执行超时

**解决**：
```bash
# 重新执行失败的批次
wrangler d1 execute fabushi-db --file=migrations/batch-XXX.sql
```

### 问题2：SQL语法错误

**症状**：提示SQL语法错误

**原因**：文件内容包含特殊字符

**解决**：
1. 检查错误的批次文件
2. 手动修复SQL转义
3. 重新执行该批次

### 问题3：数据重复

**症状**：某些文件被重复插入

**解决**：
```bash
# 清空并重新执行
wrangler d1 execute fabushi-db --command="DELETE FROM text_contents;"
./migrate-execute-all.sh
```

### 问题4：网络中断

**症状**：执行过程中网络中断

**解决**：
1. 检查已执行的批次
2. 从中断的批次继续执行
3. 不需要重新开始

```bash
# 查看当前数据量
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM text_contents;"

# 从特定批次继续
wrangler d1 execute fabushi-db --file=migrations/batch-015.sql
# 继续后续批次...
```

## 回滚方案

### 完全回滚

```bash
# 清空D1数据
wrangler d1 execute fabushi-db --command="DELETE FROM text_contents;"

# 恢复旧的搜索代码（如果需要）
git checkout HEAD~1 web/src/handlers/search.js
wrangler deploy
```

### 部分回滚

```bash
# 只删除特定分类
wrangler d1 execute fabushi-db --command="DELETE FROM text_contents WHERE category='乾隆大藏经';"

# 重新导入该分类
# 执行相关批次...
```

## 监控和维护

### 定期检查

```bash
# 每周检查数据完整性
wrangler d1 execute fabushi-db --command="
  SELECT 
    category,
    COUNT(*) as count,
    SUM(LENGTH(content)) as total_size
  FROM text_contents 
  GROUP BY category;
"
```

### 性能监控

在Worker中添加日志：

```javascript
console.time('d1-search');
const results = await env.DB.prepare(sql).bind(...params).all();
console.timeEnd('d1-search');
```

### 数据更新

添加新文本：

```bash
# 1. 将新文件放到 assets/built_in/ 目录
# 2. 重新生成迁移文件
node migrate-texts-batch.js

# 3. 只执行新增的批次
wrangler d1 execute fabushi-db --file=migrations/batch-036.sql
```

## 成本分析

### D1存储成本
- 前5GB免费
- 预计使用：约100MB
- 成本：$0/月

### D1查询成本
- 前500万次读取免费
- 预计使用：约10万次/月
- 成本：$0/月

### R2存储节省
- 减少静态文件存储
- 节省约50MB存储空间
- 节省约$0.015/月

### 总结
- ✅ 迁移后完全免费
- ✅ 性能大幅提升
- ✅ 用户体验更好

## 最佳实践

1. **备份数据**：迁移前导出现有数据
2. **测试环境**：先在开发环境测试
3. **分批执行**：不要一次性执行所有批次
4. **监控日志**：关注Wrangler输出
5. **验证结果**：每次迁移后验证数据
6. **文档记录**：记录迁移过程和问题

## 下一步

迁移完成后，可以：

1. **优化搜索**：实现搜索结果高亮
2. **添加功能**：搜索建议、热门搜索
3. **性能优化**：缓存热门查询
4. **用户体验**：搜索历史、收藏功能
5. **数据分析**：统计搜索热词

## 参考文档

- [D1_SEARCH_MIGRATION.md](D1_SEARCH_MIGRATION.md) - D1搜索功能详细说明
- [schema.sql](schema.sql) - 数据库Schema
- [migrations/README.md](migrations/README.md) - 批次文件说明

---

**准备好了吗？开始迁移吧！** 🚀

```bash
cd web
node migrate-texts-batch.js
./migrate-execute-all.sh
```
