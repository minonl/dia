#!/usr/bin/env bash
# E2E-1: 管线验收（干净临时目录；只读源；Node + 可选 Bun）
set -euo pipefail
cd "$(dirname "$0")/.."

RUNTIME=${DIA_E2E_RUNTIME:-node}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export DIA_DATA_DIR="$TMP/data" DIA_STATE_DIR="$TMP/state"
KB="$TMP/kb"; mkdir -p "$KB/rules"
printf '# 索引\n\n- [规则一](rules/a.md)\n' > "$KB/index.md"
printf -- '---\nreview_by: 2020-01-01\n---\n# 规则一\n\n知识库预算 token 压力。\n\n[坏链](nope.md)\n' > "$KB/rules/a.md"
printf '# 规则二\n\n会话采集与脱敏。\n' > "$KB/rules/b.md"

run() {
  if [ "$RUNTIME" = "bun" ]; then bun src/cli.ts "$@"; else node bin/dia.js "$@"; fi
}

[ -f dist/cli.js ] || bun run build >/dev/null

echo "[1/7] kb index + search"
run kb index --root "$KB" --db "$TMP/kb.db" >/dev/null
run kb search --root "$KB" --db "$TMP/kb.db" "脱敏" | grep -q "rules/b.md"

echo "[2/7] kb lint 报出基线问题（strict 必须非 0）"
set +e; run kb lint --root "$KB" --db "$TMP/kb.db" --strict > "$TMP/lint.txt"; LINT_RC=$?; set -e
[ "$LINT_RC" -ne 0 ] || { echo "lint strict should fail"; exit 1; }
grep -q "broken links: 1" "$TMP/lint.txt"
grep -q "missing: 1" "$TMP/lint.txt"

echo "[3/7] 造 dsh / opencode 夹具并记录源 mtime"
DSH="$TMP/sessions/e2e-s1"; mkdir -p "$DSH"
node -e '
const fs=require("fs"),z=require("node:zlib");
const lines=[
 {type:"session",id:"e2e-s1",createdAt:Date.parse("2026-10-01T10:00:00Z"),cwd:"/tmp/e2e"},
 {type:"user/message",seq:1,time:Date.parse("2026-10-01T10:00:01Z"),data:{content:"修复索引 bug，token=ghp_abcdefghijklmnopqrstuvwxyz0123"}},
 {type:"tool/call",seq:2,time:Date.parse("2026-10-01T10:00:02Z"),data:{name:"bash"}},
 {type:"tool/result",seq:3,time:Date.parse("2026-10-01T10:00:03Z"),data:{message:{ok:false}}},
 {type:"tool/call",seq:4,time:Date.parse("2026-10-01T10:00:04Z"),data:{name:"bash"}},
 {type:"tool/result",seq:5,time:Date.parse("2026-10-01T10:00:05Z"),data:{message:{}}},
 {type:"tool/call",seq:6,time:Date.parse("2026-10-01T10:00:06Z"),data:{name:"read"}},
 {type:"tool/result",seq:7,time:Date.parse("2026-10-01T10:00:07Z"),data:{message:{}}},
].map(l=>JSON.stringify(l)).join("\n");
fs.writeFileSync(process.argv[1], z.zstdCompressSync(Buffer.from(lines)));
' "$DSH/session.v4.jsonl.zstd"
node -e '
const {DatabaseSync}=require("node:sqlite"); const db=new DatabaseSync(process.argv[1]);
db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER)");
db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT)");
db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?)").run("e2e-oc1",null,"修复登录", "/tmp/e2e","build",1,2);
db.prepare("INSERT INTO message VALUES (?,?,?)").run("m1","e2e-oc1",JSON.stringify({role:"user"}));
db.prepare("INSERT INTO part VALUES (?,?,?,?)").run("p1","m1","e2e-oc1",JSON.stringify({type:"tool",tool:"bash",state:{status:"completed"}}));
db.close();
' "$TMP/opencode.db"
# ⚠️ 顺序不能反（2026-10-30 实测）：Linux 的 `stat -f` **不报错**（那是「看文件系统」）⇒
#   `stat -f … || stat -c …` 兜底永不触发，拿到的是含 free-blocks 的 fs 信息（每次跑都不一样）
#   ⇒ 「源只读」那步必然假红「dsh source changed」。故 GNU 优先、BSD 兜底。
_stat_meta() { stat -c "%Y %s" "$1" 2>/dev/null || stat -f "%m %z" "$1" 2>/dev/null; }
DSH_MTIME=$(_stat_meta "$DSH/session.v4.jsonl.zstd")
OC_MTIME=$(_stat_meta "$TMP/opencode.db")

