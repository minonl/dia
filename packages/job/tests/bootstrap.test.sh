#!/usr/bin/env bash
# yan-task-bootstrap.test.sh —— `yan-task bootstrap` 字段解析回归（2026-10-16 实测事故）
#
# **被修的 bug**：原实现 `print(n, cmd, interval, calendar, desc)` + `while IFS=' ' read`，
#   而 **cmd 里含空格**（macOS 数据根 `Application Support/…`，desc 也含空格）⇒ 字段错位 ⇒
#   cmd 被截断成 `bash` ⇒ 门控判 unknown ⇒ **每个任务 rc=4** ⇒ bootstrap（设计的**兜底恢复入口**）
#   在 macOS 上**完全不可用**（现场：四个 yan 定时任务全掉线，跑 bootstrap 一个都恢复不了）。
#   另修：分派行 `bootstrap) cmd_bootstrap` **没 shift/透传** ⇒ `--dry-run` 永远进不去。
#
# 本测试用 `--dry-run`（只打印解析结果、不装 launchd）⇒ **无需 root/launchd 即可回归**；
#   数据根**故意带空格**（复现事故现场）。用法：bash scripts/yan-task-bootstrap.test.sh
set -uo pipefail

# tests must not inherit the developer global config
export DIA_JOB_CONFIG=/dev/null

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YT="$HERE/../bin/dia-job"
TD="$(mktemp -d)"
DR="$TD/yan agent data"          # ⚠️ 故意带空格（事故现场）
mkdir -p "$DR/tasks"
export YAN_DATA_ROOT="$DR"

PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# 夹具：两个任务，cmd **都含空格路径**（一个引导层直连、一个业务层走指针）
CMD1="bash '$DR/repos/yan-agent/scripts/yan-task' selfcheck"
CMD2="CODE=\"\$(bash '$DR/bin/yan-ref' resolve)\" || { CODE='$DR/repos/yan-agent'; echo \"[warn] x\" >&2; }; bash \"\$CODE/scripts/yan-worktree\" check --all --quiet"
python3 - "$DR/tasks/registry.json" "$CMD1" "$CMD2" <<'PY'
import json, sys
p, c1, c2 = sys.argv[1], sys.argv[2], sys.argv[3]
json.dump({"tasks": {
    "demo-selfcheck": {"type": "periodic", "backend": "launchd", "label": "local.dia-job-demo-selfcheck",
                       "cmd": c1, "interval": "300", "calendar": "-", "desc": "演示 引导层（含 空格）"},
    "demo-business":  {"type": "periodic", "backend": "launchd", "label": "local.dia-job-demo-business",
                       "cmd": c2, "interval": "-", "calendar": "14:10", "desc": "演示 业务层（含 空格）"},
}}, open(p, "w"), ensure_ascii=False)
PY

echo "== 1. --dry-run 只打印、不重建（分派行必须 shift+透传）=="
OUT="$(bash "$YT" bootstrap --dry-run 2>&1)"
printf '%s' "$OUT" | grep -q "重建" && bad "dry-run 竟然真的重建了" || ok "未执行重建（dry-run 语义正确）"
[ "$(printf '%s' "$OUT" | grep -c '^DRYRUN')" = "2" ] && ok "打印 2 行（= 任务数）" || { bad "行数不对"; printf '%s\n' "$OUT" | sed 's/^/     | /'; }

echo "== 2. **含空格的 cmd 不被截断**（核心回归：原实现会截成 \`bash\`）=="
# ⚠️ 用 `python3 -c`（差值走管道喂 stdin）——不要与 heredoc 抢 stdin（首版就是这么写歪的）
if printf '%s' "$OUT" | python3 -c '
import sys
c1, c2 = sys.argv[1], sys.argv[2]
rows = {}
for ln in sys.stdin:
    f = ln.rstrip("\n").split("\t")
    if len(f) >= 5 and f[0] == "DRYRUN":
        rows[f[1]] = f[2]
bad = 0
for name, want in {"demo-selfcheck": c1, "demo-business": c2}.items():
    got = rows.get(name, "")
    if got == want:
        print(f"  ✓ {name}: cmd 完整保留（{len(got)} 字符，含空格路径）")
    else:
        print(f"  ✗ {name}: cmd 被改动\n      want={want!r}\n      got ={got!r}")
        bad += 1
sys.exit(1 if bad else 0)
' "$CMD1" "$CMD2"; then
  PASS=$((PASS+2))
else
  FAIL=$((FAIL+1))
fi

echo "== 3. 无 registry ⇒ 优雅返回 0 =="
DRE="$TD/empty-root"; mkdir -p "$DRE"
YAN_DATA_ROOT="$DRE" bash "$YT" bootstrap >/dev/null 2>&1 && ok "exit 0（无 registry 不报错）" || bad "无 registry 应返回 0"

