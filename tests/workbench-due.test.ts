// M4：`dia wb due` / `dia wb brief` 的到期判定（§9.3、§5.1）
// 判据：--now 注入 + fixture 固定，不依赖本机数据与真实时钟。

import { describe, expect, test } from "bun:test";
import { computeDue, parseLocalTime, DEFAULT_DUE_CFG, type DueSessionInput, type DueTrackInput } from "../src/workbench/due.ts";
import type { Track } from "../src/workbench/schema.ts";

const NOW = "2026-11-18T04:00:00.000Z";
const H = 3_600_000;
const D = 24 * H;
/** now - n ms 的 ISO */
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

function mkTrack(over: Partial<Track> & { status_since?: string } = {}): DueTrackInput {
  return {
    id: "tr-aaaa1111",
    title: "灰度开通服务",
    goal: "",
    status: "active",
    stage: "dev",
    next: "补幂等单测",
    repo: ["org/group/project-a"],
    prio: "P1",
    refs: [],
    sessions: [{ session_id: "ses_a", role: "lead", host: "opencode", bound_at: ago(2 * H) }],
    tasks: [],
    created_at: ago(7 * D),
    updated_at: ago(2 * H),
    ...over,
  };
}

const alive: DueSessionInput[] = [{ session_id: "ses_a", liveness: "alive", last_activity: ago(2 * 60_000) }];

