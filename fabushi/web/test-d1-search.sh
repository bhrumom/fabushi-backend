#!/bin/bash

# D1搜索功能测试脚本

BASE_URL="${1:-http://localhost:8787}"

echo "🧪 测试D1搜索功能"
echo "服务器: $BASE_URL"
echo ""

# 测试1: 基础搜索
echo "📝 测试1: 基础搜索 - 搜索'心经'"
curl -s "$BASE_URL/api/search?q=心经" | jq '.total, .results[0].title'
echo ""

# 测试2: 分类筛选
echo "📝 测试2: 分类筛选 - 搜索'佛'（仅经文）"
curl -s "$BASE_URL/api/search?q=佛&category=经文" | jq '.total, .category'
echo ""

# 测试3: 分页
echo "📝 测试3: 分页 - 每页5条"
curl -s "$BASE_URL/api/search?q=佛&limit=5&offset=0" | jq '.total, .limit, .results | length'
echo ""

# 测试4: 获取分类列表
echo "📝 测试4: 获取分类列表"
curl -s "$BASE_URL/api/search/categories" | jq '.categories'
echo ""

# 测试5: 获取内容
echo "📝 测试5: 获取内容"
curl -s "$BASE_URL/api/search/content?path=assets/built_in/经文/般若波罗蜜多心经.txt" | jq '.title, .category'
echo ""

# 测试6: 空查询
echo "📝 测试6: 空查询"
curl -s "$BASE_URL/api/search?q=" | jq '.total'
echo ""

# 测试7: 不存在的内容
echo "📝 测试7: 不存在的内容"
curl -s "$BASE_URL/api/search?q=不存在的内容xyz123" | jq '.total'
echo ""

echo "✅ 测试完成"
