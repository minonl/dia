#!/usr/bin/env bash
# adopt / doctor / gate 回归测试（2026-11-06：每仓本地钩子 + simple-git-hooks RC）
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT="$HERE/../bin/dia-wt"
TD="$(mktemp -d)"; trap 'rm -rf "$TD"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }; bad(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }

# 隔离 HOME / 全局 git 配置 / 数据根 / shell rc（避免污染真实机器）
export HOME="$TD/home"; mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL="$TD/gitconfig"; : > "$GIT_CONFIG_GLOBAL"
export GIT_CONFIG_NOSYSTEM=1
export DIA_ROOT="$TD/dia"
export DIA_WT_SHELL_RC="$HOME/.zshenv"

mk_repo(){ local r="$1"; mkdir -p "$r"; git -C "$r" init -q -b main; git -C "$r" config user.email t@example.com; git -C "$r" config user.name t; echo a > "$r/a.txt"; git -C "$r" add -A; git -C "$r" commit -qm init; }

R="$TD/repo"; mk_repo "$R"
out="$(bash "$WT" adopt "$R" --json)"
printf '%s' "$out" | grep -q '"defaultBranch":"main"' && ok "dry-run 识别默认分支" || bad "dry-run: $out"
[ ! -f "$R/.git/dia/config.json" ] && ok "dry-run 不落盘" || bad "dry-run 落盘了"

bash "$WT" adopt "$R" --apply >/dev/null 2>&1 || bad "apply 失败"
[ -f "$R/.git/dia/config.json" ] && ok "config 已写" || bad "缺 config"
hp="$(git -C "$R" config --local --get core.hooksPath)"
case "$hp" in */repo/.git/dia/hooks) ok "仓库本地 hooksPath 指向 dia 目录" ;; *) bad "hooksPath=$hp" ;; esac
for h in pre-commit pre-push post-checkout; do [ -x "$R/.git/dia/hooks/$h" ] || bad "缺 $h"; done
ok "三个钩子可执行"
python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d.get("hooksManager")=="local" else 1)' "$R/.git/dia/config.json" \
  && ok "config 记录 hooksManager=local" || bad "hooksManager 未记录"
[ -z "$(git config --global --get core.hooksPath 2>/dev/null || true)" ] && ok "未写全局 git 配置" || bad "仍写了全局 hooksPath"

bash "$WT" adopt "$R" --apply >/dev/null 2>&1 && ok "重复 apply 幂等" || bad "重复 apply 失败"
bash "$WT" adopt "$R" --check >/dev/null 2>&1 && ok "check 通过" || bad "check 失败"
bash "$WT" doctor "$R" >/dev/null 2>&1 && ok "doctor 通过" || bad "doctor 失败"

echo b > "$R/b.txt"; git -C "$R" add b.txt
if git -C "$R" commit -qm should-block 2>/dev/null; then bad "主 checkout main 提交未被拦截"; else ok "主 checkout main 提交被拦截"; fi
git -C "$R" reset -q

# 链式：仓库自己的 .git/hooks/pre-commit 仍要执行
printf '#!/bin/sh\necho chained >> "$(git rev-parse --show-toplevel)/chain.log"\n' > "$R/.git/hooks/pre-commit"; chmod +x "$R/.git/hooks/pre-commit"
git -C "$R" worktree add -q -b feat/y "$TD/repo-worktree--y" main
echo c > "$TD/repo-worktree--y/c.txt"; git -C "$TD/repo-worktree--y" add c.txt
git -C "$TD/repo-worktree--y" commit -qm feat-y >/dev/null 2>&1
[ -f "$TD/repo-worktree--y/chain.log" ] && ok "仓库自己的钩子被链式执行" || bad "仓库钩子未执行"
rm -f "$TD/repo-worktree--y/chain.log"