describe("computeDue（§9.3 命中与排序）", () => {
  test("remind_at=now-2h 命中，overdue≈2h 且给可执行 next_actions", () => {
    const r = computeDue({ now: NOW, tracks: [mkTrack({ remind_at: ago(2 * H) })], sessions: alive });
    expect(r.items.length).toBe(1);
    const it = r.items[0];
    expect(it.track_id).toBe("tr-aaaa1111");
    expect(it.reasons.map((x) => x.kind)).toEqual(["remind"]);
    expect(it.overdue_ms).toBe(2 * H);
    expect(r.counts.total).toBe(1);
    expect(r.counts.remind).toBe(1);
    expect(r.counts.overdue).toBe(1);
    expect(it.next_actions.length).toBeGreaterThan(0);
    expect(it.next_actions.every((c) => c.startsWith("dia wb track "))).toBe(true);
    expect(r.assumed_tz).toBe("local");
    expect(r.as_of).toBe(NOW);
  });

  test("无活跃 lead 命中（bind 过但已 unbind 也算无 lead）", () => {
    const r = computeDue({ now: NOW, tracks: [mkTrack({ sessions: [] })], sessions: alive });
    expect(r.items.length).toBe(1);
    expect(r.items[0].reasons.map((x) => x.kind)).toEqual(["no_lead"]);
    expect(r.items[0].lead).toBe(null);
    expect(r.items[0].lead_liveness).toBe("none");
    expect(r.counts.no_lead).toBe(1);

    const unbound = computeDue({
      now: NOW,
      tracks: [mkTrack({ sessions: [{ session_id: "ses_a", role: "lead", host: "opencode", bound_at: ago(2 * H), unbound_at: ago(H) }] })],
      sessions: alive,
    });
    expect(unbound.items[0].reasons.map((x) => x.kind)).toEqual(["no_lead"]);
  });

  test("blocked 超 24h 命中；status_since 缺失时按 updated_at 兜底并标 estimated", () => {
    const precise = computeDue({
      now: NOW,
      tracks: [mkTrack({ status: "blocked", status_since: ago(25 * H) })],
      sessions: alive,
    });
    expect(precise.items.length).toBe(1);
    expect(precise.items[0].reasons.map((x) => x.kind)).toEqual(["blocked"]);
    expect(precise.items[0].overdue_ms).toBe(1 * H);
    expect(precise.items[0].estimated).toBe(false);
    expect(precise.counts.blocked).toBe(1);

    const fallback = computeDue({
      now: NOW,
      tracks: [mkTrack({ status: "blocked", updated_at: ago(25 * H) })],
      sessions: alive,
    });
    expect(fallback.items[0].reasons[0].kind).toBe("blocked");
    expect(fallback.items[0].estimated).toBe(true);
    expect(fallback.items[0].reasons[0].estimated).toBe(true);

    // 未超阈值（2h < 24h）不命中
    const fresh = computeDue({
      now: NOW,
      tracks: [mkTrack({ status: "blocked", status_since: ago(2 * H) })],
      sessions: alive,
    });
    expect(fresh.items).toEqual([]);
  });

  test("零命中 → 空数组 + counts 全 0", () => {
    const r = computeDue({ now: NOW, tracks: [mkTrack()], sessions: alive });
    expect(r.items).toEqual([]);
    expect(r.counts).toEqual({ total: 0, overdue: 0, remind: 0, stale_wait: 0, no_lead: 0, lead_dead: 0, blocked: 0 });
    expect(r.brief.head).toBe("你有 0 条 track 待关注（超期 0 条）");
    expect(r.brief.items).toEqual([]);
    expect(r.brief.next_actions).toEqual([]);
  });

  test("已关闭 track（done/abandoned）不提醒", () => {
    const now = NOW;
    const tracks = [mkTrack({ id: "tr-1", status: "done", remind_at: ago(3 * H) }), mkTrack({ id: "tr-2", status: "abandoned", remind_at: ago(3 * H) })];
    expect(computeDue({ now, tracks, sessions: alive }).items).toEqual([]);
  });

  test("waiting_on 超 stale_wait_days（默认 3 天）命中，2 天不命中", () => {
    const stale = computeDue({
      now: NOW,
      tracks: [mkTrack({ waiting_on: { kind: "human", ref: "maintainer" }, updated_at: ago(4 * D) })],
      sessions: alive,
    });
    expect(stale.items[0].reasons.map((x) => x.kind)).toEqual(["stale_wait"]);
    expect(stale.items[0].overdue_ms).toBe(1 * D);
    expect(stale.counts.stale_wait).toBe(1);

    const ok = computeDue({
      now: NOW,
      tracks: [mkTrack({ waiting_on: { kind: "human", ref: "maintainer" }, updated_at: ago(2 * D) })],
      sessions: alive,
    });
    expect(ok.items).toEqual([]);
    expect(DEFAULT_DUE_CFG.stale_wait_days).toBe(3);
  });

  test("lead suspect 且无 claim、15min 内无心跳 → 失效；有心跳则有效", () => {
    const suspect: DueSessionInput[] = [{ session_id: "ses_a", liveness: "suspect", last_activity: ago(40 * 60_000) }];
    const dead = computeDue({ now: NOW, tracks: [mkTrack()], sessions: suspect });
    expect(dead.items[0].reasons.map((x) => x.kind)).toEqual(["lead_dead"]);
    expect(dead.items[0].lead_liveness).toBe("suspect");
    expect(dead.counts.lead_dead).toBe(1);

    const beat = computeDue({
      now: NOW,
      tracks: [mkTrack()],
      sessions: suspect,
      beats: [{ session: "ses_a", ts: ago(5 * 60_000) }],
    });
    expect(beat.items).toEqual([]);

    const claimed = computeDue({
      now: NOW,
      tracks: [mkTrack()],
      sessions: [{ session_id: "ses_a", liveness: "suspect", last_activity: ago(40 * 60_000), claims: 1 }],
    });
    expect(claimed.items).toEqual([]);

    const trulyDead = computeDue({
      now: NOW,
      tracks: [mkTrack()],
      sessions: [{ session_id: "ses_a", liveness: "dead", last_activity: ago(20 * H) }],
    });
    expect(trulyDead.items[0].reasons.map((x) => x.kind)).toEqual(["lead_dead"]);
    expect(trulyDead.items[0].lead_liveness).toBe("dead");

    // 无会话记录但 15min 内有心跳：活着的证据只加分，不提醒
    const beatOnly = computeDue({ now: NOW, tracks: [mkTrack()], sessions: [], beats: [{ session: "ses_a", ts: ago(3 * 60_000) }] });
    expect(beatOnly.items).toEqual([]);
  });

  test("阈值可注入（cfg 覆盖默认）", () => {
    const twoHoursBlocked = mkTrack({ status: "blocked", status_since: ago(2 * H) });
    expect(computeDue({ now: NOW, tracks: [twoHoursBlocked], sessions: alive }).items).toEqual([]);
    const hit = computeDue({ now: NOW, tracks: [twoHoursBlocked], sessions: alive, cfg: { blocked_stale_h: 1 } });
    expect(hit.items[0].reasons[0].kind).toBe("blocked");
  });

  test("一次命中多条原因时都列出（reasons 可叠加）", () => {
    const r = computeDue({
      now: NOW,
      tracks: [mkTrack({ remind_at: ago(2 * H), status: "blocked", status_since: ago(30 * H), waiting_on: { kind: "mr", ref: "!1975" }, updated_at: ago(5 * D) })],
      sessions: [{ session_id: "ses_a", liveness: "dead", last_activity: ago(D) }],
    });
    const kinds = r.items[0].reasons.map((x) => x.kind).sort();
    expect(kinds).toEqual(["blocked", "lead_dead", "remind", "stale_wait"]);
    expect(r.counts.total).toBe(1);
    expect(r.counts.remind + r.counts.blocked + r.counts.stale_wait + r.counts.lead_dead).toBe(4);
  });
});

