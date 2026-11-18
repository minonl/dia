// M2 核心：track 意图写入 + claim 租约（additive）
// 设计：docs/design/workbench.md §2.2 / §6.1 / §6.2

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;

const prevRoot = process.env.DIA_ROOT;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dia-wb-m2-"));
  process.env.DIA_ROOT = root;
  // claim 侧：数据根下建两个"工作树"目录，用于 worktree 键
  mkdirSync(join(root, "wt-a"), { recursive: true });
  mkdirSync(join(root, "wt-b"), { recursive: true });
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.DIA_ROOT;
  else process.env.DIA_ROOT = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

const wb = () => import("../src/workbench/track.ts");
const claims = () => import("../src/claims.ts");

describe("workbench track（§6.1）", () => {
  test("open → bind → next → stage → handoff → attach → close 全链路", async () => {
    const t = await wb();
    const opened = t.openTrack({
      title: "灰度开通服务",
      goal: "redteam 回灌收口并上线",
      repo: ["fed/lyzr/yan-agent", "fed/lyzr/hummus"],
      prio: "P1",
      next: "补 reply 幂等单测",
    });
    expect(opened.id.startsWith("tr-")).toBe(true);
    expect(opened.status).toBe("open");
    expect(opened.repo).toEqual(["fed/lyzr/yan-agent", "fed/lyzr/hummus"]);
    expect(opened.prio).toBe("P1");

    const bound = t.bindTrack(opened.id, { session: "ses_a", role: "lead", host: "opencode" });
    expect(bound.status).toBe("active"); // 首次绑定推进 open → active
    expect(t.leadOf(bound)).toBe("ses_a");

    const withNext = t.setNext(opened.id, {
      next: "改派 lead",
      waiting_on: t.parseWaitingOn("human:min:等验收"),
      remind_at: "2026-11-19T09:00:00+08:00",
    });
    expect(withNext.next).toBe("改派 lead");
    expect(withNext.waiting_on).toEqual({ kind: "human", ref: "min", note: "等验收" });
    expect(withNext.remind_at).toBe("2026-11-19T09:00:00+08:00");

    const blocked = t.stage(opened.id, { status: "blocked", reason: "lead dead 12h", stage: "dev" });
    expect(blocked.status).toBe("blocked");
    expect(blocked.stage).toBe("dev");

    const handed = t.handoff(opened.id, { from: "ses_a", to: "ses_b", reason: "终端关闭" });
    expect(t.leadOf(handed)).toBe("ses_b");
    expect(handed.sessions.find((s) => s.session_id === "ses_a")?.unbound_at).toBeTruthy();
    expect(handed.handoff).toMatchObject({ from: "ses_a", to: "ses_b", reason: "终端关闭" });

    const attached = t.attachTask(opened.id, "t-6d1bb07d");
    expect(attached.tasks).toEqual(["t-6d1bb07d"]);
    expect(t.attachTask(opened.id, "t-6d1bb07d").tasks).toEqual(["t-6d1bb07d"]); // 幂等

    const closed = t.close(opened.id, { reason: "accepted", evidence: "pipeline green + 验收截图" });
    expect(closed.status).toBe("done");
    expect(closed.closed_reason).toBe("accepted");

    expect(t.getTrack(opened.id)?.status).toBe("done");
    expect(t.listTracks({ status: "done" }).map((x) => x.id)).toEqual([opened.id]);
    expect(t.listTracks({ status: "active" })).toEqual([]);
  });

  test("同 title + repo 集合（顺序无关）重复 open → E_TRACK_DUP", async () => {
    const t = await wb();
    const a = t.openTrack({ title: "同一件事", repo: ["fed/lyzr/hummus", "fed/lyzr/yan-agent"] });
    let err: any;
    try {
      t.openTrack({ title: "同一件事", repo: ["fed/lyzr/yan-agent", "fed/lyzr/hummus"] });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(String(err.message)).toMatch(/^E_TRACK_DUP: 已存在 tr-/);
    expect(String(err.message)).toContain(a.id);

    // 关闭后可重新开
    t.close(a.id, { reason: "accepted" });
    const again = t.openTrack({ title: "同一件事", repo: ["fed/lyzr/hummus", "fed/lyzr/yan-agent"] });
    expect(again.id).not.toBe(a.id);
  });

  test("双 lead → E_TRACK_AMBIGUOUS（同 track 与同会话两侧）", async () => {
    const t = await wb();
    const one = t.openTrack({ title: "线一", repo: ["fed/lyzr/hummus"] });
    const two = t.openTrack({ title: "线二", repo: ["fed/lyzr/hummus"] });
    t.bindTrack(one.id, { session: "ses_a", role: "lead" });

    // 同一 track 第二个 lead
    let e1: any;
    try { t.bindTrack(one.id, { session: "ses_b", role: "lead" }); } catch (e) { e1 = e; }
    expect(String(e1?.message)).toMatch(/E_TRACK_AMBIGUOUS/);
    expect(String(e1?.message)).toContain("ses_a");

    // 同一会话做第二个活跃 track 的 lead
    let e2: any;
    try { t.bindTrack(two.id, { session: "ses_a", role: "lead" }); } catch (e) { e2 = e; }
    expect(String(e2?.message)).toMatch(/E_TRACK_AMBIGUOUS/);

    // worker 不受限
    const twoBound = t.bindTrack(two.id, { session: "ses_a", role: "worker" });
    expect(twoBound.sessions.some((s) => s.session_id === "ses_a" && s.role === "worker")).toBe(true);

    // handoff 到已是别人的 lead 也会被拒
    t.bindTrack(two.id, { session: "ses_c", role: "lead" });
    let e3: any;
    try { t.handoff(one.id, { from: "ses_a", to: "ses_c", reason: "换人" }); } catch (e) { e3 = e; }
    expect(String(e3?.message)).toMatch(/E_TRACK_AMBIGUOUS/);
  });

  test("stage 不允许直接设终态；close 二次调用报 E_TRACK_CLOSED", async () => {
    const t = await wb();
    const tr = t.openTrack({ title: "终态门", repo: ["fed/lyzr/hummus"] });
    expect(() => t.stage(tr.id, { status: "done" })).toThrow(/E_USAGE/);
    t.close(tr.id, { reason: "abandoned" });
    expect(t.getTrack(tr.id)?.status).toBe("abandoned");
    expect(() => t.close(tr.id, { reason: "accepted" })).toThrow(/E_TRACK_CLOSED/);
  });

  test("未知 id → E_TRACK_NOT_FOUND", async () => {
    const t = await wb();
    expect(() => t.bindTrack("tr-nope0000", { session: "ses_a" })).toThrow(/E_TRACK_NOT_FOUND/);
    expect(t.getTrack("tr-nope0000")).toBe(null);
  });
});

describe("claim 租约（§6.2 additive）", () => {
  test("exclusive 冲突抛 E_CLAIM_LEASE，异工作树不冲突", async () => {
    const c = await claims();
    const wtA = join(root, "wt-a");
    const wtB = join(root, "wt-b");
    const first = c.claim("src/a.ts", { session: "ses_a", cwd: wtA, worktree: wtA, lease: "exclusive", track: "tr-aaaa1111" });
    expect(first.claim.worktree).toBe(c.worktreeKey(wtA));
    expect(first.claim.lease).toBe("exclusive");
    expect(first.claim.track).toBe("tr-aaaa1111");

    let err: any;
    try {
      c.claim("src/a.ts", { session: "ses_b", cwd: wtA, worktree: wtA, lease: "exclusive" });
    } catch (e) { err = e; }
    expect(String(err?.message)).toMatch(/^E_CLAIM_LEASE: c-/);
    expect(String(err?.message)).toContain(first.claim.id);
    expect(String(err?.message)).toContain("持有中（至 ");

    // 另一棵工作树的同名文件 = 另一份资源
    const other = c.claim("src/a.ts", { session: "ses_b", cwd: wtB, worktree: wtB, lease: "exclusive" });
    expect(other.overlaps).toEqual([]);
    expect(other.claim.worktree).not.toBe(first.claim.worktree);

    // holder 自己重复 claim 不算冲突
    expect(() => c.claim("src/a.ts", { session: "ses_a", cwd: wtA, worktree: wtA, lease: "exclusive" })).not.toThrow();
  });

  test("shared 无 reason 抛错；有 reason 通过并报 overlap", async () => {
    const c = await claims();
    const wt = join(root, "wt-a");
    c.claim("docs/spec.md", { session: "ses_a", cwd: wt, worktree: wt, lease: "exclusive" });

    let err: any;
    try { c.claim("docs/spec.md", { session: "ses_b", cwd: wt, worktree: wt, lease: "shared" }); } catch (e) { err = e; }
    expect(String(err?.message)).toBe("E_CLAIM_LEASE: shared 需要 --reason");

    const shared = c.claim("docs/spec.md", { session: "ses_b", cwd: wt, worktree: wt, lease: "shared", reason: "只读引用" });
    expect(shared.claim.lease).toBe("shared");
    expect(shared.overlaps.map((x) => x.holder)).toEqual(["ses_a"]);
  });

  test("旧调用（无 worktree / track / lease）行为不变：不阻断，只报 overlap", async () => {
    const c = await claims();
    const a = c.claim("README.md", { session: "ses_a", cwd: root, reason: "A" });
    const b = c.claim("README.md", { session: "ses_b", cwd: root, reason: "B" });
    expect(a.claim.worktree).toBeUndefined();
    expect(a.claim.lease).toBeUndefined();
    expect(b.overlaps.length).toBe(1);
    expect(b.overlaps[0].holder).toBe("ses_a");

    const active = c.list({ cwd: root });
    expect(active.filter((x) => x.path === "README.md").length).toBe(2);
    expect(active.every((x) => x.worktree === undefined)).toBe(true);
  });
});
