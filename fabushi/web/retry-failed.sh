#!/bin/bash

echo "🔄 重新上传失败的文件到D1..."
echo ""

cd "$(dirname "$0")"

node find-and-retry-failed.js

echo ""
echo "✅ 完成！"
