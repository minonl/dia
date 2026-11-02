#!/usr/bin/env bash
# 单 arm 采集：reset fixed worktree -> run agent -> capture diff -> hidden judge.
set -uo pipefail
WT=""; BASE=""; PROMPT=""; AGENT_CMD=""; OUT=""; ARM="${ARM:-}"; SESSION="${OPENCODE_SESSION:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WT="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    --prompt) PROMPT="$2"; shift 2 ;;
    --agent-cmd) AGENT_CMD="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --arm) ARM="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
[ -n "$WT" ] && [ -n "$BASE" ] && [ -n "$PROMPT" ] && [ -n "$AGENT_CMD" ] && [ -n "$OUT" ] || { echo "usage: run-arm.sh --worktree DIR --base SHA --prompt FILE --agent-cmd CMD --out DIR" >&2; exit 2; }
[ -d "$WT/.git" ] || [ -f "$WT/.git" ] || { echo "not a git worktree: $WT" >&2; exit 2; }
mkdir -p "$OUT"
cp "$PROMPT" "$OUT/prompt.md"
export DIA_EVAL_PROMPT_FILE="$PROMPT"
[ -n "$SESSION" ] && export OPENCODE_SESSION="$SESSION"
git -C "$WT" reset --hard "$BASE" >/dev/null || exit 1
git -C "$WT" clean -fd >/dev/null || exit 1
START="$(node -e 'console.log(Date.now())')"
(
  cd "$WT" || exit 1
  sh -c "$AGENT_CMD"
) > "$OUT/agent.log" 2>&1
RC=$?
END="$(node -e 'console.log(Date.now())')"
git -C "$WT" diff --stat > "$OUT/diff.stat"
git -C "$WT" diff > "$OUT/diff.patch"
git -C "$WT" diff --name-only > "$OUT/changed_files.txt"
# hidden judge
git -C "$WT" checkout 30397850d -- apps/web-hub/src/lib/session-route.spec.ts libs/experimental/superbook-auth/src/__tests__/engine.test.ts >/dev/null 2>&1
(cd "$WT" && pnpm nx test web-hub --skip-nx-cache && pnpm nx test superbook-auth --skip-nx-cache) > "$OUT/judge.log" 2>&1
JRC=$?
if [ -n "$SESSION" ]; then
  (cd "$WT" && opencode session export "$SESSION" > "$OUT/session.json" 2>/dev/null) || true
  node - "$OUT/session.json" "$OUT/trace.json" <<'JS'
const fs = require("node:fs"), [src, dst] = process.argv.slice(2);
try {
  const d = JSON.parse(fs.readFileSync(src, "utf8")); let turns = 0, tools = 0, users = 0; const names = {};
  for (const m of d.messages || []) {
    if (m.type === "assistant") turns++; if (m.type === "user") users++;
    for (const p of m.content || []) if (p.type === "tool") { tools++; names[p.name] = (names[p.name] || 0) + 1; }
  }
  fs.writeFileSync(dst, JSON.stringify({ turns, tool_calls: tools, user_messages: users, tools: names, tokens: d.info?.tokens || null, model: d.info?.model || null, outcome: d.info?.outcome || null }, null, 2) + "\n");
} catch {}
JS
fi
node - "$OUT/meta.json" "$RC" "$JRC" "$START" "$END" "$BASE" "$ARM" <<'JS'
const fs = require("node:fs"), [p, rc, jrc, start, end, base, arm] = process.argv.slice(2);
let extra = {};
try { extra = JSON.parse(fs.readFileSync(p.replace(/meta\.json$/, "trace.json"), "utf8")); } catch {}
fs.writeFileSync(p, JSON.stringify({arm: arm || null, base, agent_exit: Number(rc), judge_exit: Number(jrc), wall_ms: Number(end) - Number(start), ...extra}, null, 2) + "\n");
JS
echo "agent_exit=$RC judge_exit=$JRC wall_ms=$((END-START)) out=$OUT"
exit "$JRC"
