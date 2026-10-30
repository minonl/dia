#!/usr/bin/env bash
# dia wt-prune-merged.test.sh —— `prune-merged`（R25 定期闸口）回归测试（2026-10-19）
#
# 为什么测：这是**破坏性**操作（删分支），判据错会误删他人工作。必须机械验证：
#   · 只删「已并入 base」的分支（`-d` 语义）
#   · **不删**当前分支 / 被 worktree 占用的分支 / 保护名单 / 未合并分支
#   · 默认 dry-run（不删），`--apply` 才真删
#   · 退出码：0=干净或已清完 / 1=仍有残留
#   · `--quiet` 只输出分支名（供巡检任务消费）
#
# 用法：bash scripts/dia wt-prune-merged.test.sh    （退出码 0 = 全绿）
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
run(){ bash "$WT" prune-merged "$@" >"$TD/out.txt" 2>&1; echo $?; }
see(){ grep -q "$1" "$TD/out.txt"; }
notsee(){ grep -q "$1" "$TD/out.txt" && return 1 || return 0; }

# 造仓库：main 有 init 提交；另有 origin/main 指向同一提交（模拟真实基线）
mkrepo(){
  local r="$1"; mkdir -p "$r"; git -C "$r" init -q -b main
  printf 'x\n' > "$r/f"; git -C "$r" add -A
  git -C "$r" -c user.email=t@t -c user.name=t commit -qm init
  git -C "$r" update-ref refs/remotes/origin/main refs/heads/main
}
# 建一个已并入 main 的分支（内容与 main 相同 → git 认为是 ancestor）
mkmerged(){ git -C "$1" branch "$2" main >/dev/null 2>&1; }
# 建一个未并入的分支
mkunmerged(){
  local r="$1" b="$2"
  git -C "$r" checkout -q -b "$b" main
  # ⚠️ 文件名不能用分支名（含 `/` 会变成子目录 → 写入失败 → 提交没发生 → 分支等于 main）
  printf 'y\n' > "$r/unmerged-marker.txt"; git -C "$r" add -A
  git -C "$r" -c user.email=t@t -c user.name=t commit -qm "$b only"
  git -C "$r" checkout -q main
}

echo '== ① dry-run：只列出、不删除、退出码 1 =='
R="$TD/r1"; mkrepo "$R"
mkmerged "$R" feat/done1; mkmerged "$R" review/done2
rc="$(run "$R")"
[ "$rc" = 1 ] && ok '有残留 → 退出码 1' || { bad "应 rc=1（实际 ${rc}）"; out; }
see 'feat/done1' && see 'review/done2' && ok '列出了两个残留分支' || { bad '未列出残留'; out; }
git -C "$R" rev-parse --verify -q refs/heads/feat/done1 >/dev/null \
  && ok 'dry-run 未删除' || bad 'dry-run 却删了分支'

echo '== ② --apply：真删已合并分支 =='
rc="$(run "$R" --apply)"
[ "$rc" = 0 ] && ok '全部删净 → 退出码 0' || { bad "应 rc=0（实际 ${rc}）"; out; }
git -C "$R" rev-parse --verify -q refs/heads/feat/done1 >/dev/null \
  && bad 'feat/done1 仍在' || ok 'feat/done1 已删'
git -C "$R" rev-parse --verify -q refs/heads/review/done2 >/dev/null \
  && bad 'review/done2 仍在' || ok 'review/done2 已删'

echo '== ③ 保护名单：main / master / develop / 自定义 =='
R="$TD/r2"; mkrepo "$R"
git -C "$R" branch develop main; git -C "$R" branch keepme main
mkmerged "$R" feat/gone
rc="$(run "$R" --apply --protect main,master,develop,dev,keepme)"
git -C "$R" rev-parse --verify -q refs/heads/main >/dev/null && ok 'main 保留' || bad 'main 被删'
git -C "$R" rev-parse --verify -q refs/heads/develop >/dev/null && ok 'develop 保留' || bad 'develop 被删'
git -C "$R" rev-parse --verify -q refs/heads/keepme >/dev/null && ok '自定义保护生效' || bad 'keepme 被删'
git -C "$R" rev-parse --verify -q refs/heads/feat/gone >/dev/null && bad 'feat/gone 应被删' || ok '非保护分支已删'

echo '== ④ 未合并分支：绝不删 =='
R="$TD/r3"; mkrepo "$R"
mkunmerged "$R" feat/wip
rc="$(run "$R" --apply)"
[ "$rc" = 0 ] && ok '无已合并残留 → rc 0' || { bad "应 rc=0（实际 ${rc}）"; out; }
git -C "$R" rev-parse --verify -q refs/heads/feat/wip >/dev/null \
  && ok '未合并分支保留' || bad '未合并分支被误删！'
notsee 'feat/wip' && ok '未合并分支未出现在候选里' || { bad '未合并分支被列为候选'; out; }

echo '== ⑤ 被 worktree 占用的分支：跳过 =='
R="$TD/r4"; mkrepo "$R"
mkmerged "$R" feat/wt-branch
parent="$(cd "$(dirname "$R")" && pwd)"
git -C "$R" worktree add "$parent/$(basename "$R")-worktree--wt" feat/wt-branch >/dev/null 2>&1
rc="$(run "$R" --apply)"
git -C "$R" rev-parse --verify -q refs/heads/feat/wt-branch >/dev/null \
  && ok '被 worktree 占用的分支保留' || bad '误删了 worktree 正在用的分支！'
git -C "$R" worktree remove "$parent/$(basename "$R")-worktree--wt" --force >/dev/null 2>&1

