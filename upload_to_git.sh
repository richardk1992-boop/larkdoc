#!/bin/bash

# 飞书文档插件 Git 上传脚本

set -e

echo "🚀 开始上传到 GitHub..."

# 设置目录
SOURCE_DIR="/Users/bytedance/Documents/larkdoccc"
REPO_URL="https://github.com/richardk1992-boop/larkdoc.git"
UPLOAD_DIR="$SOURCE_DIR/upload-temp"

# 清理并克隆仓库
echo "📥 正在克隆仓库..."
rm -rf "$UPLOAD_DIR"
git clone "$REPO_URL" "$UPLOAD_DIR"
cd "$UPLOAD_DIR"

# 复制文件
echo "📄 正在复制文件..."
cp "$SOURCE_DIR/popup.html" .
cp "$SOURCE_DIR/popup.js" .
cp "$SOURCE_DIR/popup.css" .
cp "$SOURCE_DIR/background.js" .
cp "$SOURCE_DIR/content.js" .
cp "$SOURCE_DIR/manifest.json" .
cp "$SOURCE_DIR/callback.html" .
cp "$SOURCE_DIR/GET_TOKEN_GUIDE.md" .

# 查看状态
echo ""
echo "📊 Git 状态："
git status

# 提交
echo ""
echo "💾 正在提交..."
git add .
git commit -m "Add manual token input feature and token guide

- Add UI to manually input user_access_token
- Skip OAuth flow by directly setting access token
- Verify token validity by fetching user info
- Support both feishu.cn and larksuite.com regions
- Add GET_TOKEN_GUIDE.md with detailed token extraction methods

Co-Authored-By: Claude <noreply@anthropic.com>"

# 推送
echo ""
echo "📤 正在推送到 GitHub..."
git push origin main

echo ""
echo "✅ 上传完成！"
echo "🔗 仓库地址: https://github.com/richardk1992-boop/forlark"
