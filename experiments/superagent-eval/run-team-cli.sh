#!/usr/bin/env bash
# dia team via opencode CLI (planner -> builder -> verifier), not the ACP TeamDriver.
set -uo pipefail
WT=""; BASE=""; PROMPT=""; JUDGE=""; OUT=""
while [ $# -gt 0 ]; do case "$1" in
  --worktree) WT="$2"; shift 2;; --base) BASE="$2"; shift 2;; --prompt) PROMPT="$2"; shift 2;;
  --judge) JUDGE="$2"; shift 2;; --out) OUT="$2"; shift 2;; *) echo "unknown $1" >&2; exit 2;;
esac; done
[ -n "$WT" ] && [ -n "$BASE" ] && [ -n "$PROMPT" ] && [ -n "$OUT" ] || { echo "usage" >&2; exit 2; }
JUDGE="${JUDGE:-true}"; mkdir -p "$OUT"; cp "$PROMPT" "$OUT/prompt.md"
git -C "$WT" reset --hard "$BASE" >/dev/null || exit 1
git -C "$WT" clean -fd >/dev/null || exit 1
start=$(node -e 'console.log(Date.now())')
run_role() { # role, prompt-file, out
  local role="$1" pf="$2" of="$3"
  (cd "$WT" && opencode run --format json --agent "dabo-$role" --model example/deepseek-v4.1-flash --auto "$(cat "$pf")") > "$of" 2>&1
  echo $?
}
printf '%s\n' "$(cat "$PROMPT")" > "$OUT/planner.prompt"
printf '\nReturn only the JSON object: {"plan":["..."],"judge":"executable","risks":[]}.\n' >> "$OUT/planner.prompt"
PRC=$(run_role planner "$OUT/planner.prompt" "$OUT/planner.jsonl")
node - "$OUT/planner.jsonl" "$OUT/plan.json" <<'JS'
const fs=require('node:fs'); const [src,dst]=process.argv.slice(2);
let text=''; for (const l of fs.readFileSync(src,'utf8').split('\n')) { try { const e=JSON.parse(l); if(e.type==='text') text += e.part?.text || ''; } catch {} }
const a=text.indexOf('{'), b=text.lastIndexOf('}');
fs.writeFileSync(dst, b>a ? text.slice(a,b+1) : '{}');
JS
PLAN="$(cat "$OUT/plan.json")"
printf 'Task:\n%s\n\nPlan:\n%s\n\nImplement in the current repo. Run relevant tests. Do not modify tests.\n' "$(cat "$PROMPT")" "$PLAN" > "$OUT/builder.prompt"
BRC=$(run_role builder "$OUT/builder.prompt" "$OUT/builder.jsonl")
printf 'Repo: %s\nRun this judge yourself: %s\nReturn only JSON {"conclusion":"通过|不通过|无法判定","evidence":["..."]}.\n' "$WT" "$JUDGE" > "$OUT/verifier.prompt"
VRC=$(run_role verifier "$OUT/verifier.prompt" "$OUT/verifier.jsonl")
git -C "$WT" diff --stat > "$OUT/diff.stat"
git -C "$WT" diff > "$OUT/diff.patch"
git -C "$WT" diff --name-only > "$OUT/changed_files.txt"
# external hidden judge
git -C "$WT" checkout 30397850d -- apps/web-hub/src/lib/session-route.spec.ts libs/experimental/superbook-auth/src/__tests__/engine.test.ts >/dev/null 2>&1
(cd "$WT" && pnpm nx test web-hub --skip-nx-cache && pnpm nx test superbook-auth --skip-nx-cache) > "$OUT/judge.log" 2>&1
JRC=$?
end=$(node -e 'console.log(Date.now())')
node - "$OUT/meta.json" "$PRC" "$BRC" "$VRC" "$JRC" "$start" "$end" "$BASE" <<'JS'
const fs=require('node:fs'), [p,prc,brc,vrc,jrc,start,end,base]=process.argv.slice(2);
fs.writeFileSync(p, JSON.stringify({arm:'dia-team-cli',base,planner_exit:+prc,builder_exit:+brc,verifier_exit:+vrc,judge_exit:+jrc,wall_ms:+end-(+start)},null,2)+'\n');
JS
echo "planner=$PRC builder=$BRC verifier=$VRC judge=$JRC wall=$((end-start))ms out=$OUT"
exit "$JRC"
