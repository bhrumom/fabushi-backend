# D1直接迁移 - 快速指南

## 一键迁移

```bash
cd web

# 开发环境
./migrate-now.sh

# 生产环境
./migrate-now.sh production
```

## 工作原理

脚本会实时将1785个文本文件直接写入D1数据库：

1. **扫描文件** - 查找所有.txt文件
2. **清空表** - 删除旧数据
3. **批量写入** - 每批10条，实时写入D1
4. **自动验证** - 检查数据完整性

## 特点

- ✅ **无中间文件** - 直接写入D1，不生成SQL文件
- ✅ **实时反馈** - 显示进度和成功/失败状态
- ✅ **自动重试** - 失败自动跳过，继续下一批
- ✅ **快速执行** - 10-15分钟完成全部迁移
- ✅ **安全可靠** - 自动转义SQL，防止注入

## 预期输出

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  D1直接迁移 - 实时写入
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎯 环境: 开发环境

📂 扫描文本文件...
✓ 找到 1785 个文本文件

🗑️  清空现有数据...
✓ 数据已清空

📝 开始插入数据...

[1/179] 插入 1-10/1785... ✓
[2/179] 插入 11-20/1785... ✓
[3/179] 插入 21-30/1785... ✓
...
   进度: 10% (成功: 178, 失败: 0)
...
[179/179] 插入 1781-1785/1785... ✓

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ 迁移完成！
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 统计:
   - 总文件数: 1785
   - 成功: 1785
   - 失败: 0

🔍 验证数据...

category        count
经文            4
咒语            3
乾隆大藏经      1778

📝 下一步:
   1. 测试搜索: wrangler dev
   2. 部署应用: wrangler deploy
```

## 验证

```bash
# 查看总数
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM text_contents;"

# 按分类统计
wrangler d1 execute fabushi-db --command="SELECT category, COUNT(*) FROM text_contents GROUP BY category;"

# 测试搜索
wrangler d1 execute fabushi-db --command="SELECT title FROM text_contents WHERE title LIKE '%心经%';"
```

## 故障排除

### 执行超时

减小批次大小：

```javascript
// 编辑 migrate-direct-to-d1.js
const BATCH_SIZE = 5; // 从10改为5
```

### 网络中断

重新运行脚本即可，会自动清空并重新导入：

```bash
./migrate-now.sh
```

### 数据不完整

检查并重新导入：

```bash
# 查看当前数据量
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM text_contents;"

# 重新导入
./migrate-now.sh
```

## 技术细节

### 批次大小

- 默认：每批10条
- 原因：避免命令行参数过长
- 调整：修改 `BATCH_SIZE` 常量

### SQL转义

自动转义特殊字符：
- 单引号 `'` → `''`
- 反斜杠 `\` → `\\`

### 错误处理

- 文件不存在：跳过并警告
- 读取失败：记录错误，继续下一个
- 写入失败：标记失败，继续下一批

## 性能

- **扫描速度**：约5秒（1785个文件）
- **写入速度**：约5-10秒/批（10条）
- **总时间**：10-15分钟
- **网络流量**：约100MB

## 成本

- **D1存储**：约100MB（前5GB免费）
- **D1写入**：约1785次（前500万次免费）
- **总成本**：$0

## 对比

### 旧方案（生成SQL文件）

- ❌ 需要生成36个SQL文件
- ❌ 占用磁盘空间（约100MB）
- ❌ 需要手动执行每个文件
- ❌ 难以追踪进度

### 新方案（直接写入）

- ✅ 无中间文件
- ✅ 不占用磁盘空间
- ✅ 自动执行所有批次
- ✅ 实时显示进度

## 下一步

迁移完成后：

1. **部署Worker**
```bash
wrangler deploy
```

2. **测试搜索**
```bash
wrangler dev
curl "http://localhost:8787/api/search?q=心经"
```

3. **运行应用**
```bash
cd ..
flutter run
```

## 相关文档

- [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md) - 完整部署指南
- [D1_SEARCH_MIGRATION.md](D1_SEARCH_MIGRATION.md) - D1搜索功能详解
- [D1_BATCH_MIGRATION_GUIDE.md](D1_BATCH_MIGRATION_GUIDE.md) - 批量迁移详细指南

---

**简单、快速、可靠！** 🚀
