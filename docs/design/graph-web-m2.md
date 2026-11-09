# graph live 服务（M2 设计，可选包）

> 状态：M2a 已实现（2026-11-09）：`packages/graph-web` + `dia graph --serve`
> 已实现：loopback/端口 0、token→HttpOnly cookie、`/`、`/api/graph`（rev/304）、`/api/health`、`/api/meta`、Host/Origin 校验、CSP、405/421
> 已实现补充（0.0.25）：轮询自动刷新（2s + 304 + 顶部「有更新/刷新」条，可在 live 注入、导出件不含 fetch）、
> Origin / Sec-Fetch-Site 校验、`localhost` → `127.0.0.1` 归一、E_PORT/E_RUNTIME 提示；
> 服务端以 `bun build` 打成 `packages/graph-web/dist/main.js`（模板内联，node 可直接跑）；publish 增加「装 tarball → --serve → /api/health」冒烟。
> 已实现（D3 后续）：`/api/next`（next/seats 两种形态，完全复用 CLI 同一构造函数）、`/api/events` SSE（rev 推送，前端优先 SSE、失败回落轮询）、非 TTY 打码 + `~/.dia/export/serve-<pid>.url`（0600）
> 未实现：写操作（保持只读）｜前置：`graph-web-m1.md`、`graph-ui-m1.md`、`seat-scheduling-m2.md`
> 定位：本机**只读**实时预览；不写账本、不做多人共享、不暴露公网。

## 1. 目标 / 非目标

**目标**：把 M1 的静态快照变成「自动刷新」的只读页面，复用同一套 payload 与 UI。

**非目标**：多人协作/鉴权体系；写操作（介入、plan、claim）；守护进程/开机自启；公网/局域网访问。

## 2. 包边界（为什么不在 `src/`）

- `tests/static.test.ts` 的意图是「框架核心零网络」；`src/**` 永远不出现 `node:http`；
- 服务实现放 `packages/graph-web/`（与 `packages/job`、`packages/wt` 同构），独立 `bin/dia-graph-web`；
- `dia graph --serve` 只做 **spawn**（`child_process`），由 `src`/CLI 转发，不 import http——保持静态约束与测试不变；
- 未安装该包时，`--serve` 输出明确安装命令（`bash install.sh`），不静默失败。

## 3. 进程与生命周期

- 前台阻塞运行，`Ctrl-C` 退出；不自动重启、不写 pid 文件、不依赖 launchd/systemd；
- 一次运行 = 一个浏览器会话；重启即换 token 与端口；
- `--no-open`：只打印 URL；默认尝试 `open`/`xdg-open`/`start`，失败则仅打印提示。

## 4. 网络面与 token

- 只绑 `127.0.0.1`；默认 `--port 0`（内核分配），启动后从 `server.address()` 取真实端口；
- 拒绝 `0.0.0.0` 与 IPv6 通配；显式 `--port` 也只绑 loopback；
- **token**：32B 随机 base64url，进程内有效（**不是单次**），所有 `/api/*` 要求 `X-Dia-Token`，比较用 `timingSafeEqual`；
- 传递（M2a 实现）：启动打印 `/?t=<token>`；服务端校验后种 `HttpOnly; SameSite=Strict` cookie 并 302 到 `/`，
  token 不残留在页面 URL；`/api/*` 也接受 `x-dia-token` 头（脚本用）。
  （原设计的 fragment 方案需要页面 JS 读取，当前静态模板没有 fetch，故采用 cookie 换票，等价于「一次性 token 换会话」。）
- 输出：仅 TTY 打印完整 URL；非 TTY 打码并写 `~/.dia/export/serve-<pid>.url`（0600），打印路径（已实现）；
- 401：页面显示「会话已失效，请回到终端重新打开」+ 可复制的重开命令。

