# 用户入口：人在哪进，agent 叫什么

> 日期 2026-10-28。
> 一句话：**入口仍是 opencode/dsh（和 yan 一样），但 agent 名是 `dabo`，不是 `dia`；`dia` 是控制面命令，不是人格。**
>
> **2026-11-03 复核**：终端入口已落地（`~/.config/opencode/agents/dabo.md` + `~/.dsh/profiles/dabo`）；
> IM bridge 仍未写；文中出现的 `dia status` / `dia model` **不存在**，观测入口目前是 `dia doctor`。

---

## 0. 三个名字别混

| 名字 | 是什么 | 用户会怎么遇到 |
|---|---|---|
| **dabo** | 个人域 agent（人格 + 域知识 + 工具） | 在 opencode/dsh 里选 agent |
| **yan** | 工作域 agent | 同上（已有） |
| **dia** | 框架/控制面（知识、审计、基准、门禁） | 命令行 `dia ...`，不是聊天对象 |

所以：**不会出现"选 dia agent 聊天"**；用户选的是 `dabo` 或 `yan`。

---

## 1. 入口矩阵

| 入口 | 形态 | 跑什么 | 现状 |
|---|---|---|---|
| **终端（主）** | `opencode`（agent=dabo）/ `dsh`（profile=dabo） | 交互式会话 | **已渲染**（yan 同构，profile 3091；dabo 端口动态） |
| **IM（异步）** | 钉钉 → dws-hub → dia bridge | 建任务 → 后端执行 → 草稿回复 | bridge 未写 |
| **自动化** | launchd → `dsh headless` / `dia run` | 批处理、canary、巡检 | 部分有 |
| **控制面** | `dia doctor` / `audit` / `kb` / `price` | 观测、审计、知识、计价 | 已有（`status` / `model` 未实现） |

**没有第四种"dia 自带界面"**：dia 不拥有运行时，也不做 TUI。

---

## 2. 终端入口：和 yan 完全同构

```
opencode:  ~/.config/opencode/agents/dabo.md     （persona + 工具 + permission）
dsh:       profile bundle: dabo-preset           （dsh-agent-preset + persona + 域插件）
```

选择方式：
- opencode：切 agent 到 `dabo`（或 `opencode --agent dabo`）。
- dsh：profile 选择 / preset `dabo`。

**与 yan 的差别只在内容**：`dabo` 用个人域知识与策略；机制一样。

---

## 3. IM 入口：不是另一个 agent

```
钉钉消息 → dws-hub（通道，常驻）
        → dia bridge（消息 → 任务；不做语义）
        → 选后端（dsh/opencode/ACP）
        → 产出草稿 → 人工确认 → 发送
```

- bridge 不扮演 agent，不写人格；
- 回复默认 **draft-only**；
- 会话记录进同一套 episodes/audit。

---

## 4. 配置失败时的入口体验

| 失败 | 用户看到 | 行为 |
|---|---|---|
| dabo preset 未渲染 | `dia doctor` 报 `preset dabo missing`；opencode 里看不到 `dabo` | **不静默回退到默认 agent**；提示渲染命令 |
| ACP 不可用 | `dia run` 报错，不静默回退 | 交互可用，审计降级（degraded 状态未实现） |
| dws-hub 未运行 | bridge 未写，无入口 | IM 入口不可用，终端入口不受影响 |
| 策略未加载 | **拒绝高风险动作**（不是回退到无策略） | 只读/草稿可用 |

原则：**入口可以少，策略不能悄悄没。**

---

## 5. 落地顺序

1. 渲染 `dabo` preset（opencode md + dsh bundle），先能在终端里选到；
2. 写 `dia bridge`（IM 入口），默认 draft-only；
3. `dia doctor` 增加入口自检：preset 是否存在、ACP 是否握手、dws-hub 是否心跳。
