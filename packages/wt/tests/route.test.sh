#!/usr/bin/env bash
# dia wt-route.test.sh —— `dia wt route` 回归测试（R1.7 配置驱动判定，2026-10-16）
#
# 覆盖（**为什么是这些**）：
#   · 无配置时**绝不放行**：即便命名空间看着像我的，也只能走 MR（不瞎猜"我是谁"）
#   · 命名空间推导：配置了 my_namespaces 后，我的仓 → MR + owner 自合（rc 0）
#   · 显式名单：direct 放行 / mr **否决优先**
#   · 个人仓基线 + 数据根本地**并集合并**；数据根配置**可以是软链**
#   · 空列表**不误命中**（`grep -qx ""` 匹配空行是这类脚本的经典假阳性）
#   · 坏 JSON 不崩、无 remote / 非 git 仓 → 信息不足（rc=2，安全侧）
#   · worktree 路径输入 → 归主仓判定（沿用既有行为）
# 用法：bash scripts/dia wt-route.test.sh   （退出码 0 = 全绿）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$HERE/../bin/dia-wt"
TD="$(mktemp -d)"
export DIA_WT_DATA_ROOT="$TD/dr" PERSONAL_AGENT_DIR="$TD/pa"
mkdir -p "$DIA_WT_DATA_ROOT" "$PERSONAL_AGENT_DIR/config"
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }
out(){ sed 's/^/     | /' "$TD/out.txt"; }
run(){ env -u DIA_WT_ROUTE_CONFIG bash "$WT" route "$@" >"$TD/out.txt" 2>&1; echo $?; }
see(){ grep -q "$1" "$TD/out.txt"; }
setcfg(){ printf '%s\n' "$2" > "$1"; }
CFG="$DIA_WT_DATA_ROOT/route.json"
BASE="$PERSONAL_AGENT_DIR/config/yan-route.json"

mkrepo(){  # <name> <remote-url>（空 URL ⇒ 不配 remote）
  local d="$TD/$1"; mkdir -p "$d"; git -C "$d" init -q
  [ -n "${2:-}" ] && git -C "$d" remote add origin "$2"
  printf 'x\n' > "$d/f"; git -C "$d" add -A
  git -C "$d" -c user.email=t@t -c user.name=t commit -qm init; printf '%s' "$d"
}
MINE="$(mkrepo myrepo git@git.example.com:example-user/myrepo.git)"
TEAM="$(mkrepo teamrepo https://git.example.com/fed/teamrepo.git)"
NOREMOTE="$(mkrepo noremote)"

echo "== 1. 无配置 + 非我命名空间 ⇒ MR（安全侧）=="
[ "$(run "$TEAM")" = 1 ] && ok "退出码 1" || { bad "应 1"; out; }
see "安全侧默认 MR" && ok "给出默认理由" || { bad "缺理由"; out; }

echo "== 2. 无配置 + 命名空间看着像我的 ⇒ **仍 MR**（不瞎猜）=="
[ "$(run "$MINE")" = 1 ] && ok "退出码 1（未因命名空间相似而放行）" || { bad "应 1：不能瞎猜"; out; }
see "不在 my_namespaces" && ok "说明未配置" || { bad "缺说明"; out; }

echo "== 3. 配置 my_namespaces ⇒ 我的仓 = MR + owner 自合 =="
setcfg "$CFG" '{ "my_namespaces": ["example-user"] }'
[ "$(run "$MINE")" = 0 ] && ok "退出码 0" || { bad "应 0"; out; }
see "∈ my_namespaces" && ok "判定来源 = 命名空间" || { bad "来源不对"; out; }
[ "$(run "$TEAM")" = 1 ] && ok "非我命名空间仍 MR" || { bad "应 1"; out; }

echo "== 4. direct 名单 ⇒ owner 自合（覆盖默认）=="
setcfg "$CFG" '{ "my_namespaces": ["example-user"], "direct": ["teamrepo"] }'
[ "$(run "$TEAM")" = 0 ] && ok "退出码 0" || { bad "应 0"; out; }
see "配置 direct 名单命中" && ok "判定来源 = 配置" || { bad "来源不对"; out; }