describe("computeDue（排序与 brief）", () => {
  test("按 overdue_ms desc → prio → remind_at 排序，brief 取前 5", () => {
    // 6 条：overdue 1h..6h；其中 #1 改成 P9 也被 overdue 压住
    const tracks = Array.from({ length: 6 }, (_, i) =>
      mkTrack({ id: `tr-${i}`, title: `线 ${i}`, remind_at: ago((i + 1) * H), prio: i === 5 ? "P9" : "P2" }),
    );
    const r = computeDue({ now: NOW, tracks, sessions: alive });
    expect(r.items.map((x) => x.track_id)).toEqual(["tr-5", "tr-4", "tr-3", "tr-2", "tr-1", "tr-0"]);
    expect(r.items[0].overdue_ms).toBe(6 * H);
    expect(r.brief.items.length).toBe(5);
    expect(r.brief.items.map((x) => x.track_id)).toEqual(["tr-5", "tr-4", "tr-3", "tr-2", "tr-1"]);
    expect(r.brief.head).toBe("你有 6 条 track 待关注（超期 6 条）");
    expect(r.brief.next_actions.length).toBe(5);
    expect(r.brief.next_actions.every((c) => c.startsWith("dia wb track "))).toBe(true);
  });

  test("overdue 相同 → prio 小的在前；再相同 → remind_at 早的在前", () => {
    const tracks = [
      mkTrack({ id: "tr-b", prio: "P2", remind_at: ago(2 * H) }),
      mkTrack({ id: "tr-a", prio: "P1", remind_at: ago(2 * H) }),
      mkTrack({ id: "tr-c", prio: "P1", remind_at: ago(3 * H) }),
    ];
    const r = computeDue({ now: NOW, tracks, sessions: alive });
    expect(r.items.map((x) => x.track_id)).toEqual(["tr-c", "tr-a", "tr-b"]);
  });
});

describe("remind_at 时区（§9.3 assumed_tz local）", () => {
  test("无时区按本地解释", () => {
    expect(parseLocalTime("2026-11-18T10:00:00")).toBe(new Date(2026, 10, 18, 10, 0, 0).getTime());
    expect(parseLocalTime("2026-11-18 10:00")).toBe(new Date(2026, 10, 18, 10, 0, 0).getTime());
    expect(parseLocalTime("2026-11-18")).toBe(new Date(2026, 10, 18).getTime());
    expect(parseLocalTime("2026-11-18T10:00:00Z")).toBe(Date.UTC(2026, 10, 18, 10, 0, 0));
    expect(parseLocalTime("")).toBe(null);
  });

  test("本地 remind_at 到点即命中", () => {
    const now = new Date(2026, 10, 18, 12, 0, 0);
    const r = computeDue({ now, tracks: [mkTrack({ remind_at: "2026-11-18T10:00:00" })], sessions: alive });
    expect(r.items.length).toBe(1);
    expect(r.items[0].overdue_ms).toBe(2 * H);
    expect(r.assumed_tz).toBe("local");
    expect(r.as_of).toBe(now.toISOString());
  });
});
