/**
 * 子命令级 `--help` 的单一实现（issue #228）。
 *
 * 背景：2026-11 事故 —— `dia job uninstall --help` **真的执行了 uninstall**。
 *   根因是各子命令用 `args.includes("--help")` / `args[i+1]` 这类**不看上下文**的判定，
 *   既无法区分「值位」（`--body --help` 的正文就是 --help）也不能保证每个命令都处理。
 *
 * 设计（用户 2026-11-19 拍板）：
 *   1) **单一拦截点**：main() 里一次 helpGate，而不是散在 18 个函数里；
 *   2) **值位白名单**：取值的 flag 后面那个 token 是值，不是 help；
 *   3) **fail-safe**：拿不准（未知 flag / 无法判定）⇒ 当作用户要帮助，**绝不执行**。
 *      宁可多打印一次帮助，也不让 `--help` 触发破坏性动作。
 *   4) 帮助文本集中在本文件 HELP_TEXTS（key = "cmd" 或 "cmd sub"），逐字搬迁，
 *      保证 `dia --help` 输出与改造前**完全一致**。
 *
 * ── 判定原则（两个方向的错误代价不对称，2026-11-19 对抗评审后写死）─────────────
 *
 *   误收（把真 `--help` 当值） ⇒ `helpRequested=false` ⇒ **命令照常执行** ⇒ 危险
 *   漏收（把值当 `--help`）     ⇒ 只多打印一次帮助、不执行     ⇒ 安全
 *
 *   ⇒ **拿不准就不收。** 往 VALUE_FLAGS 里加一项的唯一门槛是「有真实取值点」：
 *     - TS：某处的 `flag(args, "--x")` / `flags(args, "--x")`（值位唯一口径）
 *     - bash：`--x) v="$2"` / `--x) v="${2:-}"`（且该子命令确实经过本 gate）
 *   实测反例（评审给出并复现）：`--force-with-lease` 零消费方却被收 ⇒
 *     `dia cache gc --apply --force-with-lease --help` 把 --help 当值吞掉 ⇒ **真删了 cache**。
 */

/** 取值的 flag（白名单）：紧跟其后的 token 是值，即使它长得像 --help。
 *  来源 = 代码里 `flag(args,"--x")` / `flags(args,"--x")` 的实际调用点（值位为唯一口径）。
 *  ⚠️ 只收**确实取值**的 flag：误收会反过来把 `--help` 当值吞掉 ⇒ 变成执行（与目标相反）。
 *  ⚠️ 只被 `dia wt`（packages/wt/bin/dia-wt）消费的 flag **不收** —— wt 不走本 gate，
 *     它自己在各子命令参数循环最前面判 `-h|--help`（见 cmd_* 的早退）。
 *     实测移除：`--base` / `--protect`（仅 wt 用）、`--force-with-lease`（零消费方）。
 *  ⚠️ 「存在性开关 + 可选值」的 flag **刻意不收**（见 EXCLUDED_OPTIONAL_VALUE 的说明）。
 *  ⚠️ 即使收进来，`--flag --help` 也只有 HELP_AS_VALUE_FLAGS 里的自由文本字段会吃掉 --help；
 *     其余一律按「请求帮助」处理 —— 否则 `dia cache gc --apply --id --help` 会真删数据。 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--acp-cmd",
  "--addr",
  "--agent",
  "--blocked-reason",
  "--body",
  "--body-file",
  "--bw",
  "--by",
  "--cache-dir",
  "--calendar",
  "--calls",
  "--class",
  "--cmd",
  "--cwd",
  "--days",
  "--db",
  "--deadline",
  "--decision",
  "--deps",
  "--depth",
  "--desc",
  "--dir",
  "--domain",
  "--env",
  "--evidence",
  "--exit",
  "--exit-code",
  "--explain",
  "--fanout",
  "--file",
  "--files",
  "--from",
  "--gen",
  "--goal",
  "--home",
  "--hops",
  "--host",
  "--hypotheses",
  "--id",
  "--idempotency-key",
  "--integrity",
  "--interval",
  "--into",
  "--item",
  "--judge",
  "--keep",
  "--keys",
  "--kind",
  "--label",
  "--last-episode",
  "--lease",
  "--limit",
  "--map",
  "--max",
  "--n",
  "--name",
  "--note",
  "--now",
  "--opencode-db",
  "--out",
  "--owner",
  "--pane",
  "--params",
  "--passwordfile",
  "--persona",
  "--pid",
  "--pr",
  "--presence-ttl",
  "--prio",
  "--profile",
  "--progress",
  "--project",
  "--reason",
  "--ref",
  "--remind-at",
  "--removal-after",
  "--reply-to",
  "--reply-to-id",
  "--repo",
  "--resolved",
  "--result",
  "--risk",
  "--role",
  "--root",
  "--runtime",
  "--section",
  "--session",
  "--sessions-root",
  "--set",
  "--since",
  "--skills-dir",
  "--slice",
  "--socket",
  "--sort",
  "--source",
  "--stage",
  "--stale-days",
  "--start",
  "--state-file",
  "--status",
  "--subject",
  "--tag",
  "--task",
  "--thread",
  "--timeout",
  "--title",
  "--to",
  "--tool",
  "--touch",
  "--touches",
  "--track",
  "--transport",
  "--ttl",
  "--type",
  "--version",
  "--waiting-on",
  "--waiver",
  "--weekdays",
  "--width",
  "--workspace",
  "--worktree",
]);

/** 「存在性开关 + **可选**值」的 flag —— **刻意不收**进 VALUE_FLAGS（fail-safe）。
 *
 *  为什么：这些 flag 既可以裸用（当布尔），也可以带一个值；一旦收进白名单，
 *  `--due --help` 就会被当成「--help 是 --due 的值」⇒ 不打印帮助 ⇒ 命令执行（危险方向）。
 *  不收的代价只是「用户真想传值 --help 时多看到一次帮助」（安全方向）。
 *  ⇒ 拿不准就不收。新增同形态 flag 时按此表登记，别偷偷塞进 VALUE_FLAGS。 */
