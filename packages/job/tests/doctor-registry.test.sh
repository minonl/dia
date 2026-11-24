#!/usr/bin/env bash
# doctor §6：registry ↔ 载体 一致性
# 回归（2026-11-24）：旧实现用 `launchctl list | grep -E '^com\.'` 取「已加载集合」，
# 而本机 label 前缀是 `local.dia-job-` ⇒ 集合恒空 ⇒ registry 里每条都被判「已登记但未加载」
# （19/19 全量误报，doctor 永久 warn=1）。现改为逐条走 `_sched_state`（显式域）。
set -uo pipefail
export DIA_JOB_CONFIG=/dev/null
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YT="$HERE/../bin/dia-job"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

[ "$(uname -s)" = Darwin ] || { echo "  · 跳过（仅 macOS：需要 launchctl 语义）"; exit 0; }

ROOT="$TD/root"; mkdir -p "$ROOT/tasks"
cat > "$ROOT/tasks/registry.json" <<'JSON'
{"tasks":{"demo":{"type":"periodic","backend":"launchd","label":"local.test-demo","cmd":"bash /tmp/demo.sh","interval":"600","calendar":"-","desc":"demo"}}}
JSON

# 假 launchctl：
#   · print gui/<uid>/local.test-demo → 仅在 FAKE_LOADED=1 时成功（模拟载体在场/不在场）
#   · list → 只给第三方 com.* 标签（模拟旧实现能看到的"已加载集合"）
FAKE="$TD/bin"; mkdir -p "$FAKE"
cat > "$FAKE/launchctl" <<'SH'
#!/usr/bin/env bash
case "$1" in
  print)
    case "${2:-}" in
      gui/*/local.test-demo)
        # 与真 launchctl print 一致：成功时必须**有输出**（调用方据输出判在场；无 pid 行 = 待触发）
        if [ "${FAKE_LOADED:-0}" = 1 ]; then printf 'state = not running\n\n\tjob state = exited\n'; exit 0; fi
        exit 1 ;;
      *) exit 1 ;;
    esac ;;
  list)
    echo "PID	Status	Label"
    echo "-	0	com.apple.third-party"
    exit 0 ;;
  *) exit 0 ;;
esac
SH
chmod +x "$FAKE/launchctl"

run_doctor() { DIA_JOB_ROOT="$ROOT" PATH="$FAKE:$PATH" FAKE_LOADED="${1:-0}" bash "$YT" doctor 2>&1; }

out="$(run_doctor 0)"
printf '%s' "$out" | grep -q '已登记但未加载' && ok "载体不在场 → 报「已登记但未加载」" || bad "未报未加载：$out"
printf '%s' "$out" | grep -q 'local.test-demo' && ok "点名具体 label" || bad "未点名 label：$out"

out="$(run_doctor 1)"
printf '%s' "$out" | grep -q '已登记但未加载' && bad "载体在场仍报未加载（^com. 前缀回归）：$out" || ok "载体在场 → 不再误报（^com. 回归）"
printf '%s' "$out" | grep -q 'registry 与已加载任务一致' && ok "输出「一致」结论" || bad "缺一致结论：$out"

echo "  ── doctor-registry: $PASS passed, $FAIL failed ──"
[ "$FAIL" = 0 ]
