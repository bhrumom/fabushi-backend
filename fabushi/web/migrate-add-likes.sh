#!/bin/bash

# 添加点赞表到现有D1数据库

echo "🚀 添加点赞表到D1数据库..."

# 执行SQL（添加到现有数据库）
wrangler d1 execute fabushi-db --file=./schema-likes.sql

echo "✅ 完成！"
echo ""
echo "📊 验证："
wrangler d1 execute fabushi-db --command="SELECT name FROM sqlite_master WHERE type='table' AND name='content_likes';"
