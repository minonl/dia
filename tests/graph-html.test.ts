import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHtml, buildPayload, localDay, dayDiff } from "../src/graph-html/render.ts";

const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "graph.v1.json"), "utf8"));
const now = new Date("2026-11-06T10:00:00");

describe("graph-html 单文件导出", () => {
  test("渲染出数据槽 + 任务 + depends_on 边", () => {
    const html = renderHtml(fixture, { now });
    expect(html).toContain('id="dia-graph"');
    const payload = buildPayload(fixture, { now });
    expect(payload.today).toBe("2026-11-06");
    expect(payload.tasks.length).toBe(2);
    const a = payload.tasks.find((t) => t.id === "t-fix-a")!;
    expect(a.prio).toBe("P1");
    expect(a.start).toBe(dayDiff("2026-11-06", "2026-11-01"));
    expect(a.end).toBe(dayDiff("2026-11-06", "2026-11-08"));
    expect(a.progress).toBe(40);
    expect(a.derived).toBe(false);
    expect(payload.edges).toEqual([{ from: "t-fix-a", to: "t-fix-b", kind: "depends_on" }]);
  });

  test("无网络/无外链/无 fetch：单文件可直接 file:// 打开", () => {
    const html = renderHtml(fixture, { now });
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/\bfetch\s*\(/);
    expect(html).not.toMatch(/XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
  });

  test("标题里的 </script> 被转义，不破坏数据槽", () => {
    const evil = structuredClone(fixture);
    evil.nodes[0].label = '</script><img src=x onerror=alert(1)>';
    const html = renderHtml(evil, { now });
    const slot = html.slice(html.indexOf('id="dia-graph"'), html.indexOf("</script>", html.indexOf('id="dia-graph"')));
    expect(slot).not.toContain("</script>");
    const payload = buildPayload(evil, { now });
    expect(payload.tasks[0].label).toBe('</script><img src=x onerror=alert(1)>');
  });

  test("确定性：同一输入 + 同一 now 输出完全一致", () => {
    expect(renderHtml(fixture, { now })).toBe(renderHtml(fixture, { now }));
  });

  test("空账本可渲染（空态）", () => {
    const html = renderHtml({ schema: 1, nodes: [], edges: [], cycles: [] } as any, { now });
    expect(html).toContain('id="dia-graph"');
    expect(buildPayload({ schema: 1, nodes: [], edges: [], cycles: [] } as any, { now }).tasks).toEqual([]);
  });

  test("超限截断并标记 truncated", () => {
    const p = buildPayload(fixture, { now, limit: 1 });
    expect(p.tasks.length).toBe(1);
    expect(p.truncated).toEqual({ shown: 1, total: 2 });
  });

  test("--redact 脱敏 owner 与路径", () => {
    const p = buildPayload(fixture, { now, redact: true });
    const a = p.tasks.find((t) => t.id === "t-fix-a")!;
    expect(a.owner).toMatch(/^owner-[0-9a-f]{8}$/);
    expect(a.touches).toEqual(["a.ts"]);
  });

  test("缺 start 用 created_at 回填；缺 due 且未完成 → end=null（开放端）", () => {
    const p = buildPayload(fixture, { now });
    const b = p.tasks.find((t) => t.id === "t-fix-b")!;
    expect(b.start).toBe(dayDiff("2026-11-06", localDay(new Date("2026-10-29T00:00:00.000Z"))));
    expect(b.end).toBeNull();
    expect(b.derived).toBe(true);
  });

  test("未知/扩展状态有图标兜底，不渲染 undefined", () => {
    const tpl = readFileSync(join(import.meta.dir, "..", "src", "graph-html", "template.html"), "utf8");
    expect(tpl).toContain("stIconOf");
    expect(tpl).not.toContain("stIcon[t.status]");
    const evil = structuredClone(fixture);
    evil.nodes[0].status = "rejected";
    const p = buildPayload(evil, { now });
    expect(p.tasks.find((t) => t.id === "t-fix-a")!.status).toBe("rejected");
  });

  test("模板自身不含网络调用（静态安全）", () => {
    const tpl = readFileSync(join(import.meta.dir, "..", "src", "graph-html", "template.html"), "utf8");
    expect(tpl).not.toMatch(/https?:\/\//i);
    expect(tpl).not.toMatch(/\bfetch\s*\(/);
    expect(tpl).not.toMatch(/node:http/);
  });
});
