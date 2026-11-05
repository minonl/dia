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

# ── 推送前敏感扫描（PII/凭据形态）──
BR="$TD/remote.git"; git init -q --bare "$BR"
git -C "$R" remote add origin "$BR" 2>/dev/null || true
git -C "$R" push -q --no-verify -u origin main 2>/dev/null || true
git -C "$R" worktree add -q "$TD/wt" -b feat/scan 2>/dev/null || true
echo "/Users/alice/secret" > "$TD/wt/bad.txt"
git -C "$TD/wt" add -A && git -C "$TD/wt" commit -qm bad --no-verify
if git -C "$TD/wt" push -q origin feat/scan 2>/dev/null; then bad "敏感推送未被拦截"; else ok "敏感推送被拦截"; fi
echo ok > "$TD/wt/bad.txt" && git -C "$TD/wt" add -A && git -C "$TD/wt" commit -qm fix --no-verify
git -C "$TD/wt" push -q origin feat/scan 2>/dev/null && ok "干净推送放行" || bad "干净推送被拒"

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

# ── template 生效（P2-6）：adopt 后 create 按 config.template 推导路径 ─────────
out="$(bash "$WT" create "$R5" t1 --dry-run 2>&1 || true)"
printf '%s' "$out" | grep -q "repo5-worktree--t1" && ok "默认模板 create 路径" || bad "默认模板 create: $out"
bash "$WT" adopt "$R5" --apply --template '{{parent}}/{{repo}}.wt.{{feature}}' >/dev/null 2>&1 || bad "template apply 失败"
out="$(bash "$WT" create "$R5" t1 --dry-run 2>&1 || true)"
printf '%s' "$out" | grep -q "repo5.wt.t1" && ok "自定义模板 create 路径生效" || bad "自定义模板: $out"
bash "$WT" adopt "$R5" --apply >/dev/null 2>&1

# ── 过期 origin/HEAD（远端分支已删）不误判默认分支 ──────────────────────────
R6="$TD/repo6"; mkdir -p "$R6"; git -C "$R6" init -q -b main
git -C "$R6" config user.email t@example.com; git -C "$R6" config user.name t
echo a > "$R6/a.txt"; git -C "$R6" add -A; git -C "$R6" commit -qm init --no-verify
git -C "$R6" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/gone
out="$(bash "$WT" adopt "$R6" --json)"
printf '%s' "$out" | grep -q '"defaultBranch":"main"' && ok "过期 origin/HEAD 回落到 main" || bad "过期 origin/HEAD: $out"

# ── 钩子链：原 hooksPath（.githooks / husky）不被吞掉 ─────────────────────────
R7="$TD/repo7"; mkdir -p "$R7/.githooks"; git -C "$R7" init -q -b main
git -C "$R7" config user.email t@example.com; git -C "$R7" config user.name t
printf '#!/bin/sh\necho chained >> "$(git rev-parse --show-toplevel)/chain.log"\n' > "$R7/.githooks/pre-commit"
chmod +x "$R7/.githooks/pre-commit"
echo a > "$R7/a.txt"; git -C "$R7" add -A; git -C "$R7" commit -qm init --no-verify
git -C "$R7" config --local core.hooksPath .githooks
bash "$WT" adopt "$R7" --apply >/dev/null 2>&1 || bad "R7 apply 失败"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d.get("hooksChain")==".githooks" else 1)' "$R7/.git/dia/config.json" \
  && ok "config 记录 hooksChain" || bad "hooksChain 未记录"
git -C "$R7" worktree add -q -b feat/y "$TD/repo7-worktree--y" main
echo b > "$TD/repo7-worktree--y/b.txt"; git -C "$TD/repo7-worktree--y" add b.txt
git -C "$TD/repo7-worktree--y" commit -qm feat-y >/dev/null 2>&1
[ -f "$TD/repo7-worktree--y/chain.log" ] && ok "原 pre-commit 被链式执行" || bad "原 pre-commit 未执行（钩子被吞）"
bash "$WT" adopt "$R7" --revert >/dev/null 2>&1
[ "$(git -C "$R7" config --get core.hooksPath)" = ".githooks" ] && ok "revert 还原原 hooksPath（相对）" || bad "revert 未还原 .githooks"

