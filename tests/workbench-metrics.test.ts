// M4：指标聚合（§8.1 口径 / §8.2 团队模式 / §8.3 输出）
// 判据：固定 fixture + 期望值写死（容差 0，fixture 不跨表）；同输入字节一致。

import { describe, expect, test } from "bun:test";
import { buildMetrics, ACTIVE_GAP_MS, COMPARE_MIN_N, type MetricsInput } from "../src/workbench/metrics.ts";
import type { Track } from "../src/workbench/schema.ts";

const PRICES = {
  "deepseek/deepseek-flash": { input: 0.15, output: 0.6, cache_read: 0.003 },
};

function mkTrack(over: Partial<Track> = {}): Track {
  return {
    id: "tr-aaaa1111",
    title: "灰度开通服务",
    goal: "redteam 回灌收口并上线",
    status: "active",
    stage: "dev",
    next: "补幂等单测",
    repo: ["fed/lyzr/hummus"],
    prio: "P1",
    refs: [],
    sessions: [],
    tasks: [],
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-17T00:00:00.000Z",
    ...over,
  };
}

const T0 = "2026-11-18T01:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString();

/** root 1000/200/5000 + child 100/20/0（§8.1 口径 fixture） */
const BASE: MetricsInput = {
  as_of: "2026-11-18T04:00:00.000Z",
  prices: {},
  sessions: [
    {
      session_id: "ses_root",
      host: "opencode",
      tokens: { input: 1000, output: 200, cache_read: 5000, cache_write: 0 },
      models: ["leyantech/deepseek-v4.1-flash"],
      turns: 4,
      tools: { bash: 3, edit: 1 },
      tool_errors: 1,
      turn_times: [at(0), at(5), at(30)],
      first_seen: at(0),
      last_activity: at(30),
    },
    {
      session_id: "ses_child",
      parent_id: "ses_root",
      host: "opencode",
      tokens: { input: 100, output: 20, cache_read: 0, cache_write: 0 },
      models: ["leyantech/deepseek-v4.1-flash"],
      turns: 2,
      turn_times: [at(31), at(33)],
      first_seen: at(31),
      last_activity: at(33),
    },
  ],
};

