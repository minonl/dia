# dia CLI 词表（动作规范）

> 日期 2026-10-28。原则：**动作成对、名词分层、不混轴。**
> 名词：`persona`（可被选中的 agent 定义）、`kit`（知识/技能/工具内容）、`profile`（dsh 宿主组合，不对外当命令）。

---

## 1. 动词矩阵

| 动作 | 含义 | 反义/配套 | 示例 |
|---|---|---|---|
| **add** | 从 git/本地取回 → 校验 → 渲染 → 登记 lock/deps | **remove** | `dia persona add dabo --from git+... --ref <sha>` |
| **remove** | 注销 + 删除带 `managed-by: dia` 的产物 | add | `dia persona remove dabo` |
| **create** | **本地生成**一个新骨架（`dia.json` + 最小文件） | （无；不是安装） | `dia persona create mybot` |
| **update** | **换内容**（ref→新 commit）+ 重渲染；旧版本备份；运行中会话不切换 | — | `dia persona update dabo --ref <sha>` |
| **render** | **不换内容**，只把已安装版本重渲染到宿主（宿主升级/文件漂移） | — | `dia persona render dabo --host dsh` |
| **verify** | 清单/哈希/版本校验 | — | `dia persona verify dabo` |
| **list / show** | 列出 / 看详情 | — | `dia persona list` |
| **add / remove**（kit） | 同上，作用于内容 | — | `dia kit add git+...` |

**不要用**：
- `install/uninstall`（与 add/remove 重复，且暗示系统级安装）；
- `preset`（宿主概念，不当作名词）；
- `pkg`（npm 语义，暗示依赖/执行）。

---

## 2. 名词与子命令

```
dia persona add|remove|create|update|render|verify|list|show
dia kit     add|remove|create|update|verify|list|show
dia patch   create|add|list|verify|revert|export
dia persona activation <id> --mode next-session|active-additive|active-all|manual
```

**默认行为约束**：
- `add` 只新增/渲染，**不改默认 agent**、不碰 yan；
- `remove` 只删 `managed-by: dia` 的文件，用户手改过的拒绝删除；
- `create` 不联网、不执行脚本，只写骨架；
- 所有写动作支持 `--dry-run`。
- **按能力热更新**：T3 增量可 `--apply active`；破环性变更只允许 `--apply next-session`；`--activate-now` 需 `--i-am-human`。

---

## 3. 退出码

| 码 | 含义 |
|---|---|
| 0 | OK |
| 2 | 用法错误 |
| 30 | degraded（已回退/部分宿主缺失） |
| 31 | 配置/鉴权失败 |
| 32 | 清单/冲突（E_MANIFEST / E_CONFLICT） |
| 33 | 能力缺失（capabilities 不支持该动作） |

---

## 4. 示例

```bash
# 安装 dabo 人格（只新增，不改默认）
dia persona add dabo --from git+https://github.com/minonl/dabo-agent.git --ref <sha> --dry-run
dia persona add dabo --from git+... --ref <sha>

# 从零写一个新人格
dia persona create mybot --dir ~/repos/mybot

# 宿主升级后重渲染
dia persona render dabo --host dsh

# 校验/卸载
dia persona verify dabo
dia persona remove dabo
```

---

## 4.1 实现状态（2026-10-28）

| 命令 | 状态 |
|---|---|
| `persona add / list / verify / remove` | **已实现**（本地源 + opencode 渲染） |
| `persona add --from git+... --ref` | 已实现（fetch 后 checkout FETCH_HEAD） |
| `persona add --host dsh` | 未实现（E_HOST，exit 33） |
| `persona create / update / render / show` | 未实现（exit 2） |
| `kit ...` | 未实现（exit 2） |
| `patch ...` | 未实现（exit 2） |
| `task add/list/status/done` | **已实现**（done 需 judge+evidence） |
| `team run --mock / gate / accept / reject` | **已实现**（状态机与门禁） |
| `team run --acp --workspace DIR` | **已实现（opencode ACP）** |
| `team run --dsh --workspace DIR` | **已实现（dsh ACP，成功路径）** |
| `team gate / accept / reject` | 已实现 |

## 5. 与安装文档的关系

- 清单格式与安全规则见 `docs/persona-install.md`；
- 入口与默认 agent 规则见 `docs/entrypoints.md`。
