#!/usr/bin/env python3
"""K2.2 benchmark: old yan-kb vs dia kb query on a stratified query sample.
Raw queries stay under the work data root; repo stores only summary/hash.
"""
import hashlib, json, os, random, statistics, subprocess, sys, time

def main():
    calls = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 100
    out = sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser("~/.yan-agent/observability/kb-bench-100.json")
    yan = os.path.expanduser("~/.yan-agent/repos/yan-agent")
    root = os.path.join(yan, "core", "knowledge")
    dia = os.path.expanduser("~/repos/github/dia/bin/dia.js")
    rows = [json.loads(l) for l in open(calls, encoding="utf-8") if l.strip()]
    rows = [r for r in rows if r.get("mode") == "query" and r.get("query")]
    random.seed(32)
    sample = random.sample(rows, min(n, len(rows)))
    subprocess.run([dia, "kb", "index", "--root", root], capture_output=True)

    stats = {"total": 0, "answerable": 0, "old_hits": 0, "recall_hits": 0,
             "zero": 0, "top1_equal": 0, "top1_in_old": 0, "old_ms": [], "dia_ms": []}
    details = []
    for it in sample:
        q = it["query"]
        t = time.perf_counter()
        old = json.loads(subprocess.run(["yan-kb", q, "--json"], cwd=yan, text=True, capture_output=True).stdout or "{}")
        stats["old_ms"].append((time.perf_counter() - t) * 1000)
        t = time.perf_counter()
        new = json.loads(subprocess.run([dia, "kb", "query", q, "--root", root, "--json"], text=True, capture_output=True).stdout or "[]")
        stats["dia_ms"].append((time.perf_counter() - t) * 1000)
        old_paths = {h.get("file") for h in old.get("hits", []) if h.get("file")}
        new_paths = {x.get("path") for x in new if isinstance(x, dict) and x.get("path")}
        old_top = (old.get("hits") or [{}])[0].get("file")
        new_top = new[0].get("path") if new else None
        stats["total"] += 1
        stats["old_hits"] += len(old_paths)
        stats["recall_hits"] += len(old_paths & new_paths)
        if old_paths and not new_paths: stats["zero"] += 1
        if old_paths: stats["answerable"] += 1
        if old_top == new_top: stats["top1_equal"] += 1
        if new_top in old_paths: stats["top1_in_old"] += 1
        details.append({"query_hash": hashlib.sha256(q.encode()).hexdigest()[:16],
                        "old_hits": len(old_paths), "new_hits": len(new_paths),
                        "miss": sorted(old_paths - new_paths), "old_top": old_top, "new_top": new_top})

    def pct(a, n): return round(a / n * 100, 2) if n else 0
    def p95(xs): return sorted(xs)[max(0, int(len(xs) * .95) - 1)] if xs else 0
    summary = {
        "schema": 1, "sample": len(sample), "answerable": stats["answerable"],
        "rule_recall": f'{stats["recall_hits"]}/{stats["old_hits"]}',
        "recall_pct": pct(stats["recall_hits"], stats["old_hits"]),
        "answerable_zero": stats["zero"],
        "top1_equal": stats["top1_equal"], "top1_equal_pct": pct(stats["top1_equal"], stats["answerable"]),
        "top1_in_old": stats["top1_in_old"], "top1_in_old_pct": pct(stats["top1_in_old"], stats["answerable"]),
        "old_p50_ms": round(statistics.median(stats["old_ms"]), 1), "old_p95_ms": round(p95(stats["old_ms"]), 1),
        "dia_p50_ms": round(statistics.median(stats["dia_ms"]), 1), "dia_p95_ms": round(p95(stats["dia_ms"]), 1),
        "query_hash": hashlib.sha256("\n".join(x["query"] for x in sample).encode()).hexdigest(),
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"summary": summary, "details": details}, f, ensure_ascii=False, indent=2); f.write("\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
