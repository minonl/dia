#!/usr/bin/env bash
# dia global install: copy CLI + dist + job package; never point at a worktree.
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIA_HOME="${DIA_HOME:-$HOME/.dia}"
DIA_BIN_DIR="${DIA_BIN_DIR:-$HOME/.local/bin}"
DRY=0; FORCE=0; MIGRATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --home) DIA_HOME="$2"; shift 2 ;;
    --bin) DIA_BIN_DIR="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --force) FORCE=1; shift ;;
    --migrate) MIGRATE=1; shift ;;
    -h|--help) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: install.sh [--home DIR] [--bin DIR] [--dry-run] [--force]" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
[ -f "$SRC/dist/cli.js" ] || { echo "缺 dist/cli.js；先跑 bun run build" >&2; exit 1; }
[ -f "$SRC/bin/dia.js" ] || { echo "缺 bin/dia.js" >&2; exit 1; }

run mkdir -p "$DIA_HOME/bin" "$DIA_HOME/dist" "$DIA_HOME/packages/job" "$DIA_HOME/packages/wt" "$DIA_HOME/registry" "$DIA_BIN_DIR"
run cp "$SRC/bin/dia.js" "$DIA_HOME/bin/dia.js"
run cp "$SRC/dist/cli.js" "$DIA_HOME/dist/cli.js"
run cp "$SRC/package.json" "$DIA_HOME/package.json"
run cp -R "$SRC/packages/job/bin" "$DIA_HOME/packages/job/"
run cp -R "$SRC/packages/job/lib" "$DIA_HOME/packages/job/"
run cp -R "$SRC/packages/wt/bin" "$DIA_HOME/packages/wt/"
if [ -f "$SRC/docs/platforms/registry.json" ]; then run cp "$SRC/docs/platforms/registry.json" "$DIA_HOME/registry/platforms.json"; fi
if [ -f "$SRC/docs/deps.jsonl" ]; then run cp "$SRC/docs/deps.jsonl" "$DIA_HOME/registry/deps.jsonl"; fi
run chmod +x "$DIA_HOME/packages/wt/bin/dia-wt"
run chmod +x "$DIA_HOME/bin/dia.js" "$DIA_HOME/packages/job/bin/dia-job"
run ln -sfn "$DIA_HOME/bin/dia.js" "$DIA_BIN_DIR/dia"
echo "dia installed: $DIA_HOME -> $DIA_BIN_DIR/dia"
