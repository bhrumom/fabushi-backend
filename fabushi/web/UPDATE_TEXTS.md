# 更新文本内容指南

## 方式1：增量更新（推荐）⭐

只添加新文件，不影响现有数据。

### 单个文件
```bash
wrangler d1 execute fabushi-db --command="
INSERT INTO text_contents (title, content, file_path, category) 
VALUES ('新经文标题', '经文内容...', 'assets/built_in/经文/新经文.txt', '经文');
"
```

### 批量添加
```bash
# 1. 将新文件放到 assets/built_in/ 目录
# 2. 创建增量脚本
node migrate-incremental.js

# 3. 执行增量更新
wrangler d1 execute fabushi-db --file=incremental-update.sql
```

## 方式2：更新单个文件

```bash
wrangler d1 execute fabushi-db --command="
UPDATE text_contents 
SET content = '更新后的内容', title = '新标题'
WHERE file_path = 'assets/built_in/经文/般若波罗蜜多心经.txt';
"
```

## 方式3：完全重新导入

适合大量更新或重构时使用。

```bash
# 重新执行迁移（会清空并重新导入所有数据）
./migrate-now.sh
```

⚠️ **注意**：会清空 `text_contents` 表的所有数据

## 增量更新脚本

创建 `web/migrate-incremental.js`：

```javascript
#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 获取已存在的文件路径
const existingPaths = new Set([
  'assets/built_in/经文/般若波罗蜜多心经.txt',
  // ... 从数据库查询获取
]);

// 扫描新文件
function scanNewFiles() {
  const newFiles = [];
  // 扫描逻辑...
  return newFiles.filter(f => !existingPaths.has(f.path));
}

// 生成增量SQL
const newFiles = scanNewFiles();
const sql = newFiles.map(f => 
  `INSERT INTO text_contents (title, content, file_path, category) VALUES (...);`
).join('\n');

fs.writeFileSync('incremental-update.sql', sql);
console.log(`✓ 生成 ${newFiles.length} 个新文件的SQL`);
```

## 最佳实践

### 日常更新（推荐）
1. 添加新文件到 `assets/built_in/`
2. 使用增量更新脚本
3. 只导入新文件

### 大版本更新
1. 备份现有数据
2. 执行完全重新导入
3. 验证数据完整性

### 修复错误
1. 使用 UPDATE 语句修改单个文件
2. 或重新导入该文件

## 备份数据

```bash
# 导出现有数据
wrangler d1 execute fabushi-db --command="SELECT * FROM text_contents;" > backup.json

# 恢复时重新导入
./migrate-now.sh
```

## 查询现有文件

```bash
# 查看所有文件路径
wrangler d1 execute fabushi-db --command="SELECT file_path FROM text_contents ORDER BY category, title;"

# 查看特定分类
wrangler d1 execute fabushi-db --command="SELECT file_path FROM text_contents WHERE category='经文';"
```

## 总结

| 场景 | 推荐方式 | 影响范围 |
|------|---------|---------|
| 添加新文件 | 增量更新 | 只添加新数据 |
| 修改单个文件 | UPDATE语句 | 只影响该文件 |
| 大量更新 | 完全重新导入 | 清空并重新导入 |
| 修复错误 | UPDATE或重新导入 | 按需选择 |

---

**建议：日常使用增量更新，大版本使用完全重新导入** ✨
