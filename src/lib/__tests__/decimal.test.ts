import { describe, it, expect } from "vitest";
import {
  parseMicro,
  formatMicro,
  addMicro,
  subMicro,
  compareMicro,
  addDecimalStrings,
  compareDecimalStrings,
  USDT_SCALE,
} from "../decimal.js";

describe("decimal.ts — parseMicro", () => {
  it("parses integer string", () => {
    expect(parseMicro("1")).toBe(1_000_000n);
  });

  it("parses decimal string with 6 places", () => {
    expect(parseMicro("1.500000")).toBe(1_500_000n);
  });

  it("parses decimal string with fewer than 6 places (right-pads)", () => {
    expect(parseMicro("1.5")).toBe(1_500_000n);
    expect(parseMicro("0.1")).toBe(100_000n);
  });

  it("truncates beyond 6 decimal places", () => {
    // "1.9999999" → truncated to "1.999999" = 1_999_999n
    expect(parseMicro("1.9999999")).toBe(1_999_999n);
  });

  it("parses zero", () => {
    expect(parseMicro("0")).toBe(0n);
    expect(parseMicro("0.000000")).toBe(0n);
  });

  it("parses large amount", () => {
    expect(parseMicro("1000000")).toBe(1_000_000n * USDT_SCALE);
  });

  it("throws on invalid input", () => {
    expect(() => parseMicro("abc")).toThrow(TypeError);
    expect(() => parseMicro("1.2.3")).toThrow(TypeError);
    expect(() => parseMicro("")).toThrow(TypeError);
  });

  it("throws on negative when not allowed", () => {
    expect(() => parseMicro("-1.0")).toThrow(RangeError);
  });

  it("parses negative when explicitly allowed", () => {
    expect(parseMicro("-1.0", true)).toBe(-1_000_000n);
  });
});

describe("decimal.ts — formatMicro", () => {
  it("formats zero", () => {
    expect(formatMicro(0n)).toBe("0.000000");
  });

  it("formats 1 USDT", () => {
    expect(formatMicro(1_000_000n)).toBe("1.000000");
  });

  it("formats fractional", () => {
    expect(formatMicro(1_500_000n)).toBe("1.500000");
    expect(formatMicro(100_000n)).toBe("0.100000");
    expect(formatMicro(1n)).toBe("0.000001");
  });

  it("formats negative", () => {
    expect(formatMicro(-1_000_000n)).toBe("-1.000000");
  });

  it("round-trips parse→format", () => {
    const cases = ["1.500000", "0.000001", "999999.999999", "0.000000"];
    for (const c of cases) {
      expect(formatMicro(parseMicro(c))).toBe(c);
    }
  });
});

describe("decimal.ts — arithmetic", () => {
  it("adds two amounts", () => {
    expect(addMicro(1_000_000n, 500_000n)).toBe(1_500_000n);
  });

  it("subtracts amounts", () => {
    expect(subMicro(2_000_000n, 500_000n)).toBe(1_500_000n);
  });

  it("subMicro can go negative", () => {
    expect(subMicro(100_000n, 200_000n)).toBe(-100_000n);
  });
});

describe("decimal.ts — compareMicro", () => {
  it("returns -1 when a < b", () => {
    expect(compareMicro(1n, 2n)).toBe(-1);
  });

  it("returns 0 when equal", () => {
    expect(compareMicro(5n, 5n)).toBe(0);
  });

  it("returns 1 when a > b", () => {
    expect(compareMicro(10n, 3n)).toBe(1);
  });
});

describe("decimal.ts — string-level helpers", () => {
  it("addDecimalStrings", () => {
    expect(addDecimalStrings("1.500000", "0.500000")).toBe("2.000000");
  });

  it("compareDecimalStrings", () => {
    expect(compareDecimalStrings("1.0", "2.0")).toBe(-1);
    expect(compareDecimalStrings("2.0", "2.0")).toBe(0);
    expect(compareDecimalStrings("3.0", "2.0")).toBe(1);
  });
});