echo "[4/7] ingest 两源 + 幂等"
run ingest sessions --full --sessions-root "$TMP/sessions" --opencode-db "$TMP/opencode.db" \
  --out "$TMP/corpus" --cache-dir "$TMP/cache" --json > "$TMP/ing1.json"
grep -q '"written":2' "$TMP/ing1.json"
run ingest sessions --sessions-root "$TMP/sessions" --opencode-db "$TMP/opencode.db" \
  --out "$TMP/corpus" --cache-dir "$TMP/cache" --json > "$TMP/ing2.json"
grep -q '"written":0' "$TMP/ing2.json"
grep -q 'REDACTED:GITHUB_TOKEN' "$TMP/corpus/episodes.jsonl"

echo "[5/7] 审计对账"
for i in 1 2 3; do run audit append --session e2e-s1 --tool bash --decision allow >/dev/null; done
run audit verify --session e2e-s1 --calls 3 >/dev/null
run audit verify --session e2e-s1 --calls 3 --chain >/dev/null
set +e; run audit verify --session e2e-s1 --calls 4 >/dev/null; RC=$?; set -e
[ "$RC" -ne 0 ] || { echo "verify should fail on gap"; exit 1; }

echo "[6/7] 红线冻结 + guard 闸口"
run audit append --session e2e-s1 --tool send --decision deny --redline >/dev/null
set +e; run freeze status >/dev/null; FZ=$?; set -e; [ "$FZ" -eq 1 ]
set +e; run guard >/dev/null; GD=$?; set -e; [ "$GD" -eq 42 ]
set +e; run freeze thaw --reason "agent try" >/dev/null 2>&1; TH=$?; set -e; [ "$TH" -eq 3 ]

echo "[7/8] 人工解冻 + 源只读"
run freeze thaw --reason "reviewed" --i-am-human >/dev/null
run guard >/dev/null
DSH_AFTER=$(_stat_meta "$DSH/session.v4.jsonl.zstd")
OC_AFTER=$(_stat_meta "$TMP/opencode.db")
[ "$DSH_MTIME" = "$DSH_AFTER" ] || { echo "dsh source changed"; exit 1; }
[ "$OC_MTIME" = "$OC_AFTER" ] || { echo "opencode source changed"; exit 1; }

echo "[8/9] dia run 包装器（审计自动化）"
run run --session e2e-run -- echo wrapped >/dev/null
run audit verify --session e2e-run >/dev/null
set +e; run run --session e2e-run -- sh -c "exit 3" >/dev/null; RC3=$?; set -e; [ "$RC3" -eq 3 ]

echo "[9/9] H3 冻结 -> 解冻 -> 续跑"
run run --session e2e-resume -- sh -c "exit 0" >/dev/null
set +e; run run --session e2e-resume -- sh -c "exit 5" >/dev/null; RC5=$?; set -e; [ "$RC5" -eq 5 ]
run freeze --reason "e2e" --session e2e-resume >/dev/null
run freeze thaw --reason "e2e" --i-am-human >/dev/null
run resume --session e2e-resume > "$TMP/resume.txt"
grep -q "2 steps done" "$TMP/resume.txt"
grep -q "exit=5" "$TMP/resume.txt"

echo "E2E-1 OK ($RUNTIME)"
