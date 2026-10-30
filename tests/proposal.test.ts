import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let task: any, proposal: any, data: string;

beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), "dia-prop-"));
  process.env.DIA_DATA_DIR = data;
  task = await import("../src/task.ts");
  proposal = await import("../src/proposal.ts");
});

describe("proposals", () => {
  test("collects escalated task, failed verify, deps, hypotheses", () => {
    const t = task.add("broken thing", { judge: "true" });
    task.status(t.id, "escalated", "verify failed");
    const runDir = join(data, "runs", t.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "verify.json"), JSON.stringify({ conclusion: "不通过", evidence: ["cmd exit 1"] }));
    const deps = join(data, "deps.yaml");
    writeFileSync(deps, "- id: x@1\n  result: unknown\n");
    const hyp = join(data, "hyp.md");
    writeFileSync(hyp, "| **H1** | 测试假设 | exp | cost |\n| H1 / H2–H3 | 待验证 | x |\n");
    const t2 = task.add("stuck thing", { judge: "true" });
    task.status(t2.id, "escalated", "no run");
    const rows = proposal.propose({ depsPath: deps, hypothesesPath: hyp, limit: 10 });
    const titles = rows.map((r: any) => r.title).join("\n");
    expect(titles).toContain("升级任务");
    expect(titles).toContain("修复验证失败");
    expect(titles).toContain("复核依赖");
    expect(titles).toContain("验证假设：H1 测试假设");
    expect(titles).toContain("验证假设：H2");
    expect(titles).toContain("验证假设：H3");
  });

  test("does not create tasks", () => {
    const before = task.list().length;
    proposal.propose({ depsPath: join(data, "none.yaml"), hypothesesPath: join(data, "none.md") });
    expect(task.list().length).toBe(before);
  });
});
