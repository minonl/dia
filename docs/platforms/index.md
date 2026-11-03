# AI 工具平台经验库（索引）

> 2026-11-03 起。**本目录记录的是 AI 工具平台**（opencode / dsh / codex / pi / mimocode / zed …）
> 「某平台 × 某版本怎么配、哪里会炸、怎么验」——**不记录设备/主机信息**（主机名、内网地址、机器清单一律不入本目录）。
> 规则：**一条经验 = 版本范围 + 复现命令 + 现有判据**；没有复现命令的写「未验证」。
> 现状地图见 `../overview.md`；长期规划见 `../vision.md` §4。

## 0. 脱敏规则（写之前先看）

| 可以入仓（公开级） | 不入公共仓（私人仓/数据根） |
|---|---|
| 软件名、公开版本号、公开配置键、公开 issue/文档链接 | 设备名 / hostname、内网域名 / IP、账号、凭据 |
| 通用路径（`~/.config/...`、`~/.dsh/profiles/...`） | 个人设备清单、家庭设备、组织机构内部标识 |
| 复现命令（用占位符 `<host>` / `<org>` / `<id>`） | 任何能反查到个人或组织的组合信息 |

判据：提交前 `git grep -nE "<内网域名>|<hostname>|<账号>"` 必须为空；拿不准就按"私人仓"处理。

---

## 1. 支持矩阵（2026-11-03 实测）

| 宿主 | 本机版本 | dia 渲染目标 | 状态 | 备注 |
|---|---|---|---|---|
| **opencode** | `v2.2.5` | `~/.config/opencode/agents/<id>.md` | **已支持** | 配置文件 `opencode.json` / `opencode.jsonc` 二选一（两者都在时宿主先读 `.json`） |
| **dsh** | `0.2.1-rc.2` | `~/.dsh/profiles/<id>/` | **已支持** | profile 里 `cordis.patch.yml` 是声明层；`cordis.yml` 由宿主运行时重写 |
| codex | 未安装（`~/.codex/config.toml` 存在） | — | **仅配置注入实践**（见 yan-agent skill） | 未纳入 `dia persona render` |
| mimocode | 未安装 | — | 仅配置注入实践 | 同上 |
| zed | 未安装 | — | 仅配置注入实践 | 同上 |

> `dia persona/add` 的 `--host` 目前只接受 `opencode` / `dsh`；其余宿主会报 `E_HOST: host not implemented`。

---

## 2. 已知断代与坑

| 宿主 | 版本范围 | 坑 | 判据 / 复现 | 出处 |
|---|---|---|---|---|
| opencode | V1 → V2 | **断代**：V1 实现不在 V2 运行，配置键与 hook API 全变 | `opencode --version`；按 `docs/host-control-surface.md` §1 的 v2 拓扑核对 | `docs/ecosystem-integration.md` §1 |
| dsh | `0.2.1-rc.2` | preset 里 patch **覆写** preset 会让全部 agent 掉工具，需冷启动 | `dia doctor --persona <id>` 的 `dsh.preset` 项；对照 `Config.required()` | dabo `core/knowledge/ops/troubleshooting.md` §2 |
| dsh | `0.2.1-rc.2` | `cordis.yml` 是宿主生成物，不要手改（改 `cordis.patch.yml`） | `dia persona render <id> --check`（已排除该文件） | `src/persona.ts` 的 `HOST_OWNED_FILES` |
| dsh | 未知→`2026-11` | dabo 的 webserver 端口由 `?? 1111` 动态决定，**不是固定 3090** | 读 `~/.dsh/profiles/<id>/cordis.patch.yml` 的 `webserver.port` | dabo-agent `platform/dsh/dabo-persona` 提交 `0df7b64` |

---

## 3. 待补（P0）

1. `hosts.yaml`：机器可读的 `version_range / checks / fallback`，供 `dia doctor --host` 消费。
2. 每个宿主一篇 `<host>.md`：配置键全量、渲染目标、升级注意事项、验证命令。
3. codex / mimocode / zed 接入前先补"配置注入"事实（当前只在 yan 的 skill 里有，未在本机验证）。
