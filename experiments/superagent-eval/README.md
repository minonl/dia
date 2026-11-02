# superagent 效率对照实验（pilot）

> 目标：在**同一个老 commit、同一个 prompt、同一个 worktree、同一个 judge** 下，对比
> dsh-superagent / dia team / 单 agent 的代码结果、对话轮次、工具调用、token 与人工介入。
> 这不是“跑一次感觉快”，而是可复现的对照。

---

## 1. Pilot 任务

| 项 | 值 |
|---|---|
| 仓库 | 本地 example-repo checkout（`$HUMMUS_REPO`） |
| Base commit | `61e0bc1d55088f48487d8781ed2d4a2fbb1c77e3` |
| 参考修复 | `30397850d`（staff 回跳 / 主 token 分流） |
| 固定 worktree | `$HUMMUS_WORKTREE`（detached；pilot 已建） |
| 隐藏 judge | 参考修复里的两个测试文件（agent 不可见） |
| 目标测试 | `web-hub` + `superbook-auth` 的 vitest |

prompt 见 `prompt.md`。agent 只看到 base commit 和 prompt，看不到参考修复、测试补丁。

---

## 2. 三个 arm

| arm | 跑什么 | 说明 |
|---|---|---|
| `superagent` | dsh-superagent 完整链路 | 需要 DSH profile + GitHub Source + issue 触发；最接近产品形态 |
| `dia-team` | `dia team` 4 角色 | planner/builder/verifier/redteam，ACP/dsh |
| `single` | 单 agent 同模型 | 控制组，排除“多角色”影响 |

**注意**：`superagent` 不是一个本地 one-shot CLI；它通过 Source/Trigger 工作。若不做 GitHub issue，
只能跑它的 worker prompt（Tier A），不能算完整 superagent（Tier B）。实验报告必须注明是哪一档。

---

## 3. 固定 worktree 协议

```sh
# 已创建（变量由操作者提供，不写死公司路径）
git -C "$HUMMUS_REPO" worktree add --detach "$HUMMUS_WORKTREE" 61e0bc1d5

# 依赖必须在 worktree 内真装（禁止软链主仓 node_modules）
cd "$HUMMUS_WORKTREE"
pnpm install --frozen-lockfile
```

每次 run 前：

```sh
git reset --hard 61e0bc1d5
git clean -fd          # 保留 node_modules（已 gitignore）
```

- 不要 `git clean -fdx`：会删 node_modules。
- 不要从主仓软链 node_modules（R20）。
- 固定 worktree 已建在 `61e0bc1d5`，依赖已在该 worktree 内安装。
- 固定 Node/pnpm/模型：`node -v`、`pnpm -v`、模型 id 写进 meta。

---

## 4. 采集字段

`run-arm.sh` 输出：

```text
results/<run-id>/
  meta.json
  agent.log
  diff.patch
  diff.stat
  changed_files.txt
  judge.log
  result.json
```

最少指标：

| 类别 | 指标 |
|---|---|
| 结果 | hidden tests pass、lint/typecheck、changed files、diff 行数 |
| 效率 | wall time、agent turns、tool calls、input/output tokens、cost |
| 交互 | human messages / approvals |
| 质量 | 独立 verifier 的 findings、是否改测试/绕过 |

`trace.json` 约定（agent 适配器可写；没有就记 unknown，不伪造）：

```json
{"turns":0,"tool_calls":0,"input_tokens":0,"output_tokens":0,"human_messages":0}
```

---

## 5. Judge（隐藏测试）

不要提前把测试放进 worktree。agent 结束后：

```sh
# 只取参考修复的测试文件
git checkout 30397850d -- \
  apps/web-hub/src/lib/session-route.spec.ts \
  libs/experimental/superbook-auth/src/__tests__/engine.test.ts

pnpm nx test web-hub --skip-nx-cache
pnpm nx test superbook-auth --skip-nx-cache
```

- 若 agent 自己加了测试，先恢复 judge 测试文件，再跑；
- 记录退出码和失败断言，不修改 agent 实现来“帮它过”。

---

## 6. 运行

```sh
# 一个 arm 一次；agent 命令由适配器提供
bash experiments/superagent-eval/run-arm.sh \
  --arm single \
  --worktree "$HUMMUS_WORKTREE" \
  --base 61e0bc1d5 \
  --prompt experiments/superagent-eval/prompt.md \
  --agent-cmd '<your-agent-command>' \
  --out results/pilot/single-1
```

同 prompt、同 base、同模型，至少每 arm 3 次；报告中位数，不挑最好的一次。

---

## 7. 统计与结论

- 先跑 1 次 sanity，确认 judge 在 base 上确实失败（实测 web-hub 9 个断言失败）；
- 每 arm 3 次，记录中位数/范围；
- **代码结果**：hidden tests + 独立 review，不以“agent 说完成”为准；
- **效率**：wall / turns / tool calls / tokens 分开报，不合成一个“效率分”掩盖差异；
- **人工注意力**：human messages、approval 次数单独列；
- 结论必须写清 arm 类型（Tier A worker vs Tier B full superagent），否则不可比。
