#!/usr/bin/env bash
# dia global install: 安装物（bin/dist/packages/registry）与数据根（~/.dia）分离
#
#   DIA_INSTALL_DIR  安装目录，默认 ~/.local/share/dia（可用 --home 覆盖）
#   DIA_BIN_DIR      链接目录（生效路径），默认 ~/.local/bin（可用 --bin 覆盖）
#   DIA_ROOT         数据根，默认 ~/.dia（由 dia 代码解析，本脚本只在 --migrate 时搬旧根）
#   DIA_ALLOW_SCRIPT_INSTALL=1  默认 bin 已被包管理器全局安装占用时，显式允许脚本安装抢链接
#
# 退出码：0 装好｜1 前置缺失（dist/cli.js、bin/dia.js）｜2 用法｜3 守卫拒绝（未改动任何文件）
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 记下环境变量形态的显式路径：只有 **bin 目录被重定向**（≠ 默认 ~/.local/bin）才算「沙箱」放行，
# 只改安装目录不算——那样链接仍会写在默认生效路径上，守卫必须照旧生效。
ENV_INSTALL_DIR="${DIA_INSTALL_DIR:-${DIA_HOME_INSTALL:-}}"
ENV_BIN_DIR="${DIA_BIN_DIR:-}"
DEFAULT_BIN_DIR="$HOME/.local/bin"
DIA_INSTALL_DIR="${ENV_INSTALL_DIR:-$HOME/.local/share/dia}"
DIA_BIN_DIR="${ENV_BIN_DIR:-$DEFAULT_BIN_DIR}"
DATA_ROOT="${DIA_ROOT:-$HOME/.dia}"
OLD_DATA="${OLD_DIA_HOME:-$HOME/.local/share/dia}"
DRY=0; MIGRATE=0; EXPLICIT_INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --home|--install-dir) DIA_INSTALL_DIR="$2"; EXPLICIT_INSTALL=1; shift 2 ;;
    --bin) DIA_BIN_DIR="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --migrate) MIGRATE=1; shift ;;
    --force) echo "note: --force 已废弃（安装是覆盖式）" >&2; shift ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: install.sh [--home DIR] [--bin DIR] [--dry-run] [--migrate]" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }

