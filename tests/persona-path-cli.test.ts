// dia persona path —— 「生效版本目录」解析（2026-10-30 迁移：dws-hub 服务入口从 yan-ref 切到这里）
// 契约：
//   · 输出**目录绝对路径**（--json 出 {id,version,dir,source,commit}）
//   · 版本缺省 ⇒ active 指针（多版本并存时不许"最新即生效"地猜）
//   · id 缺省 ⇒ persona 作用域（--persona / DIA_PERSONA / 唯一已装）
//   · 未安装 / 版本不存在 ⇒ 非 0 退出（消费方据此大声失败，绝不回退旧 checkout）
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const cwd = join(import.meta.dir, "..");

function cli(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["src/cli.ts", "persona", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/** 装一个假 persona：data/personas/<id>/<ver>/（带 dia.lock，供 active 指针记 commit） */
function fixture(versions: string[] = ["0.1.0"], id = "dabo") {
  const data = mkdtempSync(join(tmpdir(), "dia-path-data-"));
  const home = mkdtempSync(join(tmpdir(), "dia-path-home-"));
  for (const v of versions) {
    const dir = join(data, "personas", id, v);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dia.json"), JSON.stringify({ schema: 1, kind: "persona", id, version: v }));
    writeFileSync(join(dir, "dia.lock"), JSON.stringify({ id, version: v, commit: `c-${v}`, content: {} }));
  }
  return { data, home, id, env: { DIA_DATA_DIR: data, DIA_HOME: home } };
}

describe("dia persona path", () => {
  test("单版本：打印安装目录", () => {
    const f = fixture();
    const r = cli(["path", f.id], f.env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(join(f.data, "personas", f.id, "0.1.0"));
  });

  test("多版本 + active 指针：跟指针走，不跟「最新安装」", () => {
    const f = fixture(["0.1.0", "0.2.0"]);
    mkdirSync(join(f.data, "state"), { recursive: true });
    writeFileSync(
      join(f.data, "state", "active.json"),
      JSON.stringify({ [f.id]: { version: "0.1.0", commit: "c-0.1.0", at: "2026-10-30T00:00:00.000Z", by: "test" } }),
    );
    const r = cli(["path", f.id, "--json"], f.env);
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.version).toBe("0.1.0");
    expect(j.source).toBe("active");
    expect(j.dir).toBe(join(f.data, "personas", f.id, "0.1.0"));
    expect(j.commit).toBe("c-0.1.0");
  });

  test("显式 @版本：绕过指针", () => {
    const f = fixture(["0.1.0", "0.2.0"]);
    const r = cli(["path", `${f.id}@0.2.0`], f.env);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(join(f.data, "personas", f.id, "0.2.0"));
  });

  test("id 缺省：DIA_PERSONA 生效", () => {
    const f = fixture();
    const r = cli(["path"], { ...f.env, DIA_PERSONA: f.id });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(join(f.data, "personas", f.id, "0.1.0"));
  });

  test("未安装的版本 → 非 0（绝不静默回退）", () => {
    const f = fixture();
    const r = cli(["path", `${f.id}@9.9.9`], f.env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("E_VERSION");
  });

  test("未安装的 persona → 非 0", () => {
    const f = fixture();
    const r = cli(["path", "nope"], f.env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/E_SCOPE|E_NOT_INSTALLED/);
  });
});
