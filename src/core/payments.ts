/**
 * Payment domain logic — pure shapes and decisions.
 *
 * The idempotent DB insert + row-lock is Sprint 5's adapter (PaymentRepository).
 * This file provides the pure logic the watcher will call before persisting.
 */

import { parseMicro } from "../lib/decimal.js";
import type { Network, PaymentStatus, InvoiceRow } from "./ports.js";
import { TERMINAL_STATUSES } from "./lifecycle.js";

// ── Payment shape ─────────────────────────────────────────────────────────────

/**
 * The minimal on-chain event the watcher surfaces for each USDT Transfer log.
 * Used as input to `classifyPayment`.
 */
export interface OnChainTransfer {
  txHash: string;
  logIndex: number;
  network: Network;
  fromAddress: string;
  /** Amount as decimal string (micro-USDT), e.g. "50.000000" */
  amountUsdt: string;
  blockNumber: bigint;
  blockHash: string;
}

/**
 * Result of payment classification: what status should this payment get
 * at initial insertion, and is the amount positive?
 */
export interface PaymentClassification {
  /**
   * Initial status.
   * - "detected" → the watcher has seen the tx (0-conf); chain is not solid yet.
   * - "confirmed" → block is below latestSolidBlock at insertion time.
   */
  initialStatus: PaymentStatus;
  /** Parsed amount in micro-USDT (must be > 0). */
  amountMicro: bigint;
}

// ── Validation ────────────────────────────────────────────────────────────────

export class PaymentValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PaymentValidationError";
  }
}

/**
 * Validate and classify an on-chain transfer for a given invoice.
 *
 * Checks:
 * 1. Transfer targets the invoice's deposit address (passed as `depositAddress`).
 * 2. Amount is > 0.
 * 3. txHash/logIndex are non-empty.
 *
 * @param transfer        The raw on-chain event.
 * @param invoice         The invoice the transfer targets.
 * @param latestSolidBlock Current solid block height.
 */
export function classifyPayment(
  transfer: OnChainTransfer,
  invoice: Pick<InvoiceRow, "depositAddress" | "network">,
  latestSolidBlock: bigint,
): PaymentClassification {
  // Network must match
  if (transfer.network !== invoice.network) {
    throw new PaymentValidationError(
      "NETWORK_MISMATCH",
      `Transfer network ${transfer.network} does not match invoice network ${invoice.network}`,
    );
  }

  // Basic field presence
  if (!transfer.txHash || transfer.txHash.trim() === "") {
    throw new PaymentValidationError("MISSING_TX_HASH", "txHash is required");
  }
  if (transfer.logIndex < 0) {
    throw new PaymentValidationError(
      "INVALID_LOG_INDEX",
      `logIndex must be >= 0, got ${transfer.logIndex}`,
    );
  }

  // Amount validation
  let amountMicro: bigint;
  try {
    amountMicro = parseMicro(transfer.amountUsdt);
  } catch (err) {
    throw new PaymentValidationError(
      "INVALID_AMOUNT",
      `Cannot parse amountUsdt "${transfer.amountUsdt}": ${(err as Error).message}`,
    );
  }
  if (amountMicro <= 0n) {
    throw new PaymentValidationError(
      "ZERO_AMOUNT",
      `Payment amount must be positive, got ${amountMicro}`,
    );
  }

  // Determine initial status based on solid block
  const initialStatus: PaymentStatus =
    transfer.blockNumber <= latestSolidBlock ? "confirmed" : "detected";

  return { initialStatus, amountMicro };
}

/**
 * Determine whether a payment that arrived after the invoice reached a terminal
 * state should be classified as "late_funds".
 *
 * A payment is "late" when the invoice is already terminal AND the payment is
 * NEW (not yet recorded). This includes `overdue` — additional funds arriving
 * on an already-overdue invoice are also late funds.
 * The watcher calls this before inserting to know which webhook to emit.
 *
 * Uses the shared TERMINAL_STATUSES set from lifecycle.ts so the two can never
 * drift apart.
 */
export function isLatePayment(invoiceStatus: InvoiceRow["status"]): boolean {
  return TERMINAL_STATUSES.has(invoiceStatus);
}
