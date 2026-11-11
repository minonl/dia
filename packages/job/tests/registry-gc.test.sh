#!/usr/bin/env bash
# registry gc：登记表里的「历史条目」（登记 ≠ 在跑 / 目标已不存在）应可一键列出并清理
# 2026-11-11：`dia job list` 混着早年条目的问题（gaps：缺 registry gc + 实际调度态）
set -uo pipefail

export DIA_JOB_CONFIG=/dev/null
export YAN_TASK_NO_LAUNCHD=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YT="$HERE/../bin/dia-job"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

ROOT="$TD/root"; mkdir -p "$ROOT/tasks"
# 一个「活着」的 cmd（路径存在） + 一个「目标已不存在」的历史条目 + 一个无 state 且无载体的孤儿
LIVE="$TD/live.sh"; printf '#!/bin/bash\nexit 0\n' > "$LIVE"; chmod +x "$LIVE"
node - "$ROOT/tasks/registry.json" "$LIVE" <<'JS'
const fs = require("node:fs"), p = process.argv[2], live = process.argv[3];
const tasks = {
  alpha: { type: "periodic", backend: "cron", label: "local.test-alpha", cmd: `bash ${live}`, interval: "300", calendar: "-", desc: "alive" },
  ghost: { type: "periodic", backend: "cron", label: "local.test-ghost", cmd: "bash /nonexistent/ghost.sh", interval: "300", calendar: "-", desc: "cmd target missing" },
  orphan:{ type: "periodic", backend: "cron", label: "local.test-orphan", cmd: `bash ${live}`, interval: "300", calendar: "-", desc: "no state, no carrier" },
};
fs.writeFileSync(p, JSON.stringify({ tasks }, null, 2) + "\n");
JS

out="$(DIA_JOB_ROOT="$ROOT" bash "$YT" registry gc --dry-run 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "gc --dry-run rc=0" || { bad "gc --dry-run rc=$rc"; printf '%s\n' "$out"; }
printf '%s' "$out" | grep -q ghost && ok "列出 cmd 目标不存在的条目" || bad "未列出 ghost"
printf '%s' "$out" | grep -q orphan && ok "列出无 state/无载体的孤儿" || bad "未列出 orphan"
if printf '%s' "$out" | grep -q 'alpha'; then bad "误列健康条目 alpha"; else ok "健康条目未被列入"; fi

# --dry-run 不得改动登记表
before="$(node -e "const d=require('$ROOT/tasks/registry.json');console.log(Object.keys(d.tasks).sort().join(','))")"
[ "$before" = "alpha,ghost,orphan" ] && ok "dry-run 未改动登记表" || bad "dry-run 改了登记表：$before"

out="$(DIA_JOB_ROOT="$ROOT" bash "$YT" registry gc --apply 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "gc --apply rc=0" || { bad "gc --apply rc=$rc"; printf '%s\n' "$out"; }
after="$(node -e "const d=require('$ROOT/tasks/registry.json');console.log(Object.keys(d.tasks).sort().join(','))")"
[ "$after" = "alpha" ] && ok "apply 只清理候选、保留健康条目" || bad "apply 后登记表=$(echo "$after")"

out="$(DIA_JOB_ROOT="$ROOT" bash "$YT" list 2>&1)"
printf '%s' "$out" | grep -qE 'alpha.*(scheduled|运行|absent|未运行)' && ok "list 展示实际调度态" || bad "list 未展示实际调度态：$out"

echo
echo "── PASS $PASS · FAIL $FAIL ──"
[ "$FAIL" -eq 0 ]
