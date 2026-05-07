#!/bin/bash
# 部署模块化后端 Worker 脚本

set -e

echo "🚀 开始部署模块化后端 Worker（旧项目，保留 secrets）"

# 部署
echo "📦 开始部署..."
wrangler deploy --env production

echo "✨ 部署完成！"
echo ""
echo "📝 验证步骤："
echo "1. 测试健康检查: curl https://api.ombhrum.com/health"
echo "2. 测试登录功能"
echo "3. 测试订单创建"
