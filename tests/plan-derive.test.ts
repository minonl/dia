import { describe, expect, test } from "bun:test";
import { derive, prioIndex, isSatisfied } from "../src/plan.ts";

const t = (id: string, o: any = {}) => ({
  id, title: id, role: "builder", judge: "", status: "todo", evidence: "",
  deps: [], touches: [], created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z",
  ...o,
});

describe("plan 派生：eff 传播", () => {
  test("P0 沿依赖链向上游传播，且声明值不变", () => {
    const tasks = [t("A", { prio: "P3" }), t("B", { prio: "P2", deps: ["A"] }), t("C", { prio: "P0", deps: ["B"] })];
    const d = derive(tasks).byId;
    expect(d.get("C")!.eff_prio).toBe("P0");
    expect(d.get("B")!.eff_prio).toBe("P0");
    expect(d.get("A")!.eff_prio).toBe("P0");
    expect(d.get("A")!.prio_inherited).toBe(true);
    expect(d.get("A")!.prio_source).toEqual({ id: "C", declared: "P0", distance: 2 });
    expect(d.get("C")!.prio_inherited).toBe(false);
  });

  test("P2/P3 不传播；终态下游不传播", () => {
    const tasks = [
      t("A", { prio: "P3" }),
      t("B", { prio: "P2", deps: ["A"] }),
      t("C", { prio: "P0", deps: ["B"], status: "done" }),
    ];
    const d = derive(tasks).byId;
    expect(d.get("A")!.eff_prio).toBe("P3");
    expect(d.get("B")!.eff_prio).toBe("P2");
  });

  test("fan-in 取最小（最高）优先级，不累加", () => {
    const tasks = [t("A"), t("B", { deps: ["A"], prio: "P1" }), t("C", { deps: ["A"], prio: "P1" })];
    const d = derive(tasks).byId;
    expect(d.get("A")!.eff_prio).toBe("P1");
    expect(d.get("A")!.prio_inherited).toBe(true);
  });
});

describe("plan 派生：就绪与排序", () => {
  test("ready/startable：accepted/dropped 满足；dangling 不满足", () => {
    const tasks = [
      t("A", { status: "accepted" }),
      t("B", { status: "dropped" }),
      t("C", { deps: ["A", "B"] }),
      t("D", { deps: ["nope"] }),
      t("E", { deps: ["A"], status: "doing" }),
    ];
    const d = derive(tasks).byId;
    expect(d.get("C")!.ready).toBe(true);
    expect(d.get("C")!.startable).toBe(true);
    expect(d.get("D")!.ready).toBe(false);
    expect(d.get("D")!.dangling_deps).toEqual(["nope"]);
    expect(d.get("E")!.ready).toBe(true);
    expect(d.get("E")!.startable).toBe(false); // doing 不进 next 候选
    expect(d.get("C")!.released_by).toEqual(["B"]);
  });

  test("rank 是拓扑序且按 eff → due 排序", () => {
    const tasks = [
      t("A", { prio: "P3" }),
      t("B", { prio: "P2", deps: ["A"] }),
      t("C", { prio: "P0", deps: ["B"], due: "2026-11-10" }),
      t("X", { prio: "P1", due: "2026-11-01" }),
    ];
    const d = derive(tasks).byId;
    expect(d.get("A")!.rank!).toBeLessThan(d.get("B")!.rank!);
    expect(d.get("B")!.rank!).toBeLessThan(d.get("C")!.rank!);
    // X 是独立 P1：A/B 被追认为 P0，应先于 X
    expect(d.get("A")!.rank!).toBeLessThan(d.get("X")!.rank!);
  });

  test("环内任务 rank=null 且 not ready；lint 报 cycle", () => {
    const tasks = [t("A", { deps: ["B"] }), t("B", { deps: ["A"] })];
    const r = derive(tasks);
    expect(r.byId.get("A")!.rank).toBeNull();
    expect(r.byId.get("A")!.ready).toBe(false);
    expect(r.lint.some((f) => f.kind === "cycle")).toBe(true);
  });

  test("critical = 非终态 P0/P1 的祖先", () => {
    const tasks = [t("A"), t("B", { deps: ["A"], prio: "P0" }), t("C")];
    const d = derive(tasks).byId;
    expect(d.get("A")!.critical).toBe(true);
    expect(d.get("B")!.critical).toBe(false);
    expect(d.get("C")!.critical).toBe(false);
  });

  test("long_chain lint：P0 任务依赖链 ≥3 跳", () => {
    const tasks = [
      t("A"), t("B", { deps: ["A"] }), t("C", { deps: ["B"] }), t("D", { deps: ["C"], prio: "P0" }),
    ];
    const r = derive(tasks);
    expect(r.lint.some((f) => f.kind === "long_chain" && f.id === "D")).toBe(true);
  });

  test("P10 与 P2 按数字比较；无 prio 视为最后", () => {
    expect(prioIndex("P10")).toBe(10);
    expect(prioIndex("P2")).toBe(2);
    expect(prioIndex(undefined)).toBe(99);
    const tasks = [t("A", { prio: "P10" }), t("B", { prio: "P2" }), t("C")];
    const d = derive(tasks).byId;
    expect(d.get("B")!.rank!).toBeLessThan(d.get("A")!.rank!);
    expect(d.get("A")!.rank!).toBeLessThan(d.get("C")!.rank!);
  });

  test("isSatisfied 口径", () => {
    expect(isSatisfied(t("A", { status: "done" }))).toBe(true);
    expect(isSatisfied(t("A", { status: "accepted" }))).toBe(true);
    expect(isSatisfied(t("A", { status: "dropped" }))).toBe(true);
    expect(isSatisfied(t("A", { status: "rejected" }))).toBe(false);
    expect(isSatisfied(undefined)).toBe(false);
  });
});
