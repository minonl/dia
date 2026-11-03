# dia 长期定位：从"安装器"到 superagent / agent-team 工厂

> 2026-11-03，方向性文档。**它不是现状**——现状看 [`overview.md`](overview.md) 与 [`status.md`](status.md)；
> 两者冲突时以现状为准。本文回答："一年后 dia 要长成什么，现在缺什么。"

---

## 1. 一句话

**dia 是 superagent / agent-team 的生成与维护工具。**
把一个「域」编译成能跑、能审、能进化的 agent（单域）或 agent-team（多角色），
再把它送进更大的组织形态（rig / fleet / software factory）里自行工作。

现在 dia 只做到这条链的前半段：**persona 安装 + 渲染 + 知识/审计控制面**；
后半段（团队生成、平台版本经验、自身成为 agent、fleet 对接）还没有。

---

## 2. 产物谱系

| 产物 | 域 | 形态 | 现状 |
|---|---|---|---|
| **yan** | 工作域 · 偏前端领域 | 单 superagent（16 个域命令 + 知识库 + 技能） | 已装，落后来源仓 1 个提交 |
| **dabo** | 个人 · 游戏 / 生活 / 个人项目 | 单 superagent（人格 + 9 角色团定义 + 2 个域命令） | 已装，与来源一致 |
| **redmine case agent**（计划） | 工作域 · 工单处理 | 单域 superagent（case 检索 → 判定 → 草稿 → 留痕） | 未开始 |
| **家庭库管家**（计划） | 个人 · 家庭资料 | 单域 superagent（私有数据根 + 只读索引 + 定期巡检） | 未开始 |
| **openrig rig**（计划） | 多 agent 协作 | agent-team / rig（组织形态见 §5） | 未开始；边界待定 |

**编译链（dia 的职责）**

```
域内容（人格 + 知识 + 技能 + 命令 + 策略）
   → dia persona/kit 校验 + 渲染（opencode / dsh / 未来宿主）
   → 运行（宿主 / ACP / headless）
   → 观测（audit / episodes / usage）
   → 知识沉淀 + 评审
   → 再编译（update / patch / activation）
```

判据：同一个域，换宿主只换 render target，不重写内容；换版本不丢审计与回滚。

---

## 3. dia 的两个面

| 面 | 形态 | 属性 | 现在 |
|---|---|---|---|
| **A. 控制面** | `dia` CLI（确定性、无 LLM） | 可脚本化、可审计、可回滚；CI/门禁的稳定接口 | 已存在（见 `cli.md`） |
| **B. dia-agent** | 跑在宿主里的 superagent，工具 = 控制面 + 知识 | 能对话、能规划、能解释"为什么这样配" | 未开始 |

**B 不是把 LLM 塞进 A。** 硬边界：

1. A 的每条命令保持确定性；同一输入同一输出，模型不参与判定。
2. B 只能**调用** A，不能绕过门禁（写操作仍要 `--force` / 人确认 / 审计）。
3. B 的成长 = 知识库 + 提案 + 评审，不是运行时自我改写（复盘见 `evolution-process.md`）。
4. B 的产物仍然是 persona：可 `verify`、可 `remove`、可回滚。

---

## 4. 平台对接能力（当前最大的工程缺口）

目标：**同一份域内容，能在不同宿主 / 不同版本上稳定落地**，且每个坑都有记录、有判据。

### 4.1 需要的能力

| 能力 | 说明 | 现状 |
|---|---|---|
| 配置矩阵 | opencode / dsh / codex / mimocode / zed / ACP 的配置键与渲染目标 | 只有 opencode + dsh；`ecosystem-integration.md` 有对照但无矩阵 |
| **版本经验库** | 每个宿主 × 版本的：配置键、断代点、已知坑、验证命令、降级策略 | **缺**（坑散落在知识库与提交信息里） |
| 能力探测 | 启动前判断宿主版本支持什么（hooks / ACP / skill 目录） | 只有 `dsh.checkPreset` 一项 |
| 依赖校验 | `deps.yaml` 与实际可执行文件/版本比对 | **缺（M1）** |
| 降级策略 | 宿主能力缺失时明确降级还是失败（不静默） | 设计有（`entrypoints.md` §4），未实现 |

