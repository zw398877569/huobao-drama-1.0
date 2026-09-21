#!/usr/bin/env bash
# 一键安装 git hooks (pre-commit + pre-push)
# 已存在的 hook 文件会跳过 (避免覆盖用户手动装的 hook)
# Usage: bash scripts/install-hooks.sh

set -e

REPO=$(git rev-parse --show-toplevel)

if [ ! -d "$REPO/.githooks" ]; then
  echo "[error] .githooks/ 目录不存在, 不是项目根目录?"
  exit 1
fi

for hook in pre-commit pre-push; do
  src="$REPO/.githooks/$hook"
  dst="$REPO/.git/hooks/$hook"

  if [ ! -f "$src" ]; then
    echo "[skip] $src 不存在, 跳过"
    continue
  fi

  if [ -f "$dst" ]; then
    # 已存在 hook, 不覆盖
    echo "[skip] $dst 已存在 (避免覆盖), 如要重装先手动 rm $dst"
    continue
  fi

  cp "$src" "$dst"
  chmod +x "$dst"
  echo "[install] $dst"
done

echo ""
echo "✓ Hooks 已安装. pre-commit + pre-push 都生效."
echo "  override 方式: git commit/push 时加 --no-verify (绕过 hook)"