export const EXCLUDED_OPTIONAL_VALUE: ReadonlySet<string> = new Set([
  "--due",          // `dia msg escalate --due`（开关）/ `dia task add --due D`（值）
  "--export-html",  // `dia graph --export-html [path]`
  "--next",         // `dia graph --next [n]`
  "--seats",        // `dia graph --next --seats N`（不带值时按默认席位）
  "--gc",           // `dia claims --gc [--days 7]`
]);

function isHelpToken(a: string): boolean { return a === "--help" || a === "-h"; }

/** **值就是字符串 `--help`** 的自由文本 flag —— 只有这几种才允许「值位吃掉 help」。
 *
 *  为什么必须缩到这么小：白名单是**全局**的（gate 不知道当前命令吃哪些 flag），
 *  若任何取值 flag 都能吃掉 `--help`，那么
 *    `dia cache gc --apply --id --help`  →  `--help` 成了 `--id` 的值  →  **真删 cache**。
 *  ⇒ 只有「用户真的可能把 --help 当正文写进去」的文本字段保留值位语义：
 *    `dia msg send … --body --help`（`HELP_TEXTS["msg send"]` 里有显式说明）、
 *    `--subject` / `--desc` / `--reason`（commit a9635a5 的测试钉住了这三个）。
 *  其余 flag（id/path/数字/枚举/env）后面跟 `--help` 一律当**请求帮助**（fail-safe）。
 *  ⚠️ 往这里加一项 = 重新打开一条「误收 ⇒ 执行」的通道，必须同时说明为什么该字段可能是 --help。 */
export const HELP_AS_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--body",
  "--subject",
  "--desc",
  "--reason",
]);

/**
 * 这串参数是否在「请求帮助」？
 *   · 遇到 `--` 立即返回 false（其后全是给子进程的数据）
 *   · `--x=--help`（attached 写法）不算
 *   · 值位：`--body --help` 是值（仅限 HELP_AS_VALUE_FLAGS 里的自由文本字段）
 *   · 其它取值 flag 后面跟 help token ⇒ 仍算请求帮助（拿不准 ⇒ 不执行）
 */
export function helpRequested(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return false;
    if (isHelpToken(a)) {
      const prev = i > 0 ? args[i - 1] : undefined;
      if (prev !== undefined && HELP_AS_VALUE_FLAGS.has(prev)) continue; // 值位（自由文本）
      return true;
    }
    if (VALUE_FLAGS.has(a)) {
      const next = args[i + 1];
      // 值本身不是 help token 才跳过；若长得像 --help，留给下一轮按「请求帮助」判定
      if (next !== undefined && !isHelpToken(next)) i++;
    }
  }
  return false;
}

