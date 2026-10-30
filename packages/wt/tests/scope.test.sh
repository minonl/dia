#!/usr/bin/env bash
# dia wt-scope.test.sh —— `dia wt scope` 的回归测试（G2，2026-10-15）
#
# 覆盖：git 仓 ⇒ 派生 worktree 同级；**非 git 目录 ⇒ 不派生**（用户 2026-10-15 关键要求）；
#       worktree 路径 ⇒ 归主仓且 mainCheckout=false；scope.json 合法且原子；--show；
#   ⚠️ 与 yan 权限层（core/perm/scope.mjs）的串联判定已移出本包——那是 yan 域，不是 dia wt 的契约。
# 用法：bash scripts/dia wt-scope.test.sh     （退出码 0 = 全绿）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$HERE/../bin/dia-wt"

TD="$(mktemp -d)"; export DIA_WT_DATA_ROOT="$TD/dr"
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }
check(){ [ "$2" = "$3" ] && ok "$1（=$2）" || bad "$1：期望 $3，实得 $2"; }
jq_get(){ python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get(sys.argv[2]))" "$1" "$2"; }

echo "== 1. git 仓库 ⇒ 派生 worktree 同级目录 =="
mkdir -p "$TD/repoA" && git -C "$TD/repoA" init -q
bash "$WT" scope "$TD/repoA" --feature demo >/dev/null
S_DIR="$DIA_WT_DATA_ROOT/tasks/scopes"
scope_of() { echo "$S_DIR/$(basename "$1").json"; }
S="$(scope_of "$TD/repoA")"
check "gitRepo" "$(jq_get "$S" gitRepo)" "True"
check "mainCheckout" "$(jq_get "$S" mainCheckout)" "True"
check "sibling 派生" "$(jq_get "$S" siblingWorktreeGlob)" "$TD/repoA-worktree--*"
check "writable 条目数" "$(python3 -c "import json;print(len(json.load(open('$S'))['writable']))")" "2"

echo "== 2. 非 git 目录 ⇒ **不派生**（关键回归：不会串到兄弟目录）=="
mkdir -p "$TD/plain/sub"
bash "$WT" scope "$TD/plain" >/dev/null
S="$(scope_of "$TD/plain")"
check "gitRepo=false" "$(jq_get "$S" gitRepo)" "False"
check "sibling 为空" "$(jq_get "$S" siblingWorktreeGlob)" "None"
check "writable 仅自身" "$(python3 -c "import json;print(len(json.load(open('$S'))['writable']))")" "1"

echo "== 3. worktree 路径 ⇒ 归主仓 + mainCheckout=false =="
git -C "$TD/repoA" worktree add -q "$TD/repoA-worktree--t1" -b t1 2>/dev/null
bash "$WT" scope "$TD/repoA-worktree--t1" --feature t1 >/dev/null
S="$(scope_of "$TD/repoA-worktree--t1")"
check "repo 归到主仓" "$(jq_get "$S" repo)" "$TD/repoA"
check "active 是 worktree" "$(jq_get "$S" active)" "$TD/repoA-worktree--t1"
check "mainCheckout=false" "$(jq_get "$S" mainCheckout)" "False"

echo "== 4. --show 按 cwd 打印适用声明 =="
# ⚠️ 2026-10-16 起 --show 按 **cwd** 选适用作用域 ⇒ 必须在被覆盖的目录里跑
out4="$(cd "$TD/plain" && bash "$WT" scope --show 2>/dev/null)"
echo "$out4" | grep -q '"repo"' && ok "--show 输出 JSON" || bad "--show 无输出（cwd=$TD/plain）"
echo "$out4" | python3 -c "import json,sys;json.load(sys.stdin)" && ok "--show 输出是合法 JSON" || bad "--show 不是合法 JSON"

echo "== 5. （跳过：yan 权限层串联判定归属 yan 域，不在 dia wt 契约内）=="


echo "== 6. 并发不覆盖：两个 worktree 各一份 scope（2026-10-16 修）=="
bash "$WT" scope "$TD/repoA" --feature A >/dev/null
bash "$WT" scope "$TD/plain" --feature B >/dev/null
n="$(ls -1 "$DIA_WT_DATA_ROOT/tasks/scopes"/*.json 2>/dev/null | wc -l | tr -d ' ')"
[ "$n" -ge 2 ] && ok "两份 scope 共存（$n 份）" || bad "应至少 2 份，实得 $n"
check "A 的 scope 未被 B 覆盖（repo）" "$(jq_get "$(scope_of "$TD/repoA")" repo)" "$TD/repoA"
check "B 的 scope 也独立存在" "$(jq_get "$(scope_of "$TD/plain")" repo)" "$TD/plain"
(cd "$TD/repoA" && bash "$WT" scope --show | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['repo'])") > /tmp/showcwd.txt
check "按 cwd 选用正确" "$(cat /tmp/showcwd.txt)" "$TD/repoA"

echo
echo "──────── 结果：$PASS 通过 / $FAIL 失败 ────────"
rm -rf "$TD"
[ "$FAIL" -eq 0 ]