# ── 可移植路径工具（不依赖 readlink -f / realpath(1)：macOS 自带的 bash 3.2 没有）──
# 逐级解析符号链接，再对 dirname 做 cd + pwd -P（顺带把 /var → /private/var 这类
# 目录级软链折叠掉）；链接断裂 / 目录不存在时原样返回，绝不报错。
realpath_portable() {
  local path="$1" link dir n=0
  case "$path" in
    /*) ;;
    *) path="$PWD/$path" ;;
  esac
  while [ -L "$path" ] && [ "$n" -lt 40 ]; do
    link="$(readlink "$path" 2>/dev/null)" || break
    [ -n "$link" ] || break
    case "$link" in
      /*) path="$link" ;;
      *) path="$(dirname "$path")/$link" ;;
    esac
    n=$((n + 1))
  done
  dir="$(cd "$(dirname "$path")" 2>/dev/null && pwd -P)" || dir="$(dirname "$path")"
  printf '%s/%s\n' "${dir%/}" "$(basename "$path")"
}

# ── 包管理器全局安装识别 ─────────────────────────────────────────────────
# 三类形态都要认（只认「realpath 含 node_modules/@minonl/dia」会漏掉 shim，事故与 npm 相同）：
#   A 软链/拷贝：真实路径含 node_modules/@minonl/dia（npm、bun 全局安装）
#   B shim 脚本：pnpm / yarn-berry 在全局 bin 放一段 shell 脚本，内容里带包路径
#   C 二进制 shim：volta 的 shim 不含包路径 → 靠全局 bin 目录归属识别
pkg_path_owned() {
  case "$1" in
    *node_modules[\\/]@minonl[\\/]dia|*node_modules[\\/]@minonl[\\/]dia[\\/]*) return 0 ;;
  esac
  return 1
}

# 规范化后的安装目录 / 旧数据根（`/var` vs `/private/var` 这类差异也要能对上）
REAL_INSTALL_DIR="$(realpath_portable "$DIA_INSTALL_DIR")"
REAL_OLD_DATA="$(realpath_portable "$OLD_DATA")"

# shim / 拷贝的内容是否指向包管理器的 dia
shim_owned() {
  local p="$1" head
  [ -f "$p" ] && [ ! -L "$p" ] && [ -r "$p" ] || return 1
  # 只读前 8KB；-d '\000' 去掉 NUL，避免 bash 变量里截断（二进制 shim 也能安全比对）
  head="$(LC_ALL=C head -c 8192 "$p" 2>/dev/null | tr -d '\000')"
  # 指向脚本安装（本脚本写的那条，以及旧数据根里的安装物）→ 不是包管理器安装
  case "$head" in
    *"$DIA_INSTALL_DIR/bin/dia.js"*|*"$REAL_INSTALL_DIR/bin/dia.js"*) return 1 ;;
    *"$OLD_DATA/bin/dia.js"*|*"$REAL_OLD_DATA/bin/dia.js"*) return 1 ;;
  esac
  printf '%s' "$head" | grep -qE '@minonl/dia|node_modules/(@minonl/)?dia/|/dia/bin/dia\.js'
}

# 已知包管理器全局 bin 目录（volta 这类同名二进制 shim 只能靠目录归属判断）
# 两边都折叠软链再比：/var/... vs /private/var/... 也能对上
pkg_bin_dir_owned() {
  local d known
  d="$(realpath_portable "$(dirname "${1%/}")")"
  for known in \
    "$HOME/.volta/bin" "$HOME/.bun/bin" "$HOME/.yarn/bin" \
    "$HOME/.pnpm-global/bin" "$HOME/.local/share/pnpm" "$HOME/.npm-global/bin" \
    "${PNPM_HOME:+${PNPM_HOME%/}}" "${YARN_GLOBAL_FOLDER:+${YARN_GLOBAL_FOLDER%/}}" \
    "${VOLTA_HOME:+${VOLTA_HOME%/}/bin}" "${BUN_INSTALL:+${BUN_INSTALL%/}/bin}"; do
    [ -n "$known" ] || continue
    case "$known" in /*) ;; *) continue ;; esac
    [ "$d" = "$(realpath_portable "${known%/}")" ] && return 0
  done
  return 1
}

# 目标 bin 是否属于包管理器的全局安装（$1 = 链接路径，$2 = 其真实路径）
pkg_owned() {
  pkg_path_owned "$2" && return 0
  pkg_path_owned "$1" && return 0
  # 本脚本自己写的安装（安装物目录）→ 永远不算包管理器安装（重复安装必须放行，
  # 即使 bin 目录恰好是 PNPM_HOME 之类的全局目录）
  case "$2" in
    "${DIA_INSTALL_DIR%/}"/*|"${REAL_INSTALL_DIR%/}"/*) return 1 ;;
    "${OLD_DATA%/}"/*|"${REAL_OLD_DATA%/}"/*) return 1 ;;
  esac
  shim_owned "$2" && return 0
  shim_owned "$1" && return 0
  pkg_bin_dir_owned "$1" && return 0
  pkg_bin_dir_owned "$2" && return 0
  return 1
}

# PATH 里第一个 dia（等价 command -v 的文件判定；shell 函数/alias 在脚本里不可见）
which_dia() {
  local rest="$1" dir cand
  while [ -n "$rest" ]; do
    case "$rest" in
      *:*) dir="${rest%%:*}"; rest="${rest#*:}" ;;
      *)   dir="$rest"; rest="" ;;
    esac
    [ -n "$dir" ] || continue
    cand="$dir/dia"
    if [ -f "$cand" ] && [ -x "$cand" ]; then printf '%s\n' "$cand"; return 0; fi
  done
  return 1
}

# ── --migrate：只搬数据子目录，不安装、不碰 bin 链接，成功后直接退出 ──────────
# （旧行为「搬完接着装」会顺带改写 bin，正是守卫要防的事；数据与安装物本就解耦）
DATA_SUBDIRS="personas msg agents state cache job runs audit tasks ingest runtime eval backups"
if [ "$MIGRATE" = 1 ]; then
  if [ ! -d "$OLD_DATA" ] || [ -z "$(ls -A "$OLD_DATA" 2>/dev/null)" ]; then
    echo "无需迁移：${OLD_DATA} 不存在或为空（本模式不安装、不改 bin 链接）"
    exit 0
  fi
  echo "迁移旧数据：${OLD_DATA}/{$DATA_SUBDIRS} → ${DATA_ROOT}"
  run mkdir -p "$DATA_ROOT"
  moved=0; failed=0
  for d in $DATA_SUBDIRS; do
    [ -e "$OLD_DATA/$d" ] || continue
    if [ -e "$DATA_ROOT/$d" ]; then
      # 目标已存在：合并（cp -R 保留两边内容，再删源）；失败计数
      if [ "$DRY" = 1 ]; then printf '[dry-run] merge %s → %s\n' "$OLD_DATA/$d" "$DATA_ROOT/$d"
      elif cp -R "$OLD_DATA/$d/." "$DATA_ROOT/$d/" 2>/dev/null; then rm -rf "$OLD_DATA/$d"
      else failed=$((failed+1)); echo "! 合并失败：$OLD_DATA/$d → $DATA_ROOT/$d" >&2; fi
    else
      if [ "$DRY" = 1 ]; then printf '[dry-run] mv %s → %s\n' "$OLD_DATA/$d" "$DATA_ROOT/$d"
      elif mv "$OLD_DATA/$d" "$DATA_ROOT/$d" 2>/dev/null; then :
      else failed=$((failed+1)); echo "! 迁移失败：$OLD_DATA/$d" >&2; fi
    fi
    moved=$((moved+1))
  done
  echo "migrate done：处理 ${moved} 个子目录，失败 ${failed}（本模式不安装、不改 bin 链接）"
  [ "$failed" = 0 ] || exit 1
  echo "安装/升级：npm i -g @minonl/dia@latest"
  exit 0
fi

[ -f "$SRC/dist/cli.js" ] || { echo "缺 dist/cli.js；先跑 bun run build" >&2; exit 1; }
[ -f "$SRC/bin/dia.js" ] || { echo "缺 bin/dia.js" >&2; exit 1; }

# ── 守卫 D1/D2：脚本安装不许抢走正在生效的包管理器全局安装 ───────────────────
# 判据是「抢链接」而不是「包存在」：只有 $DIA_BIN_DIR/dia 真实路径落在包管理器全局安装里
# （软链 → node_modules/@minonl/dia；pnpm/yarn/volta 的 shim → 内容/目录识别）、
# 且它就是 `command -v dia` 命中的那条时才拒绝（exit 3，零改动）。
# 逃生舱（任一命中即跳过守卫）：DIA_ALLOW_SCRIPT_INSTALL=1 / --dry-run /
# **生效 bin 目录被重定向**（--bin | DIA_BIN_DIR，且 ≠ 默认 ~/.local/bin）。
# 只改安装目录（--home/--install-dir/DIA_INSTALL_DIR/DIA_HOME_INSTALL）**不算**沙箱：
# 链接仍写在默认 bin，照样会抢走生效安装。
bin_redirected() {
  local a b
  # 先落成真实目录再比：`~/.local/bin/./`、`/x/../.local/bin` 这类别名不能绕过沙箱判定
  [ "$DRY" = 1 ] || mkdir -p "$DIA_BIN_DIR" 2>/dev/null || true
  a="$(cd "$DIA_BIN_DIR" 2>/dev/null && pwd -P)" || a="$(realpath_portable "${DIA_BIN_DIR%/}")"
  b="$(cd "$DEFAULT_BIN_DIR" 2>/dev/null && pwd -P)" || b="$(realpath_portable "${DEFAULT_BIN_DIR%/}")"
  [ -n "$a" ] && [ "$a" != "$b" ]
}
ALLOW=0
if [ "${DIA_ALLOW_SCRIPT_INSTALL:-}" = 1 ] || [ "$DRY" = 1 ]; then ALLOW=1; fi
if bin_redirected; then ALLOW=1; fi
if [ "$ALLOW" = 0 ] && { [ -n "$ENV_INSTALL_DIR" ] || [ "$EXPLICIT_INSTALL" = 1 ]; }; then
  printf '! note: 只改了安装目录，生效链接仍写在 %s/dia（沙箱需同时指定 --bin DIR 或 DIA_BIN_DIR）\n' "$DIA_BIN_DIR" >&2
fi

if [ "$ALLOW" = 0 ]; then
  LINK="$DIA_BIN_DIR/dia"
  if [ -L "$LINK" ] || [ -e "$LINK" ]; then
    LINK_REAL="$(realpath_portable "$LINK")"
    if pkg_owned "$LINK" "$LINK_REAL"; then
      EFF=""; EFF_REAL=""
      if EFF="$(which_dia "${PATH:-}" 2>/dev/null)"; then EFF_REAL="$(realpath_portable "$EFF")"; fi
      if [ -z "$EFF_REAL" ]; then
        printf '! note: %s 指向包管理器全局安装（%s），但 PATH 里没有 dia；继续安装\n' "$LINK" "$LINK_REAL" >&2
      elif [ "$EFF_REAL" = "$LINK_REAL" ]; then
        printf '! 拒绝安装：%s 当前指向包管理器的全局安装（npm/pnpm/yarn/bun/volta）\n    → %s\n' "$LINK" "$LINK_REAL" >&2
        printf '  脚本安装会覆盖这条链接（包管理器安装随之失效）。未改动任何文件（exit 3）。\n' >&2
        printf '  三条出路：\n' >&2
        printf '    1) 确实想用脚本安装：DIA_ALLOW_SCRIPT_INSTALL=1 bash install.sh\n' >&2
        printf '    2) 想回到 npm 安装：ln -sfn "$(npm prefix -g)/bin/dia" %s\n' "$LINK" >&2
        printf '    3) 只想装到别处（不碰生效链接）：bash install.sh --home DIR --bin BINDIR\n' >&2
        exit 3
      else
        printf '! note: %s 指向包管理器全局安装（%s），但当前生效的是 %s；继续安装\n' "$LINK" "$LINK_REAL" "$EFF_REAL" >&2
      fi
    fi
  fi

  # npm 包存在但默认 bin 没被它占用 → 只 warn 一行，继续安装（可能是旧残留）
  if command -v npm >/dev/null 2>&1; then
    NPM_ROOT="$(npm root -g 2>/dev/null || true)"
    if [ -n "$NPM_ROOT" ] && [ -d "$NPM_ROOT/@minonl/dia" ] && ! pkg_owned "$DIA_BIN_DIR/dia" "$(realpath_portable "$DIA_BIN_DIR/dia")"; then
      printf '! note: 检测到 npm 全局包（%s/@minonl/dia），但 %s/dia 未被它占用；继续脚本安装\n' "$NPM_ROOT" "$DIA_BIN_DIR" >&2
    fi
  fi
fi

# 旧数据根提示：只搬**数据子目录**，不碰安装物（bin/dist/packages/registry）
if [ -d "$OLD_DATA/personas" ] && [ ! -d "$DATA_ROOT/personas" ]; then
  echo "! 检测到旧数据根 ${OLD_DATA}；迁移数据：bash install.sh --migrate（只搬数据，不搬安装物）" >&2
fi

# 安装物：始终写 DIA_INSTALL_DIR，与数据根解耦
run mkdir -p "$DIA_INSTALL_DIR/bin" "$DIA_INSTALL_DIR/dist" "$DIA_INSTALL_DIR/packages/job" "$DIA_INSTALL_DIR/packages/wt" "$DIA_INSTALL_DIR/kits" "$DIA_INSTALL_DIR/registry" "$DIA_BIN_DIR"
run cp "$SRC/bin/dia.js" "$DIA_INSTALL_DIR/bin/dia.js"
run cp "$SRC/dist/cli.js" "$DIA_INSTALL_DIR/dist/cli.js"
run cp "$SRC/package.json" "$DIA_INSTALL_DIR/package.json"
# 所有 kit 源一起分发（dia-msg / git / node …）；安装到数据根由 `dia kit add` 完成
for _k in "$SRC"/kits/*/; do
  _k="${_k%/}"                              # 去尾斜杠：cp -R 带斜杠会"摊平"目录
  [ -d "$_k" ] && run cp -R "$_k" "$DIA_INSTALL_DIR/kits/"
done
run cp -R "$SRC/packages/job/bin" "$DIA_INSTALL_DIR/packages/job/"
run cp -R "$SRC/packages/job/lib" "$DIA_INSTALL_DIR/packages/job/"
run cp -R "$SRC/packages/wt/bin" "$DIA_INSTALL_DIR/packages/wt/"
if [ -f "$SRC/docs/platforms/registry.json" ]; then run cp "$SRC/docs/platforms/registry.json" "$DIA_INSTALL_DIR/registry/platforms.json"; fi
if [ -f "$SRC/docs/deps.jsonl" ]; then run cp "$SRC/docs/deps.jsonl" "$DIA_INSTALL_DIR/registry/deps.jsonl"; fi
run chmod +x "$DIA_INSTALL_DIR/packages/wt/bin/dia-wt"
run chmod +x "$DIA_INSTALL_DIR/bin/dia.js" "$DIA_INSTALL_DIR/packages/job/bin/dia-job"
# 记录来源：`dia update` 据此判断「脚本安装」并给出正确升级方式
run node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({tool:"dia",source:process.argv[2],installedAt:new Date().toISOString()},null,1)+"\n")' "$DIA_INSTALL_DIR/install.json" "$SRC"
# D6 原子写：先建临时链接再 rename，避免并发会话看到「命令短暂不存在」
LINK_TMP="$DIA_BIN_DIR/.dia.$$.tmp"
[ "$DRY" = 1 ] || rm -f "$LINK_TMP"
if [ "$DRY" = 1 ]; then
  run ln -s "$DIA_INSTALL_DIR/bin/dia.js" "$LINK_TMP"
  run mv -f "$LINK_TMP" "$DIA_BIN_DIR/dia"