export const HELP_TEXTS: Record<string, string> = {
  "root":
    `dia (嗲) — agent framework

usage:
  dia kb index [--root DIR] [--db PATH] [--json]
  dia kb search <query> [--root DIR] [--db PATH] [--limit N] [--json]
  dia kb query <query> [--root DIR] [--db PATH] [--limit N] [--json] [--full] [--bytes] [--auto-index]
  dia kb review [--root DIR] [--db PATH] [--json]
  dia kb path <doc:...|workflow:...|skill:...|tool:...#mode> [--root DIR] [--repo DIR] [--json]
  dia kb lint [--root DIR] [--db PATH] [--stale-days N] [--json] [--strict]
  dia kb get <path> [--root DIR] [--section HEADING]
  dia --persona ID kb <cmd>   # persona 作用域：知识根/数据根/域命令委派
  dia ingest sessions [--source dsh|opencode|all] [--domain dabo|yan] [--since ISO]
                      [--full] [--limit N] [--dry-run] [--out DIR] [--project ID] [--json]
  dia ingest git --repo DIR [--since DATE] [--limit N] [--json]
  dia audit append --session S --tool T [--decision allow|deny|waive] [--params JSON]
                    [--risk N] [--redline] [--note ...] [--json]
  dia audit verify --session S --calls N [--chain] [--json]
  dia audit score --session S [--json]
  dia audit tail [--n 20] [--json]
  dia freeze --reason R [--auto] [--last-episode ID] [--json]
  dia freeze status
  dia freeze thaw --reason R --i-am-human
  dia guard [--once] [--json]
  dia run --session S [--tool T] [--agent A] [--waive --risk N] [--redline] -- <cmd> [args...]
  dia resume --session S [--json]
  dia persona add <id|--from SRC> [--ref REF] [--host opencode|dsh|codex] [--home DIR] [--dry-run] [--force] [--json]
  dia persona create <id> --dir DIR [--host opencode|dsh|codex] [--no-msg] [--dry-run] [--json]
  dia persona render <id> [--host opencode|dsh|codex] [--home DIR] [--check] [--json]
  dia persona list|verify|remove|show <id>|use <id>[@ver]
  dia persona path [<id>[@<ver>]] [--json]   # 打印生效版本目录（服务/脚本取代码入口）
  dia persona check <id>|update <id> [--ref REF]
  dia doctor [--persona ID] [--paths] [--json]
  dia deps list [--json] [--file PATH]        # 派生视图：登记 + 实测
  dia deps record --id ID --kind K --version V [--resolved R] [--role required|optional] [--result pass|fail|unknown] [--evidence P]
  dia cache list [--root NAME] [--json]        # 缓存条目：体积/引用/是否有本地独有内容
  dia cache gc [--apply] [--force] [--referenced] [--root NAME] [--json]   # 默认 dry-run；cache 可删，要留就 backup
  dia env list|check [KEY…] | env [--dry-run] [--redact] <cmd…>
  dia env bw status|unlock [--passwordfile P]|lock
  dia env bw run --map KEY=item [--map …] [--task T] -- <cmd…>   # 只注入映射键；BW_SESSION 不进子进程
  dia env bw serve [--socket PATH] [--passwordfile P]   # 常驻 broker（可启动时解锁）
  dia env bw get --item ITEM [--env KEY] [--task T] [--json]
  dia persona default <id>|--unset|--show [--host opencode]
  dia kit add --from SRC [--ref REF] [--dry-run] [--json]
  dia kit list|verify <id>|remove <id>
  dia service add (<--from SRC> | --dir DIR) [--ref REF] [--dry-run] [--json]
  dia service list [--json] | show <id> [--json] | verify <id|--dir DIR> [--json]
  dia service health <id> [--from-wrapper --exit N --gen G] [--json]   # 0 ok/30 degraded/1 fail/31 判据不可用/2 用法
  dia service remove <id> [--json]
  dia wt create|form|list|status|check|route|scope|clean|prune-merged …
  dia cmd <name> [args…]              # 只查 persona 声明的命令（可绕开同名内置）
  dia <persona-cmd> [args…]           # 一级委派（内置优先）
  dia collab status|enable|disable [--persona ID]   # dia-msg 开关；enable 校正 300s 观察器定时并刷新 board，disable 一并卸载
  dia collab stats [--since 7d] [--by session|pair|class] [--json]   # 只读聚合（送达/回复/积压）
  dia collab board [--cached|--refresh] [--json] | observe [--interval 300] [--json]   # 一次性 tick/看板（无常驻；定时用 dia job）
  dia whoami [--json] [--name NAME]   # 当前会话身份（session id）
  dia in [--unread] [--all] [--class P0,P1] [--sort priority|arrival] [--expose] [--json]   # 会话收件箱（正文内联）
  dia out --to <session_id> --subject S (--body B|--body-file F) [--kind K] [--touch p1,p2] [--reply-to ID]
  dia ack <id> | dia reply <id> --body B | dia close <id> --reason R | dia show <id>
  dia msg send <ses_id> --subject S (--body B|--body-file F) | inbox | show <id> | ack <id> | reply <id> --body B | close <id> --reason R
  dia msg deliver <ses_id> <id> [--transport file|tmux|acp] [--wait]   # 显式重投（默认异步；日志在 collab/deliver/）
  dia msg trace <id> | stats [--since 7d] | seen <id…> | upkeep | retry | escalate --due | dsh [install|check]
  dia msg migrate [--dry-run|--apply]   # 旧 ~/.dia/msg 一次性导入 v2（默认只报告）
  dia msg analyze-storage [--json]      # 只读体检（v1 残留/v2 现状/事件流健康度）
  dia agents list|register|unregister|discover
  dia task add|list|link|plan|split|status|done [--owner S] [--depends a,b] [--touches p1,p2] [--prio P1] [--start D] [--due D] [--progress 0-100]
  dia task split <id> --into "切片A,切片B" [--slice 切片A] [--role R] [--judge J] [--touches p] [--force]
  dia wb [--json] [--summary] [--now ISO] [--depth fast|full] | wb refresh | wb migrate [--dry-run] | wb gc [--apply] | wb explain <id>
  dia wb track open|list|show|bind|unbind|stage|next|handoff|attach|close
  dia wb metrics|due|brief [--json] [--track tr-x] [--since 7d]
  dia beat [--session S] [--track tr-x] [--note N] [--json]   # 会话心跳；--help 只打印用法、不写盘
  dia graph [--json] [--task t-...] [--tui [--watch] [--status S] [--owner S] [--width N] [--no-color]]
  dia graph --serve [--port N] [--no-open]   # 本机只读 web（需 packages/graph-web）
  dia graph --export-html [path] [--out path] [--now ISO] [--redact] [--all] [--limit N] [--force]
  dia graph --next [n] [--seats N] | --explain <id> | --lint   # 只读编排建议（Kahn-v1 / seats-v1）
  dia claim <path> [--reason R] [--ttl 4h] [--session S] | dia claims [--all] [--mine] [--gc [--days 7]] | dia unclaim <path|id> [--force]
  dia team run <id> --mock | --acp|--dsh --workspace DIR
  dia team gate|accept|reject|next
  dia team accept <id> [--note ...] [--pr N [--repo R] [--merge]]   # --pr：先验 CI，绿才接受/合并
  dia job <list|status|install|...>   # 调度适配器
  dia job migrate --from <旧 job 根> [--to DIR] [--dry-run]   # 逐条重建到当前根，校验后清旧（处理双根）
  dia price list|--json
  dia postinstall [--quiet]             # 装配内置能力（npm 拦截脚本 / ignore-scripts 时的兜底；幂等）
  dia migrate data [--from DIR] [--dry-run]   # 旧数据根 → 数据根（只搬数据子目录，合并同名目录）
  dia version
  dia update [--check]                  # 查/装 npm 最新版`,
  "msg":
    `dia msg —— 跨会话消息（单一存储：~/.dia/collab/，收件人一律是会话 id）

  dia msg send <ses_id> --subject S (--body B|--body-file F) [--kind K] [--requires-reply] [--to ses_id]
  dia msg inbox [--unread] [--all] [--expose] [--json]
  dia msg show <id> [--json]
  dia msg ack <id> | dia msg reply <id> --body B | dia msg close <id> --reason R
  dia msg deliver <ses_id> <id> [--transport file|tmux|acp] [--wait]     # 显式重投（默认异步）
  dia msg trace <id> [--json] | dia msg stats [--since 7d] | dia msg seen <id…>
  dia msg migrate [--dry-run|--apply]   # 旧 ~/.dia/msg → ~/.dia/collab/inbox（默认只报告）
  dia msg analyze-storage [--json]      # 只读体检：v1 残留 / v2 现状 / 事件流健康度
  dia msg upkeep | dia msg retry | dia msg escalate --due | dia msg dsh [install|check]

  （v1 的 <agent> 名投递已下线：needs-info / stuck / thread / agents / delivered 见 --help 里的替代命令）`,
  "kb":
    `用法: dia kb index|search|query|review|path|lint|get [--root DIR] [--db PATH] [--json]
      dia --persona ID kb <cmd>   # persona 作用域（知识根/数据根/域命令委派）`,
  "ingest":
    `用法: dia ingest sessions [--source dsh|opencode|all] [--domain dabo|yan] [--since ISO] [--limit N] [--json]
      dia ingest git --repo DIR [--since DATE] [--limit N] [--json]`,
  "audit":
    `用法: dia audit append --session S --tool T [--decision allow|deny|waive] [--risk N] [--redline] [--json]
      dia audit verify --session S --calls N [--chain] [--json] | score --session S | tail [--n 20]`,
  "freeze":
    `用法: dia freeze [--reason R] [--session S] [--auto] [--last-episode ID] | dia freeze status | dia freeze thaw --reason R --i-am-human`,
  "guard":
    `用法: dia guard [--once] [--json]   # 只读判定：frozen 时打印 blocked 并以 42 退出，否则 allow/0`,
  "run":
    `用法: dia run --session S [--tool T] [--agent A] [--waive --risk N] [--redline] [--cwd DIR] -- <cmd> [args...]`,
  "resume":
    `用法: dia resume --session S [--json]   # 读会话断点卡（steps/last tool/audit 缺口/续跑提示）`,
  "persona":
    `用法: dia persona add|create|render|list|verify|remove|show|use|path|check|update|gc|default [--json]
      dia persona add <id|--from SRC> [--ref REF] [--host opencode|dsh|codex] [--home DIR] [--dry-run] [--force]`,
  "doctor":
    `用法: dia doctor [--persona ID] [--paths] [--json]   # 体检；verdict=ok/warn/fail → 退出码 0/1/2`,
  "deps":
    `用法: dia deps list [--json] [--file PATH] | dia deps record --id ID --kind K --version V [--resolved R] [--role R]`,
  "cache":
    `用法: dia cache list [--root NAME] [--json] | dia cache gc [--apply] [--force] [--referenced] [--root NAME] [--json]
      默认 dry-run；cache 是可再生派生数据，要保留的内容请先备份出 cache。`,
  "env":
    `用法: dia env list|check [KEY…] | dia env [--dry-run] [--redact] <cmd…> | dia env bw status|unlock|lock|run|serve|get
      dia env <cmd…> 把环境变量注入后执行系统命令（--help 在命令之后时属该命令，不拦）。`,
  "env bw":
    `用法: dia env bw status|unlock|lock|run|serve|get [参数…]

  dia env bw status [--json]                        # 只读：锁状态
  dia env bw unlock [--passwordfile P]              # 解锁（session 落盘 0600）
  dia env bw lock                                   # 上锁
  dia env bw run --map KEY=item [--map …] [--task T] -- <cmd…>   # 只注入映射键
  dia env bw serve [--socket PATH] [--passwordfile P]            # 常驻 broker（会起进程！）
  dia env bw get --item ITEM [--env KEY] [--task T] [--json]`,
  "env run":
    `用法: dia env run [--dry-run] [--redact] [--bw KEY=item …] <cmd…>   # 与 dia env <cmd…> 等价`,
  "kit":
    `用法: dia kit add --from SRC [--ref REF] [--dry-run] [--json] | list | verify <id> | remove <id> | gc [--json]`,
  "service":
    `用法: dia service add|remove|list|show|verify|health <id> [--json]
      dia service add (<--from SRC> | --dir DIR) [--ref REF] [--dry-run] [--json]`,
  "cmd":
    `用法: dia cmd <name> [args…]   # 只查 persona 声明的命令（可绕开同名内置命令；内置仍然优先）`,
  "collab":
    `用法: dia collab status|enable|disable|stats|board|observe [--persona ID] [--json]
      enable 校正观察器定时并刷新 board；disable 一并卸载内置 kit。`,
  "whoami":
    `用法: dia whoami [--json] [--name NAME]   # 当前会话身份（session id / display name / host / cwd）`,
  "in":
    `用法: dia in [--unread] [--all] [--class P0,P1] [--sort priority|arrival] [--expose] [--json]
      # 会话收件箱（正文内联）；--expose 把消息标记为已暴露`,
  "out":
    `用法: dia out --to <session_id> --subject S (--body B|--body-file F) [--kind K] [--touch p1,p2] [--reply-to ID]`,
  "ack":
    `用法: dia ack <id> [--json]   # 确认收到某条消息（状态转为 acked）（完整参数见 dia --help）`,
  "reply":
    `用法: dia reply <id> --body B [--json]   # 回复某条消息（建立 thread 关联）`,
  "close":
    `用法: dia close <id> --reason R [--json]   # 关闭某条消息（终态，之后不可再 ack/reply）`,
  "show":
    `用法: dia show <id> [--json]   # 查看单条消息全文（含 refs / 正文 / 处理建议）（完整参数见 dia --help）`,
  "agents":
    `用法: dia agents list|register|unregister|discover [--json]   # 已登记 agent 的只读清单与自动发现`,
  "team":
    `用法: dia team run <id> --mock | --acp|--dsh --workspace DIR | dia team gate|accept|reject|next [--json]
      dia team accept <id> [--note ...] [--pr N [--repo R] [--merge]]   # --pr：先验 CI，绿才接受/合并`,
  "price":
    `用法: dia price list [--json]   # 模型价格表（input/output per Mtok；未定价显示 unpriced）`,
  "version":
    `用法: dia version   # 打印当前 dia 版本（与 dia --version 等价）（完整参数见 dia --help）`,
  "update":
    `用法: dia update [--check]   # 查/装 npm 最新版（--check 只报告，有新版本时退出码 1）`,
  "postinstall":
    `用法: dia postinstall [--quiet]   # 装配内置能力（npm 拦截安装脚本时的兜底；幂等）（完整参数见 dia --help）`,
  "migrate":
    `用法: dia migrate data [--from DIR] [--dry-run]   # 旧数据根 → 数据根（只搬数据子目录，合并同名目录）`,
  "graph":
    `用法: dia graph [--json] [--task t-…] [--tui [--watch]] | --serve [--port N] | --export-html [path] | --next [n] | --explain <id> | --lint`,
  "task":
    `用法: dia task add|list|link|plan|split|status|done [--owner S] [--depends a,b] [--touches p1,p2] [--prio P1] [--due D]`,
  "wb":
    `用法: dia wb [--json] [--summary] [--now ISO] [--depth fast|full] | wb refresh | wb migrate [--dry-run] | wb gc [--apply] | wb explain <id>`,
  "beat":
    `usage: dia beat [--session S] [--track ID] [--note TEXT] [--json]

写入一行会话心跳（workbench/beats.jsonl，ephemeral，TTL 720h）。
会话标识取 --session > DIA_SESSION_ID > OPENCODE_SESSION_ID；--help 只打印用法、不写盘。`,
  "claim":
    `用法: dia claim <path> [--reason R] [--ttl 4h] [--session S] [--track tr-x] [--lease exclusive|shared] [--json]`,
  "claims":
    `用法: dia claims [--all] [--mine] [--gc [--days 7]] [--json]   # 列出活动 claim（--gc 清理过期租约）`,
  "unclaim":
    `用法: dia unclaim <path|id> [--force] [--session S] [--json]   # 释放 claim（--force 只能释放自己的）`,
  "job":
    `用法: dia job <list|status|install|uninstall|adopt|bootstrap|registry|gc|logs|doctor|migrate> [参数…]
      dia job migrate --from <旧 job 根> [--to DIR] [--dry-run]   # 逐条重建到当前根，校验后清旧（处理双根）`,
  "job install":
    `用法: dia job install <name> --cmd '<shell>' [--interval 300 | --calendar HH:MM [--weekdays 1-5]]
      [--desc 说明] [--type periodic|service] [--allow-unstable] [--takeover] [--label L]`,
  "job uninstall":
    `用法: dia job uninstall <name>   # 下线一个任务：删调度载体（plist/unit/cron）+ 包装脚本 + 登记
      只删本 job 根名下的条目；plist 属于其它根时会跳过并提示（避免误删）。`,
  "job adopt":
    `用法: dia job adopt <launchd-label> [--desc 说明] [--type periodic|service] [--cmd '<shell>']
      # 只登记已存在的调度条目（adopted：不接管其 plist，卸载时也不删）`,
  "job bootstrap":
    `用法: dia job bootstrap [--dry-run]   # 幂等重建本边界全部条目（registry 兜底恢复入口）`,
  "job gc":
    `用法: dia job gc [--days N] [--dry-run]   # 清理 tasks 下超过 N 天（默认 30）的 state/日志/心跳`,
  "job registry":
    `用法: dia job registry [gc [--dry-run|--apply] [--json]]   # 无参打印登记表；gc 列出/清理历史条目`,
  "job registry gc":
    `用法: dia job registry gc [--dry-run|--apply] [--json]   # 默认 dry-run；只收「可证伪」的墓碑条目`,
  "job migrate":
    `用法: dia job migrate --from <旧 job 根> [--to DIR] [--dry-run]   # 逐条重建到当前根，校验后清旧`,
  "job logs":
    `用法: dia job logs <name> [-n N]   # 看某任务最近输出（默认尾 30 行）（完整参数见 dia --help）`,
  "job doctor":
    `用法: dia job doctor   # 只读体检：后端可用性 / 载体在位 / registry 与 state 一致性`,
  "job selfcheck":
    `用法: dia job selfcheck [--dry-run]   # 体检 + 自愈本边界缺失条目（完整参数见 dia --help）`,
  "job list":
    `用法: dia job list   # 列出已发现的任务（含调度态与是否有 state）（完整参数见 dia --help）`,
  "job status":
    `用法: dia job status   # 逐任务列出调度/状态/上次运行/日志位置（只读）（完整参数见 dia --help）`,
  "msg send":
    `用法: dia msg send <ses_id> --subject S (--body B|--body-file F) [--kind K] [--requires-reply] [--to ses_id] [--touch p] [--json]
      ⚠️ --body 的值就是正文：--body --help 表示正文为字符串 --help，不是请求帮助。`,
  "msg inbox":
    `用法: dia msg inbox [--unread] [--all] [--class P0,P1] [--sort priority|arrival] [--expose] [--json]`,
  "msg show":
    `用法: dia msg show <id> [--json]   # 查看单条消息全文与处理建议（完整参数见 dia --help）`,
  "msg ack":
    `用法: dia msg ack <id> [--json]   # 确认收到（状态 acked）（完整参数见 dia --help）`,
  "msg reply":
    `用法: dia msg reply <id> --body B [--json]   # 回复消息（同一 thread，seq+1）`,
  "msg close":
    `用法: dia msg close <id> --reason R [--json]   # 关闭消息（终态；需有权操作该消息）`,
  "msg deliver":
    `用法: dia msg deliver <ses_id> <id> [--transport file|tmux|acp] [--wait]   # 显式重投（默认异步）`,
  "msg trace":
    `用法: dia msg trace <id> [--json]   # 看一条消息的送达/暴露/ack/回复事件链（完整参数见 dia --help）`,
  "msg stats":
    `用法: dia msg stats [--since 7d] [--by session|pair|class] [--json]   # 只读聚合：送达/回复/积压`,
  "msg seen":
    `用法: dia msg seen <id…>   # 标记消息为已暴露（exposed）（完整参数见 dia --help）`,
  "msg upkeep":
    `用法: dia msg upkeep   # 一轮维护：重投到期未送达 + 升级超 TTL 消息（定时任务调用）（完整参数见 dia --help）`,
  "msg retry":
    `用法: dia msg retry [--queue]   # 重投到期未送达消息；--queue 走 workbench 未解析队列`,
  "msg escalate":
    `用法: dia msg escalate --due   # 升级超 TTL 的消息（日常由 dia collab enable 注册的定时任务跑）`,
  "msg dsh":
    `用法: dia msg dsh [install|check] [--profile P] [--dry-run]   # 装配/检查 dsh 收件箱插件`,
  "msg migrate":
    `用法: dia msg migrate [--dry-run|--apply]   # 旧 ~/.dia/msg → ~/.dia/collab/inbox（默认只报告）`,
  "msg analyze-storage":
    `用法: dia msg analyze-storage [--json]   # 只读体检：v1 残留 / v2 现状 / 事件流健康度`,
  "persona add":
    `用法: dia persona add <id|--from SRC> [--ref REF] [--host opencode|dsh|codex] [--home DIR] [--dry-run] [--force] [--json]`,
  "persona create":
    `用法: dia persona create <id> --dir DIR [--host opencode|dsh|codex] [--no-msg] [--dry-run] [--json]`,
  "persona render":
    `用法: dia persona render <id> [--host opencode|dsh|codex] [--home DIR] [--check] [--json]`,
  "persona list":
    `用法: dia persona list [--json]   # 已安装 persona 及版本（完整参数见 dia --help）`,
  "persona show":
    `用法: dia persona show <id> [--json]   # 单个 persona 的清单/根目录/版本（完整参数见 dia --help）`,
  "persona verify":
    `用法: dia persona verify <id> [--json]   # 校验 persona 完整性（清单/文件/引用）`,
  "persona remove":
    `用法: dia persona remove <id> [--version V] [--json]   # 卸载 persona（只删 dia 管理的文件）`,
  "persona use":
    `用法: dia persona use <id>[@ver] [--json]   # 切换默认 persona（写 state）`,
  "persona gc":
    `用法: dia persona gc <id> [--json]   # 清掉某 persona 不再被引用的旧版本目录（完整参数见 dia --help）`,
  "persona path":
    `用法: dia persona path [<id>[@<ver>]] [--json]   # 打印生效版本目录（服务/脚本取代码入口）`,
  "persona check":
    `用法: dia persona check <id> [--json]   # 检查远端是否有新版本（只读）（完整参数见 dia --help）`,
  "persona update":
    `用法: dia persona update <id> [--ref REF] [--json]   # 拉取并安装新版本`,
  "persona default":
    `用法: dia persona default <id> | --unset | --show [--host opencode]   # 各 host 的默认 persona`,
  "service add":
    `用法: dia service add (<--from SRC> | --dir DIR) [--ref REF] [--dry-run] [--json]   # 安装常驻服务`,
  "service remove":
    `用法: dia service remove <id> [--json]   # 下线服务（只删 dia 管理的条目与文件）`,
  "service list":
    `用法: dia service list [--json]   # 已登记服务及 gen/入口（完整参数见 dia --help）`,
  "service show":
    `用法: dia service show <id> [--json]   # 单个服务清单与状态（完整参数见 dia --help）`,
  "service verify":
    `用法: dia service verify <id|--dir DIR> [--json]   # 校验服务入口/清单（完整参数见 dia --help）`,
  "service health":
    `用法: dia service health <id> [--from-wrapper --exit N --gen G] [--json]   # 0 ok/30 degraded/1 fail/31 不可用/2 用法`,
  "kit add":
    `用法: dia kit add --from SRC [--ref REF] [--dry-run] [--json]   # 安装 kit（版本化目录）`,
  "kit list":
    `用法: dia kit list [--json]   # 已安装 kit 及版本/标签（完整参数见 dia --help）`,
  "kit verify":
    `用法: dia kit verify <id> [--version V] [--json]   # 校验 kit 文件是否被本地改动`,
  "kit remove":
    `用法: dia kit remove <id> [--version V] [--json]   # 卸载 kit（被改过的文件会跳过并列出）`,
  "kit gc":
    `用法: dia kit gc [--json]   # 清掉不再被引用的旧 kit 版本目录（完整参数见 dia --help）`,
  "cache gc":
    `用法: dia cache gc [--apply] [--force] [--referenced] [--root NAME] [--json]
      默认 dry-run；--apply 才真删。cache 是可再生的派生数据。`,
  "cache list":
    `用法: dia cache list [--root NAME] [--json]   # 缓存条目：体积/引用/是否有本地独有内容`,
  "collab enable":
    `用法: dia collab enable [--persona ID] [--json]   # 打开 dia-msg：装配 kit + 校正观察器定时 + 刷新 board`,
  "collab disable":
    `用法: dia collab disable [--persona ID] [--json]   # 关闭 dia-msg：写配置 + 撤掉观察器定时（无 persona 时一并卸 kit）`,
  "collab status":
    `用法: dia collab status [--persona ID] [--json]   # 只读：开关/观察器定时/kit/config`,
  "collab stats":
    `用法: dia collab stats [--since 7d] [--by session|pair|class] [--json]   # 只读聚合（送达/回复/积压）`,
  "collab board":
    `用法: dia collab board [--cached|--refresh] [--json]   # 看板（无常驻；定时用 dia job）`,
  "collab observe":
    `用法: dia collab observe [--interval 300] [--json]   # 跑一轮观察器（一次性）`,
  "team run":
    `用法: dia team run <id> --mock | --acp|--dsh --workspace DIR [--json]`,
  "team gate":
    `用法: dia team gate <task-id> [--json]   # 判据是否满足（ok/fail）（完整参数见 dia --help）`,
  "team accept":
    `用法: dia team accept <id> [--note ...] [--pr N [--repo R] [--merge]] [--json]
      --pr：先验 CI，绿才接受/合并；--merge 走 MR 合并通道。`,
  "team reject":
    `用法: dia team reject <id> --reason R [--json]（完整参数见 dia --help）`,
  "team next":
    `用法: dia team next [--deps PATH] [--hypotheses PATH] [--limit N] [--json]`,
  "wb gc":
    `用法: dia wb gc [--apply] [--json]   # 默认 dry-run；清理僵死/超期 workbench 条目`,
  "wb refresh":
    `用法: dia wb refresh [--json]   # 重建 workbench 视图（完整参数见 dia --help）`,
  "wb migrate":
    `用法: dia wb migrate [--dry-run]   # 迁移旧 workbench 数据（完整参数见 dia --help）`,
  "wb explain":
    `用法: dia wb explain <id> [--json]   # 解释某条目的派生过程（完整参数见 dia --help）`,
  "deps record":
    `用法: dia deps record --id ID --kind K --version V [--resolved R] [--role required|optional] [--result pass|fail|unknown] [--evidence P]`,
  "deps list":
    `用法: dia deps list [--json] [--file PATH]   # 派生视图：登记 + 实测（完整参数见 dia --help）`,
  "migrate data":
    `用法: dia migrate data [--from DIR] [--dry-run]   # 旧数据根 → 数据根（只搬数据子目录，合并同名目录）`,
  "agents list":
    `用法: dia agents list [--json]（完整参数见 dia --help）`,
  "agents register":
    `用法: dia agents register [--json]   # 登记本机 agent 身份（完整参数见 dia --help）`,
  "agents unregister":
    `用法: dia agents unregister <id> [--json]（完整参数见 dia --help）`,
  "agents discover":
    `用法: dia agents discover [--json]   # 自动发现本机可用 agent（完整参数见 dia --help）`,
  "task add":
    `用法: dia task add "<title>" [--owner S] [--depends a,b] [--touches p1,p2] [--prio P0..P3] [--start D] [--due D] [--progress 0-100]`,
  "task list":
    `用法: dia task list [--json]（完整参数见 dia --help）`,
  "task plan":
    `用法: dia task plan <id> [--json]（完整参数见 dia --help）`,
  "task split":
    `用法: dia task split <id> --into "切片A,切片B" [--slice 切片A] [--role R] [--judge J] [--touches p] [--force]`,
  "task done":
    `用法: dia task done <id> [--json]（完整参数见 dia --help）`,
};


