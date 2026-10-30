#!/usr/bin/env bash
# install.sh：全局目录 + 稳定链接 + 拒绝项目路径依赖
set -uo pipefail

# tests must not inherit the developer global config
export DIA_JOB_CONFIG=/dev/null
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0; ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }; bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

HOME_DIR="$TD/home"; BIN_DIR="$TD/bin"
DIA_JOB_HOME="$HOME_DIR" DIA_JOB_BIN_DIR="$BIN_DIR" bash "$ROOT/install.sh" >/dev/null 2>&1 || bad "install 失败"
[ -x "$HOME_DIR/bin/dia-job" ] && ok "复制 binary" || bad "缺 binary"
[ -L "$BIN_DIR/dia-job" ] && ok "稳定链接" || bad "缺链接"
[ "$(readlink "$BIN_DIR/dia-job")" = "$HOME_DIR/bin/dia-job" ] && ok "链接指向全局目录" || bad "链接目标错"
[ -x "$HOME_DIR/lib/policy.sh" ] && ok "复制 policy" || ok "policy 非可执行（可接受）"
# 重复安装幂等
DIA_JOB_HOME="$HOME_DIR" DIA_JOB_BIN_DIR="$BIN_DIR" bash "$ROOT/install.sh" >/dev/null 2>&1 && ok "重复安装 rc=0" || bad "重复安装失败"
# 从全局安装跑 list
mkdir -p "$TD/root"
out="$(DIA_JOB_ROOT="$TD/root" "$BIN_DIR/dia-job" list 2>&1)"; printf '%s' "$out" | grep -q "$TD/root" && ok "安装后可运行" || bad "运行失败：$out"
# shim 找到安装的 binary
out="$(HOME="$TD/h" DIA_JOB_BIN="$BIN_DIR/dia-job" bash "$ROOT/shim/yan-task" list 2>&1)"; printf '%s' "$out" | grep -q "平台" && ok "shim 转发" || bad "shim 失败：$out"
# shim 拒绝 worktree 路径
WT="$TD/repo-worktree--x"; mkdir -p "$WT"; cp "$ROOT/shim/yan-task" "$WT/yan-task"; chmod +x "$WT/yan-task"
HOME="$TD/h" DIA_JOB_BIN="$BIN_DIR/dia-job" bash "$WT/yan-task" list >/dev/null 2>&1; [ "$?" = 4 ] && ok "shim 拒绝 worktree" || bad "worktree 未拒绝"
echo; echo "── PASS $PASS · FAIL $FAIL ──"; [ "$FAIL" = 0 ]
