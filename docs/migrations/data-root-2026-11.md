# 数据根迁移：~/.local/share/dia → ~/.dia（2026-11-05）

> 背景：PR #11 把数据根统一为 `~/.dia`（`DIA_ROOT` 可覆盖，`DIA_DATA_DIR` 兼容一个版本）。
> 代码改了，**安装器和已有数据还要迁**。

## 步骤（一次性）

```bash
# 1) 备份（可选但建议）
mv ~/.local/share/dia ~/.local/share/dia.bak-$(date +%Y%m%d)

# 2) 迁数据（只 mv 旧数据根 → ~/.dia；不装、不改 bin 链接）
npm i -g @minonl/dia@latest
dia migrate data

# 3) 验证
dia doctor
dia --persona yan kb scene S1
```

## 影响面

| 项 | 变化 |
|---|---|
| persona 安装目录 | `~/.local/share/dia/personas` → `~/.dia/personas` |
| run/审计/审计锚点 | `~/.dia/runs`、`~/.dia/audit` |
| cache | `~/.dia/cache`（kb 索引会重建） |
| msg/agents | `~/.dia/msg`、`~/.dia/agents` |
| dsh profile / opencode agent | 不变（`~/.dsh/profiles`、`~/.config/opencode`） |
| 安装物 | `<install>/{bin,dist,packages,registry}`（默认 `~/.local/share/dia`，`DIA_INSTALL_DIR` 可覆盖） |
| 数据 | `~/.dia/{personas,msg,agents,state,cache,job,runs,audit}` |
| ~/.local/bin/dia 软链 | 指向 `<install>/bin/dia.js` |

## 回滚

```bash
rm -rf ~/.dia
mv ~/.local/share/dia.bak-YYYYMMDD ~/.local/share/dia
# 用旧版 dist 重新 install.sh（DIA_HOME=~/.local/share/dia）
```

## 实战 runbook（Linux / levm，2026-11-05 已执行）

> 迁移前把 cron / systemd timer 全停，迁移后逐任务验证再恢复。以下命令在 levm 上实跑通过，`dia doctor` 终态 ok。

```bash
# 0) 备份（数据 + job + crontab）
TS=$(date +%Y%m%d-%H%M)
tar czf ~/backups/dia-data-$TS.tgz -C ~ .local/share/dia/{personas,msg,agents,state} .yan-agent/msg .cache/dia
tar czf ~/backups/dia-job-$TS.tgz -C ~ .local/share/dia-job
crontab -l > ~/backups/crontab-$TS.txt
# 把所有 `dia-job:` 行注释掉（记下原样，后面恢复）

# 1) 只迁数据（不装、不改 bin 链接）
dia migrate data
# 装新版走 npm：npm i -g @minonl/dia@latest

# 2) cache（dia migrate data 不搬）
mkdir -p ~/.dia/cache && [ -d ~/.cache/dia/index ] && mv ~/.cache/dia/index ~/.dia/cache/

# 3) 旧 yan 消息根合并（按 id/文件名去重，内容不同的记冲突人工处理）
python3 - <<'PY'
import os, shutil, filecmp
src=os.path.expanduser("~/.yan-agent/msg"); dst=os.path.expanduser("~/.dia/msg")
for agent in sorted(os.listdir(src)):
    s=os.path.join(src,agent)
    if not os.path.isdir(s): continue
    for sub in os.listdir(s):
        sd=os.path.join(s,sub); dd=os.path.join(dst,agent,sub)
        os.makedirs(dd,exist_ok=True)
        for f in os.listdir(sd):
            sp,dp=os.path.join(sd,f),os.path.join(dd,f)
            if os.path.exists(dp):
                if not filecmp.cmp(sp,dp,shallow=False): print("CONFLICT",agent,sub,f)
            else: shutil.move(sp,dp)
PY

# 4) persona 渲染产物重建（迁移后 codex/opencode 侧路径全变）
for p in $(dia persona list | cut -d: -f1); do dia persona render "$p" || true; done

# 5) dia-job 数据根：~/.local/share/dia-job → ~/.dia/job（可选，但推荐）
mkdir -p ~/.dia/job && cp -a ~/.local/share/dia-job/. ~/.dia/job/
python3 - <<'PY' > /tmp/jobs.tsv
import json, os
r = json.load(open(os.path.expanduser("~/.dia/job/tasks/registry.json")))["tasks"]
for n, v in r.items():
    print("\t".join([n, v["cmd"], v.get("interval", "-"), v.get("calendar", "-"), v.get("desc", ""), v.get("label", "")]))
PY
while IFS=$'\t' read -r n cmd iv cal desc label; do
  args=(install "$n" --cmd "$cmd" --desc "$desc" --label "$label" --allow-unstable)
  [ "$iv" != "-" ] && args+=(--interval "$iv")
  [ "$cal" != "-" ] && args+=(--calendar "$cal")
  dia job "${args[@]}"
done < /tmp/jobs.tsv
rm -rf ~/.local/share/dia-job   # 验证 cron 指向 ~/.dia/job 后再删

# 6) 验证 + 恢复调度
dia doctor --paths && dia doctor
dia msg inbox <agent>          # 条数与迁移前对齐
# 恢复 crontab（保留业务方原有暂停项）
```

### 踩过的坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `dia doctor` verdict=fail：多个 persona `verify 产物被改动` | codex 宿主渲染固定写 `<data>/codex-home`，多 persona 互相覆盖（已在 #22 改为按 `data_root` 隔离） | 升级到含 #22 的版本后重新 `dia persona render` |
| 角色任务读不到消息 / 写不进去 | `role-*` 包装脚本仍 `export DIA_MSG_ROOT=~/.yan-agent/msg`（新代码不读），systemd `ReadWritePaths` 也指向旧根 | 删掉该 export；`ReadWritePaths` 改为 `~/.dia/msg`、`~/.dia/state` |
| cron 里的任务仍跑旧根 | 任务包装脚本把 `DIA_JOB_ROOT` **写死**在文件里 | 移动 job 根后用 `dia job install` **重装**（不要手改），crontab 行会一起更新 |
| `dia job` 显示新根但数据在旧根 | `dia job` 之前不传 `DIA_JOB_ROOT`（已在 #21 修） | 升级即可；迁移期新根不存在时自动回退旧根 |

