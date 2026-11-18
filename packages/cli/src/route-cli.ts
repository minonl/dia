// dia 路由 CLI：`track:` / `group:` / `session:` 地址 + 队列出队 + 显式组成员
//
// 设计：docs/design/workbench.md §7
// 退出码：
//   0   投递成功
//   2   用法错误 / 未知地址（E_ROUTE_ADDR）/ 广播越权（E_FANOUT*）
//   40  E_ROUTE_UNRESOLVED（已入队，消息不出现在任何 inbox）
//   41  E_ROUTE_MOVED（旧会话已被 handoff；--allow-moved 放行）

import * as collab from "../../../src/collab.ts";
import * as route from "../../../src/collab-route.ts";
import * as claims from "../../../src/claims.ts";
import * as msgPriority from "../../../src/msg-priority.ts";
import * as plan from "../../../src/plan.ts";
import * as task from "../../../src/task.ts";
import * as store from "../../../src/workbench/store.ts";

const out = (s: string) => process.stdout.write(s + "\n");
const err = (s: string) => process.stderr.write(s + "\n");

export const EXIT = { OK: 0, USAGE: 2, UNRESOLVED: 40, MOVED: 41 } as const;

/** 带值的 flag 白名单：其余 `--x` 当布尔，避免把位置参数吃掉。 */
const VALUE_FLAGS = new Set([
  "--to", "--from", "--subject", "--kind", "--body", "--body-file", "--ref", "--thread",
  "--deadline", "--idempotency-key", "--hops", "--session", "--fanout", "--track", "--addr",
  "--max", "--reason", "--name", "--limit", "--class", "--touch", "--touches", "--reply-to", "--persona",
]);

function has(argv: string[], name: string): boolean { return argv.includes(name); }

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function positional(argv: string[]): string[] {
  const res: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!a.includes("=") && VALUE_FLAGS.has(a)) i++;
      continue;
    }
    res.push(a);
  }
  return res;
}

function collectRefs(argv: string[]): Record<string, string> {
  const refs: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--ref" || !argv[i + 1]) continue;
    const [k, ...v] = argv[i + 1].split("=");
    if (k && v.length) refs[k] = v.join("=");
    i++;
  }
  const touches = [...argv.flatMap((a, i) => (a === "--touch" && argv[i + 1] ? [argv[i + 1]] : [])), ...(flag(argv, "--touches") || "").split(",")]
    .map((x) => x.trim()).filter(Boolean);
  if (touches.length) refs.touches = touches.join(",");
  return refs;
}

