#!/bin/bash

# D1批量迁移快速启动脚本
# 用法: ./migrate-start.sh [production]

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  D1批量迁移 - 快速启动"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 检查环境
if [ "$1" = "production" ]; then
  ENV="生产环境"
  ENV_FLAG="--env=production"
else
  ENV="开发环境"
  ENV_FLAG=""
fi

echo "🎯 目标环境: $ENV"
echo ""

# 步骤1：生成批量迁移文件
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤 1/3: 生成批量迁移文件"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -d "migrations" ] && [ "$(ls -A migrations/*.sql 2>/dev/null)" ]; then
  echo "⚠️  检测到已存在的迁移文件"
  echo ""
  echo "选项："
  echo "  1) 使用现有文件（跳过生成）"
  echo "  2) 重新生成（覆盖现有文件）"
  echo "  3) 取消"
  echo ""
  read -p "请选择 [1-3]: " choice
  
  case $choice in
    1)
      echo "✓ 使用现有迁移文件"
      ;;
    2)
      echo "🔄 重新生成迁移文件..."
      rm -rf migrations
      node migrate-texts-batch.js
      ;;
    3)
      echo "❌ 已取消"
      exit 0
      ;;
    *)
      echo "❌ 无效选择"
      exit 1
      ;;
  esac
else
  echo "📝 生成迁移文件..."
  node migrate-texts-batch.js
fi

echo ""

# 步骤2：确认执行
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤 2/3: 确认执行"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 统计信息
BATCH_COUNT=$(ls -1 migrations/batch-*.sql 2>/dev/null | wc -l)
echo "📊 迁移统计:"
echo "   - 批次数量: $BATCH_COUNT"
echo "   - 目标环境: $ENV"
echo "   - 预计时间: $(($BATCH_COUNT * 7 / 60)) 分钟"
echo ""

echo "⚠️  警告:"
echo "   - 这将清空 text_contents 表的所有数据"
echo "   - 然后导入所有文本内容"
echo "   - 请确保已备份重要数据"
echo ""

read -p "确认执行？(yes/no): " confirm

if [ "$confirm" != "yes" ]; then
  echo "❌ 已取消"
  exit 0
fi

echo ""

# 步骤3：执行迁移
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "步骤 3/3: 执行迁移"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 执行迁移脚本
if [ -f "migrate-execute-all.sh" ]; then
  if [ "$1" = "production" ]; then
    ./migrate-execute-all.sh production
  else
    ./migrate-execute-all.sh
  fi
else
  echo "❌ 找不到执行脚本: migrate-execute-all.sh"
  exit 1
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ 迁移完成！"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📝 下一步:"
echo "   1. 验证数据: wrangler d1 execute fabushi-db $ENV_FLAG --command=\"SELECT category, COUNT(*) FROM text_contents GROUP BY category;\""
echo "   2. 测试搜索: curl \"http://localhost:8787/api/search?q=心经\""
echo "   3. 部署应用: wrangler deploy $ENV_FLAG"
echo ""
echo "📖 详细文档: D1_BATCH_MIGRATION_GUIDE.md"
echo ""
