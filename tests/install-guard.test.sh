#!/usr/bin/env bash
# 安装守卫（D1/D2/D4/D5/D6）：默认路径被 npm 全局包占用时 install.sh 必须 exit 3 且**零文件改动**；
# 显式沙箱（--home/--bin/环境变量/--dry-run/DIA_ALLOW_SCRIPT_INSTALL=1）放行；装完打印实际生效的 dia；
# `dia doctor` 的 install_shadow 双向一致判定（不一致 fail，npm 一致安装必须 pass）。
# 全程只用 mktemp 临时目录：不碰真机 ~/.local/bin，也不探测真机 npm 环境。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# 目录快照：条目 / 软链目标 / 文件字节校验和（用于断言「守卫拒绝时零改动」）
snapshot() {
  find "$1" -mindepth 1 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
    if [ -L "$f" ]; then printf 'L %s -> %s\n' "$f" "$(readlink "$f")"
    elif [ -f "$f" ]; then printf 'F %s %s\n' "$f" "$(cksum < "$f" | awk '{print $1"-"$2}')"
    else printf 'D %s\n' "$f"; fi
  done
}

# 伪 npm 全局包：<dir>/node_modules/@minonl/dia（realpath 命中 node_modules/@minonl/dia 即算 npm 安装）
make_npm_pkg() {
  mkdir -p "$1/bin" "$1/dist"
  printf '#!/usr/bin/env node\nconsole.log("dia 0.0.0-npm");\n' > "$1/bin/dia.js"
  chmod +x "$1/bin/dia.js"
}

# 测试源树：优先用仓库真实 install.sh（dist 已 build 或能 build）；否则造最小 stub 源树，
# 让守卫/自检逻辑与 dist 是否就绪解耦（CI 会先 build，本地则按需 build 一次）。
make_stub_src() {
  local s="$1"
  mkdir -p "$s/bin" "$s/dist" "$s/kits/dia-msg" "$s/packages/job/bin" "$s/packages/job/lib" "$s/packages/wt/bin"
  cp "$ROOT/install.sh" "$s/install.sh"
  printf '#!/usr/bin/env node\nconsole.log("dia 0.0.0-stub");\n' > "$s/bin/dia.js"
  printf 'export {};\n' > "$s/dist/cli.js"
  printf '{"name":"@minonl/dia","version":"0.0.0-stub"}\n' > "$s/package.json"
  printf '#!/bin/sh\necho "dia-wt 0.0.0-stub"\n' > "$s/packages/wt/bin/dia-wt"
  printf '#!/bin/sh\necho "dia-job 0.0.0-stub"\n' > "$s/packages/job/bin/dia-job"
  printf '{}\n' > "$s/kits/dia-msg/dia.json"
  chmod +x "$s/bin/dia.js" "$s/packages/wt/bin/dia-wt" "$s/packages/job/bin/dia-job"
}

SRC_ROOT="$ROOT"
if [ ! -f "$ROOT/dist/cli.js" ]; then
  if command -v bun >/dev/null 2>&1 && ( cd "$ROOT" && bun run build >/dev/null 2>&1 ); then
    :
  else
    SRC_ROOT="$TD/src"; make_stub_src "$SRC_ROOT"
    echo "  · note: dist/cli.js 未就绪且无法 build → 使用 stub 源树（install.sh 原样复制）"
  fi
fi
INSTALL="$SRC_ROOT/install.sh"

NPM_PKG="$TD/global/node_modules/@minonl/dia"; make_npm_pkg "$NPM_PKG"
NPM_BIN="$TD/npmbin"; mkdir -p "$NPM_BIN"; ln -s "$NPM_PKG/bin/dia.js" "$NPM_BIN/dia"