## 5. API（只读）

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/graph?rev=` | `{schema,rev,payload}`（与导出件同一 `buildPayload`） |
| GET | `/api/next?n=5&seats=S` | 复用 `buildNext` / 席位分配（`seats` 缺省 1） |
| GET | `/api/next?n=5&seats=S` | 与 CLI `--next` 同源（seats 参数时复用 seats.assignSeats；不写 presence） |
| GET | `/api/events` | SSE：`event: rev` 推送账本 rev 变化（2s 检测、15s 心跳） |
| GET | `/api/meta` | `{version, capabilities, next_default, seats_default, presence_ttl_s, readonly:true}` |
| GET | `/api/health` | `{ok:true}`（同样鉴权，不泄露版本细节） |

- 非 GET → 405；未知路径 → 404；错误 envelope `{error:{code,message}}`，不返回堆栈；
- 响应头：`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Cross-Origin-Resource-Policy: same-origin`；
- `rev = sha1(ledger mtimeMs + size + tasks 数 + claims 数)` 前 12 位；**不含** `generated_at/today/presence_at`；
- 带 `If-None-Match` 或 `?rev=` 相同 → `304`（不重传 payload）。

## 6. 刷新

- 默认 **2s 轮询** `/api/graph?rev=<当前>`；`304` 只更新「已检查」时间；页面隐藏时暂停（`visibilitychange`）；
- 失败：保留上一帧 + 顶部「离线，最后更新 HH:mm:ss」；连续失败退避 2→4→8s（上限 30s）；
- SSE 推迟到 M2.1：单机只读场景收益小于长连接复杂度；
- `generated_at` 用**服务端**时间，前端不猜；快照语义与导出件一致。

## 7. 安全

- `Host` 必须精确等于 `127.0.0.1:<port>`（或 `localhost:<port>`），否则 421（防 DNS rebinding）；
- `Origin` 存在时必须同源；`Sec-Fetch-Site` 非 `same-origin`/`none` 拒绝；
- **不发 CORS 头**；`OPTIONS` 一律 405；
- CSP：`default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'`（内联脚本是当前模板现状，迁 nonce 列入 M2.1）；
- 日志：只记 `{ts, method, path, status}`，不记 token/query/owner/路径；错误不回显 `req.url`；
- 文档警示：带 token 的 URL 仍会进浏览器历史/终端 scrollback/截图，别外发。

## 8. 分发与安装

- `packages/graph-web/{package.json,src/,bin/,dist/}`；根 `files` 增该目录（安装包只带 bin/dist，运行时不再依赖根 `src/`）；
- `build` 产出 `dist/main.js`（bun build，模板 text import 内联）；`dia graph --serve` spawn `process.execPath + dist/main.js`，node/bun 均可；
- publish workflow 断言 tarball 含 `packages/graph-web/dist/main.js`，并做「装 tarball → --serve → /api/health」冒烟；
- `dia doctor` 增一项「graph-web 可选包」，缺包只 warn + 修复命令；
- 兼容：`dia graph --export-html` 始终可用，作为服务不可用时的兜底。

## 9. 失败回退

| 情况 | 行为 |
|---|---|
| `--port` 被占 | 不自动换端口；`E_PORT` + 提示去掉 `--port` 用随机端口 |
| 浏览器打不开 | 打印 URL 与 `--no-open` 提示 |
| 无 bun/node | `E_RUNTIME` + 安装命令（node ≥ engines 下限） |
| 账本不可读/坏行 | 坏行按 fold 容忍；整文件不可读 → 503 + 页面错误条，不白屏 |
| 模板缺失 | `E_TEMPLATE`（打包把模板文本内联，理论不发生） |
| 账本被删/重建 | `rev` 变化触发全量重渲染，不复用旧 id |

## 10. 测试与发布顺序

1. **M2a 骨架**：包 + bin + 只绑 loopback + `/api/health`（单测：Host/端口/token 401）；`
2. **M2b API**：`/api/graph` 与导出件同源对比、`rev/304`；
3. **M2c 安全**：Host/Origin/CSP/日志负例；静态测试仍全绿；
4. **M2d 分发**：install.sh 旧树/新树、doctor、`--serve` 未装提示。

判据：`bun test tests`（含新包测试）+ `bash tests/smoke.sh` + 手工 `curl` 负例 + Edge headless 一帧。

## 11. 待定（实现前确认）

- SSE 是否 M2.1；写接口是否永远不做（当前结论：只读 + 复制命令）。