describe("workbench metrics（§8.1 口径）", () => {
  test("tokens 取会话级汇总：root 1000/200/5000 + child 100/20/0 → 1100/220/5000，total 1320", () => {
    const m = buildMetrics(BASE);
    expect(m.tokens).toEqual({ input: 1100, output: 220, cache_read: 5000, cache_write: 0, total: 1320 });
    expect(m.n.sessions).toBe(2);
    expect(m.n.parents).toBe(1);
    expect(m.n.subagents).toBe(1);
    expect(m.totals_source).toBe("session_v2");
    expect(m.detail_source).toBe("session_message");
  });

  test("子会话 tokens 上溯到 root 聚合（by_root 只出 root）", () => {
    const m = buildMetrics(BASE);
    expect(m.by_root).toEqual([
      { root: "ses_root", sessions: 2, tokens: { input: 1100, output: 220, cache_read: 5000, cache_write: 0, total: 1320 } },
    ]);
  });

  test("子会话增量超 1%（root 汇总可能已含子会话）→ within_expected=false 且给 parent_id IS NULL 兜底", () => {
    const m = buildMetrics(BASE);
    expect(m.reconcile).toEqual({ delta: 120, expected_max: 12, within_expected: false });
    expect(m.fallback?.strategy).toBe("parent_id IS NULL");
    expect(m.fallback?.sessions).toBe(1);
    expect(m.fallback?.tokens.total).toBe(1200); // 1000+200，只取 root
  });

  test("未知型号不猜价：cost_usd null / priced false / unpriced 2", () => {
    const m = buildMetrics(BASE);
    expect(m.cost_usd).toBe(null);
    expect(m.priced).toBe(false);
    expect(m.unpriced.sessions).toBe(2);
    expect(m.unpriced.models).toEqual(["leyantech/deepseek-v4.1-flash"]);
    expect(m.cost_basis).toBe("none");
  });

  test("过程指标：turns / tools.failure_rate / active_ms（相邻 turn ≤10min）", () => {
    const m = buildMetrics(BASE);
    expect(m.turns).toBe(6);
    expect(m.tools.total).toBe(4);
    expect(m.tools.errors).toBe(1);
    expect(m.tools.failure_rate).toBe(0.25);
    expect(m.tools.by_tool).toEqual({ bash: 3, edit: 1 });
    // root: 0→5min 计入 5min，5→30min 超 10min 不计；child: 31→33 计入 2min
    expect(m.active_ms).toBe(5 * 60_000 + 2 * 60_000);
    expect(m.active_ms).toBeLessThan(ACTIVE_GAP_MS + 5 * 60_000);
    expect(m.estimated.active_ms).toBe(true);
    expect(m.wall_ms).toBe(30 * 60_000 + 2 * 60_000);
  });

  test("宿主 cost>0 优先；cost=0 且型号已知 → 回落 pricing（0 不等于免费）", () => {
    const host = buildMetrics({
      ...BASE,
      prices: PRICES,
      sessions: [{ session_id: "ses_h", host: "dsh", cost_usd: 1.25, tokens: { input: 1, output: 1 }, models: ["unknown/x"] }],
    });
    expect(host.priced).toBe(true);
    expect(host.cost_usd).toBe(1.25);
    expect(host.cost_basis).toBe("host");
    expect(host.unpriced.sessions).toBe(0);

    const zero = buildMetrics({
      ...BASE,
      prices: PRICES,
      sessions: [
        { session_id: "ses_z", host: "dsh", cost_usd: 0, tokens: { input: 1_000_000, output: 0 }, models: ["deepseek/deepseek-flash"] },
      ],
    });
    expect(zero.priced).toBe(true);
    expect(zero.cost_usd).toBe(0.15);
    expect(zero.cost_basis).toBe("pricing");
  });

  test("部分未定价：cost_usd 只累加已知价，priced=false（不把未知当免费）", () => {
    const m = buildMetrics({
      ...BASE,
      prices: PRICES,
      sessions: [
        { session_id: "a", host: "dsh", cost_usd: 0.5, tokens: {}, models: ["leyantech/unknown"] },
        { session_id: "b", host: "dsh", tokens: { input: 1_000_000 }, models: ["deepseek/deepseek-flash"] },
        { session_id: "c", host: "dsh", tokens: { input: 10 }, models: ["leyantech/unknown"] },
      ],
    });
    expect(m.cost_usd).toBeCloseTo(0.65, 6);
    expect(m.priced).toBe(false);
    expect(m.unpriced).toEqual({ sessions: 1, models: ["leyantech/unknown"] });
    expect(m.cost_basis).toBe("mixed");
  });

  test("mixed_hosts 按去重 host 判定（unknown 不算）", () => {    expect(buildMetrics(BASE).mixed_hosts).toBe(false);
    const mixed = buildMetrics({
      ...BASE,
      sessions: [
        { session_id: "a", host: "opencode", tokens: {} },
        { session_id: "b", host: "dsh", tokens: {} },
      ],
    });
    expect(mixed.mixed_hosts).toBe(true);
    expect(Object.keys(mixed.by_host)).toEqual(["dsh", "opencode"]);
  });

  test("acceptance 从 tasks 派生（dropped 不计入 attempted）", () => {
    const m = buildMetrics({
      ...BASE,
      tasks: [
        { id: "t-1", status: "done", judge: "bun test" },
        { id: "t-2", status: "accepted" },
        { id: "t-3", status: "doing", judge: "  " },
        { id: "t-4", status: "dropped" },
      ],
    });
    expect(m.acceptance).toEqual({ attempted: 3, done: 2, rate: 0.6667, judge_coverage: 0.3333 });
  });
});

