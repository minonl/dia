#!/usr/bin/env bash
# dia wt-check.test.sh —— `dia wt check`（R20 机械闸口）回归测试（2026-10-15）
#
# 覆盖：
#   · A 顶层 node_modules 是软链（跨 checkout 共享的典型形态）
#   · B 顶层链逃出本 checkout   · C 顶层链悬空   · D 深层链逃逸（仅 --deep）
#   · ✅ **GVS 白名单**：指向 `<storeDir>/links/@/…` 的链**不算违规** —— 这条断言是"启用 pnpm
#     global virtual store 后不误报"的唯一保险（判据不区分共享 store 与别人的 checkout ⇒ 一开 GVS 全仓红）
#   · 真装形态不误报 · 主仓 + 各 worktree 全覆盖 · 仓根杂散 node_modules（--all）
#   · clean 软链守卫（拒绝清理且不动目录）· 退出码契约（0 干净 / 1 违规 / 2 未知子命令）
# 用法：bash scripts/dia wt-check.test.sh     （退出码 0 = 全绿）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$HERE/../bin/dia-wt"
TD="$(mktemp -d)"
export DIA_WT_DATA_ROOT="$TD/dr" DIA_WT_REPOS_ROOT="$TD/repos"
mkdir -p "$DIA_WT_DATA_ROOT" "$DIA_WT_REPOS_ROOT"
STORE="$TD/store"; mkdir -p "$STORE/links/@/lodash/1.0.0/abc123/node_modules/lodash"
printf 'x\n' > "$STORE/links/@/lodash/1.0.0/abc123/node_modules/lodash/index.js"

PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }
out(){ cat "$TD/out.txt" | sed 's/^/     | /'; }
run(){ bash "$WT" "$@" >"$TD/out.txt" 2>&1; echo $?; }
see(){ grep -q "$1" "$TD/out.txt"; }

mkrepo(){ git -C "$1" init -q; printf 'x\n' > "$1/f"; git -C "$1" add -A
          git -C "$1" -c user.email=t@t -c user.name=t commit -qm init; }
# 真装形态：node_modules 真目录 + .pnpm 实体 + 顶层链指向 **checkout 内**
mk_real(){ local d="$1"
  mkdir -p "$d/node_modules/.pnpm/lodash@1.0.0/node_modules/lodash"
  printf 'x\n' > "$d/node_modules/.pnpm/lodash@1.0.0/node_modules/lodash/index.js"
  ln -sfn .pnpm/lodash@1.0.0/node_modules/lodash "$d/node_modules/lodash"
  printf '{"storeDir": "%s"}\n' "$STORE" > "$d/node_modules/.modules.yaml"; }

echo "== 1. 真装形态（顶层链指向 checkout 内）⇒ 0 违规 =="
A="$TD/repoA"; mkdir -p "$A"; mkrepo "$A"; mk_real "$A"
[ "$(run check "$A")" = 0 ] && ok "退出码 0" || { bad "退出码应为 0"; out; }
see "全部干净" && ok "输出「全部干净」" || { bad "缺「全部干净」"; out; }

echo "== 2. A：顶层 node_modules 本身是软链 ⇒ 违规 =="
B="$TD/repoB"; mkdir -p "$B"; mkrepo "$B"; mk_real "$B"     # B 是"另一个 checkout"
rm -rf "$A/node_modules"; ln -sfn "$B/node_modules" "$A/node_modules"
RC="$(run check "$A")"
[ "$RC" = 1 ] && ok "退出码 1" || { bad "退出码应为 1（实得 ${RC}）"; out; }
see "A 顶层 node_modules 是软链" && ok "报 A 类" || { bad "未报 A 类"; out; }
see "$B/node_modules" && ok "报出目标 checkout" || { bad "未报出目标"; out; }

echo "== 3. B：顶层链逃出 checkout（指向别的 checkout）⇒ 违规 =="
rm -f "$A/node_modules"                                     # 先摘掉第 2 步的软链（否则后续夹具会顺着链写进 repoB）
mk_real "$A"                                                # 恢复真目录，只留一条逃逸链
ln -sfn "$B/node_modules/.pnpm/lodash@1.0.0/node_modules/lodash" "$A/node_modules/lodash-foreign"
RC="$(run check "$A")"
[ "$RC" = 1 ] && ok "退出码 1" || { bad "退出码应为 1（实得 ${RC}）"; out; }
see "B 顶层链指向其他 checkout" && ok "报 B 类" || { bad "未报 B 类"; out; }
rm -f "$A/node_modules/lodash-foreign"

echo "== 4. C：顶层链悬空 ⇒ 违规 =="
ln -sfn "$TD/gone/node_modules/lodash" "$A/node_modules/lodash-dangling"
RC="$(run check "$A")"
[ "$RC" = 1 ] && ok "退出码 1" || { bad "退出码应为 1（实得 ${RC}）"; out; }
see "C 顶层链悬空" && ok "报 C 类" || { bad "未报 C 类"; out; }
rm -f "$A/node_modules/lodash-dangling"

