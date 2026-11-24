#!/usr/bin/env bash
# P2.1: 项目无关路径策略 + 全局配置（env/config）
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

export DIA_JOB_ROOT="$TD/root"; mkdir -p "$DIA_JOB_ROOT/bin"
. "$ROOT/lib/policy.sh"

REPO="$TD/repo"; mkdir -p "$REPO/scripts"; git -C "$REPO" init -q
printf '#!/bin/bash\nexit 0\n' > "$REPO/scripts/x.sh"; chmod +x "$REPO/scripts/x.sh"
git -C "$REPO" add -A; git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm init
WT="$TD/wt"; git -C "$REPO" worktree add -q -b wt "$WT"
printf '#!/bin/bash\nexit 0\n' > "$WT/scripts/x.sh"; chmod +x "$WT/scripts/x.sh"

dia_job_cmd_path_class "bash '$REPO/scripts/x.sh'"; [ "$YP_CLASS" = main-checkout ] && ok "主 checkout → main-checkout" || bad "主 checkout 分类=$YP_CLASS"
dia_job_cmd_path_class "bash '$WT/scripts/x.sh'"; [ "$YP_CLASS" = ephemeral ] && ok "worktree → ephemeral" || bad "worktree 分类=$YP_CLASS"
dia_job_cmd_path_class "bash '$DIA_JOB_ROOT/bin/entry'"; [ "$YP_CLASS" = ref-entry ] && ok "稳定入口 → ref-entry" || bad "入口分类=$YP_CLASS"
dia_job_cmd_path_class "bash '/opt/not-a-repo/x.sh'"; [ "$YP_CLASS" = non-repo-abs ] && ok "非仓绝对路径 → non-repo-abs" || bad "非仓分类=$YP_CLASS"
dia_job_cmd_path_class "bash scripts/x.sh"; [ "$YP_CLASS" = unknown ] && ok "相对路径 → unknown" || bad "相对分类=$YP_CLASS"

# 复合命令兜底（2026-11-24 修）：含 && / >> / 命令替换时，仍要提取**已存在的绝对路径**
dia_job_cmd_path_class "cd $REPO && python3 tools/x.py --days 30 >> $TD/log 2>&1"
[ "$YP_CLASS" = main-checkout ] && ok "复合命令（cd … && … >> …）→ 提取到主 checkout" || bad "复合命令分类=$YP_CLASS target=$YP_CMD_TARGET"

ENTRY_REF="$TD/otherbin/ref"; mkdir -p "$TD/otherbin"; printf '#!/bin/bash\n' > "$ENTRY_REF"; chmod +x "$ENTRY_REF"
dia_job_cmd_path_class "CODE=\"\$(bash '$ENTRY_REF' resolve)\" || CODE='$TD/nope'; bash \"\$CODE/x\""
[ "$YP_CLASS" = non-repo-abs ] && ok "命令替换里的非入口绝对路径 → non-repo-abs" || bad "命令替换分类=$YP_CLASS target=$YP_CMD_TARGET"

dia_job_cmd_path_class "cd /nonexistent-dir-xyz && echo hi >> /dev/null"
[ "$YP_CLASS" = unknown ] && ok "无可提取的已存在路径 → unknown（不瞎猜）" || bad "兜底误判=$YP_CLASS target=$YP_CMD_TARGET"

# 含空格路径
mkdir -p "$TD/with space"; printf '#!/bin/bash\n' > "$TD/with space/x.sh"
dia_job_extract_target "bash '$TD/with space/x.sh' --x" > "$TD/t"
[ "$(cat "$TD/t")" = "$TD/with space/x.sh" ] && ok "含空格路径提取" || bad "空格路径提取失败：$(cat "$TD/t")"

# 全局配置文件（不依赖项目）
CFG="$TD/config"; printf 'DIA_JOB_LABEL_PREFIX=local.cfg-\nDIA_JOB_ROOT=%s\n' "$TD/cfgroot" > "$CFG"
mkdir -p "$TD/cfgroot"
out="$(env -u DIA_JOB_LABEL_PREFIX -u DIA_JOB_ROOT DIA_JOB_CONFIG="$CFG" bash -c '. "$0/lib/config.sh"; dia_job_load_config; printf "%s|%s" "$DIA_JOB_LABEL_PREFIX" "$DIA_JOB_ROOT"' "$ROOT")"
[ "$out" = "local.cfg-|$TD/cfgroot" ] && ok "配置文件生效" || bad "配置=$out"

echo; echo "── PASS $PASS · FAIL $FAIL ──"
[ "$FAIL" = 0 ]
