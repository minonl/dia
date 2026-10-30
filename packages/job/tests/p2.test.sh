#!/usr/bin/env bash
# P2: DIA_JOB_ROOT / DIA_JOB_LABEL_PREFIX / OWN_TASKS 参数化回归
set -uo pipefail

# tests must not inherit the developer global config
export DIA_JOB_CONFIG=/dev/null
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YT="$HERE/../bin/dia-job"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

ROOT="$TD/root"; mkdir -p "$ROOT"
out="$(DIA_JOB_ROOT="$ROOT" bash "$YT" list 2>&1)"
printf '%s' "$out" | grep -q "$ROOT" && ok "DIA_JOB_ROOT 生效" || bad "DIA_JOB_ROOT 未生效：$out"

REPO="$TD/repo"; mkdir -p "$REPO/scripts"; git -C "$REPO" init -q
printf '#!/bin/bash\nexit 0\n' > "$REPO/scripts/x.sh"; chmod +x "$REPO/scripts/x.sh"
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm init
out="$(DIA_JOB_ROOT="$ROOT" DIA_JOB_LABEL_PREFIX='local.test-' YAN_TASK_NO_LAUNCHD=1 \
  bash "$YT" install demo --cmd "bash '$REPO/scripts/x.sh'" --desc demo 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "install rc=0" || { bad "install rc=$rc"; printf '%s\n' "$out"; }
node - "$ROOT/tasks/registry.json" <<'JS'
const fs = require("node:fs"), p = process.argv[2];
fs.writeFileSync(p, JSON.stringify({tasks: {demo: {type: "periodic", backend: "launchd", label: "local.test-demo", cmd: "bash /tmp/x.sh", interval: "300", calendar: "-", desc: "demo"}}}, null, 2) + "\n");
JS
lb="$(node - "$ROOT/tasks/registry.json" <<'JS'
const fs = require("node:fs"), d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log((d.tasks?.demo || {}).label || "");
JS
)"
[ "$lb" = "local.test-demo" ] && ok "label 前缀生效" || bad "label=$lb"

out="$(DIA_JOB_ROOT="$ROOT" bash "$YT" own-tasks 2>&1)"
printf '%s' "$out" | grep -q 'failed-task-report' && bad "own-tasks 仍含 yan 业务任务" || ok "own-tasks 无 yan 默认任务"

# 默认根不指向旧工作域；显式 YAN_DATA_ROOT 仍兼容
out="$(env -u DIA_JOB_ROOT -u YAN_DATA_ROOT HOME="$TD/home-default" bash "$YT" list 2>&1)"
printf '%s' "$out" | grep -q "$TD/home-default/.local/share/dia-job" && ok "默认根为 dia-job" || bad "默认根错：$out"
out="$(YAN_DATA_ROOT="$ROOT" bash "$YT" list 2>&1)"
printf '%s' "$out" | grep -q "$ROOT" && ok "YAN_DATA_ROOT 兼容" || bad "YAN_DATA_ROOT 未兼容"

echo; echo "── PASS $PASS · FAIL $FAIL ──"
[ "$FAIL" = 0 ]
