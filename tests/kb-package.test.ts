import { describe, expect, test } from "bun:test";
import { tokensEst } from "@dia/kb";

describe("@dia/kb package export", () => {
  test("resolves via workspace exports", () => {
    expect(tokensEst("abc")).toBeGreaterThan(0);
  });
});
