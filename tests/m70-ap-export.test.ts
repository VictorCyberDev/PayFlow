import { describe, expect, it } from "vitest";
import { cell, decimal, toCsv, HEADER } from "../src/missions/ap-export.js";

describe("M70 accounting export (export only)", () => {
  it("writes decimals exactly, with no floating point, for every currency exponent", () => {
    expect(decimal(12_345, "USD")).toBe("123.45");
    expect(decimal(5, "USD")).toBe("0.05");
    expect(decimal(0, "GBP")).toBe("0.00");
    expect(decimal(1_900, "JPY")).toBe("1900");
    expect(decimal(4_001, "KWD")).toBe("4.001");
    expect(decimal(Number.MAX_SAFE_INTEGER, "USD")).toBe("90071992547409.91");
    expect(() => decimal(1.5, "USD")).toThrow();
    for (let m = 0; m < 5_000; m += 13)
      expect(Number(decimal(m, "USD").replace(".", ""))).toBe(m);
  });
  it("neutralises spreadsheet formulas and escapes quotes and control characters", () => {
    for (const bad of ["=1+1", "+cmd", "-2", "@SUM(A1)", "\tx", "\rx"])
      expect(cell(bad).startsWith(`"'`)).toBe(true);
    expect(cell('say "hi"')).toBe('"say ""hi"""');
    expect(cell("a\u0000b")).toBe('"a b"');
    expect(cell("plain")).toBe('"plain"');
  });
  it("one header and one line per item, CRLF-separated, hostile labels contained in their own cell", () => {
    const csv = toCsv([
      {
        itemId: "itm_1",
        kind: "PURCHASE",
        label: '=HYPERLINK("http://evil","x"),\n"injected"',
        currency: "GBP",
        amountMinor: 1_000,
        refundedMinor: 0,
        exposureMinor: 1_000,
        stage: "COMMITTED",
        verification: "OWNER_REPORTED",
        createdAt: "2026-11-09T10:00:00.000Z",
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(HEADER.map((h) => `"${h}"`).join(","));
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x""),`);
    expect(toCsv([])).toBe(lines[0] + "\r\n");
  });
});
