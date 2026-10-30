import { verify } from "./audit.ts";
import { status, snapshot } from "./freeze.ts";
import { countCalls, lastCall, lastFailure } from "./runtime.ts";

export interface ResumeCard {
  session: string;
  frozen: boolean;
  last_run: string | null;
  last_tool: string | null;
  last_exit: number | null;
  completed_runs: number;
  cwd: string | null;
  last_failure: { run_id: string; tool: string; exit: number } | null;
  audit_ok: boolean;
  audit_gap: number;
  resume_hint: string;
}

export function resumeCard(session: string): ResumeCard {
  const st = status();
  if (st.frozen) {
    throw new Error(`system is frozen (${st.reason}); thaw before resuming`);
  }
  const snap = snapshot();
  const last = lastCall(session);
  const fail = lastFailure(session);
  const calls = countCalls(session);
  const v = verify(session, calls);
  return {
    session,
    frozen: false,
    last_run: last?.run_id ?? null,
    last_tool: last?.tool ?? null,
    last_exit: last?.exit ?? null,
    completed_runs: calls,
    cwd: (snap?.session && snap.session === session ? snap.cwd : null) ?? last?.cwd ?? null,
    last_failure: fail ? { run_id: fail.run_id, tool: fail.tool, exit: fail.exit } : null,
    audit_ok: v.ok,
    audit_gap: v.gap,
    resume_hint: last
      ? `continue after run ${last.run_id} (${calls} steps done); do not repeat completed steps` +
        (fail ? `; failed step ${fail.run_id} (exit ${fail.exit}) may need retry` : "")
      : "no recorded runs; start from the last checkpoint",
  };
}
