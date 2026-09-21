#!/usr/bin/env bash
# install-cron-monitoring.sh — 一键给 4 个 launchd 任务装上 task-runner.sh 包装
# 用法: bash install-cron-monitoring.sh
#
# 会做:
#   1. 备份 4 个 plist 为 .bak-20260921-task-runner
#   2. 在每个 plist 的 ProgramArguments 数组前面插入 wrapper 调用
#   3. launchctl unload + load 让改动生效
#   4. 检查 ~/bin/task-runner.sh 是否存在且可执行
#
# 回滚: launchctl unload + cp .bak-20260921-task-runner *.plist + launchctl load

set -euo pipefail

SRC="$HOME/Library/LaunchAgents"
BAK_SUFFIX="bak-20260921-task-runner"
RUNNER="$HOME/bin/task-runner.sh"

# (plist_filename, task_name)
TARGETS=(
  "com.user.dailylearn.plist:dailylearn"
  "com.user.minimaxlearn.plist:minimaxlearn"
  "com.user.videounderstand.plist:videounderstand"
  "com.aicg.research.daily-hot-list.plist:daily-hot-list"
)

# 1. 检查 wrapper
echo "=== 检查 wrapper 脚本 ==="
if [ ! -f "$RUNNER" ]; then
  echo "ERROR: $RUNNER 不存在 — 请先确认 huobao 代码改动已部署, wrapper 脚本由 Codex 写入"
  exit 1
fi
if [ ! -x "$RUNNER" ]; then
  echo "WARN: $RUNNER 不可执行, 加 chmod +x ..."
  chmod +x "$RUNNER"
fi
ls -la "$RUNNER"
echo

# 2. 备份 + 改 plist
echo "=== 备份并修改 4 个 plist ==="
for entry in "${TARGETS[@]}"; do
  IFS=':' read -r plist name <<< "$entry"
  p="$SRC/$plist"
  bak="$p.$BAK_SUFFIX"

  if [ ! -f "$p" ]; then
    echo "SKIP: $plist (not found)"
    continue
  fi

  # 备份
  if [ ! -f "$bak" ]; then
    cp "$p" "$bak"
    echo "  backup: $bak"
  else
    echo "  backup exists, skip: $bak"
  fi

  # 检查是否已经打过 patch (有 'task-runner.sh' 字样)
  if grep -q 'task-runner.sh' "$p"; then
    echo "  already patched: $plist"
    continue
  fi

  # 用 python3 做精确替换, 避免 sed 在 plist 上多行匹配不稳
  PLIST="$p" NAME="$name" python3 <<'PYEOF'
import re, sys, os
p = os.environ['PLIST']
name = os.environ['NAME']
with open(p, 'r', encoding='utf-8') as f:
    text = f.read()
m = re.search(r'(<key>ProgramArguments</key>\s*<array>)(.*?)(</array>)', text, re.DOTALL)
if not m:
    print(f"  WARN: ProgramArguments not found in {p}")
    sys.exit(0)
prefix, inner, suffix = m.group(1), m.group(2), m.group(3)
runner = os.path.expanduser('~/bin/task-runner.sh')
insertion = (
    '        <string>/bin/bash</string>\n'
    f'        <string>{runner}</string>\n'
    f'        <string>{name}</string>\n'
    '        <string>--</string>\n'
)
new_inner = insertion + inner
new_text = text[:m.start()] + prefix + new_inner + suffix + text[m.end():]
with open(p, 'w', encoding='utf-8') as f:
    f.write(new_text)
print(f"  patched: {p}")
PYEOF
done

echo

# 3. 校验
echo "=== 校验 (grep task-runner.sh) ==="
for entry in "${TARGETS[@]}"; do
  IFS=':' read -r plist name <<< "$entry"
  if grep -q 'task-runner.sh' "$SRC/$plist" 2>/dev/null; then
    echo "  ✓ $plist"
  else
    echo "  ✗ $plist (未修改)"
  fi
done

echo
echo "=== 4. reload launchd ==="
for entry in "${TARGETS[@]}"; do
  IFS=':' read -r plist name <<< "$entry"
  label="${plist%.plist}"
  # unload 先 (忽略已加载报错), 再 load
  launchctl unload "$SRC/$plist" 2>/dev/null || true
  if launchctl load "$SRC/$plist" 2>&1; then
    echo "  ✓ loaded: $label"
  else
    echo "  ✗ load failed: $label (可能 plist 格式错)"
  fi
done

echo
echo "=== 完成 ==="
echo "  wrapper 脚本: $RUNNER"
echo "  plist 备份:  *.plist.$BAK_SUFFIX"
echo "  监控页面:    http://localhost:5679/tasks"
echo
echo "  立即试跑一个 (手动触发):"
echo "    launchctl kickstart -k gui/\$(id -u)/com.user.dailylearn"
