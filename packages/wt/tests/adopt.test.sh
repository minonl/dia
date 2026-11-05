#!/usr/bin/env bash
# adopt / doctor / gate 回归测试（2026-11-05）
# 覆盖：dry-run 计划、apply 幂等、check 通过、主 checkout 守卫、doctor、revert。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$HERE/../bin/dia-wt"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }; bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

R="$TD/repo"; mkdir -p "$R"; git -C "$R" init -q -b main
git -C "$R" config user.email t@example.com; git -C "$R" config user.name t
echo a > "$R/a.txt"; git -C "$R" add -A; git -C "$R" commit -qm init --no-verify

out="$(bash "$WT" adopt "$R" --json)"
printf '%s' "$out" | grep -q '"defaultBranch":"main"' && ok "dry-run 识别默认分支" || bad "dry-run: $out"
[ ! -f "$R/.git/dia/config.json" ] && ok "dry-run 不落盘" || bad "dry-run 落盘了"

bash "$WT" adopt "$R" --apply >/dev/null 2>&1 || bad "apply 失败"
[ -f "$R/.git/dia/config.json" ] && ok "config 已写" || bad "缺 config"
hp="$(git -C "$R" config --get core.hooksPath)"
case "$hp" in /*) ok "hooksPath 是绝对路径" ;; *) bad "hooksPath=$hp" ;; esac
[ -x "$R/.git/dia/hooks/pre-commit" ] && ok "pre-commit 可执行" || bad "缺 pre-commit"

md5_before="$(md5 -q "$R/.git/dia/config.json" 2>/dev/null || md5sum "$R/.git/dia/config.json" | cut -d' ' -f1)"
sleep 1
bash "$WT" adopt "$R" --apply >/dev/null 2>&1
md5_after="$(md5 -q "$R/.git/dia/config.json" 2>/dev/null || md5sum "$R/.git/dia/config.json" | cut -d' ' -f1)"
[ "$md5_before" != "$md5_after" ] && ok "重复 apply 会刷新时间戳（幂等语义：不重复建目录/钩子）" || bad "重复 apply 无变化"

bash "$WT" adopt "$R" --check >/dev/null 2>&1 && ok "check 通过" || bad "check 失败"
bash "$WT" doctor "$R" >/dev/null 2>&1 && ok "doctor 通过" || bad "doctor 失败"

echo b > "$R/b.txt"; git -C "$R" add b.txt
if git -C "$R" commit -qm should-block 2>/dev/null; then bad "主 checkout main 提交未被拦截"; else ok "主 checkout main 提交被拦截"; fi
git -C "$R" reset -q

bash "$WT" adopt "$R" --revert >/dev/null 2>&1 || bad "revert 失败"
[ -z "$(git -C "$R" config --get core.hooksPath || true)" ] && ok "revert 还原 hooksPath" || bad "revert 未还原"
[ ! -d "$R/.git/dia" ] && ok "revert 删除 dia 目录" || bad "dia 目录残留"

echo; echo "── PASS $PASS · FAIL $FAIL ──"
[ "$FAIL" = 0 ]
