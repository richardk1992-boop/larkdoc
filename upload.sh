#!/bin/bash
# 飞书文档读取器 - Git 上传脚本

set -e

echo "🚀 开始上传到 GitHub..."

SOURCE_DIR="/Users/bytedance/Documents/larkdoccc"
REPO_URL="https://github.com/richardk1992-boop/forlark.git"
UPLOAD_DIR="$SOURCE_DIR/upload-temp"

echo "📥 正在克隆仓库..."
rm -rf "$UPLOAD_DIR"
git clone "$REPO_URL" "$UPLOAD_DIR"
cd "$UPLOAD_DIR"

echo "📄 正在复制文件..."
cp "$SOURCE_DIR/popup.html" .
cp "$SOURCE_DIR/popup.js" .
cp "$SOURCE_DIR/background.js" .
cp "$SOURCE_DIR/content.js" .
cp "$SOURCE_DIR/manifest.json" .
cp "$SOURCE_DIR/callback.html" .

echo ""
echo "📊 Git 状态："
git status

echo ""
echo "💾 正在提交..."
git add .
git commit -m "Feature: Add Wiki document support

Wiki documents require special handling:

**Problem:**
- Wiki URL contains node_token, not the real document ID
- Cannot use node_token directly with docs API
- Returns 1770002 (document not found) error

**Solution:**
1. Detect Wiki documents by URL (/wiki/)
2. Extract space_id from URL
3. Call Wiki API: GET /wiki/v2/spaces/{space_id}/nodes/{node_token}
4. Get obj_token (real document token) from response
5. Use obj_token with docs API: GET /docs/v1/content?doc_token={obj_token}

**API Flow for Wiki:**
```
Wiki URL node_token
  ↓
Wiki API (/wiki/v2/spaces/{space_id}/nodes/{node_token})
  ↓
obj_token (real document token)
  ↓
Docs API (/docs/v1/content?doc_token={obj_token})
  ↓
Markdown content
```

**Wiki API Reference:**
- Get Wiki node: https://open.larkoffice.com/document/server-docs/docs/wiki-v2/space-node/get_node
- Returns: obj_token, obj_type, title, etc.

Co-Authored-By: Claude <noreply@anthropic.com>"

echo ""
echo "📤 正在推送到 GitHub..."
git push origin main

echo ""
echo "✅ 上传完成！"
echo ""
echo "📦 下一步："
echo "1. 等待 Zeabur 自动部署"
echo "2. 在 Chrome 中重新加载扩展"
echo "3. 测试获取 Wiki 文档"
