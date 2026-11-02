#!/usr/bin/env bash
# dia-job 安装：复制到全局目录 + 建稳定 CLI 链接；不依赖任何项目 checkout。
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${DIA_JOB_HOME:-$HOME/.local/share/dia-job}"
BIN_DIR="${DIA_JOB_BIN_DIR:-$HOME/.local/bin}"
DRY=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_DIR="$2"; shift 2 ;;
    --bin) BIN_DIR="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: install.sh [--home DIR] [--bin DIR] [--force] [--dry-run]" >&2; exit 2 ;;
  esac
done

run() { if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
for f in bin/dia-job lib/config.sh lib/policy.sh lib/json.mjs; do
  [ -f "$SRC/$f" ] || { echo "缺文件：$SRC/$f" >&2; exit 1; }
done
run mkdir -p "$HOME_DIR/bin" "$HOME_DIR/lib" "$BIN_DIR" "${XDG_CONFIG_HOME:-$HOME/.config}/dia-job"
for f in bin/dia-job lib/config.sh lib/policy.sh lib/json.mjs; do
  run cp "$SRC/$f" "$HOME_DIR/$f"
done
run chmod +x "$HOME_DIR/bin/dia-job"
run ln -sfn "$HOME_DIR/bin/dia-job" "$BIN_DIR/dia-job"

# 配置示例：只在不存在时提示，不覆盖真实配置
CFG="${XDG_CONFIG_HOME:-$HOME/.config}/dia-job/config"
if [ ! -f "$CFG" ]; then
  if [ "$DRY" = 1 ]; then echo "[dry-run] 可创建 ${CFG}（示例见 $SRC/config.example）"; else
    printf '# dia-job global config; see %s/config.example\n' "$SRC" > "$CFG"
  fi
fi
echo "dia-job installed: $HOME_DIR/bin/dia-job -> $BIN_DIR/dia-job"
