#!/bin/bash
# 部署模块化Worker脚本

set -e

echo "🚀 开始部署模块化Worker"

# 备份原worker.js
if [ -f "worker.js" ]; then
    BACKUP_FILE="worker-backup-$(date +%Y%m%d-%H%M%S).js"
    cp worker.js "$BACKUP_FILE"
    echo "✅ 已备份原worker.js到 $BACKUP_FILE"
fi

# 使用完整模块化版本
cp worker-complete.js worker.js
echo "✅ 已切换到模块化版本"

# 部署
echo "📦 开始部署..."
wrangler deploy --env production

echo "✨ 部署完成！"
echo ""
echo "📝 验证步骤："
echo "1. 测试健康检查: curl https://flutter.ombhrum.com/health"
echo "2. 测试登录功能"
echo "3. 测试订单创建"
echo ""
echo "🔙 如需回滚:"
echo "   cp $BACKUP_FILE worker.js"
echo "   wrangler deploy --env production"
