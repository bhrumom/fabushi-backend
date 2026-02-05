# D1搜索快速开始

## 一键迁移

```bash
cd web
./migrate-texts.sh
```

## 手动步骤

### 1. 更新Schema
```bash
wrangler d1 execute fabushi-db --file=schema.sql
```

### 2. 生成并导入数据
```bash
node migrate-texts-to-d1.js
wrangler d1 execute fabushi-db --file=migrate-texts.sql
```

### 3. 测试
```bash
# 启动本地服务
wrangler dev

# 另一个终端测试
./test-d1-search.sh
```

### 4. 部署
```bash
wrangler deploy
```

## API使用

### 搜索
```bash
# 基础搜索
curl "https://flutter.ombhrum.com/api/search?q=心经"

# 分类筛选
curl "https://flutter.ombhrum.com/api/search?q=佛&category=经文"

# 分页
curl "https://flutter.ombhrum.com/api/search?q=佛&limit=10&offset=0"
```

### 获取内容
```bash
curl "https://flutter.ombhrum.com/api/search/content?path=assets/built_in/经文/般若波罗蜜多心经.txt"
```

### 获取分类
```bash
curl "https://flutter.ombhrum.com/api/search/categories"
```

## 性能对比

| 指标 | 旧方案（文件系统） | 新方案（D1+FTS5） |
|------|-------------------|------------------|
| 搜索速度 | 2-5秒 | 50-200ms |
| 内存占用 | 高 | 低 |
| 并发支持 | 差 | 优秀 |
| 分页支持 | ❌ | ✅ |
| 分类筛选 | ❌ | ✅ |
| 全文搜索 | ❌ | ✅ |

## 故障排除

### 数据未导入
```bash
# 检查数据
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM text_contents"
```

### 搜索无结果
```bash
# 检查FTS索引
wrangler d1 execute fabushi-db --command="SELECT * FROM text_contents_fts LIMIT 1"
```

### 重建索引
```bash
wrangler d1 execute fabushi-db --command="INSERT INTO text_contents_fts(text_contents_fts) VALUES('rebuild')"
```

## 生产环境

```bash
# 迁移
wrangler d1 execute fabushi-db --file=schema.sql --env=production
wrangler d1 execute fabushi-db --file=migrate-texts.sql --env=production

# 部署
wrangler deploy --env=production

# 测试
./test-d1-search.sh https://flutter.ombhrum.com
```