echo "── ① 默认路径已被 npm 全局安装占用 → 拒绝（exit 3）且零改动 ──"
H1="$TD/h1"; mkdir -p "$H1/.local/bin"
ln -s "$NPM_PKG/bin/dia.js" "$H1/.local/bin/dia"
before_link="$(readlink "$H1/.local/bin/dia")"
before_snap="$(snapshot "$H1")"
out="$(HOME="$H1" PATH="$H1/.local/bin:$PATH" bash "$INSTALL" 2>&1)"; rc=$?
[ "$rc" = 3 ] && ok "exit 3" || { bad "期望 rc=3，实际 rc=$rc"; printf '%s\n' "$out" | tail -5; }
[ "$(readlink "$H1/.local/bin/dia")" = "$before_link" ] && ok "链接未被改写" || bad "链接被改写：$(readlink "$H1/.local/bin/dia")"
[ "$(snapshot "$H1")" = "$before_snap" ] && ok "目录内容字节不变（未创建安装目录）" || bad "文件被改动"
printf '%s' "$out" | grep -q 'DIA_ALLOW_SCRIPT_INSTALL=1' && ok "文案给出出路 1（显式放行）" || bad "缺显式放行文案"
printf '%s' "$out" | grep -q 'npm prefix -g' && ok "文案给出出路 2（回到 npm 安装）" || bad "缺 npm 修复命令"

echo "── ② 显式放行（逃生舱）→ exit 0 ──"
# ②-a DIA_ALLOW_SCRIPT_INSTALL=1：默认路径 + 默认 bin 被 npm 占用，人类显式意图
H2="$TD/h2"; mkdir -p "$H2/.local/bin"
ln -s "$NPM_PKG/bin/dia.js" "$H2/.local/bin/dia"
out="$(HOME="$H2" PATH="$H2/.local/bin:$PATH" DIA_ALLOW_SCRIPT_INSTALL=1 bash "$INSTALL" 2>&1)"; rc=$?
if [ "$rc" = 0 ]; then
  ok "DIA_ALLOW_SCRIPT_INSTALL=1 → rc=0"
  [ "$(readlink "$H2/.local/bin/dia")" = "$H2/.local/share/dia/bin/dia.js" ] && ok "链接改为脚本安装" || bad "链接目标错：$(readlink "$H2/.local/bin/dia")"
  printf '%s' "$out" | grep -q '^dia installed: ' && ok "打印 installed 行" || bad "缺 installed 行"
  printf '%s' "$out" | grep -q '^effective: ' && ok "打印 effective 行（D4 自检）" || bad "缺 effective 行"
  printf '%s' "$out" | grep -q '^effective: .*(' && ok "effective 行带版本" || bad "effective 行缺版本"
  printf '%s' "$out" | grep -q '! warn:' && bad "同一条链接仍报「未生效」" || ok "生效路径与目标一致（无 warn）"
  [ -z "$(find "$H2/.local/bin" -name '.dia.*.tmp' -print -quit)" ] && ok "原子写无临时链接残留" || bad "残留临时链接"
else
  bad "期望 rc=0，实际 rc=$rc"; printf '%s\n' "$out" | tail -5
fi

# ②-b --dry-run：演练不落盘
H3="$TD/h3"; mkdir -p "$H3/.local/bin"
ln -s "$NPM_PKG/bin/dia.js" "$H3/.local/bin/dia"
before_snap="$(snapshot "$H3")"
out="$(HOME="$H3" PATH="$H3/.local/bin:$PATH" bash "$INSTALL" --dry-run 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "--dry-run → rc=0" || bad "期望 rc=0，实际 rc=$rc"
[ "$(snapshot "$H3")" = "$before_snap" ] && ok "--dry-run 未写任何文件" || bad "--dry-run 有落盘"
printf '%s' "$out" | grep -q '^effective: ' && ok "--dry-run 打印 effective 行" || bad "dry-run 缺 effective 行"