/** 打印某条帮助；没有该 key 时返回 false（交给调用方继续正常分派）。 */
export function renderHelp(key: string): boolean {
  const text = HELP_TEXTS[key];
  if (!text) return false;
  process.stdout.write(text.replace(/\n+$/, "") + "\n");
  return true;
}

/** 把参数透传给子进程的命令：只在**第一个**参数就是 --help/-h 时拦
 *  （`dia run --session S -- cmd --help` 里的 --help 是给 cmd 的，不能拦）。 */
export const PASSTHROUGH_FIRST_ONLY: ReadonlySet<string> = new Set(["env", "run", "cmd"]);

/** `dia env` 下 **dia 自己的**子命令（不是透传给系统的命令名）。
 *  依据 index.ts 的 env 分支：status/list/check/bw 是 dia 实现，run 是别名。
 *  ⚠️ 之前只看 rest[0:] 的第一段「是不是 bw」，漏了 `env bw serve --help` 真的起了 broker；
 *     反过来 `dia env ls --help` 必须继续透传给系统 ls。 */
const ENV_OWN_SUBCOMMANDS: ReadonlySet<string> = new Set(["bw", "list", "check", "run"]);

/** `dia env` 自己的取值 flag（决定「env 之后的第一个位置参数」从哪开始）。 */
const ENV_OWN_VALUE_FLAGS: ReadonlySet<string> = new Set(["--files", "--keys", "--bw", "--task", "--persona"]);

