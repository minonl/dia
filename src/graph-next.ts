// 统一的「下一步」构造：CLI 与 web payload 共用，避免两套排序/两套 shape
export interface NextInput {
  id: string;
  title: string;
  status: string;
  rank: number | null;
  declared: string | null;
  eff: string;
  inherited: boolean;
  critical: boolean;
  unblocks: number;
  blocked_by: string[];
  ready: boolean;
  startable: boolean;
  rank_reason?: string | null;
}

export interface NextItem {
  id: string;
  title: string;
  status: string;
  rank: number;
  declared: string | null;
  eff: string;
  inherited: boolean;
  critical: boolean;
  unblocks: number;
  blocked_by: string[];
  ready: boolean;
  startable: boolean;
  why: string;
}

export function buildNext(items: NextInput[], n = 5): { policy: "kahn-v1"; n: number; items: NextItem[] } {
  const picked = items
    .filter((t) => (t.status === "doing" || t.startable) && t.rank !== null)
    .sort((a, b) => (a.status === "doing" ? 0 : 1) - (b.status === "doing" ? 0 : 1) || (a.rank! - b.rank!))
    .slice(0, Math.max(0, n));
  return {
    policy: "kahn-v1",
    n: Math.max(0, n),
    items: picked.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      rank: t.rank!,
      declared: t.declared,
      eff: t.eff,
      inherited: t.inherited,
      critical: t.critical,
      unblocks: t.unblocks,
      blocked_by: t.blocked_by,
      ready: t.ready,
      startable: t.startable,
      why: t.rank_reason || `eff=${t.eff}${t.inherited ? "(继承)" : ""}${t.critical ? " · 关键闭包" : ""}${t.unblocks ? ` · 解锁${t.unblocks}` : ""}`,
    })),
  };
}
