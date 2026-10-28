import { describe, expect, it } from "vitest";
import { csvCell, formatCount, formatMs, formatTps, toCsv } from "../src/client/format.js";

/**
 * 格式化层的测试。
 *
 * 重点是「null 不能变成 0」—— 那会把「没测到」静默说成「测到了 0」，
 * 是这类面板最容易犯且最难发现的错。
 */

describe("formatCount", () => {
  it("null / undefined / NaN 一律显示破折号", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(undefined)).toBe("—");
    expect(formatCount(Number.NaN)).toBe("—");
  });

  it("千位缩写", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234)).toBe("1.2k");
    expect(formatCount(1_500_000)).toBe("1.5M");
  });
});

describe("formatMs", () => {
  it("null 不显示成 0ms", () => {
    expect(formatMs(null)).toBe("—");
    expect(formatMs(undefined)).toBe("—");
  });

  it("毫秒与秒", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(456)).toBe("456ms");
    expect(formatMs(1234)).toBe("1.23s");
  });
});

describe("formatTps", () => {
  it("null 显示破折号", () => {
    expect(formatTps(null)).toBe("—");
    expect(formatTps(42.123)).toBe("42.1 tok/s");
  });
});

describe("csvCell", () => {
  it("null 变空字符串，不是 'null'", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("含逗号 / 引号 / 换行的值加引号并转义", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("公式注入被前缀 ' 挡住（error 字段是上游原文，可能以 = 开头）", () => {
    // 注意：这条没有逗号，所以只加前缀、不加引号 —— 两种防护是独立的。
    expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvCell("+1234")).toBe("'+1234");
    expect(csvCell("-1234")).toBe("'-1234");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    // 同时含逗号时，前缀与引号都要有
    expect(csvCell("=1,2")).toBe(`"'=1,2"`);
  });

  it("普通值原样返回", () => {
    expect(csvCell("hy3")).toBe("hy3");
    expect(csvCell(42)).toBe("42");
  });
});

describe("toCsv", () => {
  it("表头 + 行，CRLF 分隔", () => {
    const csv = toCsv(
      [
        { model: "hy3", tokens: 100 },
        { model: "glm", tokens: 200 },
      ],
      [
        { key: "model", label: "模型" },
        { key: "tokens", label: "tokens" },
      ],
    );
    expect(csv.split("\r\n")).toEqual(["模型,tokens", "hy3,100", "glm,200"]);
  });

  it("缺失字段变空单元格", () => {
    const csv = toCsv([{ model: "hy3" }], [
      { key: "model", label: "模型" },
      { key: "tokens", label: "tokens" },
    ]);
    expect(csv.split("\r\n")[1]).toBe("hy3,");
  });
});