# simple-git-hooks 仓：走 RC 注入，不碰仓内文件与 .git/hooks
RN="$TD/npmrepo"; mk_repo "$RN"
printf '{"name":"r","devDependencies":{"simple-git-hooks":"^2.11.1"},"simple-git-hooks":{"pre-commit":"npx lint-staged"}}\n' > "$RN/package.json"
git -C "$RN" add -A; git -C "$RN" commit -qm pkg
before="$(md5 -q "$RN/package.json" 2>/dev/null || md5sum "$RN/package.json" | cut -d' ' -f1)"
bash "$WT" adopt "$RN" --apply >/dev/null 2>&1 || bad "npm 仓 adopt 失败"
after="$(md5 -q "$RN/package.json" 2>/dev/null || md5sum "$RN/package.json" | cut -d' ' -f1)"
[ "$before" = "$after" ] && ok "不修改仓库 package.json" || bad "package.json 被改动"
[ -z "$(git -C "$RN" config --local --get core.hooksPath || true)" ] && ok "不占用仓库 hooksPath（交给管理器）" || bad "仍设置了 hooksPath"
[ -f "$DIA_ROOT/hooks/simple-git-hooks-rc.sh" ] && ok "写入 simple-git-hooks RC" || bad "缺 RC 文件"
grep -q "SIMPLE_GIT_HOOKS_RC" "$HOME/.zshenv" 2>/dev/null && ok "shell rc 注入 SIMPLE_GIT_HOOKS_RC" || bad "未注入环境变量"
bash "$WT" doctor "$RN" >/dev/null 2>&1 && ok "npm 仓 doctor 通过" || bad "npm 仓 doctor 失败"
(cd "$RN" && DIA_WT_GUARD_PROBE=1 bash "$WT" guard pre-commit >/dev/null 2>&1) && bad "guard 未拦截 main 提交" || ok "guard 拦截 main 提交"

# RC 注入不得自递归：模拟管理器钩子（source RC 后应直接结束，不再链回自己）
RC="$( wt_hooks_rc_dir 2>/dev/null || true )"; true
printf '#!/usr/bin/env bash\nset -e\nname=pre-commit\nsource "$SIMPLE_GIT_HOOKS_RC"\n' > "$TD/pre-commit"
chmod +x "$TD/pre-commit"
(cd "$RN" && timeout 10 env SIMPLE_GIT_HOOKS_RC="$DIA_ROOT/hooks/simple-git-hooks-rc.sh" "$TD/pre-commit" >/tmp/rc.log 2>&1)
rc=$?; [ "$rc" != 124 ] && ok "RC 注入不自递归（main 上被守卫拦截，退出码 $rc）" || bad "RC 注入自递归/超时"
cd - >/dev/null

# 全局配置残留检查：旧版全局钩子目录 → doctor FAIL
LEGACY="$TD/legacy-hooks"; mkdir -p "$LEGACY"
printf '#!/usr/bin/env bash\n# dia-wt guard（旧）\nexit 0\n' > "$LEGACY/pre-commit"; chmod +x "$LEGACY/pre-commit"
git config --global core.hooksPath "$LEGACY"
bash "$WT" doctor "$R" >/tmp/d20.log 2>&1; grep -q "D20" /tmp/d20.log && ok "doctor 报全局钩子残留" || bad "doctor 未报全局残留: $(head -3 /tmp/d20.log | tr "\n" " ")"
git config --global --unset core.hooksPath

# 未 adopt 的仓不受影响
R3="$TD/repo3"; mk_repo "$R3"; echo z > "$R3/z.txt"; git -C "$R3" add -A
git -C "$R3" commit -qm ok >/dev/null 2>&1 && ok "未 adopt 仓不受守卫影响" || bad "未 adopt 仓被误拦"

# 敏感扫描（worktree push）
BR="$TD/remote.git"; git init -q --bare "$BR"
git -C "$R" remote add origin "$BR" 2>/dev/null || true
git --git-dir="$BR" fetch -q "$R" main:main 2>/dev/null || true
git -C "$R" fetch -q origin 2>/dev/null || true
BAD="$(printf '/%s/alice/secret' Users)"; echo "$BAD" > "$TD/repo-worktree--y/bad.txt"
git -C "$TD/repo-worktree--y" add bad.txt; git -C "$TD/repo-worktree--y" commit -qm bad >/dev/null 2>&1
if git -C "$TD/repo-worktree--y" push -q origin feat/y 2>/dev/null; then bad "敏感推送未被拦截"; else ok "敏感推送被拦截"; fi
git -C "$TD/repo-worktree--y" reset -q --hard HEAD~1
printf 'path=$TD/home/kits/dia.json\n' > "$TD/repo-worktree--y/vars.txt"
git -C "$TD/repo-worktree--y" add vars.txt && git -C "$TD/repo-worktree--y" commit -qm vars >/dev/null 2>&1
git -C "$TD/repo-worktree--y" push -q origin feat/y 2>/dev/null && ok "相对片段 home/ 不误报" || bad "相对片段被误判"

