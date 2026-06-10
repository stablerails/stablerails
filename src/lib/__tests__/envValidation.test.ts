import { describe, it, expect } from "vitest";
import { resolveRateMicro } from "../envValidation.js";
import { FixedRateSource } from "../../server/db/adapters.js";

describe("resolveRateMicro", () => {
  it("returns 1_000_000n (1:1) when env is undefined", () => {
    expect(resolveRateMicro(undefined)).toBe(1_000_000n);
  });

  it("returns 1_000_000n (1:1) when env is empty string", () => {
    expect(resolveRateMicro("")).toBe(1_000_000n);
  });

  it("returns 1_010_000n when USDT_RATE_MICRO=1010000 (1% de-peg)", () => {
    expect(resolveRateMicro("1010000")).toBe(1_010_000n);
  });

  it("wiring: unset env → FixedRateSource converts 100 USD → 100_000_000n micro-USDT (1:1)", () => {
    // resolveRateMicro(undefined) = 1_000_000n → 1:1 rate
    const rateSource = new FixedRateSource(resolveRateMicro(undefined));
    expect(rateSource.toMicroUsdt("100", "USD")).toBe(100_000_000n);
  });

  it("wiring: USDT_RATE_MICRO=1010000 → FixedRateSource converts 100 USD → 101_000_000n micro-USDT", () => {
    // resolveRateMicro("1010000") = 1_010_000n → 1% de-peg buffer
    const rateSource = new FixedRateSource(resolveRateMicro("1010000"));
    expect(rateSource.toMicroUsdt("100", "USD")).toBe(101_000_000n);
  });

  it("throws on non-integer string (decimal)", () => {
    expect(() => resolveRateMicro("1.01")).toThrow();
  });

  it("throws on zero", () => {
    expect(() => resolveRateMicro("0")).toThrow();
  });

  it("throws on negative value", () => {
    expect(() => resolveRateMicro("-1000000")).toThrow();
  });

  it("throws on non-numeric string", () => {
    expect(() => resolveRateMicro("abc")).toThrow();
  });
});
