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

# ── 原 hooksPath 保留 + 二次 apply 不改写 hooksPrevious（review P2-7）──────────
R2="$TD/repo2"; mkdir -p "$R2" "$TD/orighooks"; git -C "$R2" init -q -b main
git -C "$R2" config user.email t@example.com; git -C "$R2" config user.name t
echo a > "$R2/a.txt"; git -C "$R2" add -A; git -C "$R2" commit -qm init --no-verify
printf '#!/bin/sh\nexit 0\n' > "$TD/orighooks/pre-commit"; chmod +x "$TD/orighooks/pre-commit"
git -C "$R2" config --local core.hooksPath "$TD/orighooks"
bash "$WT" adopt "$R2" --apply >/dev/null 2>&1 || bad "R2 apply 失败"
hp1="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("hooksPrevious") or "")' "$R2/.git/dia/config.json")"
[ "$hp1" = "$TD/orighooks" ] && ok "首次 apply 记录 hooksPrevious" || bad "hooksPrevious=$hp1"
bash "$WT" adopt "$R2" --apply >/dev/null 2>&1
hp2="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("hooksPrevious") or "")' "$R2/.git/dia/config.json")"
[ "$hp2" = "$TD/orighooks" ] && ok "二次 apply 不覆盖 hooksPrevious" || bad "hooksPrevious 被改成 $hp2"
bash "$WT" adopt "$R2" --revert >/dev/null 2>&1 || bad "R2 revert 失败"
[ "$(git -C "$R2" config --get core.hooksPath)" = "$TD/orighooks" ] && ok "revert 还原原 hooksPath" || bad "revert 未还原原 hooksPath"
# hooksPath 被第三方改动 → revert 拒绝（不抢配置）
bash "$WT" adopt "$R2" --apply >/dev/null 2>&1
git -C "$R2" config --local core.hooksPath "$TD/orighooks"
if bash "$WT" adopt "$R2" --revert >/dev/null 2>&1; then bad "hooksPath 被改动后 revert 仍执行"; else ok "hooksPath 被改动后 revert 拒绝"; fi
[ -f "$R2/.git/dia/config.json" ] && ok "拒绝 revert 时保留 config 备份" || bad "拒绝 revert 却删了 config"
git -C "$R2" config --local core.hooksPath "$R2/.git/dia/hooks"; bash "$WT" adopt "$R2" --revert >/dev/null 2>&1

# ── 自定义默认分支受保护（review P1-1 + P1-2）────────────────────────────────
R3="$TD/repo3"; mkdir -p "$R3"; git -C "$R3" init -q -b trunk
git -C "$R3" config user.email t@example.com; git -C "$R3" config user.name t
echo a > "$R3/a.txt"; git -C "$R3" add -A; git -C "$R3" commit -qm init --no-verify
bash "$WT" adopt "$R3" --apply --default-branch trunk >/dev/null 2>&1 || bad "自定义分支 apply 失败"
bash "$WT" adopt "$R3" --check >/dev/null 2>&1 && ok "自定义默认分支 check 通过" || bad "自定义默认分支 check 失败"
bash "$WT" doctor "$R3" >/dev/null 2>&1 && ok "自定义默认分支 doctor 通过" || bad "自定义默认分支 doctor 失败"
echo b > "$R3/b.txt"; git -C "$R3" add b.txt
if git -C "$R3" commit -qm should-block 2>/dev/null; then bad "trunk 提交未被拦截"; else ok "自定义默认分支 trunk 提交被拦截"; fi
git -C "$R3" reset -q

# ── doctor：未 adopt / 无参数（review P1-4）──────────────────────────────────
bash "$WT" doctor "$R3" >/dev/null 2>&1 || true
R4="$TD/repo4"; mkdir -p "$R4"; git -C "$R4" init -q -b main
git -C "$R4" config user.email t@example.com; git -C "$R4" config user.name t
echo a > "$R4/a.txt"; git -C "$R4" add -A; git -C "$R4" commit -qm init --no-verify
if bash "$WT" doctor "$R4" >/dev/null 2>&1; then bad "未 adopt 的仓 doctor 误报通过"; else ok "未 adopt 的仓 doctor 失败"; fi
bash "$WT" doctor >/dev/null 2>&1; [ $? = 2 ] && ok "doctor 无参数 exit 2" || bad "doctor 无参数未 exit 2"

# ── pre-push 守卫（主 checkout 拒绝 / worktree 放行）──────────────────────────
R5="$TD/repo5"; ORIGIN5="$TD/origin5.git"; git init -q --bare "$ORIGIN5"
mkdir -p "$R5"; git -C "$R5" init -q -b main
git -C "$R5" config user.email t@example.com; git -C "$R5" config user.name t
echo a > "$R5/a.txt"; git -C "$R5" add -A; git -C "$R5" commit -qm init --no-verify
git -C "$R5" remote add origin "$ORIGIN5"; git -C "$R5" push -q --no-verify origin main
git -C "$R5" fetch -q origin
git -C "$R5" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
bash "$WT" adopt "$R5" --apply >/dev/null 2>&1 || bad "R5 apply 失败"
echo x >> "$R5/a.txt"; git -C "$R5" commit -qam dirty-main --no-verify 2>/dev/null
if git -C "$R5" push origin main >/dev/null 2>&1; then bad "主 checkout push 未被拦截"; else ok "主 checkout push 被拦截"; fi
git -C "$R5" reset -q --hard origin/main
git -C "$R5" worktree add -q -b feat/x "$TD/repo5-worktree--x" main
echo b > "$TD/repo5-worktree--x/b.txt"; git -C "$TD/repo5-worktree--x" add b.txt
git -C "$TD/repo5-worktree--x" commit -qm feat-x --no-verify 2>/dev/null
if git -C "$TD/repo5-worktree--x" push -q origin feat/x >/dev/null 2>&1; then ok "worktree push 放行"; else bad "worktree push 被误拦"; fi

# ── gate：成功 / 失败（P1-3 精确匹配）────────────────────────────────────────
bash "$WT" gate "$R5" x >/dev/null 2>&1 && ok "gate 成功" || bad "gate 失败"
if bash "$WT" gate "$R5" xb >/dev/null 2>&1; then bad "gate 子串误匹配（x 命中 xb）"; else ok "gate 精确匹配 feature"; fi
echo dirty >> "$TD/repo5-worktree--x/b.txt"
if bash "$WT" gate "$R5" x >/dev/null 2>&1; then bad "worktree 脏时 gate 通过"; else ok "worktree 脏时 gate 失败"; fi
git -C "$TD/repo5-worktree--x" checkout -q -- b.txt

echo; echo "── PASS $PASS · FAIL $FAIL ──"
[ "$FAIL" = 0 ]
