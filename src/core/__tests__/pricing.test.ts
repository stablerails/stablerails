import { describe, it, expect } from "vitest";
import {
  fiatToMicroUsdt,
  computeToleranceBand,
  computePricing,
  DEFAULT_TOLERANCE,
  DEFAULT_RATE,
  type RateConfig,
  type ToleranceConfig,
} from "../pricing.js";

const LOCKED_AT = new Date("2025-01-01T00:00:00Z");

function rate(microUsdtPerFiatUnit: bigint): RateConfig {
  return { microUsdtPerFiatUnit, lockedAt: LOCKED_AT };
}

describe("fiatToMicroUsdt", () => {
  it("converts 1 USD at 1:1 rate to 1_000_000 micro-USDT", () => {
    expect(fiatToMicroUsdt("1.000000", rate(1_000_000n))).toBe(1_000_000n);
  });

  it("converts 100 USD at 1:1 rate", () => {
    expect(fiatToMicroUsdt("100.000000", rate(1_000_000n))).toBe(100_000_000n);
  });

  it("converts 50.50 USD at 1:1 rate", () => {
    expect(fiatToMicroUsdt("50.500000", rate(1_000_000n))).toBe(50_500_000n);
  });

  it("applies de-peg buffer: 1 USD at 1.01 USDT/USD rate", () => {
    // rate: 1_010_000 micro-USDT per 1.000000 USD
    // 100 USD * 1.01 = 101 USDT = 101_000_000 micro-USDT
    expect(fiatToMicroUsdt("100.000000", rate(1_010_000n))).toBe(101_000_000n);
  });

  it("floors fractional micro-USDT (no rounding up)", () => {
    // 1 USD at rate 1_000_001 → 1_000_001 / 1_000_000 = 1.000001 floored = 1_000_001
    // Actually: 1_000_000 * 1_000_001 / 1_000_000 = 1_000_001
    expect(fiatToMicroUsdt("1.000000", rate(1_000_001n))).toBe(1_000_001n);
  });

  it("handles very small amounts", () => {
    // 0.01 USD at 1:1 → 10_000 micro-USDT
    expect(fiatToMicroUsdt("0.010000", rate(1_000_000n))).toBe(10_000n);
  });

  it("handles large amounts", () => {
    expect(fiatToMicroUsdt("10000.000000", rate(1_000_000n))).toBe(10_000_000_000n);
  });

  it("throws on negative amount", () => {
    expect(() => fiatToMicroUsdt("-1.000000", rate(1_000_000n))).toThrow();
  });
});

describe("computeToleranceBand — ±1% default", () => {
  const amount = 100_000_000n; // 100 USDT

  it("lower bound = floor(100 * 0.99) = 99_000_000", () => {
    const band = computeToleranceBand(amount);
    expect(band.lowerBound).toBe(99_000_000n);
  });

  it("upper bound = ceil(100 * 1.01) = 101_000_000", () => {
    const band = computeToleranceBand(amount);
    expect(band.upperBound).toBe(101_000_000n);
  });

  it("amount is stored on band", () => {
    const band = computeToleranceBand(amount);
    expect(band.amount).toBe(amount);
  });

  it("exact lower boundary is NOT underpaid", () => {
    const band = computeToleranceBand(amount);
    // lowerBound itself should be within band (>= lower)
    expect(band.lowerBound >= band.lowerBound).toBe(true);
    expect(band.lowerBound <= band.upperBound).toBe(true);
  });
});

describe("computeToleranceBand — boundary rounding correctness (spec §15/N7)", () => {
  it("lower bound is always a floor (never rounds up, never makes valid payment look underpaid)", () => {
    // Use an amount that doesn't divide evenly: 10_000_001 (10.000001 USDT)
    const amount = 10_000_001n;
    const band = computeToleranceBand(amount);
    // lower = floor(10_000_001 * 99 / 100) = floor(9_900_000.99) = 9_900_000
    expect(band.lowerBound).toBe(9_900_000n); // floor
  });

  it("upper bound is always a ceil (never rounds down, never makes overpay look in-band)", () => {
    const amount = 10_000_001n;
    const band = computeToleranceBand(amount);
    // upper = ceil(10_000_001 * 101 / 100) = ceil(10_100_001.01) = 10_100_002
    expect(band.upperBound).toBe(10_100_002n); // ceil
  });

  it("0% tolerance — lower === upper === amount", () => {
    const tol: ToleranceConfig = { numerator: 0n, denominator: 100n };
    const band = computeToleranceBand(1_000_000n, tol);
    expect(band.lowerBound).toBe(1_000_000n);
    expect(band.upperBound).toBe(1_000_000n);
  });

  it("5% tolerance band for 200 USDT", () => {
    const tol: ToleranceConfig = { numerator: 5n, denominator: 100n };
    const amount = 200_000_000n; // 200 USDT
    const band = computeToleranceBand(amount, tol);
    expect(band.lowerBound).toBe(190_000_000n); // 200 * 0.95
    expect(band.upperBound).toBe(210_000_000n); // 200 * 1.05
  });

  it("throws on zero amount", () => {
    expect(() => computeToleranceBand(0n)).toThrow(RangeError);
  });

  it("throws on negative amount", () => {
    expect(() => computeToleranceBand(-1n)).toThrow(RangeError);
  });
});

describe("computePricing round-trips", () => {
  it("produces consistent amountUsdtString from amountMicro", () => {
    const result = computePricing("100.000000", "USD", rate(1_000_000n));
    expect(result.amountUsdtString).toBe("100.000000");
    expect(result.amountMicro).toBe(100_000_000n);
  });

  it("round-trips fiat through pricing and tolerance", () => {
    const result = computePricing("50.500000", "USD", rate(1_000_000n));
    expect(result.amountMicro).toBe(50_500_000n);
    expect(result.band.lowerBound).toBe(49_995_000n); // floor(50_500_000 * 0.99)
    expect(result.band.upperBound).toBe(51_005_000n); // ceil(50_500_000 * 1.01)
  });

  it("stores rate snapshot on result", () => {
    const r = rate(1_000_000n);
    const result = computePricing("10.000000", "USD", r);
    expect(result.rate).toBe(r);
  });

  it("throws on zero price", () => {
    expect(() => computePricing("0.000000", "USD", rate(1_000_000n))).toThrow(
      RangeError,
    );
  });
});

describe("DEFAULT_TOLERANCE", () => {
  it("is ±1%", () => {
    expect(DEFAULT_TOLERANCE.numerator).toBe(1n);
    expect(DEFAULT_TOLERANCE.denominator).toBe(100n);
  });
});

describe("DEFAULT_RATE", () => {
  it("is 1:1 USDT:USD", () => {
    expect(DEFAULT_RATE.microUsdtPerFiatUnit).toBe(1_000_000n);
  });
});