echo '== ⑥ 当前分支：跳过 =='
R="$TD/r5"; mkrepo "$R"
git -C "$R" checkout -q -b feat/current main
rc="$(run "$R" --apply)"
git -C "$R" rev-parse --verify -q refs/heads/feat/current >/dev/null \
  && ok '当前分支保留' || bad '误删当前分支！'

echo '== ⑦ --quiet：只输出分支名（供巡检消费）=='
R="$TD/r6"; mkrepo "$R"
mkmerged "$R" feat/q1; mkmerged "$R" feat/q2
bash "$WT" prune-merged "$R" --quiet >"$TD/out.txt" 2>&1
[ "$(grep -c 'feat/q' "$TD/out.txt")" = 2 ] && ok '输出 2 行分支名' || { bad '输出行数不对'; out; }
notsee '仓库：' && ok 'quiet 无装饰性输出' || { bad 'quiet 仍有装饰输出'; out; }

echo '== ⑧ 干净仓库：rc 0 + 明确提示 =='
R="$TD/r7"; mkrepo "$R"
rc="$(run "$R")"
[ "$rc" = 0 ] && ok '干净 → rc 0' || bad "应 rc=0（实际 ${rc}）"
see '无已合并的残留分支' && ok '有明确提示' || { bad '缺提示'; out; }

echo '== ⑨ 基线不存在：明确报错 =='
R="$TD/r8"; mkrepo "$R"
rc="$(run "$R" --base origin/nonexistent)"
[ "$rc" = 1 ] && ok '基线缺失 → rc 1' || bad "应 rc=1（实际 ${rc}）"
see '基线不存在' && ok '有明确报错' || { bad '缺报错文案'; out; }

echo '== ⑩ --all：批量扫仓（无基线的仓跳过、不中断）=='
RR="$TD/reposleyan"; mkdir -p "$RR"
A="$RR/repoA"; mkrepo "$A"; mkmerged "$A" feat/a-gone
B="$RR/repoB"; mkdir -p "$B"; git -C "$B" init -q -b main
printf 'x\n' > "$B/f"; git -C "$B" add -A
git -C "$B" -c user.email=t@t -c user.name=t commit -qm init   # 无 origin/main
C="$RR/repoC"; mkrepo "$C"; mkmerged "$C" feat/c-gone
export DIA_WT_REPOS_ROOT="$RR"
rc="$(run --all)"
[ "$rc" = 1 ] && ok '--all 有残留 → rc 1' || { bad "应 rc=1（实际 ${rc}）"; out; }
see 'feat/a-gone' && see 'feat/c-gone' && ok '扫到两个仓的残留' || { bad '漏扫'; out; }
notsee 'feat/b' && ok '无基线仓不产生候选（不误删）' || { bad 'repoB 不应有候选'; out; }
# ⚠️ 非 quiet 模式下「跳过 repoB」的告警是**预期行为**（让人知道少扫了一个仓）；
#    断言重点 = **不中断**（后面 repoC 仍被扫到）——上面 see 'feat/c-gone' 已覆盖。
see '跳过' && ok '无基线仓给出跳过说明（不静默）' || { bad '无基线仓应说明'; out; }
# --all + --apply 一次清完
rc="$(run --all --apply)"
[ "$rc" = 0 ] && ok '--all --apply → rc 0' || { bad "应 rc=0（实际 ${rc}）"; out; }
git -C "$A" rev-parse --verify -q refs/heads/feat/a-gone >/dev/null && bad 'a-gone 仍在' || ok 'repoA 已清'
git -C "$C" rev-parse --verify -q refs/heads/feat/c-gone >/dev/null && bad 'c-gone 仍在' || ok 'repoC 已清'
unset DIA_WT_REPOS_ROOT

echo '== ⑪ upstream 落后于本地（`-d` 误拒的真实根因）=='
# 复现：分支 push -u 后又提交（远端落后）→ 合进 main → `-d` 会因「未并入 upstream」拒绝，
# 即使该分支**已完全并入 main**（example-repo fix/format-superbook-cli 的真实情形）。
R="$TD/r9"; mkrepo "$R"
git -C "$R" init -q --bare "$TD/remote9.git"
git -C "$R" remote add origin "$TD/remote9.git"
git -C "$R" push -q -u origin main 2>/dev/null
git -C "$R" checkout -q -b feat/upstream-behind main
printf 'u\n' > "$R/u.txt"; git -C "$R" add -A
git -C "$R" -c user.email=t@t -c user.name=t commit -qm 'u1'
git -C "$R" push -q -u origin feat/upstream-behind 2>/dev/null   # 远端 = u1
printf 'u2\n' > "$R/u2.txt"; git -C "$R" add -A
git -C "$R" -c user.email=t@t -c user.name=t commit -qm 'u2'      # 本地再提交 → 远端落后
git -C "$R" checkout -q main
git -C "$R" -c user.email=t@t -c user.name=t merge -q --no-ff feat/upstream-behind -m merge
git -C "$R" update-ref refs/remotes/origin/main refs/heads/main
# 前置确认：确实「已并入 origin/main」但 upstream 落后
git -C "$R" merge-base --is-ancestor feat/upstream-behind refs/remotes/origin/main \
  && ok '前置：分支已并入 origin/main' || bad '前置条件不成立'
[ "$(git -C "$R" rev-parse feat/upstream-behind)" != "$(git -C "$R" rev-parse origin/feat/upstream-behind)" ] \
  && ok '前置：远端确实落后' || bad '前置：远端未落后'
rc="$(run "$R" --apply)"
git -C "$R" rev-parse --verify -q refs/heads/feat/upstream-behind >/dev/null \
  && bad 'upstream 落后导致误拒（未修复）' || ok '已正确删除（不再被 upstream 挡住）'

echo
printf '结果：%d 通过，%d 失败\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
