# D1搜索迁移检查清单

## 迁移前准备

### 环境检查
- [ ] 已安装 Node.js (v16+)
- [ ] 已安装 wrangler CLI
- [ ] 已登录 Cloudflare 账号
- [ ] 已配置 D1 数据库

### 备份检查
- [ ] 备份现有代码
- [ ] 备份 wrangler.toml
- [ ] 记录当前搜索API行为

### 文件检查
- [ ] 确认所有txt文件存在
- [ ] 确认文件编码为UTF-8
- [ ] 确认文件路径正确

## 迁移步骤

### 第一步：更新Schema
```bash
wrangler d1 execute fabushi-db --file=schema.sql
```

- [ ] Schema更新成功
- [ ] 表创建成功
- [ ] 索引创建成功
- [ ] FTS5虚拟表创建成功
- [ ] 触发器创建成功

**验证**:
```bash
wrangler d1 execute fabushi-db --command="SELECT name FROM sqlite_master WHERE type='table'"
```

预期输出：包含 `text_contents` 和 `text_contents_fts`

### 第二步：生成迁移SQL
```bash
node migrate-texts-to-d1.js
```

- [ ] 脚本执行成功
- [ ] 生成 migrate-texts.sql
- [ ] 文件大小合理（>10KB）
- [ ] 检查SQL语法正确

**验证**:
```bash
ls -lh migrate-texts.sql
head -20 migrate-texts.sql
```

### 第三步：执行数据迁移
```bash
wrangler d1 execute fabushi-db --file=migrate-texts.sql
```

- [ ] 数据导入成功
- [ ] 无SQL错误
- [ ] 导入记录数正确

**验证**:
```bash
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) as total FROM text_contents"
wrangler d1 execute fabushi-db --command="SELECT category, COUNT(*) as count FROM text_contents GROUP BY category"
```

预期输出：
- 总数 > 0
- 分类统计正确（经文、咒语等）

### 第四步：测试搜索功能
```bash
wrangler dev
```

在另一个终端：
```bash
./test-d1-search.sh
```

- [ ] 基础搜索正常
- [ ] 分类筛选正常
- [ ] 分页查询正常
- [ ] 获取内容正常
- [ ] 获取分类正常
- [ ] 空查询处理正常
- [ ] 错误处理正常

### 第五步：性能测试
```bash
# 使用ab进行压力测试
ab -n 100 -c 10 "http://localhost:8787/api/search?q=心经"
```

- [ ] 响应时间 < 500ms
- [ ] 无错误响应
- [ ] 并发处理正常

### 第六步：部署到生产
```bash
wrangler deploy --env=production
```

- [ ] 部署成功
- [ ] 无部署错误
- [ ] 服务正常运行

**验证**:
```bash
curl "https://flutter.ombhrum.com/api/search?q=心经"
```

## 迁移后验证

### 功能验证
- [ ] 搜索功能正常
- [ ] 分类筛选正常
- [ ] 分页功能正常
- [ ] 内容获取正常
- [ ] 分类列表正常

### 性能验证
- [ ] 搜索速度 < 500ms
- [ ] 内存占用正常
- [ ] CPU使用率正常
- [ ] 并发处理正常

### 数据验证
```bash
# 检查数据完整性
wrangler d1 execute fabushi-db --command="SELECT title FROM text_contents WHERE title LIKE '%心经%'"
wrangler d1 execute fabushi-db --command="SELECT category, COUNT(*) FROM text_contents GROUP BY category"
```

- [ ] 所有文本都已导入
- [ ] 分类统计正确
- [ ] 内容完整无损

### 用户体验验证
- [ ] 搜索响应快速
- [ ] 结果准确
- [ ] 预览显示正常
- [ ] 排序合理

## 回滚准备

### 回滚条件
如果出现以下情况，考虑回滚：
- [ ] 搜索功能完全失效
- [ ] 性能严重下降
- [ ] 数据丢失或损坏
- [ ] 用户投诉增加

