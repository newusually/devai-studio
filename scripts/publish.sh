#!/usr/bin/env bash
# ============================================================================
#  scripts/publish.sh —— 一键发布到 GitHub（仓库 + 代码 + Release 安装包）
#
#  用法：
#    bash scripts/publish.sh <GITHUB_TOKEN>
#
#  做的事：
#    ① 用 token 登录 gh
#    ② 创建仓库 newusually/devai-studio（已存在则跳过）
#    ③ 推送 main 分支 + v1.0.0 tag
#    ④ 打 Release 并上传安装包
# ============================================================================
set -e

REPO="newusually/devai-studio"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GH="/c/Program Files/GitHub CLI/gh"

if [ -z "$1" ]; then
  echo "用法: bash scripts/publish.sh <GITHUB_TOKEN>"
  echo "  token 需具备 repo 权限: https://github.com/settings/tokens/new"
  exit 1
fi
TOKEN="$1"

cd "$ROOT"

echo "═══ ① 登录 GitHub ═══"
"$GH" auth login --hostname github.com --git-protocol https --with-token <<< "$TOKEN"

echo "═══ ② 创建仓库 ═══"
if "$GH" repo view "$REPO" >/dev/null 2>&1; then
  echo "    仓库已存在，跳过"
else
  "$GH" repo create "$REPO" \
    --public \
    --description "免费开源的本地 AI 编程助手 —— 对话式写代码、自动识别错误并修复、代码分析、多 Agent 协作、自动学习" \
    --homepage "https://github.com/$REPO" \
    --source . \
    --remote origin \
    --push
  echo "    ✓ 仓库已创建并推送"
fi

echo "═══ ③ 配置远程并推送 ═══"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$REPO.git"
git branch -M main

# 用 token 走 https（避免交互式密码提示）
AUTH_HEADER="Authorization: Basic $(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')"
git -c http.extraHeader="$AUTH_HEADER" push -u origin main
git -c http.extraHeader="$AUTH_HEADER" push origin --tags

echo "═══ ④ 创建 Release 并上传安装包 ═══"
if "$GH" release view v1.0.0 --repo "$REPO" >/dev/null 2>&1; then
  echo "    Release 已存在，删除重建"
  "$GH" release delete v1.0.0 --repo "$REPO" --yes
fi

"$GH" release create v1.0.0 \
  --repo "$REPO" \
  --title "DevAI Studio v1.0.0" \
  --notes-file release/RELEASE-NOTES.md \
  release/DevAI-Studio-Setup-1.0.0-x64.exe \
  release/latest.yml

echo ""
echo "════════════════════════════════════════"
echo "  ✓ 上传完成"
echo ""
echo "  仓库:   https://github.com/$REPO"
echo "  Release: https://github.com/$REPO/releases/tag/v1.0.0"
echo "════════════════════════════════════════"
