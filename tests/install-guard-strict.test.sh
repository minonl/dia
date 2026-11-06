#!/usr/bin/env bash
# 守卫收紧回归（D0.65 的高危洞）：
#   ① 只改**安装目录**（--home/--install-dir/DIA_INSTALL_DIR/DIA_HOME_INSTALL）不算沙箱：
#      生效链接仍写在默认 ~/.local/bin/dia，所以默认 bin 被包管理器占用时仍须 exit 3、零改动。
#   ② 全局 bin 是 **shim**（pnpm / yarn-berry / volta）而不是 node_modules 软链时同样拒绝：
#      覆盖 shim 的事故形态与 npm 一致（rc=0 静默抢链接）。
#   ③ 控制组：真·沙箱（bin 目录重定向）放行；普通用户自建 wrapper（非包管理器）不被误拦；
#      重复安装自己的脚本安装保持 rc=0。
# 全程只用 mktemp 临时目录：不碰真机 ~/.local/bin，也不探测真机 npm 环境。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

snapshot() {
  find "$1" -mindepth 1 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
    if [ -L "$f" ]; then printf 'L %s -> %s\n' "$f" "$(readlink "$f")"
    elif [ -f "$f" ]; then printf 'F %s %s\n' "$f" "$(cksum < "$f" | awk '{print $1"-"$2}')"
    else printf 'D %s\n' "$f"; fi
  done
}

# 最小 stub 源树：守卫只看 install.sh 的行为，与 dist 是否 build 解耦
SRC="$TD/src"
mkdir -p "$SRC/bin" "$SRC/dist" "$SRC/kits/dia-msg" "$SRC/packages/job/bin" "$SRC/packages/job/lib" "$SRC/packages/wt/bin"
cp "$ROOT/install.sh" "$SRC/install.sh"
printf '#!/usr/bin/env node\nconsole.log("dia 0.0.0-stub");\n' > "$SRC/bin/dia.js"
printf 'export {};\n' > "$SRC/dist/cli.js"
printf '{"name":"@minonl/dia","version":"0.0.0-stub"}\n' > "$SRC/package.json"
printf '#!/bin/sh\necho "dia-wt 0.0.0-stub"\n' > "$SRC/packages/wt/bin/dia-wt"
printf '#!/bin/sh\necho "dia-job 0.0.0-stub"\n' > "$SRC/packages/job/bin/dia-job"
printf '{}\n' > "$SRC/kits/dia-msg/dia.json"
chmod +x "$SRC/bin/dia.js" "$SRC/packages/wt/bin/dia-wt" "$SRC/packages/job/bin/dia-job"
INSTALL="$SRC/install.sh"

# 伪 npm 全局包：realpath 落在 node_modules/@minonl/dia
make_npm_home() {
  local h="$1" pkg="$2"
  mkdir -p "$h/.local/bin" "$pkg/bin"
  printf '#!/usr/bin/env node\nconsole.log("dia 0.0.0-npm");\n' > "$pkg/bin/dia.js"
  chmod +x "$pkg/bin/dia.js"
  ln -s "$pkg/bin/dia.js" "$h/.local/bin/dia"
}

# ── ① 只改安装目录不算沙箱：默认 bin 被占用 → exit 3、零改动 ──
echo "── ① 只改安装目录（--home/--install-dir/环境变量）→ 守卫仍生效 ──"
# 断言「拒绝且零改动」
expect_reject() {  # $1=label $2=home $3=原链接目标 $4=目录快照 $5=输出 $6=rc
  local label="$1" h="$2" link_before="$3" snap_before="$4" out="$5" rc="$6"
  [ "$rc" = 3 ] && ok "$label → exit 3" || { bad "$label 期望 rc=3，实际 rc=$rc"; printf '%s\n' "$out" | tail -3; }
  [ "$(readlink "$h/.local/bin/dia")" = "$link_before" ] && ok "$label 生效链接未被改写" || bad "$label 链接被抢：$(readlink "$h/.local/bin/dia")"
  [ "$(snapshot "$h")" = "$snap_before" ] && ok "$label 零改动" || bad "$label 有落盘"
}

HA="$TD/i-home"; make_npm_home "$HA" "$HA/pkg/node_modules/@minonl/dia"
lb="$(readlink "$HA/.local/bin/dia")"; sb="$(snapshot "$HA")"
out="$(HOME="$HA" PATH="$HA/.local/bin:$PATH" bash "$INSTALL" --home "$TD/inst-a" 2>&1)"; rc=$?
expect_reject "--home" "$HA" "$lb" "$sb" "$out" "$rc"

HB="$TD/i-installdir"; make_npm_home "$HB" "$HB/pkg/node_modules/@minonl/dia"
lb="$(readlink "$HB/.local/bin/dia")"; sb="$(snapshot "$HB")"
out="$(HOME="$HB" PATH="$HB/.local/bin:$PATH" bash "$INSTALL" --install-dir "$TD/inst-b" 2>&1)"; rc=$?
expect_reject "--install-dir" "$HB" "$lb" "$sb" "$out" "$rc"

HC="$TD/i-envdir"; make_npm_home "$HC" "$HC/pkg/node_modules/@minonl/dia"
lb="$(readlink "$HC/.local/bin/dia")"; sb="$(snapshot "$HC")"
out="$(HOME="$HC" PATH="$HC/.local/bin:$PATH" DIA_INSTALL_DIR="$TD/inst-c" bash "$INSTALL" 2>&1)"; rc=$?
expect_reject "DIA_INSTALL_DIR" "$HC" "$lb" "$sb" "$out" "$rc"

