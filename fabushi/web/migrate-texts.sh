#!/bin/bash

# D1搜索功能迁移脚本
# 自动化执行所有迁移步骤

set -e

# 检查环境参数
ENV="${1:-dev}"
if [ "$ENV" = "production" ] || [ "$ENV" = "prod" ]; then
    ENV_FLAG="--env=production"
    echo "🚀 开始D1搜索功能迁移（生产环境）..."
else
    ENV_FLAG=""
    echo "🚀 开始D1搜索功能迁移（开发环境）..."
fi
echo ""

# 检查Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未找到Node.js，请先安装Node.js"
    exit 1
fi

# 检查wrangler
if ! command -v wrangler &> /dev/null; then
    echo "❌ 错误: 未找到wrangler，请先安装: npm install -g wrangler"
    exit 1
fi

# 步骤1: 更新Schema
echo "📝 步骤1: 更新数据库Schema..."
wrangler d1 execute fabushi-db --file=schema.sql $ENV_FLAG
echo "✅ Schema更新完成"
echo ""

# 步骤2: 生成迁移SQL
echo "📝 步骤2: 生成迁移SQL..."
node migrate-texts-to-d1.js
if [ ! -f "migrate-texts.sql" ]; then
    echo "❌ 错误: 未能生成migrate-texts.sql"
    exit 1
fi
echo "✅ SQL文件生成完成"
echo ""

# 步骤3: 执行数据迁移
echo "📝 步骤3: 执行数据迁移..."
wrangler d1 execute fabushi-db --file=migrate-texts.sql $ENV_FLAG
echo "✅ 数据迁移完成"
echo ""

# 步骤4: 验证数据
echo "📝 步骤4: 验证数据..."
echo "分类统计:"
wrangler d1 execute fabushi-db --command="SELECT category, COUNT(*) as count FROM text_contents GROUP BY category" $ENV_FLAG
echo ""
echo "总文本数:"
wrangler d1 execute fabushi-db --command="SELECT COUNT(*) as total FROM text_contents" $ENV_FLAG
echo ""

# 步骤5: 测试搜索
echo "📝 步骤5: 测试搜索功能..."
echo "搜索'心经':"
wrangler d1 execute fabushi-db --command="SELECT title, category FROM text_contents WHERE title LIKE '%心经%' LIMIT 3" $ENV_FLAG
echo ""

echo "✅ 迁移完成！"
echo ""
if [ "$ENV" = "production" ] || [ "$ENV" = "prod" ]; then
    echo "下一步:"
    echo "  1. 测试搜索: ./test-d1-search.sh https://flutter.ombhrum.com"
    echo "  2. 监控日志: wrangler tail --env=production"
else
    echo "下一步:"
    echo "  1. 运行 'wrangler dev' 启动本地测试"
    echo "  2. 测试搜索: ./test-d1-search.sh"
    echo "  3. 确认无误后部署: wrangler deploy"
    echo ""
    echo "生产环境迁移:"
    echo "  ./migrate-texts.sh production"
fi
