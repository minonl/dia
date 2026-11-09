// dia-graph-web 入口（构建后 dist/main.js，node/bun 均可运行）
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startDiaServer } from "./server.ts";

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name: string) => argv.includes(name);

const portRaw = flag("--port");
const port = portRaw ? Number(portRaw) : 0;
if (!Number.isInteger(port) || port < 0) { console.error("E_USAGE: --port 必须是 >=0 的整数"); process.exit(2); }
const nowRaw = flag("--now");
const now = nowRaw ? new Date(nowRaw) : undefined;
if (now && Number.isNaN(now.getTime())) { console.error("E_USAGE: 非法 --now"); process.exit(2); }

let started: Awaited<ReturnType<typeof startDiaServer>>;
try {
  started = await startDiaServer({ port, now });
} catch (e: any) {
  const msg = String(e?.message || e);
  if (/EADDRINUSE/.test(msg)) { console.error(`E_PORT: 端口被占用（${port}）；去掉 --port 用随机端口`); process.exit(2); }
  console.error(`E_SERVE: ${msg}`); process.exit(1);
}

const { url, close } = started;
const masked = url.replace(/t=[^&]+/, "t=***");
if (process.stdout.isTTY) {
  console.log(`dia graph web: ${url}`);
} else {
  // 非 TTY（脚本/CI）：只打印打码 URL，完整 URL 0600 落盘
  try {
    const root = process.env.DIA_ROOT || process.env.DIA_DATA_DIR || join(homedir(), ".dia");
    const dir = join(root, "export");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `serve-${process.pid}.url`);
    writeFileSync(file, url + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(`dia graph web: ${masked}`);
    console.log(`完整 URL（0600）：${file}`);
  } catch (e: any) {
    console.log(`dia graph web: ${masked}`);
    console.log(`E_URLFILE: ${e?.message || e}`);
  }
}
console.log("只读 · 仅本机 · 关闭：Ctrl-C");

if (process.stdout.isTTY && !has("--no-open")) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(opener, args, { stdio: "ignore", detached: true }).unref(); } catch { /* 手开 URL */ }
}

const stop = async () => { try { await close(); } catch { /* ignore */ } process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
