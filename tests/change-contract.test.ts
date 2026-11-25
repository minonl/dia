import { describe, expect, test } from "bun:test";

import { checkContract, countContractRows, extractSection } from "../kits/change-contract/bin/cc-check.mjs";

const contractTable = `
| 字段 | 改动前 | 改动后 | 判定 | 依据 |
| --- | --- | --- | --- | --- |
| 取数方式 | 全量 | 分页 | 需求内 | 性能 |
| 触发方式 | 滚动 | 滚动 | 不变 | — |
| 顺序 | 无 | 热度 | 需求内 | 需求 |
| 加载态 | 一次 | 两段 | 不变 | — |
| 结束态 | 无 | 无 | 不变 | — |
| 计数 | 共 N | 已加载 N | 需求内 | 无 total |
| 空态 | 有 | 有 | 不变 | — |
| 搜索 | 全量 | 全量 | 不变 | — |
`;

describe("cc-check", () => {
  test("B 级：声明交互不变即通过", () => {
    const md = `## 变更影响面\n\n分级：B\n交互契约：不变\n${contractTable}`;
    const r = checkContract(md);
    expect(r.ok).toBe(true);
    expect(r.level).toBe("B");
    expect(r.rows).toBe(8);
  });

  test("B 级但未声明交互不变 → 不通过", () => {
    const r = checkContract(`## 变更影响面\n\n分级：B\n`);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("交互契约：不变");
  });

  test("A 级缺确认人/依据 → 不通过", () => {
    const r = checkContract(`## 变更影响面\n\n分级：A\n触发方式：滚动→按钮\n`);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("确认人");
    expect(r.errors.join()).toContain("依据");
  });

  test("A 级齐全 → 通过，但字段不足给 warning", () => {
    const r = checkContract(
      `## 变更影响面\n\n分级：A\n确认人：杨汉卿\n依据：https://example/issue/1\n`,
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test("缺少整段 → 不通过", () => {
    const r = checkContract(`# 标题\n\n随便写点\n`);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("变更影响面");
  });

  test("段边界：遇到同级标题即结束", () => {
    const md = `## 变更影响面\n分级：B\n\n## 其他\n分级：A\n`;
    const sec = extractSection(md);
    expect(sec?.body).toContain("分级：B");
    expect(sec?.body).not.toContain("其他");
  });

  test("countContractRows 去掉表头与分隔行", () => {
    expect(countContractRows(contractTable)).toBe(8);
    expect(countContractRows("没有表")).toBe(0);
  });

  test("待确认残留 → warning", () => {
    const r = checkContract(`## 变更影响面\n分级：B\n交互契约：不变\n待确认：PD\n`);
    expect(r.ok).toBe(true);
    expect(r.warnings.join()).toContain("待确认");
  });
});

describe("cc-check 占位符", () => {
  test("模板占位符未填 → 不通过", () => {
    const r = checkContract(
      "## 变更影响面\n\n分级：<请填 A/B/C>\n交互契约：<B/C 级写「不变」>\n确认人：<A 级必填>\n依据：<A 级必填>\n",
    );
    expect(r.ok).toBe(false);
  });

  test("B 级把占位符留在交互契约 → 不通过", () => {
    const r = checkContract("## 变更影响面\n\n分级：B\n交互契约：<B/C 级写「不变」>\n");
    expect(r.ok).toBe(false);
  });

  test("A 级确认人仍是占位符 → 不通过", () => {
    const r = checkContract("## 变更影响面\n\n分级：A\n确认人：<A 级必填>\n依据：https://x\n");
    expect(r.ok).toBe(false);
  });

  test("A 级可带说明文字", () => {
    const r = checkContract("## 变更影响面\n\n分级：A（交互级）\n确认人：杨汉卿（群聊）\n依据：需求原文\n");
    expect(r.ok).toBe(true);
  });
});
