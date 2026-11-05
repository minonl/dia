#!/usr/bin/env bash
# 卸载 bw broker 的 launchd 服务。
set -uo pipefail
LABEL="com.minzhao.dia-bw-broker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[ -f "$PLIST" ] || { echo "未安装：$PLIST 不存在"; exit 0; }
launchctl unload -w "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "已卸载；session 文件保留（需要时 dia env bw lock）"
