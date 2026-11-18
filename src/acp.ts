import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; }

export class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private texts = new Map<string, string[]>();
  /** 子进程级错误（spawn ENOENT/EACCES、启动后 error 事件）：之后所有请求立即失败，不空等超时。 */
  private spawnError: Error | null = null;

  constructor(cmd: string[], cwd: string, private timeoutMs = 180_000) {
    this.child = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", () => {});
    // ⚠️ spawn 失败（二进制不存在/无执行权限）只发 `error` 事件、**不发 exit**：
    //    不监听 `error` 就是 uncaught exception（进程直接崩，调用方连 catch 都轮不到）。
    //    所以这里必须把 error 转成 pending 的 reject，让 acpNotify 能写 inject.failed(E_ACP_SPAWN)。
    const onChildError = (e: Error) => this.failAll(e);
    this.child.on("error", onChildError);
    this.child.on("exit", (code) => {
      // exit 时 error 已经把 pending 清空则这里是空操作
      this.failAll(new Error("E_ACP: exited " + code));
    });
  }

  /** 把子进程级失败转成所有 pending 请求的 reject（E_ACP_SPAWN: <原因>），并记住原因。 */
  private failAll(e: Error) {
    if (!this.spawnError) this.spawnError = new Error("E_ACP_SPAWN: " + e.message);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(this.spawnError); }
    this.pending.clear();
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line.startsWith("{")) continue; // 过滤 stdout 噪音
      let d: any; try { d = JSON.parse(line); } catch { continue; }
      if (typeof d.id === "number" && this.pending.has(d.id)) {
        const p = this.pending.get(d.id)!; this.pending.delete(d.id); clearTimeout(p.timer);
        if (d.error) p.reject(new Error("E_ACP: " + JSON.stringify(d.error))); else p.resolve(d.result);
      } else if (d.method === "session/request_permission") {
        const opts = d.params?.options || [];
        const allow = opts.find((o: any) => /allow/i.test(o.kind || "") || /allow/i.test(o.optionId || ""));
        this.child.stdin.write(JSON.stringify(allow
          ? { jsonrpc: "2.0", id: d.id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } }
          : { jsonrpc: "2.0", id: d.id, result: { outcome: { outcome: "cancelled" } } }) + "\n");
      } else if (d.method === "session/update") {
        const sid = d.params?.sessionId; const u = d.params?.update;
        if (sid && u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          const arr = this.texts.get(sid) || []; arr.push(String(u.content.text || "")); this.texts.set(sid, arr);
        }
      }
    }
  }

  private request(method: string, params: any): Promise<any> {
    if (this.spawnError) return Promise.reject(this.spawnError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`E_ACP: timeout ${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async init() { return this.request("initialize", { protocolVersion: 1, clientCapabilities: {} }); }
  async newSession(cwd: string) { return this.request("session/new", { cwd, mcpServers: [] }); }
  /** 绑定**已有**会话（opencode v2）：之后的 prompt 才落在这个 session 上。
   *  ⚠️ 本实现的用法约定：load 与 prompt 走同一个 `opencode acp` 进程/连接。
   *  「拆到两个进程会得到 `-32602 session not found`」是**实测结论**（2026-11-18 / opencode 2.2.6 / WSL），
   *  不是 ACP 协议文本里的硬约束；未在其他 opencode 版本 / 原生环境上验证。 */
  async loadSession(sessionId: string, cwd: string) { return this.request("session/load", { sessionId, cwd, mcpServers: [] }); }
  async setMode(sessionId: string, modeId: string) { return this.request("session/set_mode", { sessionId, modeId }); }
  async setConfig(sessionId: string, configId: string, value: unknown) {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  async prompt(sessionId: string, text: string): Promise<{ text: string; usage?: any }> {
    this.texts.set(sessionId, []);
    const result = await this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
    return { text: (this.texts.get(sessionId) || []).join(""), usage: result?.usage };
  }

  close() { try { this.child.kill(); } catch {} }
}
