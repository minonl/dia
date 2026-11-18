import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
const prev = process.env.DIA_ROOT;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dia-graph-track-"));
  process.env.DIA_ROOT = root;
});
afterEach(() => {
  if (prev === undefined) delete process.env.DIA_ROOT; else process.env.DIA_ROOT = prev;
  rmSync(root, { recursive: true, force: true });
});

describe("graph：track 节点与边（track-v1）", () => {
  test("track 节点 + belongs_to/serves + payload.tracks", async () => {
    const task = await import("../src/task.ts");
    const store = await import("../src/workbench/store.ts");
    const graph = await import("../src/graph.ts");
    const render = await import("../src/graph-html/render.ts");

    const t = task.add("切片 A", { judge: "bun test" });
    const ts = new Date().toISOString();
    store.appendTrack({ ts, event: "open", id: "tr-graph01", title: "长任务 A", repo: ["fed/lyzr/hummus"], prio: "P1", next: "下一步" });
    store.appendTrack({ ts, event: "bind", id: "tr-graph01", session: "ses_lead", role: "lead", host: "opencode" });
    store.appendTrack({ ts, event: "attach_task", id: "tr-graph01", task: t.id });

    const g = graph.build();
    const track = g.nodes.find((n) => n.id === "track:tr-graph01")!;
    expect(track.kind).toBe("track");
    expect(track.next).toBe("下一步");
    expect(track.repo).toEqual(["fed/lyzr/hummus"]);
    expect(track.lead).toBe("ses_lead");
    expect(g.edges.some((e) => e.kind === "belongs_to" && e.from === `task:${t.id}` && e.to === "track:tr-graph01")).toBe(true);
    expect(g.edges.some((e) => e.kind === "serves" && e.from === "session:ses_lead" && e.to === "track:tr-graph01")).toBe(true);
    expect(g.capabilities).toContain("track-v1");

    const payload = render.buildPayload(g, { now: new Date("2026-01-01T00:00:00Z") });
    expect(payload.tracks.length).toBe(1);
    expect(payload.tracks[0].id).toBe("tr-graph01");
    expect(payload.tracks[0].label).toBe("长任务 A");
  });

  test("--task 过滤会带上所属 track；无 workbench 时向后兼容", async () => {
    const task = await import("../src/task.ts");
    const store = await import("../src/workbench/store.ts");
    const graph = await import("../src/graph.ts");

    const t = task.add("切片 B", { judge: "x" });
    const ts = new Date().toISOString();
    store.appendTrack({ ts, event: "open", id: "tr-graph02", title: "长任务 B", repo: ["r"], prio: "P2", next: "n" });
    store.appendTrack({ ts, event: "attach_task", id: "tr-graph02", task: t.id });

    const one = graph.build({ task: t.id });
    expect(one.nodes.some((n) => n.kind === "track")).toBe(true);

    // 清空 tracks 后：不出现 track 节点，也不声明 track-v1
    rmSync(join(root, "workbench"), { recursive: true, force: true });
    const plain = graph.build();
    expect(plain.nodes.some((n) => n.kind === "track")).toBe(false);
    expect(plain.capabilities).not.toContain("track-v1");
  });
});