echo "== 5. mr 名单 ⇒ **否决优先**（即便同时命中 direct）=="
setcfg "$CFG" '{ "my_namespaces": ["example-user"], "direct": ["teamrepo"], "mr": ["teamrepo"] }'
[ "$(run "$TEAM")" = 1 ] && ok "退出码 1（否决压过放行）" || { bad "应 1"; out; }
see "显式否决" && ok "给出否决理由" || { bad "缺理由"; out; }

echo "== 6. 个人仓基线 + 数据根 ⇒ 并集合并（判定来源列出两个文件）=="
setcfg "$CFG" '{ "direct": ["teamrepo"] }'
setcfg "$BASE" '{ "my_namespaces": ["example-user"], "direct": ["myrepo"] }'
[ "$(run "$TEAM")" = 0 ] && ok "本地新增生效（teamrepo = owner 自合）" || { bad "本地配置未生效"; out; }
see "route.json" && ok "来源含数据根文件" || { bad "缺来源"; out; }
[ "$(run "$MINE")" = 0 ] && ok "基线条目保留（myrepo = owner 自合）" || { bad "基线未生效"; out; }
see "yan-route.json" && ok "来源含基线文件" || { bad "缺基线来源"; out; }
[ "$(run "$NOREMOTE")" = 2 ] && ok "无 remote 的仓：信息不足（rc=2）" || { bad "应 2"; out; }

echo "== 7. 数据根配置**是软链** ⇒ 生效（指向个人仓版本化文件）=="
mv "$CFG" "$TD/route-real.json"; ln -s "$TD/route-real.json" "$CFG"
[ "$(run "$TEAM")" = 0 ] && ok "软链配置被读到" || { bad "软链未生效"; out; }
rm -f "$CFG"; setcfg "$CFG" '{}'

echo "== 8. 空列表**不误命中**（经典假阳性：空串匹配空行）=="
setcfg "$CFG" '{ "my_namespaces": [], "direct": [], "mr": [] }'
[ "$(run "$TEAM")" = 1 ] && ok "空名单 ⇒ MR" || { bad "空名单误放行"; out; }

echo "== 9. 坏 JSON ⇒ 不崩、按无配置处理并提示 =="
setcfg "$CFG" '{ this is not json'
RC="$(run "$TEAM")"
[ "$RC" = 1 ] && ok "退出码 1（安全侧）" || { bad "应 1（实得 ${RC}）"; out; }
see "JSON 解析失败" && ok "提示解析失败" || { bad "缺解析失败提示"; out; }

echo "== 10. \$DIA_WT_ROUTE_CONFIG 显式指定 ⇒ 最高优先（忽略其余）=="
setcfg "$CFG" '{ "direct": ["myrepo"] }'
EX="$TD/explicit.json"; setcfg "$EX" '{ "direct": ["teamrepo"] }'
env DIA_WT_ROUTE_CONFIG="$EX" bash "$WT" route "$TEAM" >"$TD/out.txt" 2>&1; RC=$?
[ "$RC" = 0 ] && ok "显式配置生效（teamrepo = owner 自合）" || { bad "显式配置未生效（rc=${RC}）"; out; }
env DIA_WT_ROUTE_CONFIG="$EX" bash "$WT" route "$MINE" >"$TD/out.txt" 2>&1; RC=$?
[ "$RC" = 1 ] && ok "其余配置被忽略（myrepo 走 LGTM+bot）" || { bad "应忽略数据根配置（rc=${RC}）"; out; }
rm -f "$EX"

echo "== 11. worktree 路径输入 ⇒ 归主仓判定 =="
setcfg "$CFG" '{ "direct": ["teamrepo"] }'
git -C "$TEAM" worktree add -q "$TD/teamrepo-worktree--t1" -b t1 >/dev/null 2>&1
RC="$(run "$TD/teamrepo-worktree--t1")"
[ "$RC" = 0 ] && ok "worktree 归主仓 → owner 自合" || { bad "worktree 判定错（rc=${RC}）"; out; }
see "teamrepo" && ok "报出主仓名" || { bad "未报主仓名"; out; }

echo "== 12. 非 git 目录 ⇒ 信息不足（rc=2）=="
mkdir -p "$TD/plain"
[ "$(run "$TD/plain")" = 2 ] && ok "退出码 2" || { bad "应 2"; out; }
see "不是 git 仓" && ok "给出理由" || { bad "缺理由"; out; }

echo
echo "── PASS $PASS · FAIL $FAIL ──"
rm -rf "$TD"
[ "$FAIL" = 0 ]