# ②-c 显式 --home + --bin（沙箱路径）
H4="$TD/h4"; mkdir -p "$H4/.local/bin"
ln -s "$NPM_PKG/bin/dia.js" "$H4/.local/bin/dia"
out="$(HOME="$H4" PATH="$H4/.local/bin:$PATH" bash "$INSTALL" --home "$TD/inst4" --bin "$TD/bin4" 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "--home/--bin → rc=0" || { bad "期望 rc=0，实际 rc=$rc"; printf '%s\n' "$out" | tail -5; }
[ "$(readlink "$TD/bin4/dia" 2>/dev/null)" = "$TD/inst4/bin/dia.js" ] && ok "装到显式指定路径" || bad "显式路径未生效"

# ②-d 环境变量形态（老测试/test 常用）同样算沙箱，不被误拦
H5="$TD/h5"; mkdir -p "$H5/.local/bin"
ln -s "$NPM_PKG/bin/dia.js" "$H5/.local/bin/dia"
out="$(HOME="$H5" PATH="$H5/.local/bin:$PATH" DIA_INSTALL_DIR="$TD/inst5" DIA_BIN_DIR="$TD/bin5" bash "$INSTALL" 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "DIA_INSTALL_DIR/DIA_BIN_DIR → rc=0（不误拦）" || bad "期望 rc=0，实际 rc=$rc"

echo "── ③ npm 包存在但默认 bin 未被占用 → 只 warn 一行后继续 ──"
H6="$TD/h6"; mkdir -p "$H6/.local/bin" "$TD/fakeglobal/@minonl/dia" "$TD/fakebin"
printf '#!/bin/sh\n[ "$1 $2" = "root -g" ] && { echo "%s"; exit 0; }\nexit 0\n' "$TD/fakeglobal" > "$TD/fakebin/npm"
chmod +x "$TD/fakebin/npm"
out="$(HOME="$H6" PATH="$H6/.local/bin:$TD/fakebin:$PATH" bash "$INSTALL" 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "rc=0（继续安装）" || { bad "期望 rc=0，实际 rc=$rc"; printf '%s\n' "$out" | tail -5; }
printf '%s' "$out" | grep -q '检测到 npm 全局包' && ok "打印 npm 包提示" || bad "缺 npm 包提示"
[ "$(readlink "$H6/.local/bin/dia" 2>/dev/null)" = "$H6/.local/share/dia/bin/dia.js" ] && ok "链接已建立" || bad "链接未建立"