else
  if ! ln -s "$DIA_INSTALL_DIR/bin/dia.js" "$LINK_TMP" 2>/dev/null; then
    echo "E_INSTALL: 链接创建失败：${LINK_TMP}（检查 ${DIA_BIN_DIR} 写权限）" >&2
    exit 1
  fi
  if ! mv -f "$LINK_TMP" "$DIA_BIN_DIR/dia" 2>/dev/null; then
    rm -f "$LINK_TMP"
    echo "E_INSTALL: 链接落位失败：$DIA_BIN_DIR/dia" >&2
    exit 1
  fi
fi
echo "dia installed: ${DIA_INSTALL_DIR}（安装物）；data root: ${DATA_ROOT}（数据）-> $DIA_BIN_DIR/dia"

# D4 安装后自检：把「实际生效的 dia」打出来，PATH 顺序 / 未生效可见化
TARGET="$DIA_BIN_DIR/dia"
if [ "$DRY" = 1 ]; then
  echo "effective: (dry-run) 未写入文件"
else
  EFF=""; EFF_REAL=""
  if EFF="$(which_dia "${PATH:-}" 2>/dev/null)"; then EFF_REAL="$(realpath_portable "$EFF")"; fi
  VER="$("$TARGET" version 2>/dev/null | head -1 | awk '{print $2}')"
  printf 'effective: %s%s\n' "${EFF_REAL:-（PATH 中没有 dia）}" "${VER:+ ($VER)}"
  if [ -n "$EFF_REAL" ] && [ "$EFF_REAL" != "$(realpath_portable "$TARGET")" ]; then
    printf '! warn: 生效的 dia 不是刚安装的这条（PATH 顺序或需重开终端）；期望 %s\n' "$TARGET" >&2
  fi
fi
