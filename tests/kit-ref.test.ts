import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as kit from "../src/kit.ts";
import * as persona from "../src/persona.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "dia-kitref-"));
const saved: Record<string, string | undefined> = {};
const KEYS = ["DIA_ROOT", "DIA_DATA_DIR", "DIA_INSTALL_DIR", "DIA_HOME_INSTALL", "DIA_OPENCODE_AGENTS_DIR", "DIA_DSH_PROFILES_DIR"];
function setEnv(env: Record<string, string>) {
  for (const k of KEYS) if (!(k in saved)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function seedInstall(install: string, id: string, versions: string[]) {
  for (const v of versions) {
    const dir = join(install, "kits", id, v);
    mkdirSync(join(dir, "knowledge"), { recursive: true });
    writeFileSync(join(dir, "dia.json"), JSON.stringify({ schema: 1, kind: "kit", id, version: v, tags: [id], knowledge: ["knowledge"] }));
    writeFileSync(join(dir, "knowledge", "a.md"), `---\ntitle: ${id} ${v}\n---\n\n${id}@${v}\n`);
  }
}

function seedPersona(src: string, kits: string[]) {
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "AGENTS.md"), "# p\n");
  writeFileSync(join(src, "dia.json"), JSON.stringify({
    schema: 1, kind: "persona", id: "p", version: "0.1.0", hosts: ["opencode"],
    entry: { opencode: "AGENTS.md" }, kits,
  }));
}

describe("kit semver range", () => {
  test("^ / ~ / >= / 精确", () => {
    expect(kit.satisfies("0.2.0", "^0.2.0")).toBe(true);
    expect(kit.satisfies("0.3.0", "^0.2.0")).toBe(false);
    expect(kit.satisfies("1.4.9", "^1.2.0")).toBe(true);
    expect(kit.satisfies("2.0.0", "^1.2.0")).toBe(false);
    expect(kit.satisfies("0.2.5", "~0.2.0")).toBe(true);
    expect(kit.satisfies("0.3.0", "~0.2.0")).toBe(false);
    expect(kit.satisfies("1.0.0", ">=0.9.0")).toBe(true);
    expect(kit.satisfies("0.2.0", "0.2.0")).toBe(true);
    expect(kit.satisfies("0.2.1", "0.2.0")).toBe(false);
    expect(kit.satisfies("9.9.9", "*")).toBe(true);
  });
});

describe("persona 外部 kit 引用", () => {
  test("kits: [\"git@^0.2\"] 从安装目录解析并安装", () => {
    const data = tmp(), install = tmp(), src = tmp(), agents = tmp();
    seedInstall(install, "git", ["0.1.0", "0.2.0", "0.3.0"]);
    seedPersona(src, ["git@^0.2"]);
    setEnv({ DIA_ROOT: data, DIA_INSTALL_DIR: install, DIA_OPENCODE_AGENTS_DIR: agents });
    const r = persona.install(src);
    const slot = readdirSync(join(data, "personas", "p"))[0];
    const lock = JSON.parse(readFileSync(join(data, "personas", "p", slot, "dia.lock"), "utf8"));
    expect(lock.kits).toEqual([{ id: "git", version: "0.2.0", range: "^0.2" }]);
    expect(existsSync(join(data, "kits", "git", "0.2.0", "dia.json"))).toBe(true);
    expect(r.rendered.length).toBeGreaterThan(0);
  });

  test("无匹配版本报 E_KIT_VERSION", () => {
    const data = tmp(), install = tmp(), src = tmp(), agents = tmp();
    seedInstall(install, "git", ["0.1.0"]);
    seedPersona(src, ["git@^0.2"]);
    setEnv({ DIA_ROOT: data, DIA_INSTALL_DIR: install, DIA_OPENCODE_AGENTS_DIR: agents });
    expect(() => persona.install(src)).toThrow(/E_KIT_VERSION/);
  });
});