describe("workbench metrics（§8.2 团队模式与对照）", () => {
  test("mode 只看非 mock run 的角色集合：builder+verifier → team", () => {
    const m = buildMetrics({ ...BASE, runs: [{ role: "builder" }, { role: "verifier" }] });
    expect(m.mode).toBe("team");
    expect(m.n.runs).toBe(2);
    expect(m.n.excluded_mock).toBe(0);
  });

  test("只有 builder → solo；含 redteam → team", () => {
    expect(buildMetrics({ ...BASE, runs: [{ role: "builder" }] }).mode).toBe("solo");
    expect(buildMetrics({ ...BASE, runs: [{ role: "redteam" }] }).mode).toBe("team");
    expect(buildMetrics({ ...BASE, runs: [{ role: "redteam-1" }] }).mode).toBe("team");
  });

  test("mock run 不参与 mode 判定，计入 excluded_mock", () => {
    const m = buildMetrics({
      ...BASE,
      runs: [
        { role: "builder", mock: true },
        { role: "verifier", mock: true },
      ],
    });
    expect(m.mode).toBe("solo");
    expect(m.n.runs).toBe(0);
    expect(m.n.excluded_mock).toBe(2);
  });

  test("返工轮次：^-repair$ / ^redteam-\\d / ^builder-fix$ 命中（mock 不算）", () => {
    const m = buildMetrics({
      ...BASE,
      runs: [
        { role: "builder" },
        { role: "verifier" },
        { role: "builder-repair" },
        { role: "redteam-1" },
        { role: "builder-fix" },
        { role: "redteam" },
        { role: "builder-fix", mock: true },
      ],
    });
    expect(m.rework).toBe(3);
    expect(m.n.excluded_mock).toBe(1);
  });

  test("n<5 不下结论：conclusive=false / need_more=3 / verdict=null", () => {
    const tracks = [mkTrack({ id: "tr-1", status: "done" }), mkTrack({ id: "tr-2", status: "done" })];
    const m = buildMetrics({ ...BASE, tracks, runs: [{ role: "builder" }, { role: "verifier" }] });
    expect(m.compare.n).toBe(2);
    expect(m.compare.conclusive).toBe(false);
    expect(m.compare.need_more).toBe(COMPARE_MIN_N - 2);
    expect(m.compare.verdict).toBe(null);
    expect(m.n.done_tracks).toBe(2);
  });

  test("已完成 track 达到 5 条才 conclusive，且 goal_type 可注入 repo::tag", () => {
    const tracks = Array.from({ length: 5 }, (_, i) => mkTrack({ id: `tr-${i}`, status: "done" }));
    const m = buildMetrics({
      ...BASE,
      tracks,
      runs: [{ role: "builder" }, { role: "verifier" }],
      goal_type: { repo: "fed/lyzr/hummus", tag: "release" },
    });
    expect(m.compare.n).toBe(5);
    expect(m.compare.conclusive).toBe(true);
    expect(m.compare.need_more).toBe(0);
    expect(m.goal_type).toBe("fed/lyzr/hummus::release");
    expect(m.compare.team.n).toBe(5);
    expect(m.compare.solo.n).toBe(0);
  });

  test("abandoned 不算已完成 track", () => {
    const m = buildMetrics({ ...BASE, tracks: [mkTrack({ id: "tr-x", status: "abandoned" })] });
    expect(m.n.done_tracks).toBe(0);
    expect(m.compare.n).toBe(0);
  });
});

describe("workbench metrics（确定性）", () => {
  test("同输入两次输出字节一致", () => {
    const input: MetricsInput = {
      ...BASE,
      runs: [{ role: "builder" }, { role: "verifier" }, { role: "redteam-1" }],
      tasks: [{ id: "t-1", status: "done", judge: "bun test" }],
      tracks: [mkTrack({ id: "tr-1", status: "done" })],
      goal_type: { repo: "fed/lyzr/hummus", tag: "feature" },
    };
    expect(JSON.stringify(buildMetrics(input))).toBe(JSON.stringify(buildMetrics(input)));
  });

  test("未注入 clock 时 as_of 不读墙钟（null 或 window.until）", () => {
    const m = buildMetrics({ sessions: [] });
    expect(m.as_of).toBe(null);
    expect(m.window).toEqual({ since: null, until: null, approximate: true });
    const withWindow = buildMetrics({ sessions: [], window: { until: "2026-11-18T04:00:00.000Z" } });
    expect(withWindow.as_of).toBe("2026-11-18T04:00:00.000Z");
  });
});
