#!/usr/bin/env bash
# adopt / doctor / gate 回归测试（2026-11-06：本机全局钩子模型）
# 覆盖：dry-run、apply(全局钩子)、check/doctor、主 checkout 守卫、链式调用仓库钩子、
#       非 adopt 仓透传、敏感扫描、adopt --all、gate、revert。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$HERE/../bin/dia-wt"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }; bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# 隔离：HOME / 全局 git 配置 / 数据根，避免污染真实机器
export HOME="$TD/home"; mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL="$TD/gitconfig"; : > "$GIT_CONFIG_GLOBAL"
export GIT_CONFIG_NOSYSTEM=1
export DIA_WT_DATA_ROOT="$TD/data"
GH="$TD/data/hooks"

R="$TD/repo"; mkdir -p "$R"; git -C "$R" init -q -b main
git -C "$R" config user.email t@example.com; git -C "$R" config user.name t
echo a > "$R/a.txt"; git -C "$R" add -A; git -C "$R" commit -qm init

out="$(bash "$WT" adopt "$R" --json)"
printf '%s' "$out" | grep -q '"defaultBranch":"main"' && ok "dry-run 识别默认分支" || bad "dry-run: $out"
[ ! -f "$R/.git/dia/config.json" ] && ok "dry-run 不落盘" || bad "dry-run 落盘了"

bash "$WT" adopt "$R" --apply >/dev/null 2>&1 || bad "apply 失败"
[ -f "$R/.git/dia/config.json" ] && ok "config 已写" || bad "缺 config"
[ "$(git config --global --get core.hooksPath)" = "$GH" ] && ok "全局 hooksPath 指向 $GH" || bad "全局 hooksPath 未设置"
for h in pre-commit pre-push post-checkout; do [ -x "$GH/$h" ] || bad "缺全局钩子 $h"; done
ok "全局三钩子可执行"
[ -z "$(git -C "$R" config --local --get core.hooksPath || true)" ] && ok "不再设置仓库本地 hooksPath" || bad "仍设了本地 hooksPath"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d.get("hooksManager")=="global" else 1)' "$R/.git/dia/config.json" \
  && ok "config 记录 hooksManager=global" || bad "hooksManager 未记录"

bash "$WT" adopt "$R" --apply >/dev/null 2>&1 && ok "重复 apply 幂等" || bad "重复 apply 失败"
bash "$WT" adopt "$R" --check >/dev/null 2>&1 && ok "check 通过" || bad "check 失败"
bash "$WT" doctor "$R" >/dev/null 2>&1 && ok "doctor 通过" || bad "doctor 失败"

echo b > "$R/b.txt"; git -C "$R" add b.txt
if git -C "$R" commit -qm should-block 2>/dev/null; then bad "主 checkout main 提交未被拦截"; else ok "主 checkout main 提交被拦截"; fi
git -C "$R" reset -q

# 链式：仓库自己的 .git/hooks/pre-commit 仍要执行（simple-git-hooks 等管理器就写这里）
printf '#!/bin/sh\necho chained >> "$(git rev-parse --show-toplevel)/chain.log"\n' > "$R/.git/hooks/pre-commit"
chmod +x "$R/.git/hooks/pre-commit"
git -C "$R" worktree add -q -b feat/y "$TD/repo-worktree--y" main
echo c > "$TD/repo-worktree--y/c.txt"; git -C "$TD/repo-worktree--y" add c.txt
git -C "$TD/repo-worktree--y" commit -qm feat-y >/dev/null 2>&1
[ -f "$TD/repo-worktree--y/chain.log" ] && ok "仓库自己的钩子被链式执行" || bad "仓库钩子未执行"
rm -f "$TD/repo-worktree--y/chain.log"

# 本地 hooksPath（husky/.githooks）优先于全局 → 守卫不生效，但 adopt 不得破坏它
R2="$TD/repo2"; mkdir -p "$R2/.githooks"; git -C "$R2" init -q -b main
git -C "$R2" config user.email t@example.com; git -C "$R2" config user.name t
echo a > "$R2/a.txt"; git -C "$R2" add -A; git -C "$R2" commit -qm init
git -C "$R2" config --local core.hooksPath .githooks
bash "$WT" adopt "$R2" --apply >/dev/null 2>&1
[ "$(git -C "$R2" config --get core.hooksPath)" = ".githooks" ] && ok "保留仓库本地 hooksPath（husky 等）" || bad "破坏了本地 hooksPath"
bash "$WT" doctor "$R2" 2>&1 | grep -q "本地 hooksPath" && ok "doctor 提示本地 hooksPath 覆盖全局" || bad "doctor 未提示覆盖"

