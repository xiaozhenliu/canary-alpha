#!/usr/bin/env bash
# cleanup-screenpipe.sh
# 安全清理 Screenpipe 后台进程与历史数据
# - 不直接 rm -rf；把数据 mv 到 macOS 回收站（~/.Trash），仍可在 Finder 还原
# - 每个破坏性步骤都有明确的二次确认
# - 不主动卸载 .app 或 brew formula，只清后台进程和数据

set -euo pipefail

YEL='\033[0;33m'; GRN='\033[0;32m'; RED='\033[0;31m'; CYA='\033[0;36m'; OFF='\033[0m'

confirm() {
  local prompt="$1" ans
  printf "%b" "${YEL}${prompt} [y/N]: ${OFF}"
  read -r ans
  ans="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
  [ "$ans" = "y" ] || [ "$ans" = "yes" ]
}

step() { echo -e "\n${CYA}==> $*${OFF}"; }
ok()   { echo -e "${GRN}✓ $*${OFF}"; }
warn() { echo -e "${YEL}! $*${OFF}"; }
err()  { echo -e "${RED}✗ $*${OFF}"; }

# -----------------------------------------------------------------------------
# 1. 探测 Screenpipe 进程
# -----------------------------------------------------------------------------
step "1/5 检查 screenpipe 相关进程"
PIDS="$(pgrep -af 'screenpipe|screen-pipe' || true)"
if [[ -z "$PIDS" ]]; then
  ok "未发现 screenpipe 进程"
else
  echo "$PIDS"
fi

# 顺带看一下 launchctl / brew services
step "查 launchctl / brew services 中的注册项"
launchctl list 2>/dev/null | grep -i screenpipe || warn "launchctl 中无 screenpipe"
if command -v brew >/dev/null 2>&1; then
  brew services list 2>/dev/null | grep -i screenpipe || warn "brew services 中无 screenpipe"
fi

# -----------------------------------------------------------------------------
# 2. 停止后台进程
# -----------------------------------------------------------------------------
if [[ -n "$PIDS" ]]; then
  step "2/5 停止 screenpipe 进程"
  if confirm "确认要给上面这些进程发 SIGTERM 吗？"; then
    pkill -TERM -f screenpipe || true
    sleep 2
    REMAIN="$(pgrep -af 'screenpipe|screen-pipe' || true)"
    if [[ -n "$REMAIN" ]]; then
      warn "仍有进程残留："
      echo "$REMAIN"
      if confirm "用 SIGKILL 强制终止？"; then
        pkill -KILL -f screenpipe || true
        sleep 1
      fi
    fi
    ok "进程已处理"
  else
    warn "跳过停进程"
  fi
else
  step "2/5 无活动进程，跳过"
fi

# 如果是 brew services 装的，提醒手动停
if command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -qi screenpipe; then
  warn "screenpipe 在 brew services 中注册，建议执行：brew services stop screenpipe"
fi

# -----------------------------------------------------------------------------
# 3. 列出可能的数据目录与体积
# -----------------------------------------------------------------------------
step "3/5 扫描 screenpipe 数据目录"
CANDIDATES=(
  "$HOME/.screenpipe"
  "$HOME/Library/Application Support/screenpipe"
  "$HOME/Library/Application Support/Screenpipe"
  "$HOME/Library/Caches/screenpipe"
  "$HOME/Library/Logs/screenpipe"
)

FOUND=()
for p in "${CANDIDATES[@]}"; do
  if [[ -e "$p" ]]; then
    SIZE="$(du -sh "$p" 2>/dev/null | awk '{print $1}')"
    echo "  - $p  (${SIZE})"
    FOUND+=("$p")
  fi
done

if [[ ${#FOUND[@]} -eq 0 ]]; then
  ok "未发现任何 screenpipe 数据目录，已清理完毕"
  exit 0
fi

# -----------------------------------------------------------------------------
# 4. 移到回收站（不是删除）
# -----------------------------------------------------------------------------
step "4/5 把上面这些目录移动到回收站（可恢复）"
if ! confirm "确认把以上目录全部移到 ~/.Trash？"; then
  warn "已取消，未做改动"
  exit 0
fi

TS="$(date +%Y%m%d-%H%M%S)"
TRASH="$HOME/.Trash"
mkdir -p "$TRASH"

for p in "${FOUND[@]}"; do
  base="$(basename "$p")"
  dest="$TRASH/${base}.screenpipe-cleanup-${TS}"
  echo "  mv \"$p\" → \"$dest\""
  mv "$p" "$dest"
done
ok "已移入回收站"

# -----------------------------------------------------------------------------
# 5. 收尾确认
# -----------------------------------------------------------------------------
step "5/5 复检"
for p in "${CANDIDATES[@]}"; do
  if [[ -e "$p" ]]; then
    err "仍存在：$p"
  fi
done
ok "完成。如确认无误，可在 Finder 中清空回收站；若想恢复，从回收站还原即可。"
