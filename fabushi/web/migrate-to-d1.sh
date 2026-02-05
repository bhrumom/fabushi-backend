#!/bin/bash

# KV到D1迁移脚本
# 使用方法: ./migrate-to-d1.sh [production|development]

set -e

ENV=${1:-development}
echo "🚀 开始迁移到D1数据库 (环境: $ENV)"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查wrangler是否安装
if ! command -v wrangler &> /dev/null; then
    echo -e "${RED}❌ 错误: wrangler未安装${NC}"
    echo "请运行: npm install -g wrangler"
    exit 1
fi

# 步骤1: 创建D1数据库
echo -e "\n${YELLOW}📦 步骤1: 创建D1数据库${NC}"
if [ "$ENV" = "production" ]; then
    DB_NAME="fabushi-db"
else
    DB_NAME="fabushi-db-dev"
fi

echo "数据库名称: $DB_NAME"
read -p "是否创建新数据库? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    wrangler d1 create $DB_NAME
    echo -e "${GREEN}✅ 数据库创建成功${NC}"
    echo -e "${YELLOW}⚠️  请将返回的database_id更新到wrangler.toml中${NC}"
    read -p "按Enter继续..."
fi

# 步骤2: 初始化Schema
echo -e "\n${YELLOW}📋 步骤2: 初始化数据库Schema${NC}"
if [ "$ENV" = "production" ]; then
    wrangler d1 execute $DB_NAME --file=schema.sql --remote
else
    wrangler d1 execute $DB_NAME --file=schema.sql --local
fi
echo -e "${GREEN}✅ Schema初始化完成${NC}"

# 步骤3: 验证表结构
echo -e "\n${YELLOW}🔍 步骤3: 验证表结构${NC}"
if [ "$ENV" = "production" ]; then
    wrangler d1 execute $DB_NAME --command="SELECT name FROM sqlite_master WHERE type='table';" --remote
else
    wrangler d1 execute $DB_NAME --command="SELECT name FROM sqlite_master WHERE type='table';" --local
fi

# 步骤4: 备份当前worker
echo -e "\n${YELLOW}💾 步骤4: 备份当前worker.js${NC}"
if [ -f "worker.js" ]; then
    BACKUP_FILE="worker-kv-backup-$(date +%Y%m%d-%H%M%S).js"
    cp worker.js "$BACKUP_FILE"
    echo -e "${GREEN}✅ 备份完成: $BACKUP_FILE${NC}"
fi

# 步骤5: 数据迁移
echo -e "\n${YELLOW}🔄 步骤5: 数据迁移${NC}"
echo "准备部署迁移脚本..."

# 临时使用迁移脚本
cp worker.js worker-original.js
cp migrate-kv-to-d1.js worker.js

echo "部署迁移worker..."
if [ "$ENV" = "production" ]; then
    wrangler deploy --env production
else
    wrangler deploy --env development
fi

echo -e "${YELLOW}⏳ 等待5秒让部署生效...${NC}"
sleep 5

# 执行迁移
echo "开始数据迁移..."
if [ "$ENV" = "production" ]; then
    MIGRATE_URL="https://flutter.ombhrum.com/migrate-data"
else
    MIGRATE_URL="http://localhost:8787/migrate-data"
fi

echo "访问迁移端点: $MIGRATE_URL"
MIGRATE_RESULT=$(curl -s "$MIGRATE_URL")
echo "$MIGRATE_RESULT" | jq '.'

# 恢复原始worker
cp worker-original.js worker.js
rm worker-original.js

echo -e "${GREEN}✅ 数据迁移完成${NC}"

# 步骤6: 验证迁移结果
echo -e "\n${YELLOW}✔️  步骤6: 验证迁移结果${NC}"

echo "检查用户数量..."
if [ "$ENV" = "production" ]; then
    USER_COUNT=$(wrangler d1 execute $DB_NAME --command="SELECT COUNT(*) as count FROM users;" --remote --json | jq '.[0].results[0].count')
    ORDER_COUNT=$(wrangler d1 execute $DB_NAME --command="SELECT COUNT(*) as count FROM orders;" --remote --json | jq '.[0].results[0].count')
    CODE_COUNT=$(wrangler d1 execute $DB_NAME --command="SELECT COUNT(*) as count FROM redeem_codes;" --remote --json | jq '.[0].results[0].count')
else
    USER_COUNT=$(wrangler d1 execute $DB_NAME --command="SELECT COUNT(*) as count FROM users;" --local --json | jq '.[0].results[0].count')
    ORDER_COUNT=$(wrangler d1 execute $DB_NAME --command="SELECT COUNT(*) as count FROM orders;" --local --json | jq '.[0].results[0].count')
    CODE_COUNT=$(wrangler d1 execute $DB_NAME --command="SELECT COUNT(*) as count FROM redeem_codes;" --local --json | jq '.[0].results[0].count')
fi

echo -e "用户数量: ${GREEN}$USER_COUNT${NC}"
echo -e "订单数量: ${GREEN}$ORDER_COUNT${NC}"
echo -e "兑换码数量: ${GREEN}$CODE_COUNT${NC}"

# 步骤7: 切换到D1版本
echo -e "\n${YELLOW}🔀 步骤7: 切换到D1版本${NC}"
read -p "是否切换到D1版本的worker? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    cp worker-d1.js worker.js
    echo "部署D1版本..."
    if [ "$ENV" = "production" ]; then
        wrangler deploy --env production
    else
        wrangler deploy --env development
    fi
    echo -e "${GREEN}✅ 已切换到D1版本${NC}"
fi

# 步骤8: 功能测试
echo -e "\n${YELLOW}🧪 步骤8: 功能测试${NC}"
echo "请手动测试以下功能:"
echo "1. 用户注册"
echo "2. 用户登录"
echo "3. 获取用户信息"
echo "4. 创建订单"
echo "5. 使用兑换码"
echo "6. 查看购买记录"
echo "7. 查看兑换记录"

# 完成
echo -e "\n${GREEN}🎉 迁移完成!${NC}"
echo -e "\n${YELLOW}后续步骤:${NC}"
echo "1. 测试所有功能确保正常工作"
echo "2. 监控Cloudflare Dashboard中的D1性能"
echo "3. 30天后清理KV中的历史数据"
echo "4. 定期备份D1数据库"

echo -e "\n${YELLOW}回滚方案:${NC}"
echo "如果出现问题，运行以下命令回滚:"
echo "  cp $BACKUP_FILE worker.js"
echo "  wrangler deploy"

echo -e "\n${GREEN}✨ 祝使用愉快!${NC}"