function newThreadId(): string {
  return `th-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

/** 与 `dia out` 同口径的优先级快照（发送者 doing 任务 eff 最低者） */
function classOf(kind: collab.Kind, requiresReply: boolean, hops: number, deadline?: string) {
  const baseInfo = (() => {
    try {
      const tasks = task.list();
      const dr = plan.derive(tasks);
      const mine = tasks.filter((t) => t.owner === collab.resolveSessionId(undefined) && t.status === "doing");
      if (!mine.length) return { base: 2, why: "无 doing 任务" };
      const best = mine.map((t) => dr.byId.get(t.id)?.eff_prio ?? "P99")
        .sort((a, b) => plan.prioIndex(a) - plan.prioIndex(b))[0];
      return { base: Math.min(3, plan.prioIndex(best)), why: `doing eff=${best}` };
    } catch { return { base: 2, why: "任务账本不可读" }; }
  })();
  const cls = msgPriority.classify({ base: baseInfo.base, kind, requiresReply, hops, deadline });
  return { cls: cls.cls, why: [...cls.why, baseInfo.why] };
}

function routeErrorCode(e: any): number {
  const m = String(e?.message || e);
  if (m.startsWith("E_ROUTE_ADDR") || m.startsWith("E_FANOUT") || m.startsWith("E_USAGE") || m.startsWith("E_SESSION") || m.startsWith("E_NO_SESSION") || m.startsWith("E_KIND") || m.startsWith("E_GROUP_MEMBER")) {
    return EXIT.USAGE;
  }
  return 31;
}

/**
 * `dia msg send --to <addr>` / `dia out --to <addr>` 的路由分支。
 * 返回 null 表示「不是路由地址」→ 调用方继续走旧路径（裸 session id / agent 名）。
 */
export function routeMsgSend(argv: string[]): number | null {
  const toRaw = flag(argv, "--to") || positional(argv)[0];
  const addr = route.parseAddr(toRaw);
  if (!addr) return null;

  const asJson = has(argv, "--json");
  const kind = (flag(argv, "--kind") || "notify") as collab.Kind;
  const subject = flag(argv, "--subject") || "";
  const requiresReply = has(argv, "--requires-reply") ? true : undefined;
  const deadline = flag(argv, "--deadline");
  const hops = flag(argv, "--hops") ? Number(flag(argv, "--hops")) : undefined;
  const fanoutExecute = flag(argv, "--fanout") === "execute";
  const allowMoved = has(argv, "--allow-moved");
  const refs = collectRefs(argv);
  const toText = String(toRaw);

  try {
    const ctx = route.readRouteContext();
    if (route.snapshotStale(ctx)) {
      try {
        store.appendDrift({
          kind: "route-snapshot-stale",
          subject: toText,
          detail: `snapshot 已 ${Math.round((ctx.snapshotAgeMs || 0) / 60000)} 分钟未刷新（>6h）；仍按旧活性解析`,
        });
      } catch { /* drift 写失败不影响投递 */ }
    }

    const res = route.resolveAddress(toText, ctx);

    // 广播/组播越权：question/handoff 会诱发多会话同时执行 → 必须显式 --fanout execute
    if (res.kind === "fanout" && kind !== "notify" && !fanoutExecute) {
      err(`E_FANOUT: ${toText} 是广播地址，kind=${kind} 需要显式 --fanout execute（防 N 个会话同时改同一处/提双 MR）`);
      return EXIT.USAGE;
    }

    const from = collab.resolveSessionId(flag(argv, "--session"));

    if (res.kind === "unresolved") {
      const threadId = flag(argv, "--thread") || newThreadId();
      const cls = classOf(kind, requiresReply ?? kind === "question", hops || 0, deadline);
      const key = flag(argv, "--idempotency-key") || `${threadId}#1`;
      const r = store.enqueueUnresolved({
        addr: toText,
        kind,
        subject,
        body: flag(argv, "--body"),
        bodyFile: flag(argv, "--body-file"),
        refs,
        reason: res.reason,
        from,
        thread_id: threadId,
        seq: 1,
        idempotency_key: key,
        requires_reply: requiresReply,
        deadline,
        class_snapshot: cls.cls,
        class_why: cls.why,
      });
      try {
        store.appendDrift({
          kind: "route-unresolved",
          track: addr.kind === "track" ? addr.body : undefined,
          subject: toText,
          detail: `${res.reason}；已入队 ${r.row.id}${r.reused ? "（复用同幂等键）" : ""}`,
        });
      } catch { /* ignore */ }
      if (asJson) {
        out(JSON.stringify({ queued: r.row.id, addr: toText, reason: res.reason, reused: r.reused, queue: r.row }, null, 1));
      } else {
        out(`queued ${r.row.id} addr=${toText} reason=${res.reason}${r.reused ? " reused" : ""}`);
        if (res.reason === "snapshot-missing") err("hint: 先跑 `dia wb refresh` 生成 derived/snapshot.json（活性证据来源）");
        err(`  ${r.row.id} 已在 ~/.dia/workbench/queue.jsonl 等待：handoff/bind 后重试，或 \`dia msg retry --queue\``);
      }
      return EXIT.UNRESOLVED;
    }

    // 旧会话地址命中 handoff：默认拒绝（防投给已交接的窗口），--allow-moved 放行
    if (addr.kind === "session") {
      const moved = route.handoffTarget(addr.body, ctx.handoffs);
      if (moved && !allowMoved) {
        err(`E_ROUTE_MOVED: ${addr.body} 已交接 → ${moved.to}（track:${moved.track}）`);
        err(`  改用 --to track:${moved.track} 或 --to session:${moved.to}；确认要投旧会话再加 --allow-moved`);
        return EXIT.MOVED;
      }
      if (moved && allowMoved) refs.route_moved = "1";
    }

    const targets = res.kind === "session" ? [res.to] : res.to;
    const sharedThread = flag(argv, "--thread") || (targets.length > 1 ? newThreadId() : undefined);
    const explicitKey = flag(argv, "--idempotency-key");
    const cls = classOf(kind, requiresReply ?? kind === "question", hops || 0, deadline);
    const sent: collab.MessageV2[] = [];
    for (const to of targets) {
      const m = collab.send({
        from,
        to,
        toAddr: toText,
        toResolved: to,
        kind,
        subject,
        body: flag(argv, "--body"),
        bodyFile: flag(argv, "--body-file"),
        refs: Object.keys(refs).length ? refs : undefined,
        requiresReply,
        deadline,
        threadId: sharedThread,
        replyTo: flag(argv, "--reply-to"),
        idempotencyKey: explicitKey ? (targets.length > 1 ? `${explicitKey}#${to}` : explicitKey) : undefined,
        hops,
        classSnapshot: cls.cls,
        classWhy: cls.why,
      });
      if (m.reply_to) { try { collab.markReplied(m.reply_to, m.id); } catch { /* 原消息可能已关闭/迁移 */ } }
      sent.push(m);
    }

    const touchPaths = (refs.touches || "").split(",").map((x) => x.trim()).filter(Boolean);
    const overlaps = touchPaths.length
      ? claims.list({}).filter((c) => touchPaths.includes(c.path) && c.holder !== from)
      : [];

    if (asJson) {
      out(JSON.stringify({ addr: toText, why: res.why, messages: sent, ...(overlaps.length ? { claim_overlaps: overlaps } : {}) }, null, 1));
    } else {
      for (const m of sent) {
        const nt = m.notify ? `\tnotified=${m.notify.channel}${m.notify.reason ? `(${m.notify.reason})` : ""}` : "";
        out(`${m.id}\t${m.thread_id}#${m.seq}\t${m.from.session_id} → ${m.to.session_id}\t${m.kind}\t${m.subject}${nt}`);
      }
      out(`addr=${toText} via=${res.why} targets=${targets.length}`);
      for (const c of overlaps) out(`  ⚠ claim overlap: ${c.path} 由 ${c.holder} 持有（${c.reason || "no reason"}）`);
    }
    return EXIT.OK;
  } catch (e: any) {
    err(e?.message || String(e));
    return routeErrorCode(e);
  }
}

