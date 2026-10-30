#!/usr/bin/env python3
"""Reproduce the H0 sample: 322 episodes -> filter fixtures -> seed sample 20."""
import json, random, re, sys

path = sys.argv[1]
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 11
rows = [json.loads(line) for line in open(path, encoding="utf-8")]
bad = re.compile(
    r"headless|Implement this task in the repo|Repo: /tmp/team|verify-ws|redteam-ws|"
    r"只回答|YAN-OK|mock|Return only JSON|You are teammate|team-data",
    re.I,
)
keep = [r for r in rows if not bad.search(str(r.get("summary")))]
random.seed(seed)
print(f"# total={len(rows)} keep={len(keep)} seed={seed}", file=sys.stderr)
for r in random.sample(keep, 20):
    print(f"{r['episode_id']}\t{r['source']}\t{str(r.get('summary'))[:80]}")
