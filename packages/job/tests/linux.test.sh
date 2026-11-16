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
  # ⚠️ is-enabled 必须排在 enable 前面：「is-enabled」本身含子串「enable」，
  #   否则假实现会把「查询」当成「启用」（实测：selfcheck 永远判在场，漏掉 timer 自愈）。
  *is-active*) [ -f "$d/$u" ] && { echo active; exit 0; }; echo inactive; exit 3 ;;
  *is-enabled*) [ -f "$d/$u" ] && { echo enabled; exit 0; }; echo disabled; exit 1 ;;
  *disable*)  rm -f "$d/$u"; exit 0 ;;
  *enable*)   mkdir -p "$d"; : > "$d/$u"; exit 0 ;;
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
# ⚠️ XDG_CONFIG_HOME 必须一起沙箱化：CI（GitHub runner）会预置它 ⇒ 不覆盖的话
#    unit 会写到 runner 的 ~/.config 而不是测试沙箱（本地没设该变量 ⇒ 本地假绿，CI 红）
run() { HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" DIA_JOB_ROOT="$ROOT_DIR" \
        DIA_JOB_CRONTAB_BIN="$FAKE/crontab" DIA_JOB_SYSTEMCTL_BIN="$FAKE/systemctl" \
        PATH="$FAKE:$PATH" "$JOB" "$@"; }
reg_field() { HOME="$HOME_DIR" DIA_JOB_ROOT="$ROOT_DIR" node "$ROOT/lib/json.mjs" field "$ROOT_DIR/tasks/registry.json" "$1" "$2" 2>/dev/null; }

echo "── periodic：interval → crontab ──"
out="$(run install hello --cmd 'echo hi' --interval 300 --desc '测试任务' --allow-unstable 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "install rc=0" || bad "install rc=${rc}：$out"
line="$(grep -F '# dia-job:hello' "$CRON_TABLE")"
printf '%s' "$line" | grep -q '^\*/5 \* \* \* \*' && ok "interval 300 → */5 分钟" || bad "cron 表达式错：$line"
printf '%s' "$line" | grep -q 'PATH=' && ok "行内含 PATH（cron 最小环境）" || bad "缺 PATH：$line"
# 2026-11-16：node 由 nvm/fnm 安装时，系统目录 PATH 里没有 node ⇒ 任务 127 静默失败
NODE_DIR="$(cd -P "$(dirname "$(command -v node)")" >/dev/null 2>&1 && pwd)"
printf '%s' "$line" | grep -qF "PATH=$NODE_DIR" && ok "行内 PATH 以 node 目录开头（防 127）" || bad "行内 PATH 缺 node 目录（$NODE_DIR）：$line"
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
[ "$rc" = 1 ] && ok "条目被删 → selfcheck --dry-run rc=1" || bad "selfcheck dry-run 期望 rc=1，实得 ${rc}：$out"
printf '%s' "$out" | grep -q 'hello' && ok "selfcheck 点名 hello" || bad "selfcheck 未点名：$out"
run selfcheck >/dev/null 2>&1
grep -qF '# dia-job:hello' "$CRON_TABLE" && ok "selfcheck 自愈：条目重建" || bad "selfcheck 未重建条目"
out="$(run selfcheck 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "自愈后 selfcheck rc=0" || bad "自愈后 selfcheck rc=${rc}：$out"

echo "── service：systemd --user ──"
out="$(run install svc --cmd 'bash /tmp/svc.sh' --type service --allow-unstable --desc '常驻测试' 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "service install rc=0" || bad "service install rc=${rc}：$out"
UNIT="$HOME_DIR/.config/systemd/user/local.dia-job-svc.service"
[ -f "$UNIT" ] && ok "unit 落到 systemd --user 目录" || bad "缺 unit：$UNIT"
grep -q 'Restart=always' "$UNIT" && ok "Restart=always（≈ KeepAlive）" || bad "unit 缺 Restart=always"
# 2026-11-16：systemd --user 的 PATH 未必含 nvm（headless/linger 场景）⇒ unit 显式注入
grep -q '^Environment=PATH=' "$UNIT" && ok "unit 显式注入 PATH" || bad "unit 缺 Environment=PATH"
grep -qF "Environment=PATH=$NODE_DIR" "$UNIT" && ok "unit PATH 含 node 目录" || bad "unit PATH 缺 node 目录：$(grep '^Environment=PATH=' "$UNIT")"
grep -q "ExecStart=/bin/bash \"$ROOT_DIR/tasks/svc.sh\"" "$UNIT" && ok "ExecStart 指向 wrapper" || bad "ExecStart 错：$(grep ExecStart "$UNIT")"
grep -q -- '--user enable' "$SYSTEMCTL_LOG" && ok "systemctl --user enable 被调用" || bad "未 enable：$(cat "$SYSTEMCTL_LOG")"
[ "$(reg_field svc backend)" = systemd ] && ok "registry backend=systemd" || bad "registry backend=$(reg_field svc backend)"
out="$(run status 2>&1)"; printf '%s' "$out" | grep -q 'active' && ok "status 显示 active" || bad "status 未见 active：$out"

echo "── periodic：systemd timer（无 crontab 的发行版）──"
# 模拟 Fedora 族 / 不可变系统：没有 crontab，systemctl --user 可用
run_nocron() { HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" DIA_JOB_ROOT="$ROOT_DIR" \
  DIA_JOB_CRONTAB_BIN=/nonexistent/crontab DIA_JOB_SYSTEMCTL_BIN="$FAKE/systemctl" \
  PATH="$FAKE:$PATH" "$JOB" "$@"; }
out="$(run_nocron install tick --cmd 'echo tick' --interval 90 --desc 'timer 测试' --allow-unstable 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "无 crontab：periodic 自动落 timer（rc=0）" || bad "timer install rc=${rc}：$out"
TIMER="$HOME_DIR/.config/systemd/user/local.dia-job-tick.timer"
TUNIT="$HOME_DIR/.config/systemd/user/local.dia-job-tick.service"
[ -f "$TIMER" ] && ok ".timer 已落盘" || bad "缺 timer：$TIMER"
[ -f "$TUNIT" ] && ok "oneshot .service 已落盘" || bad "缺 oneshot unit：$TUNIT"
grep -q 'OnUnitInactiveSec=90s' "$TIMER" && ok "interval 90 → OnUnitInactiveSec（cron 表达不了，timer 能跑）" || bad "timer 触发条件错：$(cat "$TIMER")"
grep -q '^Unit=local.dia-job-tick.service' "$TIMER" && ok "timer 指向 oneshot unit" || bad "Unit= 错：$(cat "$TIMER")"
grep -q 'Type=oneshot' "$TUNIT" && ok "periodic 的 service 是 oneshot（不常驻）" || bad "缺 Type=oneshot"
grep -q '^Environment=PATH=' "$TUNIT" && ok "oneshot unit 注入 PATH" || bad "缺 Environment=PATH"
grep -q -- '--user enable --now local.dia-job-tick.timer' "$SYSTEMCTL_LOG" && ok "enable --now timer 被调用" || bad "未启用 timer：$(cat "$SYSTEMCTL_LOG")"
[ "$(reg_field tick backend)" = systemd-timer ] && ok "registry backend=systemd-timer" || bad "registry backend=$(reg_field tick backend)"
grep -qF '# dia-job:tick' "$CRON_TABLE" && bad "timer 后端不应写 crontab" || ok "timer 后端未污染 crontab"
out="$(run_nocron status 2>&1)"; printf '%s' "$out" | grep -q 'scheduled' && ok "status 显示 scheduled" || bad "timer status 未见 scheduled：$out"
run_nocron install weekly --cmd 'echo w' --calendar 09:30 --weekdays 1,2 --allow-unstable --desc '日历' >/dev/null 2>&1
WTIMER="$HOME_DIR/.config/systemd/user/local.dia-job-weekly.timer"
grep -q 'OnCalendar=Mon,Tue \*-\*-\* 09:30:00' "$WTIMER" && ok "calendar+weekdays → OnCalendar=Mon,Tue *-*-* 09:30:00" || bad "OnCalendar 错：$(cat "$WTIMER" 2>/dev/null)"
grep -q '^Persistent=true' "$WTIMER" && ok "日历型带 Persistent=true（错过补跑）" || bad "缺 Persistent=true"
out="$(run_nocron install toofast --cmd 'echo x' --interval 30 --allow-unstable --desc '太短' 2>&1)"; rc=$?
[ "$rc" = 2 ] && ok "timer 也拒绝 <60s（与 cron 语义一致）" || bad "timer interval 30s 期望 rc=2，实得 $rc"
# 自愈：timer 单元被外部删掉（且已 disable）→ selfcheck 点名并重建，且**保持 timer 后端**
rm -f "$TIMER" "$TUNIT" "$SVC_STATE_DIR/local.dia-job-tick.timer"
out="$(run_nocron selfcheck --dry-run 2>&1)"; rc=$?
[ "$rc" = 1 ] && ok "timer 丢失 → selfcheck --dry-run rc=1" || bad "selfcheck dry-run 期望 rc=1，实得 ${rc}：$out"
printf '%s' "$out" | grep -q 'probe-timer\|tick' && ok "selfcheck 点名 timer 任务" || bad "selfcheck 未点名：$out"
run_nocron selfcheck >/dev/null 2>&1
[ -f "$TIMER" ] && ok "selfcheck 自愈：timer 重建" || bad "selfcheck 未重建 timer"
[ "$(reg_field tick backend)" = systemd-timer ] && ok "重建保持 systemd-timer 后端（不悄悄迁回 cron）" || bad "重建后端变了：$(reg_field tick backend)"
out="$(run install forced --cmd 'echo f' --interval 300 --allow-unstable --desc '强制 cron' 2>&1)"; rc=$?
[ "$rc" = 0 ] && grep -qF '# dia-job:forced' "$CRON_TABLE" && ok "有 crontab 时仍默认 cron（不迁移已有行为）" || bad "默认后端变了：$out"

echo "── 卸载 ──"
run uninstall svc >/dev/null 2>&1
[ -f "$UNIT" ] && bad "service 卸载后 unit 仍在" || ok "service 卸载删 unit"
grep -q -- '--user disable' "$SYSTEMCTL_LOG" && ok "systemctl --user disable 被调用" || bad "未 disable"
run uninstall hello >/dev/null 2>&1
grep -qF '# dia-job:hello' "$CRON_TABLE" && bad "periodic 卸载后 crontab 条目仍在" || ok "periodic 卸载删条目"
[ -f "$ROOT_DIR/tasks/hello.sh" ] && bad "卸载后 wrapper 仍在" || ok "卸载删 wrapper"
[ -n "$(reg_field hello backend)" ] && bad "卸载后 registry 仍有条目" || ok "卸载删 registry 条目"
grep -qF '# dia-job:daily' "$CRON_TABLE" && ok "他人条目未被连带删除" || bad "误删了其它条目"
run_nocron uninstall tick >/dev/null 2>&1
[ -f "$TIMER" ] && bad "timer 卸载后 .timer 仍在" || ok "timer 卸载删 .timer"
[ -f "$TUNIT" ] && bad "timer 卸载后 oneshot unit 仍在" || ok "timer 卸载删 oneshot unit"
grep -q -- '--user disable --now local.dia-job-tick.timer' "$SYSTEMCTL_LOG" && ok "timer 卸载调用 disable --now" || bad "timer 未 disable"

echo "── doctor（Linux 分支）──"
out="$(run doctor 2>&1)"; rc=$?
printf '%s' "$out" | grep -q 'periodic 后端 = cron' && ok "doctor 报 periodic 后端 = cron" || bad "doctor 缺 cron 后端检查：$out"
printf '%s' "$out" | grep -q 'systemctl --user 可用' && ok "doctor 报 systemd 可用" || bad "doctor 缺 systemd 检查：$out"
printf '%s' "$out" | grep -q '调度 PATH 能找到 node' && ok "doctor 校验调度 PATH 的 node" || bad "doctor 缺调度 PATH 检查：$out"
# 显式 DIA_JOB_CRONTAB_BIN 指向坏路径 ⇒ 不算可用；auto 下应自动落到 systemd timer
out="$(HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" DIA_JOB_ROOT="$ROOT_DIR" \
       DIA_JOB_CRONTAB_BIN=/nonexistent/crontab \
       DIA_JOB_SYSTEMCTL_BIN="$FAKE/systemctl" PATH="$FAKE:$PATH" "$JOB" doctor 2>&1)"
printf '%s' "$out" | grep -q 'periodic 后端 = systemd timer' && ok "坏 crontab 路径 ⇒ auto 落到 systemd timer" || bad "坏 crontab 路径未回退 timer：$out"
# 强制 cron 后端时才该报缺 cron，并给不可变系统的 rpm-ostree 口径
out="$(HOME="$HOME_DIR" XDG_CONFIG_HOME="$HOME_DIR/.config" DIA_JOB_ROOT="$ROOT_DIR" \
       DIA_JOB_CRONTAB_BIN=/nonexistent/crontab DIA_JOB_OSTREE=1 DIA_JOB_PERIODIC_BACKEND=cron \
       DIA_JOB_SYSTEMCTL_BIN="$FAKE/systemctl" PATH="$FAKE:$PATH" "$JOB" doctor 2>&1)"
printf '%s' "$out" | grep -q '找不到 crontab' && ok "强制 cron + 坏 crontab 路径 ⇒ 明确报缺" || bad "坏 crontab 路径被当成可用：$out"
printf '%s' "$out" | grep -q 'rpm-ostree install cronie' && ok "不可变系统给 rpm-ostree 提示" || bad "ostree 提示缺失：$out"
[ "$rc" = 0 ] || [ "$rc" = 1 ] && ok "doctor 退出码在 0/1（非崩溃）" || bad "doctor rc=$rc"

echo; echo "── PASS $PASS · FAIL $FAIL ──"; [ "$FAIL" = 0 ]
