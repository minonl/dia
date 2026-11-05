#!/usr/bin/env bash
# dia global install: stable path + job package discoverable; no repo/worktree link.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }; bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }
out="$(DIA_INSTALL_DIR="$TD/home" DIA_BIN_DIR="$TD/bin" bash "$ROOT/install.sh" 2>&1)"; rc=$?
[ "$rc" = 0 ] || { echo "$out" | tail -5; bad "install 失败 rc=$rc"; }
[ -x "$TD/bin/dia" ] && ok "dia 链接可执行" || bad "缺 dia"
[ "$(readlink "$TD/bin/dia")" = "$TD/home/bin/dia.js" ] && ok "链接指向全局目录" || bad "链接目标错"
out="$("$TD/bin/dia" version 2>&1)"; printf '%s' "$out" | grep -q '^dia ' && ok "dia version" || bad "version: $out"
out="$(DIA_JOB_ROOT="$TD/root" "$TD/bin/dia" job platform 2>&1)"; printf '%s' "$out" | grep -qE '^(macos|linux)$' && ok "dia job 找到包" || bad "job: $out"
[ -f "$TD/home/kits/dia-msg/dia.json" ] && ok "默认 dia-msg kit 随安装分发" || bad "缺 kits/dia-msg"
# idempotent
DIA_HOME="$TD/home" DIA_BIN_DIR="$TD/bin" bash "$ROOT/install.sh" >/dev/null 2>&1 && ok "重复安装 rc=0" || bad "重复安装失败"
echo; echo "── PASS $PASS · FAIL $FAIL ──"; [ "$FAIL" = 0 ]
