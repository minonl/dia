#!/usr/bin/env bash
# dia wt-clean.test.sh —— `dia wt clean`（R25 收尾闸口）回归测试（2026-10-19）
#
# 为什么单独测：`clean` 是**唯一**执行 R25「worktree + 分支」的机械闸口，此前**无测试**。
# 2026-10-19 实测发现 P0 级静默缺陷：
#   原实现写死 `br="feat/${feature}"`，而 `create` 接受任意分支名（`review/*`、`fix/*` …）
#   ⇒ 名字对不上时**跳过删分支且不告警**，仍打印「✅ 清理完成」+ 退出码 0 ⇒ **谎报**。
#
# 覆盖：
#   ① 任意前缀（review/ fix/ feat/ 无前缀）都能删分支 ← 本次修复的核心
#   ② 已合并 → 删分支 + 退出码 0
#   ③ 未合并 → **保留分支 + 退出码 1**（不能谎报完成）
#   ④ detached HEAD → worktree 删掉、不报错、说清楚
#   ⑤ 有未提交改动 → 拒绝（worktree 与分支都不动）
#   ⑥ 软链 node_modules → 拒绝（R20 守卫仍在）
#   ⑦ 清理后 worktree 目录确实消失
#
# 用法：bash scripts/dia wt-clean.test.sh     （退出码 0 = 全绿）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$HERE/../bin/dia-wt"
TD="$(mktemp -d)"
trap 'rm -rf "$TD"' EXIT
export DIA_WT_DATA_ROOT="$TD/dr" DIA_WT_REPOS_ROOT="$TD/repos"
mkdir -p "$DIA_WT_DATA_ROOT" "$DIA_WT_REPOS_ROOT"

PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }
out(){ sed 's/^/     | /' "$TD/out.txt"; }
run(){ bash "$WT" "$@" >"$TD/out.txt" 2>&1; echo $?; }
see(){ grep -q "$1" "$TD/out.txt"; }

mkrepo(){ git -C "$1" init -q -b main; printf 'x\n' > "$1/f"
          git -C "$1" add -A
          git -C "$1" -c user.email=t@t -c user.name=t commit -qm init; }

# 建一个 worktree（模拟 dia wt create 的产物：平级目录 + 指定分支名）
mkwt(){ local repo="$1" feature="$2" branch="$3"
  local parent; parent="$(cd "$(dirname "$repo")" && pwd)"
  git -C "$repo" worktree add "$parent/$(basename "$repo")-worktree--$feature" -b "$branch" >/dev/null 2>&1
}

echo '== ① 任意分支前缀都能删（本次修复核心）=='
for br in 'review/head-gate' 'fix/wt-clean' 'feat/plain' 'no-prefix'; do
  R="$TD/r-$br"; mkdir -p "$R"; mkrepo "$R"
  f="t$(echo "$br" | tr '/-' '__')"
  mkwt "$R" "$f" "$br"
  rc="$(run clean "$R" "$f")"
  if [ "$rc" = 0 ] && ! git -C "$R" rev-parse --verify --quiet "refs/heads/$br" >/dev/null; then
    ok "${br}：已删分支 + 退出码 0"
  else
    bad "${br}：应删分支且退出码 0（实际 rc=${rc}）"; out
  fi
  [ -d "$TD/$(basename "$R")-worktree--$f" ] && bad "${br}：worktree 目录仍存在" || ok "${br}：worktree 目录已删"
done

echo '== ② 已合并分支 → 删分支 + rc 0 =='
R="$TD/r-merged"; mkdir -p "$R"; mkrepo "$R"; mkwt "$R" m1 'review/merged'
# 把分支内容合进 main，使其可被 -d 删除
git -C "$R" merge --no-ff -q 'review/merged' -m merge 2>/dev/null
rc="$(run clean "$R" m1)"
[ "$rc" = 0 ] && ! git -C "$R" rev-parse --verify --quiet refs/heads/review/merged >/dev/null \
  && ok '已合并：分支已删、rc 0' || { bad "已合并：应删分支 rc=0（实际 rc=${rc}）"; out; }

echo '== ③ 未合并分支 → 保留分支 + rc 1（不谎报完成）=='
R="$TD/r-unmerged"; mkdir -p "$R"; mkrepo "$R"; mkwt "$R" u1 'review/unmerged'
# 在分支上加提交，使其未合并
( cd "$TD/r-unmerged-worktree--u1" && printf 'y\n' > y.txt && git add -A \
  && git -c user.email=t@t -c user.name=t commit -qm 'branch only' ) >/dev/null 2>&1