HD="$TD/i-envhome"; make_npm_home "$HD" "$HD/pkg/node_modules/@minonl/dia"
lb="$(readlink "$HD/.local/bin/dia")"; sb="$(snapshot "$HD")"
out="$(HOME="$HD" PATH="$HD/.local/bin:$PATH" DIA_HOME_INSTALL="$TD/inst-d" bash "$INSTALL" 2>&1)"; rc=$?
expect_reject "DIA_HOME_INSTALL" "$HD" "$lb" "$sb" "$out" "$rc"

# ── ② shim 形态的包管理器全局安装（pnpm / yarn-berry / volta）──
echo "── ② 全局 bin 是 shim（pnpm/yarn/volta）→ 同样 exit 3、shim 字节不变 ──"
check_shim() {
  local label="$1" body="$2"
  local h="$TD/s-$(printf '%s' "$label" | tr -c 'a-zA-Z0-9' '_')"
  mkdir -p "$h/.local/bin"
  printf '%s\n' "$body" > "$h/.local/bin/dia"; chmod +x "$h/.local/bin/dia"
  local before out rc
  before="$(cksum < "$h/.local/bin/dia")"
  out="$(HOME="$h" PATH="$h/.local/bin:$PATH" DIA_INSTALL_DIR="$TD/inst-shim" bash "$INSTALL" 2>&1)"; rc=$?
  [ "$rc" = 3 ] && ok "$label → exit 3" || { bad "$label 期望 rc=3，实际 rc=$rc"; printf '%s\n' "$out" | tail -3; }
  [ "$(cksum < "$h/.local/bin/dia")" = "$before" ] && ok "$label shim 未被覆盖" || bad "$label shim 被覆盖"
}
check_shim "pnpm-shim" '#!/bin/sh
basedir=$(dirname "$0")
exec node "$basedir/../global/5/node_modules/@minonl/dia/bin/dia.js" "$@"'
check_shim "yarn-shim" '#!/bin/sh
exec node /yarn/global/dia/bin/dia.js "$@"'
# volta 的 shim 是不含包路径的同名二进制 → 靠 ~/.volta/bin 目录归属识别
HV="$TD/h-volta"; mkdir -p "$HV/.volta/bin" "$HV/.local/bin"
printf '\177ELF\001\002\001\000\000\000\000\000\000\000\000\000\002\000\076\000\001\000\000\000' > "$HV/.volta/bin/dia"
chmod +x "$HV/.volta/bin/dia"
ln -s "$HV/.volta/bin/dia" "$HV/.local/bin/dia"
out="$(HOME="$HV" PATH="$HV/.local/bin:$PATH" bash "$INSTALL" 2>&1)"; rc=$?
[ "$rc" = 3 ] && ok "volta-shim → exit 3" || { bad "volta-shim 期望 rc=3，实际 rc=$rc"; printf '%s\n' "$out" | tail -3; }
[ "$(readlink "$HV/.local/bin/dia")" = "$HV/.volta/bin/dia" ] && ok "volta shim 未被覆盖" || bad "volta shim 被覆盖"

# ── ③ 控制组：真沙箱放行、非包管理器 wrapper 不误拦 ──
echo "── ③ 控制组：沙箱放行 / 普通 wrapper 不误拦 ──"
H3="$TD/h-sandbox"; make_npm_home "$H3" "$H3/pkg/node_modules/@minonl/dia"
out="$(HOME="$H3" PATH="$H3/.local/bin:$PATH" bash "$INSTALL" --home "$TD/inst-e" --bin "$TD/bin-e" 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "--home + --bin → rc=0（真沙箱）" || bad "沙箱期望 rc=0，实际 rc=$rc"
[ "$(readlink "$TD/bin-e/dia" 2>/dev/null)" = "$TD/inst-e/bin/dia.js" ] && ok "沙箱内链接正确" || bad "沙箱链接未建立"

H4="$TD/h-wrap"; mkdir -p "$H4/.local/bin"
printf '#!/bin/sh\nexec node /opt/mytools/dia.js "$@"\n' > "$H4/.local/bin/dia"; chmod +x "$H4/.local/bin/dia"
out="$(HOME="$H4" PATH="$H4/.local/bin:$PATH" bash "$INSTALL" 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "普通 wrapper（非包管理器）→ rc=0（不误拦）" || bad "普通 wrapper 被误拦（rc=${rc}）"

H5="$TD/h-reinstall"; mkdir -p "$H5/.local/bin"
HOME="$H5" PATH="$H5/.local/bin:$PATH" bash "$INSTALL" >/dev/null 2>&1
out="$(HOME="$H5" PATH="$H5/.local/bin:$PATH" bash "$INSTALL" 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "重复安装脚本安装 → rc=0（幂等）" || bad "重复安装期望 rc=0，实际 rc=$rc"

# shim 指向**脚本安装**（不是包管理器）→ 不误拦
H6="$TD/h-shim-script"; mkdir -p "$H6/.local/bin"
printf '#!/bin/sh\nexec node %s/.local/share/dia/bin/dia.js "$@"\n' "$H6" > "$H6/.local/bin/dia"
chmod +x "$H6/.local/bin/dia"
out="$(HOME="$H6" PATH="$H6/.local/bin:$PATH" bash "$INSTALL" 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "shim 指向脚本安装 → rc=0（不误拦）" || bad "指向脚本安装的 shim 被误拦（rc=${rc}）"

echo; echo "── PASS $PASS · FAIL $FAIL ──"; [ "$FAIL" = 0 ]
