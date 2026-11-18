// service.requiredHosts —— 缺宿主严重度的依据：只有已安装 service 真声明了 host，才算「运行必需」。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let service: any;
let saved: string | undefined;
let root: string;

const manifest = (id: string, host: string) => ({
  schema: 1,
  kind: "service",
  id,
  version: "0.1.0",
  entry: { agent: { host } },
  lifecycle: { type: "service" },
  healthcheck: { kind: "acp" },
});

const installSvc = (dir: string, id: string, host: string) => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "dia.json"), JSON.stringify(manifest(id, host)));
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "dia-svc-host-"));
  saved = process.env.DIA_SERVICE_HOME;
  process.env.DIA_SERVICE_HOME = root;
  service = await import("../src/service.ts");
});

afterEach(() => {
  if (saved === undefined) delete process.env.DIA_SERVICE_HOME;
  else process.env.DIA_SERVICE_HOME = saved;
});

describe("service.requiredHosts", () => {
  test("收集 entry.agent.host → service id", () => {
    installSvc("svc-a", "svc-a", "dsh");
    installSvc("svc-b", "svc-b", "opencode");
    const m = service.requiredHosts();
    expect(m.get("dsh")).toEqual(["svc-a"]);
    expect(m.get("opencode")).toEqual(["svc-b"]);
  });

  test("多个服务同宿主 → 全列出", () => {
    installSvc("svc-a", "svc-a", "dsh");
    installSvc("svc-b", "svc-b", "dsh");
    expect(service.requiredHosts().get("dsh")?.sort()).toEqual(["svc-a", "svc-b"]);
  });

  test("无 services 目录 → 空；坏清单跳过不抛", () => {
    expect(service.requiredHosts()).toEqual(new Map());
    mkdirSync(join(root, "broken"), { recursive: true });
    writeFileSync(join(root, "broken", "dia.json"), "{not json");
    installSvc("svc-ok", "svc-ok", "dsh");
    expect(service.requiredHosts().get("dsh")).toEqual(["svc-ok"]);
    expect(existsSync(join(root, "broken", "dia.json"))).toBe(true);
  });
});