# 未 adopt 的仓：全局钩子纯透传（主 checkout 可正常提交）
R3="$TD/repo3"; mkdir -p "$R3"; git -C "$R3" init -q -b main
git -C "$R3" config user.email t@example.com; git -C "$R3" config user.name t
echo a > "$R3/a.txt"; git -C "$R3" add -A
git -C "$R3" commit -qm init >/dev/null 2>&1 && ok "未 adopt 仓不受守卫影响" || bad "未 adopt 仓被误拦"

# 敏感扫描：adopted 仓的 worktree 推送带绝对路径 → 阻断；相对片段不误报
BR="$TD/remote.git"; git init -q --bare "$BR"
git -C "$R" remote add origin "$BR" 2>/dev/null || true
git --git-dir="$BR" fetch -q "$R" main:main 2>/dev/null || true
git -C "$R" fetch -q origin 2>/dev/null || true
echo "/Users/alice/secret" > "$TD/repo-worktree--y/bad.txt"
git -C "$TD/repo-worktree--y" add bad.txt
git -C "$TD/repo-worktree--y" commit -qm bad >/dev/null 2>&1
if git -C "$TD/repo-worktree--y" push -q origin feat/y 2>/dev/null; then bad "敏感推送未被拦截"; else ok "敏感推送被拦截"; fi
git -C "$TD/repo-worktree--y" reset -q --hard HEAD~1   # 丢掉含敏感内容的提交
printf 'path=$TD/home/kits/dia.json\n' > "$TD/repo-worktree--y/vars.txt"
git -C "$TD/repo-worktree--y" add vars.txt && git -C "$TD/repo-worktree--y" commit -qm vars >/dev/null 2>&1
git -C "$TD/repo-worktree--y" push -q origin feat/y 2>/dev/null && ok "相对片段 home/ 不误报" || bad "相对片段被误判"

# adopt --all：只处理主 checkout，跳过 *-worktree--*
AR="$TD/allroot"; mkdir -p "$AR/a" "$AR/b"
for r in a b; do
  git -C "$AR/$r" init -q -b main
  git -C "$AR/$r" config user.email t@example.com; git -C "$AR/$r" config user.name t
  echo x > "$AR/$r/x.txt"; git -C "$AR/$r" add -A; git -C "$AR/$r" commit -qm init
done
git -C "$AR/a" worktree add -q -b feat/w "$AR/a-worktree--w" main
out="$(DIA_WT_REPOS_ROOT="$AR" bash "$WT" adopt --all --apply --json 2>&1)"
printf '%s' "$out" | grep -q '"repos":2,"ok":2,"fail":0' && ok "adopt --all 覆盖 2 个主 checkout" || bad "adopt --all: $out"
[ ! -d "$AR/a-worktree--w/.git/dia" ] && ok "adopt --all 跳过 worktree 目录" || bad "adopt --all 误改 worktree"
out="$(DIA_WT_REPOS_ROOT="$AR" bash "$WT" doctor --all --json 2>/dev/null)"
printf '%s' "$out" | grep -q "$AR/a" && ok "doctor --all 覆盖自定义仓根" || bad "doctor --all 未覆盖"
DIA_WT_REPOS_ROOT="$TD/empty-root" bash "$WT" adopt --all >/dev/null 2>&1
[ $? = 2 ] && ok "adopt --all 空结果 exit 2" || bad "adopt --all 空结果未 exit 2"

# gate
rm -f "$TD/repo-worktree--y/chain.log"
if bash "$WT" gate "$R" y >/tmp/gate.log 2>&1; then ok "gate 成功"; else bad "gate 失败: $(tail -2 /tmp/gate.log | tr "\n" " ")"; fi
if bash "$WT" gate "$R" yb >/dev/null 2>&1; then bad "gate 子串误匹配"; else ok "gate 精确匹配 feature"; fi
echo dirty >> "$TD/repo-worktree--y/c.txt"
if bash "$WT" gate "$R" y >/dev/null 2>&1; then bad "worktree 脏时 gate 通过"; else ok "worktree 脏时 gate 失败"; fi
git -C "$TD/repo-worktree--y" checkout -q -- c.txt

# revert：撤本仓配置，保留全局钩子
bash "$WT" adopt "$R" --revert >/dev/null 2>&1 || bad "revert 失败"
[ ! -f "$R/.git/dia/config.json" ] && ok "revert 删除本仓配置" || bad "配置残留"
[ -x "$GH/pre-commit" ] && ok "revert 不影响全局钩子" || bad "revert 误删全局钩子"
git -C "$R" worktree remove --force "$TD/repo-worktree--y" >/dev/null 2>&1 || true

echo; echo "── PASS $PASS · FAIL $FAIL ──"
[ "$FAIL" = 0 ]
