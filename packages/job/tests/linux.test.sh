#!/usr/bin/env bash
# linux.test.sh —— Linux/WSL 后端（periodic=crontab、service=systemd --user）的行为约束
#
# 为什么要有这份（2026-10-30）：Linux 后端此前只有 `return 3 未实现` ⇒ 一旦落地，
#   「装了但不会跑」是最坏的失败模式（cron 没有进程状态、systemd 不 active 也照样"注册成功"）。
#   ⇒ 本测试用**假的 crontab / systemctl**（沙箱 PATH 前置）覆盖：写入形态、幂等、不可表达拒绝、
#   在场判定（status/selfcheck/doctor）、卸载清理、service→systemd 分派。
#
# 平台边界：只在 linux/wsl 上跑（macOS 上 launchd 分支走既有测试）。
set -uo pipefail
export DIA_JOB_CONFIG=/dev/null
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
JOB="$ROOT/bin/dia-job"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0; ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }; bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

case "$(uname -s)" in Linux) ;; *) echo "（非 Linux，跳过 linux.test.sh）"; exit 0 ;; esac

# ── 沙箱：fake crontab / systemctl ─────────────────────────────────────────
FAKE="$TD/fakebin"; mkdir -p "$FAKE"
export CRON_TABLE="$TD/crontab.txt"; : > "$CRON_TABLE"
cat > "$FAKE/crontab" <<'EOS'
#!/bin/bash
# 假 crontab：-l 打印表；`-` 从 stdin 覆盖表
if [ "${1:-}" = "-l" ]; then cat "$CRON_TABLE"; exit 0; fi
if [ "${1:-}" = "-" ]; then cat > "$CRON_TABLE"; exit 0; fi
exit 2
EOS
cat > "$FAKE/systemctl" <<'EOS'
#!/bin/bash
# 假 systemctl：记录调用；is-active/is-enabled 依据 $SVC_STATE_DIR/<unit>
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
u="${!#}"; d="$SVC_STATE_DIR"
case "$*" in
  *show-environment*) exit 0 ;;
  *daemon-reload*) exit 0 ;;
  *enable*)   mkdir -p "$d"; : > "$d/$u"; exit 0 ;;
  *disable*)  rm -f "$d/$u"; exit 0 ;;
  *is-active*) [ -f "$d/$u" ] && { echo active; exit 0; }; echo inactive; exit 3 ;;
  *is-enabled*) [ -f "$d/$u" ] && { echo enabled; exit 0; }; echo disabled; exit 1 ;;
  *is-active\ --quiet*|*--quiet*) [ -f "$d/$u" ] && exit 0 || exit 3 ;;
  *start*|*restart*) mkdir -p "$d"; : > "$d/$u"; exit 0 ;;
  *MainPID*) echo 4242; exit 0 ;;
  *) exit 0 ;;
esac
EOS
cat > "$FAKE/systemctl-is-active" <<'EOS'
#!/bin/bash
exit 0
EOS
chmod +x "$FAKE"/*
export SYSTEMCTL_LOG="$TD/systemctl.log"; : > "$SYSTEMCTL_LOG"
export SVC_STATE_DIR="$TD/svcstate"; mkdir -p "$SVC_STATE_DIR"

HOME_DIR="$TD/home"; ROOT_DIR="$TD/root"; mkdir -p "$HOME_DIR" "$ROOT_DIR"
run() { HOME="$HOME_DIR" DIA_JOB_ROOT="$ROOT_DIR" DIA_JOB_CRONTAB_BIN="$FAKE/crontab" \
        DIA_JOB_SYSTEMCTL_BIN="$FAKE/systemctl" PATH="$FAKE:$PATH" "$JOB" "$@"; }
reg_field() { HOME="$HOME_DIR" DIA_JOB_ROOT="$ROOT_DIR" node "$ROOT/lib/json.mjs" field "$ROOT_DIR/tasks/registry.json" "$1" "$2" 2>/dev/null; }

echo "── periodic：interval → crontab ──"
out="$(run install hello --cmd 'echo hi' --interval 300 --desc '测试任务' --allow-unstable 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "install rc=0" || bad "install rc=$rc：$out"
line="$(grep -F '# dia-job:hello' "$CRON_TABLE")"
printf '%s' "$line" | grep -q '^\*/5 \* \* \* \*' && ok "interval 300 → */5 分钟" || bad "cron 表达式错：$line"
printf '%s' "$line" | grep -q 'PATH=' && ok "行内含 PATH（cron 最小环境）" || bad "缺 PATH：$line"
printf '%s' "$line" | grep -q '/bin/bash "' && ok "行内用 /bin/bash 跑 wrapper" || bad "缺 wrapper 调用：$line"
WRAPPER="$ROOT_DIR/tasks/hello.sh"
[ -x "$WRAPPER" ] && ok "wrapper 已生成且可执行" || bad "缺 wrapper：$WRAPPER"
grep -q 'export DIA_JOB_ROOT' "$WRAPPER" && ok "wrapper 导出 DIA_JOB_ROOT" || bad "wrapper 未导出数据根"
[ "$(reg_field hello backend)" = cron ] && ok "registry backend=cron" || bad "registry backend=$(reg_field hello backend)"

run install hello --cmd 'echo hi' --interval 300 --allow-unstable >/dev/null 2>&1
[ "$(grep -cF '# dia-job:hello' "$CRON_TABLE")" = 1 ] && ok "重复 install 幂等（单条）" || bad "重复 install 产生了多条"