echo "== 4. selfcheck：**adopted 不计缺失**（2026-10-16 修）；普通未加载仍计入 =="
# 两个任务都指向不存在的 label（= 未加载）：一个 adopted、一个普通
python3 - "$DR/tasks/registry.json" <<'PYREG'
import json, sys
json.dump({"tasks": {
    "demo-adopted": {"type": "periodic", "backend": "launchd", "label": "local.dia-job-demo-nonexistent-adopted",
                     "cmd": "bash '/tmp/x.sh'", "interval": "300", "calendar": "-", "desc": "演示 adopted", "adopted": True},
    "demo-normal":  {"type": "periodic", "backend": "launchd", "label": "local.dia-job-demo-nonexistent-normal",
                     "cmd": "bash '/tmp/y.sh'", "interval": "300", "calendar": "-", "desc": "演示 普通"},
}}, open(sys.argv[1], "w"), ensure_ascii=False)
PYREG
# 让"生效指针"检查通过：否则 selfcheck 会因**指针断链**多报 1 项「缺失」
# （那是 doctor/selfcheck 的另一职责，非本用例要测的"adopted 是否计入任务缺失"）
mkdir -p "$DR/bin"
printf '#!/bin/bash\ncase "${1:-}" in check) exit 0;; resolve) echo "%s/repos/yan-agent";; *) exit 0;; esac\n' "$DR" > "$DR/bin/yan-ref"
chmod +x "$DR/bin/yan-ref"
printf '{"worktree":"%s/repos/yan-agent","commit":"0000000"}\n' "$DR" > "$DR/active-ref.json"
OUT2="$(bash "$YT" selfcheck --dry-run 2>&1)"; RC2=$?
printf '%s' "$OUT2" | grep -q "adopted" && ok "adopted 未加载 ⇒ 明确标注「adopted … 不计缺失」" || { bad "adopted 未标注"; printf '%s\n' "$OUT2" | sed 's/^/     | /'; }
printf '%s' "$OUT2" | grep -q "缺失 1" && ok "缺失计数=1（**adopted 未计入**，普通仍计入）" || { bad "缺失计数不对"; printf '%s\n' "$OUT2" | sed 's/^/     | /'; }
[ "$RC2" = 1 ] && ok "exit 1（仅因普通任务未加载）" || bad "exit 应为 1（实得 ${RC2}）"
printf '%s' "$OUT2" | grep -q "未找到命令" && bad "**参数被当命令执行**（反引号命令替换回归！）" || ok "带参不报「未找到命令」（反引号 bug 已修）"

echo "== 5. YAN_TASK_NO_LAUNCHD=1 ⇒ 测试跑 install **不碰真实 launchd 域**（2026-10-16 事故隔离）=="
# cmd 指向**git 仓内**（否则被门控判 non-repo-abs 拒掉，测不到 launchd 那步）
mkdir -p "$DR/repos/yan-agent/scripts"; [ -d "$DR/repos/yan-agent/.git" ] || { git -C "$DR/repos/yan-agent" init -q; printf x > "$DR/repos/yan-agent/f"; git -C "$DR/repos/yan-agent" add -A; git -C "$DR/repos/yan-agent" -c user.email=t@t -c user.name=t commit -qm i; }
printf '#!/bin/bash\n' > "$DR/repos/yan-agent/scripts/x.sh"
OUT5="$(YAN_TASK_NO_LAUNCHD=1 bash "$YT" install demo-isolated --cmd "bash '$DR/repos/yan-agent/scripts/x.sh'" --desc '隔离演示' 2>&1)"; RC5=$?
[ "$RC5" = 0 ] && ok "install 成功（rc=0）" || { bad "install 失败（rc=${RC5}）"; printf '%s\n' "$OUT5" | sed 's/^/     | /'; }
printf '%s' "$OUT5" | grep -q "已跳过 launchd 加载" && ok "明确声明跳过 launchd 写入" || { bad "未声明跳过"; printf '%s\n' "$OUT5" | sed 's/^/     | /'; }
printf '%s' "$OUT5" | grep -q "launchctl bootstrap 失败" && bad "仍在尝试真实 launchctl" || ok "未触发真实 launchctl 调用"

echo "== 6. 静态契约：launchd 写入点**必须都在隔离守卫下**（2026-10-16 实测踩到"守卫打错行"）=="
# install 的 bootout/tootstrap 必须在 if _launchd_off 分支内；uninstall 的 bootout 必须带守卫前缀。
# 教训：`replace(...,1)` 命中了 install 里的**同名行** ⇒ uninstall 未隔离 ⇒ 定点复现里真实任务被 bootout ✗
_n_bootout="$(grep -c 'launchctl bootout' "$YT" || true)"   # 不计缩进（uninstall 那处前缀是守卫）
_n_guarded="$(grep -c '_launchd_off || launchctl bootout' "$YT" || true)"
[ "$_n_bootout" = "2" ] && ok "bootout 调用点 = 2（install + uninstall）" || bad "bootout 调用点数异常：$_n_bootout"
[ "$_n_guarded" = "1" ] && ok "其中 uninstall 那处带 _launchd_off 守卫" || bad "守卫缺失/重复：$_n_guarded"
grep -q 'if _launchd_off; then' "$YT" && ok "install 侧走 if _launchd_off 分支" || bad "install 侧未见隔离分支"
grep -q 'launchctl bootstrap' "$YT" && ! grep -q '_launchd_off || launchctl bootstrap' "$YT" && ok "bootstrap 未被冗余守卫（已在 if 分支内）" || bad "bootstrap 守卫位置可疑"

echo
echo "── PASS $PASS · FAIL $FAIL ──"
rm -rf "$TD"
[ "$FAIL" = 0 ]
