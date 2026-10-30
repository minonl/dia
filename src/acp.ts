import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; }

export class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private texts = new Map<string, string[]>();

  constructor(cmd: string[], cwd: string, private timeoutMs = 180_000) {
    this.child = spawn(cmd[0], cmd.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", () => {});
    this.child.on("exit", (code) => {
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("E_ACP: exited " + code)); }
      this.pending.clear();
    });
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
      } else if (d.method === "session/update") {
        const sid = d.params?.sessionId; const u = d.params?.update;
        if (sid && u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          const arr = this.texts.get(sid) || []; arr.push(String(u.content.text || "")); this.texts.set(sid, arr);
        }
      }
    }
  }

  private request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`E_ACP: timeout ${method}`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async init() { return this.request("initialize", { protocolVersion: 1, clientCapabilities: {} }); }
  async newSession(cwd: string) { return this.request("session/new", { cwd, mcpServers: [] }); }
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