echo "── ④ doctor install_shadow：双向一致判定 ──"
dia_doctor() {
  if command -v bun >/dev/null 2>&1; then bun "$ROOT/packages/cli/src/index.ts" doctor "$@"
  elif [ -f "$ROOT/dist/cli.js" ]; then node "$ROOT/dist/cli.js" doctor "$@"
  else return 127; fi
}
DROOT="$TD/droot"
if dia_doctor >/dev/null 2>&1 || [ $? -ne 127 ]; then
  # ④-a 源码运行（无 install.json 且非 npm 包）→ 跳过一致性判定，不误报
  out="$(DIA_ROOT="$DROOT" PATH="$NPM_BIN:$PATH" dia_doctor 2>&1)"
  printf '%s' "$out" | grep -q 'install_shadow' && ok "doctor 输出含 install_shadow" || bad "doctor 缺 install_shadow"
  printf '%s' "$out" | grep -qE '^✓ install_shadow' && ok "源码运行 → 跳过（不误报 fail）" || bad "源码运行被误判"
  printf '%s' "$out" | grep -q '源码运行' && ok "说明跳过原因" || bad "缺跳过原因"

  # ④-b 不一致（事故形态）：install 是 npm 包，PATH 的 dia 却是脚本安装 → fail，且给 npm 回链命令
  out="$(DIA_ROOT="$DROOT" DIA_INSTALL_DIR="$NPM_PKG" PATH="$H2/.local/bin:$PATH" dia_doctor 2>&1)"
  printf '%s' "$out" | grep -qE '^! install_shadow' && ok "不一致（脚本 bin 遮挡 npm 包）→ warn" || bad "事故形态未判 warn"
  printf '%s' "$out" | grep -q 'npm prefix -g' && ok "给出 npm 修复命令" || bad "缺 npm prefix -g 修复命令"

  # ④-c 一致（脚本安装）：PATH 里的 dia 也指向脚本安装 → 不 fail
  out="$(DIA_ROOT="$DROOT" PATH="$H2/.local/bin:$PATH" dia_doctor 2>&1)"
  printf '%s' "$out" | grep -qE '^✓ install_shadow' && ok "脚本安装一致 → pass" || bad "脚本安装一致被误判"

  # ④-d 一致（npm 安装）：install 与 PATH bin 同在 node_modules/@minonl/dia 下 → 必须 pass
  out="$(DIA_ROOT="$DROOT" DIA_INSTALL_DIR="$NPM_PKG" PATH="$NPM_BIN:$PATH" dia_doctor 2>&1)"
  printf '%s' "$out" | grep -qE '^✓ install_shadow' && ok "npm 一致安装 → pass（不误报）" || bad "npm 一致安装被误判"

  # ④-e volta 形态：bin 目录归属已知包管理器全局 bin（shim 不含包路径）→ 仍判 fail
  VOLTA_BIN="$TD/volta/bin"; mkdir -p "$VOLTA_BIN" "$TD/inst-v"
  printf '#!/bin/sh\nexit 0\n' > "$VOLTA_BIN/dia"; chmod +x "$VOLTA_BIN/dia"
  printf '{"tool":"dia","source":"%s"}\n' "$TD/inst-v" > "$TD/inst-v/install.json"
  out="$(DIA_ROOT="$DROOT" DIA_INSTALL_DIR="$TD/inst-v" VOLTA_HOME="$TD/volta" PATH="$VOLTA_BIN:$PATH" dia_doctor 2>&1)"
  printf '%s' "$out" | grep -qE '^! install_shadow' && ok "volta bin 目录归属 → warn（不漏判）" || bad "volta 形态未判 warn"
else
  bad "缺少 bun/node，无法运行 dia doctor（install_shadow 未验证）"
fi

echo "── ⑤ 链接落位失败 → 非 0（不再谎报装好） ──"
if [ "$(id -u)" != 0 ]; then
  H7="$TD/h7"; ROBIN="$TD/robin"
  mkdir -p "$H7/.local/bin" "$ROBIN"; chmod 500 "$ROBIN"
  out="$(HOME="$H7" PATH="$H7/.local/bin:$PATH" DIA_INSTALL_DIR="$TD/inst8" DIA_BIN_DIR="$ROBIN" bash "$INSTALL" 2>&1)"; rc=$?
  chmod 700 "$ROBIN"
  [ "$rc" = 1 ] && ok "写不了 bin 目录 → rc=1" || { bad "期望 rc=1，实际 rc=$rc"; printf '%s\n' "$out" | tail -3; }
  printf '%s' "$out" | grep -q 'E_INSTALL' && ok "给出 E_INSTALL 说明" || bad "缺 E_INSTALL 说明"
else
  ok "root 跳过权限用例（写不了目录无法模拟）"
fi

echo "── ⑥ --migrate 只搬数据：不改 bin 链接、rc=0 ──"
H8="$TD/h8"; mkdir -p "$H8/.local/share/dia/personas/dabo" "$H8/.local/bin"
ln -s "$NPM_PKG/bin/dia.js" "$H8/.local/bin/dia"
before="$(readlink "$H8/.local/bin/dia")"
out="$(HOME="$H8" PATH="$H8/.local/bin:$PATH" bash "$INSTALL" --migrate 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "--migrate → rc=0" || { bad "期望 rc=0，实际 rc=$rc"; printf '%s\n' "$out" | tail -3; }
[ -d "$H8/.dia/personas/dabo" ] && ok "数据已迁到 ~/.dia" || bad "数据未迁移"
[ "$(readlink "$H8/.local/bin/dia")" = "$before" ] && ok "bin 链接未被改写" || bad "bin 链接被改写"