/**
 * 判定 `dia env …` 的参数区归谁：
 *   · "own"         ⇒ dia 自己的参数（`env bw …` / `env list` / `env --dry-run --help` …）
 *   · "passthrough" ⇒ 第一个非 flag token 是**要执行的系统命令**（`env ls --help`）
 * 判据顺序：`--` ⇒ 透传；help token ⇒ dia；env 自己的子命令 ⇒ dia；其它位置参数 ⇒ 透传。
 */
function envArgScope(rest: string[]): "own" | "passthrough" {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") return "passthrough";
    if (isHelpToken(a)) return "own";
    if (ENV_OWN_SUBCOMMANDS.has(a)) return "own";
    if (a.startsWith("-")) {
      if (ENV_OWN_VALUE_FLAGS.has(a)) i++; // 跳过它自己的值，避免把值当命令名
      continue;
    }
    return "passthrough";
  }
  return "own";
}

/** 判定前要扫哪段参数（值位判定只看 dia 自己的那段）。 */
function helpProbe(cmd: string, rest: string[]): string[] {
  if (cmd === "env") return envArgScope(rest) === "own" ? rest : rest.slice(0, 1);
  if (cmd === "run") {
    // `--` 之前是 dia 的 flag 区，之后是给子进程的数据
    const sep = rest.indexOf("--");
    return sep < 0 ? rest : rest.slice(0, sep);
  }
  if (PASSTHROUGH_FIRST_ONLY.has(cmd)) return rest.slice(0, 1);
  return rest;
}

/**
 * 单一拦截点：返回退出码（已打印帮助）或 null（放行，按原有逻辑分派）。
 * 查找链：`cmd sub` → `cmd`。job / wt 各有专门通路（job 在 main 的 job 分支，
 * wt 由 packages/wt/bin/dia-wt 自己处理），不在此处拦。
 */
export function helpGate(cmd: string, rest: string[]): number | null {
  if (!cmd) return null;
  if (cmd === "job" || cmd === "wt") return null;
  if (!helpRequested(helpProbe(cmd, rest))) return null;
  const first = rest[0];
  if (first && !isHelpToken(first) && renderHelp(`${cmd} ${first}`)) return 0;
  return renderHelp(cmd) ? 0 : null;
}
