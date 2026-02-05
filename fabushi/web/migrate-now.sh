#!/bin/bash

# D1直接迁移 - 一键执行
# 用法: ./migrate-now.sh [production]

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  D1直接迁移 - 实时写入"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$1" = "production" ]; then
  echo "🎯 环境: 生产环境"
  node migrate-direct-to-d1.js production
else
  echo "🎯 环境: 开发环境"
  node migrate-direct-to-d1.js
fi