/** `dia msg retry --queue [--track T] [--addr A] [--max N] [--fanout execute]` */
export function routeMsgRetry(argv: string[]): number | null {
  if (!has(argv, "--queue")) return null;
  const asJson = has(argv, "--json");
  try {
    const r = route.drainRoutes({
      track: flag(argv, "--track"),
      addr: flag(argv, "--addr"),
      max: flag(argv, "--max") ? Number(flag(argv, "--max")) : undefined,
      allowFanoutExecute: flag(argv, "--fanout") === "execute",
    });
    if (asJson) { out(JSON.stringify(r, null, 1)); return r.failed.length ? 1 : 0; }
    out(`queue drained: sent=${r.sent.length} skipped=${r.skipped.length} failed=${r.failed.length}`);
    for (const x of r.sent) out(`  sent ${x.queue_id} → ${x.msg_id} (${x.to})`);
    for (const x of r.skipped) out(`  skip ${x.queue_id} (${x.reason})`);
    for (const x of r.failed) out(`  fail ${x.queue_id} (${x.error})`);
    return r.failed.length ? 1 : 0;
  } catch (e: any) {
    err(e?.message || String(e));
    return routeErrorCode(e);
  }
}

/** `dia collab group add|remove|list [--json]`（argv 为 `group` 之后的参数） */
export function routeGroupCli(argv: string[]): number {
  const [act, ...args] = argv;
  const asJson = has(args, "--json");
  const name = positional(args)[0];
  const sessionFlag = flag(args, "--session");
  try {
    if (act === "add" || act === "remove") {
      if (!name) { err(`usage: dia collab group ${act} <name> [--session S] [--json]`); return EXIT.USAGE; }
      const sid = collab.resolveSessionId(sessionFlag);
      if (act === "add") {
        const r = route.groupAdd(name, sid);
        out(asJson ? JSON.stringify(r) : `${r.added ? "added" : "already-member"} group=${r.group} session=${r.session}`);
        return EXIT.OK;
      }
      const r = route.groupRemove(name, sid);
      out(asJson ? JSON.stringify(r) : `removed group=${r.group} session=${r.session}`);
      return EXIT.OK;
    }
    if (act === "list") {
      const rows = route.groupList();
      if (asJson) { out(JSON.stringify(rows, null, 1)); return EXIT.OK; }
      if (!rows.length) out("(no groups)");
      for (const g of rows) out(`${g.group}\t${g.members.join(",")}`);
      return EXIT.OK;
    }
    bootUsage();
    return EXIT.USAGE;
  } catch (e: any) {
    err(e?.message || String(e));
    return routeErrorCode(e);
  }
}

function bootUsage() {
  err("usage: dia collab group add|remove <name> [--session S] | dia collab group list [--json]");
}
