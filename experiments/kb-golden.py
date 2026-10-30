#!/usr/bin/env python3
"""K0: deterministic 20-query golden from yan kb-calls (work-domain; keep raw local)."""
import json, random, sys, hashlib, os

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~/.yan-agent/observability/kb-golden-20.json")
rows = [json.loads(line) for line in open(src, encoding="utf-8") if line.strip()]
# 只保留有实际查询/场景的调用；排除 list/空 query
rows = [r for r in rows if (r.get("query") or r.get("scenes"))]
by = {}
for r in rows:
    by.setdefault(r.get("mode") or "query", []).append(r)
wanted = {"query": 8, "scene": 6, "rule": 3, "auto": 2, "list": 1}
random.seed(30)
picked = []
for mode, n in wanted.items():
    pool = by.get(mode, [])
    picked.extend(random.sample(pool, min(n, len(pool))))
# 去重（同 query 重复出现很常见），不足 20 用剩余池补齐
seen = set(); final = []
for r in picked:
    k = (r.get("mode"), r.get("query"), tuple(r.get("scenes") or []))
    if k not in seen:
        seen.add(k); final.append(r)
for r in rows:
    if len(final) >= 20: break
    k = (r.get("mode"), r.get("query"), tuple(r.get("scenes") or []))
    if k not in seen:
        seen.add(k); final.append(r)
final = final[:20]
data = {
    "schema": 1,
    "source": os.path.basename(src),
    "seed": 30,
    "counts": {m: sum(1 for r in final if r.get("mode") == m) for m in wanted},
    "query_hash": hashlib.sha256("\n".join(str(r.get("query") or "") for r in final).encode()).hexdigest(),
    "items": [
        {
            "ts": r.get("ts"), "mode": r.get("mode"), "query": r.get("query"),
            "scenes": r.get("scenes") or [], "hits": r.get("hits") or [],
            "zeroHit": bool(r.get("zeroHit")), "exitCode": r.get("exitCode"),
        }
        for r in final
    ],
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"wrote {out} n={len(final)} counts={data['counts']} hash={data['query_hash'][:12]}")
