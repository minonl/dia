#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/rules"
printf '# 索引\n\n- [a](rules/a.md)\n' > "$TMP/index.md"
printf '# 规则一\n\n知识库预算与脱敏。\n' > "$TMP/rules/a.md"
printf '# 规则二\n\n会话采集。\n' > "$TMP/rules/b.md"

[ -f dist/cli.js ] || bun run build >/dev/null

node bin/dia.js kb index --root "$TMP" --db "$TMP/i.db" >/dev/null
node bin/dia.js kb lint --root "$TMP" --db "$TMP/i.db" > "$TMP/lint.txt"
grep -q "docs 3" "$TMP/lint.txt"
grep -q "missing: 1" "$TMP/lint.txt"
node bin/dia.js kb search --root "$TMP" --db "$TMP/i.db" "脱敏" | grep -q "rules/a.md"
echo "smoke OK"
