#!/usr/bin/env node
// Thin Node adapter for bash. Uses built-in JSON only; no parser/package.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

const [cmd, ...a] = process.argv.slice(2);
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const write = (p, d) => {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n");
  renameSync(tmp, p);
};
const tasks = (d) => d.tasks || {};
const label = (k, v, prefix) => v.label || prefix + k.replace(/^yan-/, "");
const out = (s) => process.stdout.write(s);

switch (cmd) {
  case "labels": { // <reg> <prefix>
    const [reg, prefix] = a;
    if (!existsSync(reg)) break;
    for (const [k, v] of Object.entries(tasks(read(reg)))) out(label(k, v, prefix) + "\n");
    break;
  }
  case "entries": { // <reg> <root> <prefix>
    const [reg, root, prefix] = a;
    if (!existsSync(reg)) break;
    for (const [k, v] of Object.entries(tasks(read(reg)))) {
      const iv = v.interval, cal = v.calendar || "-";
      const sched = iv && iv !== "-" ? iv : (v.weekdays && v.weekdays !== "-" ? `${cal} [${v.weekdays}]` : cal);
      out([k, label(k, v, prefix), v.type || "periodic", sched, v.log || `${root}/tasks/${k}.log`].join("|") + "\n");
    }
    break;
  }
  case "state-last": { // <file> [--raw]
    // 取最后一条可解析行；无 kind 的历史行视为 run（dia job status 的主口径）。
    // 按 kind 筛选由 state-kind 提供，本命令签名保持不变（向后兼容）。
    try {
      const d = JSON.parse(readFileSync(a[0], "utf8").trim().split("\n").pop());
      if (a.includes("--raw")) { out(JSON.stringify(d) + "\n"); break; }
      const t = new Date((d.ts || 0) * 1000);
      const z = (n) => String(n).padStart(2, "0");
      out(`      上次运行: ${z(t.getMonth() + 1)}-${z(t.getDate())} ${z(t.getHours())}:${z(t.getMinutes())}:${z(t.getSeconds())} · exit=${d.exit}\n`);
    } catch { break; }
    break;
  }
  case "state-kind": { // <file> <kind> -> 最后一条匹配行（JSON；找不到则空输出、exit 0）
    // service healthcheck 台账读取：state.jsonl 追加的 {"kind":"health",...} 行。
    // 无 kind 的历史行视为 "run"。无匹配时输出空，调用方据此区分 n/a 与 unknown。
    const [file, kind] = a;
    let lines = [];
    try { lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()); } catch { break; }
    for (let i = lines.length - 1; i >= 0; i--) {
      let d; try { d = JSON.parse(lines[i]); } catch { continue; }
      if ((d.kind || "run") === kind) { out(JSON.stringify(d) + "\n"); break; }
    }
    break;
  }
  case "log": { // <reg> <name> <default>
    const [reg, name, def] = a;
    const t = existsSync(reg) ? tasks(read(reg))[name] : null;
    out((t && t.log) || def);
    break;
  }
  case "field": { // <reg> <name> <key>
    const [reg, name, key] = a;
    const t = existsSync(reg) ? tasks(read(reg))[name] : null;
    out(t && t[key] != null ? String(t[key]) : "");
    break;
  }
  case "get": { // <reg> <name>
    const [reg, name] = a;
    const t = existsSync(reg) ? tasks(read(reg))[name] : null;
    out(JSON.stringify(t || {}));
    break;
  }
  case "set": { // <reg> <name> <json>
    const [reg, name, payload] = a;
    const d = existsSync(reg) ? read(reg) : { tasks: {} };
    d.tasks = tasks(d); d.tasks[name] = JSON.parse(payload); write(reg, d);
    break;
  }
  case "del": { // <reg> <name>
    const [reg, name] = a;
    if (!existsSync(reg)) break;
    const d = read(reg); delete tasks(d)[name]; write(reg, d);
    break;
  }
  case "rows": { // <reg> -> name \t cmd
    if (!existsSync(a[0])) break;
    for (const [k, v] of Object.entries(tasks(read(a[0])))) out(`${k}\t${v.cmd || ""}\n`);
    break;
  }
  case "fields": { // <reg> <name> -> cmd \t interval \t calendar \t weekdays \t type
    if (!existsSync(a[0])) break;
    const t = tasks(read(a[0]))[a[1]] || {};
    out([t.cmd || "", t.interval || "-", t.calendar || "-", t.weekdays || "-", t.type || "periodic"].join("\t"));
    break;
  }
  case "selfcheck-rows": { // <reg> <prefix>
    const [reg, prefix] = a;
    if (!existsSync(reg)) break;
    for (const [k, v] of Object.entries(tasks(read(reg)))) out(`${k}\t${label(k, v, prefix)}\t${v.adopted ? 1 : 0}\n`);
    break;
  }
  case "backfill": { // <reg> <dry> <force> <tsv>
    const [reg, dry, force, tsv] = a;
    const d = read(reg), ts = tasks(d);
    let add = 0, skip = 0, eph = 0;
    for (const line of readFileSync(tsv, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const [name, cls, layer] = line.split("\t");
      const t = ts[name]; if (!t) continue;
      if (cls === "ephemeral") { out(`  ⚠️ ${name}: 存量路径被判定为 ephemeral（worktree）—— 不自动改，请人工核对后重装\n`); eph++; }
      if ("path_class" in t && force !== "1") { skip++; continue; }
      t.path_class = cls; if (layer) t.layer = layer;
      out(`  ✚ ${name}: path_class=${cls}${layer ? ` layer=${layer}` : ""}\n`); add++;
    }
    if (add && dry !== "1") write(reg, d);
    out(`── 补判 ${add} 条 · 已有值跳过 ${skip} 条 · ephemeral 待人工 ${eph} 条${dry === "1" ? "（dry-run 未写入）" : ""} ──\n`);
    break;
  }
  case "own-json": out(JSON.stringify({ ownTasks: a }) + "\n"); break;
  case "expected": { // <manifest> <reg> <platform>
    const [manifest, reg, plat] = a;
    try {
      const exp = (read(manifest).tasks || []); const have = new Set(Object.keys(tasks(read(reg))));
      const miss = exp.filter((t) => (t.platforms || [plat]).includes(plat) && !have.has(t.name)).map((t) => t.name);
      out(miss.join(" "));
    } catch { break; }
    break;
  }
  case "bootstrap-rows": { // <reg>
    if (!existsSync(a[0])) break;
    for (const [n, t] of Object.entries(tasks(read(a[0])))) out([n, t.cmd || "", t.interval || "-", t.calendar || "-", t.desc || "", t.weekdays || "-", t.type || "periodic", t.path_class || ""].join("\t") + "\n");
    break;
  }
  case "json": { // <key=value...> -> JSON object (true/false become booleans)
    const d = {};
    for (const kv of a) {
      const i = kv.indexOf("="); const v = kv.slice(i + 1);
      d[kv.slice(0, i)] = v === "true" ? true : v === "false" ? false : v;
    }
    out(JSON.stringify(d)); break;
  }
  default: process.stderr.write(`json.mjs: unknown command ${cmd}\n`); process.exit(2);
}
