import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { append as auditAppend } from "./audit.ts";
import { countCalls, callsFile as runtimeCallsFile } from "./runtime.ts";
import { status as freezeStatus } from "./freeze.ts";
import * as paths from "./paths.ts";

const DATA = () => paths.diaHome();

export interface RunOpts {
  session: string;
  tool?: string;
  agent?: string | null;
  waive?: boolean;
  risk?: number;
  redline?: boolean;
  cwd?: string;
  json?: boolean;
  stdio?: "inherit" | "pipe";
}

export interface RunResult {
  run_id: string;
  exit: number;
  audit_written: boolean;
  frozen_before: boolean;
  tool: string;
  duration_ms: number;
}

export function runWrapped(argv: string[], opts: RunOpts): RunResult {
  const st = freezeStatus();
  if (st.frozen) {
    return { run_id: "", exit: 42, audit_written: false, frozen_before: true, tool: opts.tool || (argv[0] ? basename(argv[0]) : "unknown"), duration_ms: 0 };
  }
  if (!argv.length) {
    return { run_id: "", exit: 2, audit_written: false, frozen_before: false, tool: "unknown", duration_ms: 0 };
  }
  const tool = opts.tool || basename(argv[0]);
  const run_id = createHash("sha256")
    .update(`${opts.session}|${tool}|${argv.join("\u0000")}|${Date.now()}|${Math.random()}`)
    .digest("hex").slice(0, 16);
  const params_hash = createHash("sha256")
    .update(JSON.stringify({ cmd: argv[0], args: argv.slice(1), cwd: opts.cwd || process.cwd() }))
    .digest("hex").slice(0, 16);

  const started = Date.now();
  const child = spawnSync(argv[0], argv.slice(1), {
    stdio: opts.stdio || "inherit",
    cwd: opts.cwd,
    env: { ...process.env, DIA_SESSION: opts.session, DIA_RUN_ID: run_id },
  });
  const duration_ms = Date.now() - started;
  const exit = child.error ? 127 : (child.status ?? 1);

  let audit_written = false;
  try {
    auditAppend({
      session: opts.session,
      tool,
      agent: opts.agent ?? null,
      decision: opts.waive ? "waive" : "allow",
      risk: opts.risk,
      params_hash,
      exit,
      redline: !!opts.redline,
      note: "run",
    });
    audit_written = true;
  } catch { audit_written = false; }

  try {
    mkdirSync(join(DATA(), "runtime"), { recursive: true });
    appendFileSync(runtimeCallsFile(), JSON.stringify({
      run_id, session: opts.session, tool, params_hash,
      ts: new Date(started).toISOString(), duration_ms, exit,
      cwd: opts.cwd || process.cwd(),
    }) + "\n");
  } catch {}

  return { run_id, exit, audit_written, frozen_before: false, tool, duration_ms };
}