echo "== 5. ✅ GVS 白名单：链指向 <storeDir>/links ⇒ **不算违规**（启用官方共享方案后不误报）=="
ln -sfn "$STORE/links/@/lodash/1.0.0/abc123/node_modules/lodash" "$A/node_modules/lodash-gvs"
RC="$(run check "$A")"
[ "$RC" = 0 ] && ok "退出码 0（白名单生效）" || { bad "退出码应为 0（实得 ${RC}）：GVS 链被误判"; out; }
rm -f "$A/node_modules/lodash-gvs"

echo "== 6. D：深层链逃逸 ⇒ 默认不报、--deep 才报 =="
mkdir -p "$A/node_modules/.pnpm/foo@1.0.0/node_modules"
ln -sfn "$B/node_modules/.pnpm/lodash@1.0.0/node_modules/lodash" "$A/node_modules/.pnpm/foo@1.0.0/node_modules/foo"
RC="$(run check "$A")"
[ "$RC" = 0 ] && ok "默认（浅扫）0 违规" || { bad "浅扫不该报深层链（实得 ${RC}）"; out; }
RC="$(run check "$A" --deep)"
[ "$RC" = 1 ] && ok "--deep 退出码 1" || { bad "--deep 应报违规（实得 ${RC}）"; out; }
see "D 深层链逃逸" && ok "--deep 报 D 类" || { bad "--deep 未报 D 类"; out; }
rm -rf "$A/node_modules/.pnpm/foo@1.0.0"

echo "== 7. 全覆盖：主仓 ✓ + worktree ✗ 同时报出 =="
W="$TD/repoW"; mkdir -p "$W"; mkrepo "$W"; mk_real "$W"
git -C "$W" worktree add -q "$TD/repoW-worktree--t1" -b t1
mkdir -p "$TD/repoW-worktree--t1"; rm -rf "$TD/repoW-worktree--t1/node_modules"
ln -sfn "$W/node_modules" "$TD/repoW-worktree--t1/node_modules"
RC="$(run check "$W")"
[ "$RC" = 1 ] && ok "退出码 1" || { bad "退出码应为 1（实得 ${RC}）"; out; }
see "repoW · 主仓 0 违规" && ok "主仓判干净" || { bad "主仓未被判为干净（误报）"; out; }
see "repoW-worktree--t1 违规" && ok "worktree 被判违规" || { bad "worktree 未被判违规"; out; }

echo "== 8. clean 守卫：软链 node_modules 的 worktree ⇒ 拒绝清理且目录保留 =="
RC="$(run clean "$W" t1)"
[ "$RC" = 1 ] && ok "退出码 1（拒绝）" || { bad "应拒绝清理（实得 ${RC}）"; out; }
see "拒绝清理" && ok "提示「拒绝清理」" || { bad "缺拒绝提示"; out; }
see "check" && ok "指引先跑 check" || { bad "缺 check 指引"; out; }
[ -d "$TD/repoW-worktree--t1" ] && ok "worktree 目录仍在（未被动）" || bad "worktree 被删了（守卫失效）"
rm -f "$TD/repoW-worktree--t1/node_modules"                  # 收尾：删链后应可正常清理

echo "== 9. --all：仓根杂散 node_modules 也算违规 =="
mkdir -p "$DIA_WT_REPOS_ROOT/node_modules"
RC="$(run check --all)"
[ "$RC" = 1 ] && ok "退出码 1" || { bad "退出码应为 1（实得 ${RC}）"; out; }
see "杂散" && ok "报杂散" || { bad "未报杂散"; out; }
rm -rf "$DIA_WT_REPOS_ROOT/node_modules"

echo "== 10. 退出码契约：未知子命令=2 / 参数错=1 =="
bash "$WT" bogus-subcmd >/dev/null 2>&1; RC_UNK=$?
bash "$WT" check --bogus-flag "$A" >/dev/null 2>&1; RC_ARG=$?
[ "$RC_UNK" = 2 ] && ok "未知子命令=2" || bad "未知子命令应为 2（实得 ${RC_UNK}）"
[ "$RC_ARG" = 1 ] && ok "未知参数=1" || bad "未知参数应为 1（实得 ${RC_ARG}）"

echo "== 11. 无 node_modules 的目录 ⇒ 跳过、不报错 =="
N="$TD/plain"; mkdir -p "$N"
[ "$(run check "$N")" = 0 ] && ok "退出码 0" || { bad "应 0（实得见现场）"; out; }

echo "== 12. --quiet：干净仓不打印 ✓ 行（定时任务降噪）=="
run check --quiet "$A" >/dev/null
see "✓" && bad "--quiet 仍打印 ✓ 行" || ok "--quiet 无 ✓ 行"
see "全部干净" && ok "仍打印结论行" || { bad "缺结论行"; out; }

echo
echo "── PASS $PASS · FAIL $FAIL ──"
rm -rf "$TD"
[ "$FAIL" = 0 ]
