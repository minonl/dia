#!/usr/bin/env bash
# gc --orphans 回归（issue #258）：launchd 里残留、但 plist 不在当前 HOME/job 根的服务
set -uo pipefail
[ "$(uname -s)" = Darwin ] || { echo "  · 跳过（仅 macOS：需要 launchd 语义）"; exit 0; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YT="$HERE/../bin/dia-job"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }; bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

export HOME="$TD/home"; mkdir -p "$HOME/Library/LaunchAgents"
export XDG_CONFIG_HOME="$TD/xdg"
export DIA_JOB_ROOT="$TD/root"; export YAN_DATA_ROOT="$DIA_JOB_ROOT"; mkdir -p "$DIA_JOB_ROOT/tasks"
export DIA_JOB_CONFIG=/dev/null
export DIA_JOB_LABEL_PREFIX="local.dia-job-"
export DIA_JOB_NO_LAUNCHD=0
export BOOTLOG="$TD/bootout.log"; : > "$BOOTLOG"

FAKE="$TD/fake"; mkdir -p "$FAKE"
cat > "$FAKE/launchctl" <<'SH'
#!/bin/bash
case "$1" in
  list)
    echo "PID	Status	Label"
    echo "-	0	local.dia-job-orphan"
    echo "-	0	local.dia-job-current"
    ;;
  print)
    case "${2:-}" in
      *local.dia-job-orphan)  echo "	path = /var/folders/xx/T/tmp.abc/Library/LaunchAgents/local.dia-job-orphan.plist" ;;
      *local.dia-job-current) echo "	path = $HOME/Library/LaunchAgents/local.dia-job-current.plist" ;;
      *local.dia-job-uninstall-fail) echo "	path = $HOME/Library/LaunchAgents/local.dia-job-uninstall-fail.plist" ;;
      *) exit 1 ;;
    esac ;;
  bootout)
    case "$2" in *local.dia-job-uninstall-fail) exit 1 ;; esac
    printf '%s\n' "$2" >> "$BOOTLOG" ;;
  *) exit 2 ;;
esac
SH
chmod +x "$FAKE/launchctl"
export PATH="$FAKE:$PATH"

echo "== 1. dry-run 只列出孤儿，不碰当前根任务 =="
out="$(bash "$YT" gc --orphans 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "rc=0" || bad "rc=$rc：$out"
printf '%s' "$out" | grep -q 'local.dia-job-orphan' && ok "列出 temp plist 的孤儿" || bad "未列出孤儿：$out"
printf '%s' "$out" | grep -q 'local.dia-job-current' && bad "误列当前根任务" || ok "不列当前根任务"
[ ! -s "$BOOTLOG" ] && ok "dry-run 不 bootout" || bad "dry-run 执行了 bootout"

echo "== 2. --apply 只 bootout 孤儿 =="
out="$(bash "$YT" gc --orphans --apply 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "rc=0" || bad "rc=$rc：$out"
grep -q 'local.dia-job-orphan' "$BOOTLOG" && ok "孤儿已 bootout" || bad "未 bootout 孤儿"
grep -q 'local.dia-job-current' "$BOOTLOG" && bad "误 bootout 当前根任务" || ok "当前根任务未被动"

echo "== 3. DIA_JOB_NO_LAUNCHD=1 时 --apply 降级为只列出 =="
: > "$BOOTLOG"
out="$(DIA_JOB_NO_LAUNCHD=1 bash "$YT" gc --orphans --apply 2>&1)"
printf '%s' "$out" | grep -q '只列出' && ok "明确提示降级" || bad "未提示降级：$out"
[ ! -s "$BOOTLOG" ] && ok "隔离模式下不 bootout" || bad "隔离模式仍 bootout"

echo "== 4. uninstall：bootout 失败必须显式报错，且不删 plist/registry =="
cat > "$DIA_JOB_ROOT/tasks/registry.json" <<'JSON'
{"tasks":{"uninstall-fail":{"type":"periodic","backend":"launchd","label":"local.dia-job-uninstall-fail","cmd":"echo x","interval":"300","calendar":"-","desc":"x"}}}
JSON
P="$HOME/Library/LaunchAgents/local.dia-job-uninstall-fail.plist"
cat > "$P" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>local.dia-job-uninstall-fail</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIA_JOB_ROOT/tasks/uninstall-fail.sh</string></array>
</dict></plist>
PLIST
out="$(bash "$YT" uninstall uninstall-fail 2>&1)"; rc=$?
[ "$rc" != 0 ] && ok "uninstall 返回非 0" || bad "uninstall 静默成功：$out"
printf '%s' "$out" | grep -q 'bootout 失败' && ok "显式报错" || bad "未报错：$out"
[ -f "$P" ] && ok "保留 plist（可重试）" || bad "失败时删了 plist"
grep -q 'uninstall-fail' "$DIA_JOB_ROOT/tasks/registry.json" && ok "保留 registry（可重试）" || bad "失败时删了 registry"

echo
echo "── PASS $PASS · FAIL $FAIL ──"
[ "$FAIL" = 0 ]