echo "── periodic：calendar + weekdays ──"
run install daily --cmd 'echo d' --calendar 09:30 --weekdays 1-5 --allow-unstable --desc "日历任务" >/dev/null 2>&1
grep -F '# dia-job:daily' "$CRON_TABLE" | grep -q '^30 9 \* \* 1,2,3,4,5' && ok "calendar+weekdays → 30 9 * * 1,2,3,4,5" \
  || bad "calendar 表达式错：$(grep -F '# dia-job:daily' "$CRON_TABLE")"

echo "── periodic：不可表达要明确拒绝（不许"看着装好了"）──"
before="$(wc -l < "$CRON_TABLE")"
run install tooofter --cmd 'echo x' --interval 30 --allow-unstable --desc "太短" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "interval 30s（<1min）→ rc=2" || bad "interval 30s 期望 rc=2，实得 $rc"
[ "$(wc -l < "$CRON_TABLE")" = "$before" ] && ok "拒绝后 crontab 未变" || bad "拒绝后仍写了 crontab"
run install oneshot --cmd 'echo x' --allow-unstable --desc '无调度（等价 RunAtLoad）' >/dev/null 2>&1; rc=$?
[ "$rc" = 0 ] && ok "无调度 → @reboot（对齐 macOS RunAtLoad）" || bad "无调度期望 rc=0，实得 $rc"
grep -F '# dia-job:oneshot' "$CRON_TABLE" | grep -q '^@reboot ' && ok "写的是 @reboot 条目" || bad "@reboot 条目缺失：$(grep -F oneshot "$CRON_TABLE")"

echo "── 在场判定：status / selfcheck / doctor ──"
out="$(run status 2>&1)"; printf '%s' "$out" | grep -q 'scheduled' && ok "status 显示 scheduled" || bad "status 未见 scheduled：$out"
grep -vF '# dia-job:hello' "$CRON_TABLE" > "$TD/t" && cp "$TD/t" "$CRON_TABLE"
out="$(run selfcheck --dry-run 2>&1)"; rc=$?
[ "$rc" = 1 ] && ok "条目被删 → selfcheck --dry-run rc=1" || bad "selfcheck dry-run 期望 rc=1，实得 $rc：$out"
printf '%s' "$out" | grep -q 'hello' && ok "selfcheck 点名 hello" || bad "selfcheck 未点名：$out"
run selfcheck >/dev/null 2>&1
grep -qF '# dia-job:hello' "$CRON_TABLE" && ok "selfcheck 自愈：条目重建" || bad "selfcheck 未重建条目"
out="$(run selfcheck 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "自愈后 selfcheck rc=0" || bad "自愈后 selfcheck rc=$rc：$out"

echo "── service：systemd --user ──"
out="$(run install svc --cmd 'bash /tmp/svc.sh' --type service --allow-unstable --desc '常驻测试' 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "service install rc=0" || bad "service install rc=$rc：$out"
UNIT="$HOME_DIR/.config/systemd/user/local.dia-job-svc.service"
[ -f "$UNIT" ] && ok "unit 落到 systemd --user 目录" || bad "缺 unit：$UNIT"
grep -q 'Restart=always' "$UNIT" && ok "Restart=always（≈ KeepAlive）" || bad "unit 缺 Restart=always"
grep -q "ExecStart=/bin/bash \"$ROOT_DIR/tasks/svc.sh\"" "$UNIT" && ok "ExecStart 指向 wrapper" || bad "ExecStart 错：$(grep ExecStart "$UNIT")"
grep -q -- '--user enable' "$SYSTEMCTL_LOG" && ok "systemctl --user enable 被调用" || bad "未 enable：$(cat "$SYSTEMCTL_LOG")"
[ "$(reg_field svc backend)" = systemd ] && ok "registry backend=systemd" || bad "registry backend=$(reg_field svc backend)"
out="$(run status 2>&1)"; printf '%s' "$out" | grep -q 'active' && ok "status 显示 active" || bad "status 未见 active：$out"

echo "── 卸载 ──"
run uninstall svc >/dev/null 2>&1
[ -f "$UNIT" ] && bad "service 卸载后 unit 仍在" || ok "service 卸载删 unit"
grep -q -- '--user disable' "$SYSTEMCTL_LOG" && ok "systemctl --user disable 被调用" || bad "未 disable"
run uninstall hello >/dev/null 2>&1
grep -qF '# dia-job:hello' "$CRON_TABLE" && bad "periodic 卸载后 crontab 条目仍在" || ok "periodic 卸载删条目"
[ -f "$ROOT_DIR/tasks/hello.sh" ] && bad "卸载后 wrapper 仍在" || ok "卸载删 wrapper"
[ -n "$(reg_field hello backend)" ] && bad "卸载后 registry 仍有条目" || ok "卸载删 registry 条目"
grep -qF '# dia-job:daily' "$CRON_TABLE" && ok "他人条目未被连带删除" || bad "误删了其它条目"

echo "── doctor（Linux 分支）──"
out="$(run doctor 2>&1)"; rc=$?
printf '%s' "$out" | grep -q 'crontab 可用' && ok "doctor 报 crontab 可用" || bad "doctor 缺 crontab 检查：$out"
printf '%s' "$out" | grep -q 'systemctl --user 可用' && ok "doctor 报 systemd 可用" || bad "doctor 缺 systemd 检查：$out"
[ "$rc" = 0 ] || [ "$rc" = 1 ] && ok "doctor 退出码在 0/1（非崩溃）" || bad "doctor rc=$rc"

echo; echo "── PASS $PASS · FAIL $FAIL ──"; [ "$FAIL" = 0 ]