rc="$(run clean "$R" u1)"
[ "$rc" = 1 ] && git -C "$R" rev-parse --verify --quiet refs/heads/review/unmerged >/dev/null \
  && ok '未合并：分支保留 + rc 1' || { bad "未合并：应保留分支且 rc=1（实际 rc=${rc}）"; out; }
see '未完全合并' && ok '未合并：有明确告警文案' || { bad '未合并：缺告警文案'; out; }
[ -d "$TD/r-unmerged-worktree--u1" ] && bad '未合并：worktree 应已删' || ok '未合并：worktree 已删'

echo '== ④ detached HEAD → 删 worktree、不报错 =='
R="$TD/r-detached"; mkdir -p "$R"; mkrepo "$R"
parent="$(cd "$(dirname "$R")" && pwd)"
git -C "$R" worktree add --detach "$parent/$(basename "$R")-worktree--d1" >/dev/null 2>&1
rc="$(run clean "$R" d1)"
[ "$rc" = 0 ] && [ ! -d "$parent/$(basename "$R")-worktree--d1" ] \
  && ok 'detached：worktree 已删、rc 0' || { bad "detached：应 rc=0 且目录消失（实际 rc=${rc}）"; out; }
see 'detached HEAD' && ok 'detached：说明了跳过删分支' || { bad 'detached：未说明'; out; }

echo '== ⑤ 有未提交改动 → 拒绝（不动 worktree / 分支）=='
R="$TD/r-dirty"; mkdir -p "$R"; mkrepo "$R"; mkwt "$R" d1 'review/dirty'
printf 'dirty\n' > "$TD/r-dirty-worktree--d1/dirty.txt"
rc="$(run clean "$R" d1)"
[ "$rc" = 1 ] && [ -d "$TD/r-dirty-worktree--d1" ] \
  && git -C "$R" rev-parse --verify --quiet refs/heads/review/dirty >/dev/null \
  && ok '脏工作区：拒绝且未动' || { bad "脏工作区：应拒绝且不动（rc=${rc}）"; out; }
see '唯一工作副本' && ok '脏工作区：给了抢救提示' || { bad '脏工作区：缺抢救提示'; out; }

echo '== ⑥ 软链 node_modules → 拒绝（R20 守卫）=='
R="$TD/r-link"; mkdir -p "$R"; mkrepo "$R"; mkwt "$R" l1 'review/link'
ln -sfn "$TD/store-node_modules" "$TD/r-link-worktree--l1/node_modules"
rc="$(run clean "$R" l1)"
[ "$rc" = 1 ] && [ -d "$TD/r-link-worktree--l1" ] && ok '软链：拒绝且未动' \
  || { bad "软链：应拒绝（rc=${rc}）"; out; }

echo '== ⑦ worktree 不存在 → 明确报错 =='
R="$TD/r-missing"; mkdir -p "$R"; mkrepo "$R"
rc="$(run clean "$R" nope)"
[ "$rc" = 1 ] && ok '不存在：rc 1' || bad "不存在：应 rc=1（实际 ${rc}）"

echo '== ⑧ 远端分支仍在 → 提示清理命令（不自动删）=='
R="$TD/r-remote"; mkdir -p "$R"; mkrepo "$R"
# 造一个假的 origin（裸库），推一个分支上去
git init -q --bare "$TD/remote.git"
git -C "$R" remote add origin "$TD/remote.git"
git -C "$R" push -q -u origin main 2>/dev/null
mkwt "$R" r1 'review/remote'
( cd "$TD/r-remote-worktree--r1" && printf 'z\n' > z.txt && git add -A \
  && git -c user.email=t@t -c user.name=t commit -qm 'r' && git push -q -u origin review/remote ) >/dev/null 2>&1
# 先合进 main 让本地分支可删
git -C "$R" merge --no-ff -q 'review/remote' -m merge 2>/dev/null
git -C "$R" push -q origin main 2>/dev/null
rc="$(run clean "$R" r1)"
see '远端分支仍在' && ok '远端存在：明确提示' || { bad '远端存在：未提示'; out; }
see 'push origin --delete' && ok '远端存在：给了删除命令' || { bad '远端存在：缺命令'; out; }

echo
printf '结果：%d 通过，%d 失败\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