### 4.2 版本经验库的建议形态

```
docs/hosts/
  index.md            # 宿主 × 版本矩阵：支持到哪、哪个版本断代（已建，2026-11-03）
  opencode.md         # 配置键、渲染目标、已知坑、验证命令（含 v1→v2 断代）
  dsh.md              # bundle/patch 语义、preset 校验、冷启动坑
  codex.md / mimocode.md / zed.md   # 有接入才建
hosts.yaml            # 机器可读：version_range / checks / fallback（doctor 消费）
```

规则：**一条经验 = 版本范围 + 复现命令 + 现有判据**；没有复现命令的写"未验证"。
`dia doctor --host <name>` 用 `hosts.yaml` 做校验；`deps.yaml` 仍是"装了什么"的账本，两者不混。

---

## 5. fleet / factory（openrig 层）

边界建议（**待与 openrig 侧确认**）：

| 层 | 谁负责 | 内容 |
|---|---|---|
| 域内容与配置 | **dia** | persona/kit、宿主渲染、知识根、审计契约、版本经验 |
| 编排与隔离 | **openrig** | rig 定义、席位、队列、快照、隔离环境、跨 agent 调度 |
| 证据格式 | 两边共用 | 任务 id、回合、审计行、成本行（dia 已有 `audit` / `usage` 形状） |

dia 对 fleet 的交付物：**可导出的 persona 包 + 能力声明 + 校验结果**，而不是"帮 openrig 调度"。
判据：一个 rig 不依赖 dia 的运行时也能跑；dia 只负责"装配正确 + 可追溯"。

---

## 6. 路线（按依赖排序）

| 阶段 | 内容 | 依赖 / 判据 |
|---|---|---|
| **P0** | 平台经验库 + 依赖校验（M1）：`docs/hosts/` + `hosts.yaml` + `doctor --host` | 现有两台宿主实测通过；`deps.yaml` 不再与真实环境脱节 |
| **P1** | team 生成：team spec → 多个 persona/角色 + 门禁 | `team run --mock` 已可用；需补"从 spec 生成角色" |
| **P2** | `dia-agent`：控制面 persona（读文档、解释配置、给迁移建议） | P0 的经验库是前置（否则它只会瞎猜） |
| **P3** | rig 导出：persona 包 + 能力声明 → openrig | 与 openrig 的接口定稿 |
| **P4** | 多域隔离（团队/家庭/项目）与数据根策略 | `data_root` 契约 + `DIA_DATA_ROOT_SCOPE` 已有雏形 |

与既有缺口的关系：P0 吃掉 M1；P1 顺带解决 `kit show/update/gc` 的一半需求；
P2 依赖 `patch` / `activation` 的边界先定清。

---

## 7. 不做什么（防止漂移）

- **不自建运行时 / 沙箱 / 通道**：复用宿主与 openrig，dia 只做装配与控制。
- **不把 LLM 放进确定性控制面**：模型只在 dia-agent 面说话，判定仍走命令与判据。
- **不做公共市场 / 自动安装**：安装必须可审、可回滚。
- **不存业务数据**：域数据留在各域的数据根。
- **无证据不扩团、不扩档位**：团队规模按真实任务增长。

---

## 8. 待决策

1. **dia-agent 的边界**：它是否也需要独立人格 / 数据根？还是只作为"控制面顾问"临时加载？
2. **fleet 层归谁**：配置与知识归 dia、编排与隔离归 openrig——这条边界要 openrig 侧确认。
3. **版本经验库的载体**：`docs/hosts/*.md` + `hosts.yaml` 双份（人读 + 机器读），还是只做 yaml？
4. **多域数据隔离**：家庭库这类敏感域，是否需要独立加密数据根与独立审计线？
