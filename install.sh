#!/usr/bin/env bash
# dia global install: 安装物（bin/dist/packages/registry）与数据根（~/.dia）分离
#
#   DIA_INSTALL_DIR  安装目录，默认 ~/.local/share/dia（可用 --home 覆盖）
#   DIA_ROOT         数据根，默认 ~/.dia（由 dia 代码解析，本脚本只在 --migrate 时搬旧根）
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIA_INSTALL_DIR="${DIA_INSTALL_DIR:-${DIA_HOME_INSTALL:-$HOME/.local/share/dia}}"
DIA_BIN_DIR="${DIA_BIN_DIR:-$HOME/.local/bin}"
DATA_ROOT="${DIA_ROOT:-$HOME/.dia}"
OLD_DATA="${OLD_DIA_HOME:-$HOME/.local/share/dia}"
DRY=0; MIGRATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --home|--install-dir) DIA_INSTALL_DIR="$2"; shift 2 ;;
    --bin) DIA_BIN_DIR="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --migrate) MIGRATE=1; shift ;;
    --force) echo "note: --force 已废弃（安装是覆盖式）" >&2; shift ;;
    -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: install.sh [--home DIR] [--bin DIR] [--dry-run] [--migrate]" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
[ -f "$SRC/dist/cli.js" ] || { echo "缺 dist/cli.js；先跑 bun run build" >&2; exit 1; }
[ -f "$SRC/bin/dia.js" ] || { echo "缺 bin/dia.js" >&2; exit 1; }

# 旧数据根迁移：只搬**数据子目录**，不碰安装物（bin/dist/packages/registry）
DATA_SUBDIRS="personas msg agents state cache job runs audit tasks ingest runtime eval backups"
if [ -d "$OLD_DATA/personas" ] && [ ! -d "$DATA_ROOT/personas" ]; then
  if [ "$MIGRATE" = 1 ]; then
    echo "迁移旧数据：$OLD_DATA/{$DATA_SUBDIRS} → $DATA_ROOT"
    run mkdir -p "$DATA_ROOT"
    for d in $DATA_SUBDIRS; do
      [ -e "$OLD_DATA/$d" ] && run mv "$OLD_DATA/$d" "$DATA_ROOT/"
    done
    echo "（安装物仍在 $OLD_DATA：bin/dist/packages/registry）"
  else
    echo "! 检测到旧数据根 $OLD_DATA；迁移数据：bash install.sh --migrate（只搬数据，不搬安装物）" >&2
  fi
fi

# 安装物：始终写 DIA_INSTALL_DIR，与数据根解耦
run mkdir -p "$DIA_INSTALL_DIR/bin" "$DIA_INSTALL_DIR/dist" "$DIA_INSTALL_DIR/packages/job" "$DIA_INSTALL_DIR/packages/wt" "$DIA_INSTALL_DIR/kits" "$DIA_INSTALL_DIR/registry" "$DIA_BIN_DIR"
run cp "$SRC/bin/dia.js" "$DIA_INSTALL_DIR/bin/dia.js"
run cp "$SRC/dist/cli.js" "$DIA_INSTALL_DIR/dist/cli.js"
run cp "$SRC/package.json" "$DIA_INSTALL_DIR/package.json"
run cp -R "$SRC/kits/dia-msg" "$DIA_INSTALL_DIR/kits/"
run cp -R "$SRC/packages/job/bin" "$DIA_INSTALL_DIR/packages/job/"
run cp -R "$SRC/packages/job/lib" "$DIA_INSTALL_DIR/packages/job/"
run cp -R "$SRC/packages/wt/bin" "$DIA_INSTALL_DIR/packages/wt/"
if [ -f "$SRC/docs/platforms/registry.json" ]; then run cp "$SRC/docs/platforms/registry.json" "$DIA_INSTALL_DIR/registry/platforms.json"; fi
if [ -f "$SRC/docs/deps.jsonl" ]; then run cp "$SRC/docs/deps.jsonl" "$DIA_INSTALL_DIR/registry/deps.jsonl"; fi
run chmod +x "$DIA_INSTALL_DIR/packages/wt/bin/dia-wt"
run chmod +x "$DIA_INSTALL_DIR/bin/dia.js" "$DIA_INSTALL_DIR/packages/job/bin/dia-job"
# 记录来源：`dia update` 据此判断「脚本安装」并给出正确升级方式
run node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({tool:"dia",source:process.argv[2],installedAt:new Date().toISOString()},null,1)+"\n")' "$DIA_INSTALL_DIR/install.json" "$SRC"
run ln -sfn "$DIA_INSTALL_DIR/bin/dia.js" "$DIA_BIN_DIR/dia"
echo "dia installed: ${DIA_INSTALL_DIR}（安装物）；data root: ${DATA_ROOT}（数据）-> $DIA_BIN_DIR/dia"