### 回滚步骤
```bash
# 1. 恢复旧代码
git checkout HEAD~5 web/src/handlers/search.js
git checkout HEAD~5 web/src/router.js

# 2. 重新部署
wrangler deploy --env=production

# 3. 验证
curl "https://flutter.ombhrum.com/api/search?q=心经"
```

- [ ] 旧代码恢复成功
- [ ] 部署成功
- [ ] 功能正常

## 监控设置

### 日志监控
```bash
wrangler tail --env=production
```

- [ ] 设置日志监控
- [ ] 关注错误日志
- [ ] 关注性能日志

### 性能监控
- [ ] 设置响应时间告警（>1s）
- [ ] 设置错误率告警（>1%）
- [ ] 设置CPU使用率告警（>80%）

### 数据监控
```bash
# 定期检查数据
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) FROM text_contents"
```

- [ ] 设置数据完整性检查
- [ ] 定期备份数据库

## 文档更新

- [ ] 更新API文档
- [ ] 更新README.md
- [ ] 更新维护文档
- [ ] 通知团队成员

## 清理工作

### 代码清理
- [ ] 删除旧的搜索代码（可选）
- [ ] 删除未使用的文件
- [ ] 更新注释

### 文件清理
- [ ] 删除临时文件
- [ ] 归档备份文件
- [ ] 整理文档

## 完成确认

### 最终检查
- [ ] 所有测试通过
- [ ] 性能达标
- [ ] 文档完整
- [ ] 团队知晓

### 签字确认
- [ ] 开发人员确认
- [ ] 测试人员确认
- [ ] 产品经理确认

## 时间线

| 阶段 | 预计时间 | 实际时间 | 状态 |
|------|---------|---------|------|
| 准备 | 15分钟 | | ⏳ |
| Schema更新 | 5分钟 | | ⏳ |
| 数据迁移 | 10分钟 | | ⏳ |
| 测试验证 | 20分钟 | | ⏳ |
| 部署上线 | 10分钟 | | ⏳ |
| 监控观察 | 1小时 | | ⏳ |
| **总计** | **1小时** | | ⏳ |

## 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 数据迁移失败 | 低 | 高 | 提前备份，可回滚 |
| 性能不达标 | 低 | 中 | 已测试，有优化方案 |
| 功能缺失 | 低 | 中 | 功能对等，已验证 |
| 用户投诉 | 低 | 低 | 性能提升，体验更好 |

## 联系方式

如遇问题，联系：
- 技术支持: tech@example.com
- 紧急联系: +86 xxx xxxx xxxx

## 附录

### 有用的命令

```bash
# 查看D1数据库列表
wrangler d1 list

# 查看表结构
wrangler d1 execute fabushi-db --command="PRAGMA table_info(text_contents)"

# 查看索引
wrangler d1 execute fabushi-db --command="PRAGMA index_list(text_contents)"

# 查看FTS配置
wrangler d1 execute fabushi-db --command="SELECT * FROM text_contents_fts_config"

# 重建FTS索引
wrangler d1 execute fabushi-db --command="INSERT INTO text_contents_fts(text_contents_fts) VALUES('rebuild')"

# 优化数据库
wrangler d1 execute fabushi-db --command="VACUUM"

# 分析查询性能
wrangler d1 execute fabushi-db --command="EXPLAIN QUERY PLAN SELECT * FROM text_contents WHERE title LIKE '%心经%'"
```

### 参考文档
- [D1文档](https://developers.cloudflare.com/d1/)
- [FTS5文档](https://www.sqlite.org/fts5.html)
- [迁移指南](./D1_SEARCH_MIGRATION.md)
- [快速开始](./D1_SEARCH_QUICK_START.md)

---

**版本**: v1.0  
**日期**: 2024-01-XX  
**状态**: 待执行

✅ 准备好了吗？运行 `./migrate-texts.sh` 开始迁移！
