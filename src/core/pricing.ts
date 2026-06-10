/**
 * Fiat → micro-USDT pricing (spec §4, §15/N7).
 *
 * Rules:
 * - USDT ≈ $1 + small de-peg buffer (configurable).
 * - Tolerance band computed entirely in INTEGER micro-USDT using
 *   explicit floor (lower bound) and ceil (upper bound) so boundary
 *   rounding never mis-flags a payment as underpaid.
 * - All exported functions are PURE — no I/O.
 */

import { parseMicro, formatMicro } from "../lib/decimal.js";

/** Tolerance configuration for the ±band around invoice amount. */
export interface ToleranceConfig {
  /** Numerator of the tolerance fraction, e.g. 1 for 1%. Default: 1 */
  numerator: bigint;
  /** Denominator of the tolerance fraction, e.g. 100 for 1%. Default: 100 */
  denominator: bigint;
}

export const DEFAULT_TOLERANCE: ToleranceConfig = {
  numerator: 1n,
  denominator: 100n,
};

/** De-peg buffer configuration (applied on top of nominal 1 USDT = 1 USD). */
export interface RateConfig {
  /**
   * Micro-USDT per 1.000000 fiat unit (i.e. per $1 when currency is USD).
   *
   * Default MVP assumption: 1 USDT = 1 USD exactly → rate = 1_000_000n.
   * A de-peg buffer would be e.g. 1_010_000n (1 USD = 1.01 USDT) so that
   * invoices are set slightly high, protecting the merchant from peg drift.
   */
  microUsdtPerFiatUnit: bigint;
  /**
   * Timestamp when this rate was captured (for rate-lock bookkeeping).
   * Injected by the caller — pricing.ts does not call Date.now().
   */
  lockedAt: Date;
}

export const DEFAULT_RATE: RateConfig = {
  microUsdtPerFiatUnit: 1_000_000n, // 1 USDT per 1 USD (MVP)
  lockedAt: new Date(0), // placeholder; callers MUST pass real timestamp
};

// ── Conversion ────────────────────────────────────────────────────────────────

/**
 * Convert a fiat amount (decimal string) to micro-USDT using the supplied rate.
 *
 * Example:
 *   fiatAmount = "50.00", rate.microUsdtPerFiatUnit = 1_000_000n (1:1)
 *   → parseMicro("50.00") = 50_000_000n  → 50_000_000n * 1_000_000n / 1_000_000n = 50_000_000n
 *
 * If the rate is not 1:1 (de-peg buffer), multiply and divide by USDT_SCALE.
 *
 * @returns micro-USDT as bigint (floor toward zero)
 */
export function fiatToMicroUsdt(fiatAmount: string, rate: RateConfig): bigint {
  const fiatMicro = parseMicro(fiatAmount); // e.g. 50_000_000n for "50.00"
  // microUsdtPerFiatUnit is "how many micro-USDT per 1.000000 of fiat"
  // fiatMicro already has 6 decimal places, so:
  //   result = fiatMicro * microUsdtPerFiatUnit / 1_000_000
  const SCALE = 1_000_000n;
  return (fiatMicro * rate.microUsdtPerFiatUnit) / SCALE;
}

// ── Tolerance band ────────────────────────────────────────────────────────────

export interface ToleranceBand {
  /** Lower inclusive bound: payment sum must be >= lowerBound to avoid "underpaid". */
  lowerBound: bigint; // floor( amount * (1 - tol) )
  /** Upper inclusive bound: payment sum must be <= upperBound to avoid "overpaid". */
  upperBound: bigint; // ceil( amount * (1 + tol) )
  /** Original invoice amount in micro-USDT. */
  amount: bigint;
}

/**
 * Compute the tolerance band for an invoice amount.
 *
 * Uses floor for the lower bound and ceil for the upper bound so that boundary
 * rounding never causes a correctly-paying customer to be mis-flagged:
 *   lowerBound = floor( amount * (1 - num/den) ) = floor( amount * (den - num) / den )
 *   upperBound = ceil(  amount * (1 + num/den) ) = ceil(  amount * (den + num) / den )
 *
 * Integer ceiling: ceil(a/b) = (a + b - 1) / b  (only valid for a,b > 0)
 */
export function computeToleranceBand(
  amountMicro: bigint,
  tolerance: ToleranceConfig = DEFAULT_TOLERANCE,
): ToleranceBand {
  if (amountMicro <= 0n) {
    throw new RangeError(`amountMicro must be positive, got ${amountMicro}`);
  }
  if (tolerance.numerator < 0n || tolerance.denominator <= 0n) {
    throw new RangeError("Tolerance numerator must be >= 0 and denominator > 0");
  }

  const { numerator: num, denominator: den } = tolerance;

  // lowerBound = floor( amount * (den - num) / den )
  const lowerNum = amountMicro * (den - num);
  const lowerBound = lowerNum / den; // bigint division = floor for positives

  // upperBound = ceil( amount * (den + num) / den )
  const upperNum = amountMicro * (den + num);
  const upperBound = (upperNum + den - 1n) / den; // ceiling trick

  return { lowerBound, upperBound, amount: amountMicro };
}

// ── Pricing result ────────────────────────────────────────────────────────────

export interface PricingResult {
  /** Locked USDT amount as decimal string (6 dec), e.g. "100.000000". */
  amountUsdtString: string;
  /** Locked USDT amount in micro-USDT (bigint). */
  amountMicro: bigint;
  /** Tolerance band for this invoice. */
  band: ToleranceBand;
  /** Rate snapshot applied. */
  rate: RateConfig;
}

/**
 * Full pricing computation: fiat → micro-USDT + tolerance band.
 *
 * @param fiatAmount   Decimal string, e.g. "100.00"
 * @param currency     ISO 4217 code (informational — stored for records)
 * @param rate         Rate configuration with lockedAt timestamp
 * @param tolerance    Tolerance config (defaults to ±1%)
 */
export function computePricing(
  fiatAmount: string,
  _currency: string,
  rate: RateConfig,
  tolerance: ToleranceConfig = DEFAULT_TOLERANCE,
): PricingResult {
  const amountMicro = fiatToMicroUsdt(fiatAmount, rate);
  if (amountMicro <= 0n) {
    throw new RangeError(
      `Computed USDT amount must be positive; got ${amountMicro} for fiatAmount="${fiatAmount}"`,
    );
  }
  const band = computeToleranceBand(amountMicro, tolerance);
  return {
    amountUsdtString: formatMicro(amountMicro),
    amountMicro,
    band,
    rate,
  };
}