# ── adopt --all：批量主 checkout，跳过 worktree 目录 ─────────────────────────
AR="$TD/allroot"; mkdir -p "$AR/a" "$AR/b"
for r in a b; do
  git -C "$AR/$r" init -q -b main
  git -C "$AR/$r" config user.email t@example.com; git -C "$AR/$r" config user.name t
  echo x > "$AR/$r/x.txt"; git -C "$AR/$r" add -A; git -C "$AR/$r" commit -qm init --no-verify
done
git -C "$AR/a" worktree add -q -b feat/w "$AR/a-worktree--w" main
out="$(DIA_WT_REPOS_ROOT="$AR" DIA_WT_DATA_ROOT="$TD/dr2" bash "$WT" adopt --all --apply --json 2>&1)"
printf '%s' "$out" | grep -q '"repos":2,"ok":2,"fail":0' && ok "adopt --all 覆盖 2 个主 checkout" || bad "adopt --all: $out"
for r in a b; do
  [ -n "$(git -C "$AR/$r" config --get core.hooksPath || true)" ] && ok "adopt --all: $r 已配 hooksPath" || bad "adopt --all: $r 未配置"
done
[ ! -d "$AR/a-worktree--w/.git/dia" ] && ok "adopt --all 跳过 worktree 目录" || bad "adopt --all 误改 worktree"
DIA_WT_REPOS_ROOT="$TD/empty-root" DIA_WT_DATA_ROOT="$TD/dr3" bash "$WT" adopt --all >/dev/null 2>&1
[ $? = 2 ] && ok "adopt --all 空结果 exit 2" || bad "adopt --all 空结果未 exit 2"

# ── doctor --fix：钩子被覆盖后能无损重建 ────────────────────────────────────
R8="$TD/repo8"; mkdir -p "$R8"; git -C "$R8" init -q -b main
git -C "$R8" config user.email t@example.com; git -C "$R8" config user.name t
echo a > "$R8/a.txt"; git -C "$R8" add -A; git -C "$R8" commit -qm init --no-verify
bash "$WT" adopt "$R8" --apply >/dev/null 2>&1
rm -f "$R8/.git/dia/hooks/post-checkout"
printf '#!/bin/sh\nexit 0\n' > "$R8/.git/dia/hooks/pre-commit"; chmod +x "$R8/.git/dia/hooks/pre-commit"
if bash "$WT" doctor "$R8" >/dev/null 2>&1; then bad "钩子被覆盖后 doctor 仍通过"; else ok "钩子被覆盖后 doctor 报失败"; fi
bash "$WT" doctor "$R8" --fix >/dev/null 2>&1 || bad "doctor --fix 失败"
bash "$WT" doctor "$R8" >/dev/null 2>&1 && ok "doctor --fix 后恢复 ok" || bad "doctor --fix 后仍失败"
[ -x "$R8/.git/dia/hooks/post-checkout" ] && ok "doctor --fix 补回 post-checkout" || bad "post-checkout 未补回"

# ── gate：成功 / 失败（P1-3 精确匹配）────────────────────────────────────────
bash "$WT" gate "$R5" x >/dev/null 2>&1 && ok "gate 成功" || bad "gate 失败"
if bash "$WT" gate "$R5" xb >/dev/null 2>&1; then bad "gate 子串误匹配（x 命中 xb）"; else ok "gate 精确匹配 feature"; fi
echo dirty >> "$TD/repo5-worktree--x/b.txt"
if bash "$WT" gate "$R5" x >/dev/null 2>&1; then bad "worktree 脏时 gate 通过"; else ok "worktree 脏时 gate 失败"; fi
git -C "$TD/repo5-worktree--x" checkout -q -- b.txt

echo; echo "── PASS $PASS · FAIL $FAIL ──"
[ "$FAIL" = 0 ]
