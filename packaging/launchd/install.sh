#!/usr/bin/env bash
# 安装 bw broker 的 launchd 服务（macOS）。
# 用法：packaging/launchd/install.sh [--passwordfile P] [--dry-run] [--yes]
# 默认只打印将要做的事；--yes 才落盘并 load。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIA_BIN="${DIA_BIN:-$HOME/.local/bin/dia}"
LABEL="com.minzhao.dia-bw-broker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PWFILE=""; DRY=1
while [ $# -gt 0 ]; do
  case "$1" in
    --passwordfile) PWFILE="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --yes) DRY=0; shift ;;
    -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: $0 [--passwordfile P] [--dry-run] [--yes]" >&2; exit 2 ;;
  esac
done

[ -x "$DIA_BIN" ] || { echo "E_DIA: $DIA_BIN 不存在" >&2; exit 1; }
if [ -n "$PWFILE" ] && [ ! -r "$PWFILE" ]; then echo "E_PW: 读不到 $PWFILE" >&2; exit 1; fi

tmp="$(mktemp)"
sed -e "s#@DIA_BIN@#$DIA_BIN#g" -e "s#@HOME@#$HOME#g" "$HERE/com.minzhao.dia-bw-broker.plist.template" > "$tmp"
if [ -n "$PWFILE" ]; then
  sed -i '' -e "s#@BW_PASSWORD_FILE@#$PWFILE#g" "$tmp"
else
  # 不带 --passwordfile：删掉这两行（改为等人工 dia env bw unlock）
  python3 - "$tmp" <<'PY'
import sys, re
p=sys.argv[1]; s=open(p).read()
s=re.sub(r'\n\s*<!-- 可选：启动时自动解锁.*?-->\s*\n\s*<string>--passwordfile</string>\s*\n\s*<string>@BW_PASSWORD_FILE@</string>', '', s, flags=re.S)
open(p,'w').write(s)
PY
fi

echo "将写入：$PLIST"
echo "  binary: $DIA_BIN"
echo "  passwordfile: ${PWFILE:-（不自动解锁）}"
if [ "$DRY" = 1 ]; then echo "[dry-run] 加 --yes 才会落盘并 load"; rm -f "$tmp"; exit 0; fi
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.dia/logs"
cp "$tmp" "$PLIST" && rm -f "$tmp"
launchctl unload -w "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"
echo "已安装：launchctl list | grep dia-bw-broker"