echo "── ⑦ PATH 里没有 dia 时不挂死（旧版 which_dia 死循环） ──"
H9="$TD/h9"; mkdir -p "$H9/.local/bin"
# 便携 watchdog：CI 的 macOS 没有 timeout(1)（用它会 rc=127 假失败）
run_watchdog() {
  local secs="$1"; shift
  "$@" & local pid=$! n=0
  while kill -0 "$pid" 2>/dev/null; do
    n=$((n+1))
    if [ "$n" -ge "$secs" ]; then kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 124; fi
    sleep 1
  done
  wait "$pid"; return $?
}
out="$(HOME="$H9" PATH="/usr/bin:/bin" run_watchdog 8 bash "$INSTALL" 2>&1)"; rc=$?
[ "$rc" != 124 ] && ok "无 dia 的 PATH → 未挂死（rc=${rc}）" || bad "PATH 无 dia 时挂死（rc=124）"
[ "$(readlink "$H9/.local/bin/dia" 2>/dev/null)" = "$H9/.local/share/dia/bin/dia.js" ] && ok "链接照常建立" || bad "链接未建立"

echo "── ⑧ bash 3.2 兼容：--migrate 不因全角字符紧贴变量名而崩 ──"
if [ -x /bin/bash ] && [ "$(/bin/bash -c 'echo ${BASH_VERSINFO[0]}')" -lt 4 ]; then
  H10="$TD/h10"; mkdir -p "$H10/.local/share/dia/personas/dabo"
  out="$(HOME="$H10" /bin/bash "$INSTALL" --migrate 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "/bin/bash 3.2 下 --migrate → rc=0" || { bad "/bin/bash 3.2 下 rc=$rc"; printf '%s\n' "$out" | tail -3; }
  [ -d "$H10/.dia/personas/dabo" ] && ok "数据已迁移" || bad "数据未迁移"
else
  ok "无 bash 3.2（跳过）"
fi

echo "── ⑨ --bin 别名/相对路径不能绕过沙箱判定 ──"
H11="$TD/h11"; mkdir -p "$H11/.local/bin"
ln -s "$NPM_PKG/bin/dia.js" "$H11/.local/bin/dia"
before="$(readlink "$H11/.local/bin/dia")"
for alias in "$H11/.local/bin/./" "$H11/nope/../.local/bin"; do
  out="$(HOME="$H11" PATH="$H11/.local/bin:$PATH" bash "$INSTALL" --bin "$alias" 2>&1)"; rc=$?
  [ "$rc" = 3 ] && ok "--bin ${alias#"$H11"} → rc=3" || { bad "--bin ${alias#"$H11"} 绕过守卫（rc=$rc）"; printf '%s\n' "$out" | tail -3; }
done
[ "$(readlink "$H11/.local/bin/dia")" = "$before" ] && ok "npm 链接未被改写" || bad "npm 链接被改写"

echo "── ⑩ bash 3.2：旧数据根提示不得崩（全角字符紧贴变量名） ──"
if [ -x /bin/bash ] && [ "$(/bin/bash -c 'echo ${BASH_VERSINFO[0]}')" -lt 4 ]; then
  H12="$TD/h12"; mkdir -p "$H12/.local/share/dia/personas/dabo"
  out="$(HOME="$H12" /bin/bash "$INSTALL" --bin "$TD/bin12" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "/bin/bash 3.2 + 旧数据根 → rc=0" || { bad "/bin/bash 3.2 崩溃 rc=$rc"; printf '%s\n' "$out" | tail -3; }
else
  ok "无 bash 3.2（跳过）"
fi

echo; echo "── PASS $PASS · FAIL $FAIL ──"; [ "$FAIL" = 0 ]
