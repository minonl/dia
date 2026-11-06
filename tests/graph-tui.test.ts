import { describe, expect, test } from "bun:test";
import { render } from "../src/graph-tui.ts";

const g: any = {
  schema: 1,
  nodes: [
    { id: "task:t-1", kind: "task", label: "实现 A", status: "doing", owner: "ses_a" },
    { id: "task:t-2", kind: "task", label: "实现 B", status: "todo" },
    { id: "session:ses_a", kind: "session", label: "ses_a" },
    { id: "path:src/x.ts", kind: "path", label: "src/x.ts" },
  ],
  edges: [
    { from: "task:t-1", to: "task:t-2", kind: "depends_on", source: "declared" },
    { from: "task:t-1", to: "path:src/x.ts", kind: "touches", source: "declared" },
    { from: "session:ses_a", to: "path:src/x.ts", kind: "claims", source: "declared" },
  ],
  cycles: [],
};

describe("dia graph --tui", () => {
  test("按状态分组渲染 task/deps/touches/claims", () => {
    const s = render(g, { color: false });
    expect(s).toContain("[doing]");
    expect(s).toContain("实现 A");
    expect(s).toContain("↳ depends 实现 B [todo]");
    expect(s).toContain("↳ touches src/x.ts");
    expect(s).toContain("a → src/x.ts");
  });

  test("--status 过滤只保留匹配任务", () => {
    const s = render(g, { color: false, status: "todo" });
    expect(s).toContain("实现 B");
    expect(s).not.toContain("实现 A");
    expect(s).toContain("filter: status=todo");
  });

  test("有环时显示 cycle", () => {
    const s = render({ ...g, cycles: [["task:t-1", "task:t-2"]] }, { color: false });
    expect(s).toContain("⚠ cycle: t-1 -> t-2");
  });
});
