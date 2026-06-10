/**
 * Payment aggregation — pure functions (spec §15).
 *
 * Computes the total received from confirmed payments and evaluates it
 * against the invoice amount + tolerance band.
 *
 * "confirmed" = PaymentStatus === "confirmed" AND blockNumber <= latestSolidBlock.
 * This module is imported by lifecycle.ts for the paid/underpaid/overpaid decision.
 */

import { parseMicro, formatMicro } from "../lib/decimal.js";
import type { PaymentRow } from "./ports.js";
import type { ToleranceBand } from "./pricing.js";

// ── Aggregation result ────────────────────────────────────────────────────────

export type PayDecision = "paid" | "underpaid" | "overpaid" | "insufficient";

export interface AggregationResult {
  /** Sum of confirmed (solid) payment amounts in micro-USDT. */
  totalMicro: bigint;
  /** Decimal-string representation of totalMicro. */
  totalString: string;
  /** How the total compares to the invoice amount. */
  decision: PayDecision;
  /** Whether at least one confirmed solid payment exists. */
  hasAnyConfirmedSolid: boolean;
}

/**
 * Filter payments to confirmed-and-solid only.
 *
 * @param payments         All payments on the invoice.
 * @param latestSolidBlock The current solid (irreversible) block height.
 */
export function filterConfirmedSolid(
  payments: readonly PaymentRow[],
  latestSolidBlock: bigint,
): PaymentRow[] {
  return payments.filter(
    (p) => p.status === "confirmed" && p.blockNumber <= latestSolidBlock,
  );
}

/**
 * Sum confirmed+solid payment amounts in micro-USDT.
 */
export function sumConfirmedSolid(
  payments: readonly PaymentRow[],
  latestSolidBlock: bigint,
): bigint {
  return filterConfirmedSolid(payments, latestSolidBlock).reduce(
    (acc, p) => acc + parseMicro(p.amountUsdt),
    0n,
  );
}

/**
 * Aggregate confirmed+solid payments and decide paid/underpaid/overpaid.
 *
 * - "paid"        → total ∈ [lowerBound, upperBound]
 * - "overpaid"    → total > upperBound
 * - "underpaid"   → total < lowerBound AND total > 0
 * - "insufficient"→ total === 0 (nothing solid yet)
 */
export function aggregatePayments(
  payments: readonly PaymentRow[],
  latestSolidBlock: bigint,
  band: ToleranceBand,
): AggregationResult {
  const solidPayments = filterConfirmedSolid(payments, latestSolidBlock);
  const totalMicro = solidPayments.reduce(
    (acc, p) => acc + parseMicro(p.amountUsdt),
    0n,
  );

  const hasAnyConfirmedSolid = solidPayments.length > 0;

  let decision: PayDecision;
  if (totalMicro === 0n) {
    decision = "insufficient";
  } else if (totalMicro > band.upperBound) {
    decision = "overpaid";
  } else if (totalMicro >= band.lowerBound) {
    decision = "paid";
  } else {
    // 0 < total < lowerBound
    decision = "underpaid";
  }

  return {
    totalMicro,
    totalString: formatMicro(totalMicro),
    decision,
    hasAnyConfirmedSolid,
  };
}
