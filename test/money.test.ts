import { describe, expect, test } from "bun:test";
import { add, subtract, multiply, moneyJson, normalizeMoney, minorUnits, idrEquivalent } from "../src/money";

describe("exact major-unit money", () => {
  test("preserves legacy IDR, including the full bigint range", () => {
    expect(normalizeMoney(1250000, "IDR")).toBe("1250000");
    expect(moneyJson("1250000")).toBe(1250000);
    expect(moneyJson("9223372036854775807")).toBe("9223372036854775807");
  });
  test("respects currency minor units, including zero, three and four digits", () => {
    expect(normalizeMoney("12.50", "SGD")).toBe("12.5");
    expect(normalizeMoney("0.001", "KWD")).toBe("0.001");
    expect(minorUnits("CLF")).toBe(4);
    for (const [value, code] of [["1.01", "JPY"], ["0.01", "IDR"], ["1.001", "SGD"], ["1e3", "USD"], ["1,25", "SGD"], ["NaN", "USD"]]) {
      expect(() => normalizeMoney(value, code)).toThrow();
    }
    expect(() => normalizeMoney(Number.MAX_SAFE_INTEGER + 1, "IDR")).toThrow();
    expect(() => normalizeMoney("1", "XYZ")).toThrow();
  });
  test("adds, subtracts and multiplies without binary rounding", () => {
    expect(add("0.1", "0.2")).toBe("0.3");
    expect(subtract("1", "0.9")).toBe("0.1");
    expect(multiply("8.5", "2")).toBe("17");
    expect(moneyJson(multiply("0.1", "3"))).toBe("0.3");
    expect(idrEquivalent("48.9", "12742.125")).toBe(623090);
    expect(idrEquivalent("10", null)).toBeNull();
  });
});