# 文档（.md）里的绝对 home 路径：降级为告警，不阻断（2026-11-11）
ABS="/""home/developer/repos/x"   # 拆开写：避免本仓守卫把测试样本当真实泄漏
printf 'abs=%s\n' "$ABS" > "$TD/repo-worktree--y/doc.md"
git -C "$TD/repo-worktree--y" add doc.md && git -C "$TD/repo-worktree--y" commit -qm doc-path >/dev/null 2>&1
git -C "$TD/repo-worktree--y" push -q origin feat/y 2>/dev/null && ok "文档里的绝对 home 路径 放行（仅告警）" || bad "文档里的绝对 home 路径被误拦"
git -C "$TD/repo-worktree--y" reset -q --hard HEAD~1

# 非文档（.txt）里的绝对 home 路径：仍然阻断
printf 'abs=%s\n' "$ABS" > "$TD/repo-worktree--y/conf.txt"
git -C "$TD/repo-worktree--y" add conf.txt && git -C "$TD/repo-worktree--y" commit -qm txt-path >/dev/null 2>&1
if git -C "$TD/repo-worktree--y" push -q origin feat/y 2>/dev/null; then bad "非文档绝对 home 路径未被拦截"; else ok "非文档绝对 home 路径仍拦截"; fi
git -C "$TD/repo-worktree--y" reset -q --hard HEAD~1

# 扫描规则优先级 / 路径归一化（2026-11-11 两遍法）
# 夹具注意：敏感样本一律用拼接构造（printf/引号拼接），否则本仓 pre-push 会把测试文件自己拦下。
SCAN_W="$TD/repo-worktree--y"
try_push(){ git -C "$SCAN_W" push -q origin feat/y >"$TD/push.out" 2>"$TD/push.err"; }
commit_scan(){ git -C "$SCAN_W" add -A . >/dev/null 2>&1; git -C "$SCAN_W" commit -qm "scan $1" >/dev/null 2>&1; }
# 回退本地提交，并把远端 ref 同步回本地 HEAD：否则前面的 reset 会让后续 push 变成
# non-fast-forward，失败原因不是守卫 → 用例失真（判定要看 stderr 有没有 [dia-wt]）。
undo_scan(){ git -C "$SCAN_W" reset -q --hard HEAD~1; git --git-dir="$BR" update-ref refs/heads/feat/y "$(git -C "$SCAN_W" rev-parse HEAD)"; }
git --git-dir="$BR" update-ref refs/heads/feat/y "$(git -C "$SCAN_W" rev-parse HEAD)"

# ② 敏感目录：文档不豁免
SSH_ABS="$(printf '/%s/alice/.ssh/id_rsa' Users)"
printf 'ssh=%s\n' "$SSH_ABS" > "$SCAN_W/doc-ssh.md"; commit_scan doc-ssh
try_push; if [ $? -ne 0 ] && grep -q '已阻断' "$TD/push.err"; then ok ".md 里的 ~/.ssh 仍拦截"; else bad ".md 里的 ~/.ssh 未拦截"; fi
undo_scan
ENV_ABS="$(printf '/%s/bob/.env' home)"
printf 'env=%s\n' "$ENV_ABS" > "$SCAN_W/doc-env.md"; commit_scan doc-env
try_push; if [ $? -ne 0 ] && grep -q '已阻断' "$TD/push.err"; then ok ".md 里的 ~/.env 仍拦截（home 前缀）"; else bad ".md 里的 ~/.env 未拦截"; fi
undo_scan

# ① 凭证：文档降级不豁免
PK="-----BEGIN ""RSA PRIVATE KEY-----"
printf 'key=%s\n' "$PK" > "$SCAN_W/leak.txt"; commit_scan pk-txt
try_push; if [ $? -ne 0 ] && grep -q '已阻断' "$TD/push.err"; then ok ".txt 里的私钥块拦截"; else bad ".txt 里的私钥块未拦截"; fi
undo_scan
printf '%s\n' "$PK" > "$SCAN_W/key.md"; commit_scan pk-md
try_push; if [ $? -ne 0 ]; then ok ".md 里的私钥仍拦截（凭证不降级）"; else bad ".md 里的私钥被放行"; fi
undo_scan
AK="AKIA""ABCDEFGHIJKLMNOP"; GH="ghp_""0123456789abcdefghijABCD"
printf 'a=%s\nb=%s\n' "$AK" "$GH" > "$SCAN_W/tok.txt"; commit_scan tok
try_push; if [ $? -ne 0 ] && grep -q '已阻断' "$TD/push.err"; then ok ".txt 里的 AKIA / ghp_ 拦截"; else bad ".txt 里的 AKIA / ghp_ 未拦截"; fi
undo_scan

# ③ 路径与扩展名归一化：带空格 / 中文名的 .md 必须仍认作文档
printf 'abs=%s\n' "$ABS" > "$SCAN_W/doc 中文 笔记.md"; commit_scan spaced
if try_push; then grep -q '仅告警' "$TD/push.err" && ok "带空格/中文名 .md 放行且出告警" || bad "带空格/中文名 .md 放行但无告警"; else bad "带空格/中文名 .md 被误拦（quotepath/引号回归）"; fi
[ ! -s "$TD/push.out" ] && ok "告警不出现在 stdout" || bad "告警泄漏到 stdout: $(head -2 "$TD/push.out" | tr '\n' ' ')"
undo_scan
printf 'abs=%s\r\n' "$ABS" > "$SCAN_W/crlf.md"; commit_scan crlf
if try_push; then ok "CRLF 行尾的 .md 放行"; else bad "CRLF 行尾的 .md 被误拦"; fi
undo_scan

# 多文件混合命中：一条 .md 告警 + 一条 .txt 阻断 → 必须阻断
printf 'abs=%s\n' "$ABS" > "$SCAN_W/multi-doc.md"
printf 'abs=%s\n' "$ABS" > "$SCAN_W/multi-conf.txt"; commit_scan multi
try_push; if [ $? -ne 0 ] && grep -q '已阻断' "$TD/push.err" && grep -q '仅告警' "$TD/push.err"; then ok "混合命中阻断且告警并存"; else bad "混合命中未正确阻断"; fi
[ ! -s "$TD/push.out" ] && ok "阻断文本只走 stderr" || bad "阻断文本泄漏到 stdout"
undo_scan

# 告警上限：最多 5 条 + 省略提示
{ i=1; while [ "$i" -le 7 ]; do printf 'p%d=%s/developer/d%d\n' "$i" "/""home" "$i"; i=$((i+1)); done; } > "$SCAN_W/many.md"; commit_scan many
if try_push && grep -q '另有 2 条已省略' "$TD/push.err"; then ok "告警上限 5 条并提示省略数"; else bad "告警未按上限省略"; fi
undo_scan

# adopt --all
AR="$TD/allroot"; mkdir -p "$AR/a" "$AR/b"
for r in a b; do mk_repo "$AR/$r"; done
git -C "$AR/a" worktree add -q -b feat/w "$AR/a-worktree--w" main
out="$(DIA_WT_REPOS_ROOT="$AR" bash "$WT" adopt --all --apply --json 2>&1)"
printf '%s' "$out" | grep -q '"repos":2,"ok":2,"fail":0' && ok "adopt --all 覆盖 2 个主 checkout" || bad "adopt --all: $out"
[ ! -d "$AR/a-worktree--w/.git/dia" ] && ok "adopt --all 跳过 worktree 目录" || bad "adopt --all 误改 worktree"
out="$(DIA_WT_REPOS_ROOT="$AR" bash "$WT" doctor --all --json 2>/dev/null)"
printf '%s' "$out" | grep -q "$AR/a" && ok "doctor --all 覆盖自定义仓根" || bad "doctor --all 未覆盖"
DIA_WT_REPOS_ROOT="$TD/empty-root" bash "$WT" adopt --all >/dev/null 2>&1
[ $? = 2 ] && ok "adopt --all 空结果 exit 2" || bad "adopt --all 空结果未 exit 2"

# gate
rm -f "$TD/repo-worktree--y/chain.log"
if bash "$WT" gate "$R" y >/tmp/gate.log 2>&1; then ok "gate 成功"; else bad "gate 失败: $(tail -2 /tmp/gate.log | tr '\n' ' ')"; fi
if bash "$WT" gate "$R" yb >/dev/null 2>&1; then bad "gate 子串误匹配"; else ok "gate 精确匹配 feature"; fi
echo dirty >> "$TD/repo-worktree--y/c.txt"
if bash "$WT" gate "$R" y >/dev/null 2>&1; then bad "worktree 脏时 gate 通过"; else ok "worktree 脏时 gate 失败"; fi
git -C "$TD/repo-worktree--y" checkout -q -- c.txt

# revert
bash "$WT" adopt "$R" --revert >/dev/null 2>&1 || bad "revert 失败"
[ ! -f "$R/.git/dia/config.json" ] && ok "revert 删除本仓配置" || bad "配置残留"
[ -z "$(git -C "$R" config --local --get core.hooksPath || true)" ] && ok "revert 还原本地 hooksPath" || bad "hooksPath 未还原"
git -C "$R" worktree remove --force "$TD/repo-worktree--y" >/dev/null 2>&1 || true

echo; echo "── PASS $PASS · FAIL $FAIL ──"
[ "$FAIL" = 0 ]
