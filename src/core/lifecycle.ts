/**
 * Invoice lifecycle state machine (spec §5, §15).
 *
 * This is a PURE function module — no I/O.
 * All inputs are injected: invoice row, payment rows, latestSolidBlock.
 *
 * Solid-block injection model:
 *   The watcher (Sprint 5) reads `ChainCursor.lastSolidBlock` from the DB and
 *   passes it as a plain `bigint` parameter. Core never imports chain or DB
 *   code — the solid block is just a number from the outside world.
 *
 * Overpay-vs-late-funds tie-break (spec §15):
 *   A payment contributes to `overpaid` iff it confirms BEFORE `paid` is set
 *   (i.e. while the invoice is still in a non-terminal state). Any NEW confirmed
 *   payment that arrives after `paid` is already set routes to `overdue` (late_funds).
 *   Implementation: `transitionInvoice` is called with ALL payments at the moment
 *   the transition is evaluated. Only payments already present in the DB at the
 *   time of each evaluation participate in the decision. The watcher calls this
 *   function fresh each time a new payment is recorded, so the ordering is
 *   naturally correct: once `paid` is persisted, future calls see the terminal
 *   status and route new payments to `overdue`.
 */

import type { InvoiceRow, PaymentRow } from "./ports.js";
import type { ToleranceBand } from "./pricing.js";
import { aggregatePayments, filterConfirmedSolid } from "./aggregation.js";
import { parseMicro } from "../lib/decimal.js";

// ── Webhook event types ───────────────────────────────────────────────────────

export type WebhookEventType =
  | "invoice.payment_detected"
  | "invoice.paid"
  | "invoice.underpaid"
  | "invoice.overpaid"
  | "invoice.expired"
  | "invoice.canceled"
  | "invoice.late_funds";

// ── Transition result ─────────────────────────────────────────────────────────

export interface TransitionResult {
  /** The new status the invoice should be set to (or current if no change). */
  newStatus: InvoiceRow["status"];
  /** Whether the status actually changed from the invoice's current status. */
  changed: boolean;
  /** The webhook event to emit, if any. */
  webhookEvent: WebhookEventType | null;
  /** Updated amountReceived (decimal string). */
  amountReceived: string;
  /** If the invoice just reached `paid`, the timestamp to record as paidAt. */
  paidAt: Date | null;
  /**
   * The confirmed-solid payments that drove this transition decision.
   * The Sprint-6 webhook delivery layer uses this to enrich the payload.
   * Note: the per-invoice monotonic `version` field is assigned by the webhook layer,
   * not here — core stays pure.
   */
  qualifyingPayments: readonly PaymentRow[];
}

// ── Terminal status set ───────────────────────────────────────────────────────

/**
 * Statuses from which the invoice cannot leave the terminal branch.
 * `overdue` is terminal: once an invoice is overdue (late funds received after
 * a prior terminal state), it stays overdue — further funds emit `invoice.late_funds`
 * and update `amountReceived` but never re-enter the non-terminal machine.
 * Export so payments.ts (isLatePayment) can reference the same set and the two
 * can never drift apart.
 */
export const TERMINAL_STATUSES: ReadonlySet<InvoiceRow["status"]> = new Set([
  "paid",
  "overpaid",
  "underpaid",
  "expired",
  "canceled",
  "overdue",
]);

export function isTerminal(status: InvoiceRow["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ── Core transition function ──────────────────────────────────────────────────

/**
 * Compute the next lifecycle state for an invoice given its current payments
 * and the latest solid block height.
 *
 * Callers (watcher, tests) are responsible for:
 *   1. Loading the invoice + all its payments from the DB.
 *   2. Passing the current `latestSolidBlock` from ChainCursor.
 *   3. Applying the returned `newStatus` / `paidAt` to the DB if `changed`.
 *   4. Enqueuing the returned `webhookEvent` if non-null.
 *
 * @param invoice           Current invoice row from DB.
 * @param payments          ALL payment rows for this invoice (any status).
 * @param latestSolidBlock  Current solid block height (injected, never from chain).
 * @param band              Tolerance band for this invoice's amountUsdt.
 * @param now               Current timestamp (injected Clock value).
 */
export function transitionInvoice(
  invoice: InvoiceRow,
  payments: readonly PaymentRow[],
  latestSolidBlock: bigint,
  band: ToleranceBand,
  now: Date,
): TransitionResult {
  const currentStatus = invoice.status;

  // ── TERMINAL INVOICES: only late_funds can happen ─────────────────────────
  if (isTerminal(currentStatus)) {
    // Check for any NEW confirmed+solid payment (watcher calls us after each upsert)
    // If there's a solid payment AND the invoice is terminal → late_funds / overdue.
    // We detect this by checking if there are confirmed+solid payments whose
    // amountUsdt contributes to an increased amountReceived vs what was last stored.
    const solidPayments = filterConfirmedSolid(payments, latestSolidBlock);
    const agg = aggregatePayments(payments, latestSolidBlock, band);

    // If aggregate total is larger than what the DB currently records,
    // new solid funds arrived → emit late_funds.
    const storedMicro = parseMicro(invoice.amountReceived);
    if (agg.totalMicro > storedMicro) {
      // H1 fix: changed = true whenever the confirmed-solid aggregate INCREASED,
      // even if the status stays "overdue" (repeat late payment). This ensures
      // the updated amountReceived is persisted and a fresh invoice.late_funds
      // webhook fires for every new confirmed late payment.
      return {
        newStatus: "overdue",
        changed: true,
        webhookEvent: "invoice.late_funds",
        amountReceived: agg.totalString,
        paidAt: invoice.paidAt,
        qualifyingPayments: solidPayments,
      };
    }

    // No new funds — no change.
    return {
      newStatus: currentStatus,
      changed: false,
      webhookEvent: null,
      amountReceived: invoice.amountReceived,
      paidAt: invoice.paidAt,
      qualifyingPayments: solidPayments,
    };
  }

  // ── NON-TERMINAL: normal state machine ───────────────────────────────────

  // 1. Check for expiry first (TTL elapsed, nothing confirmed).
  const expired = now >= invoice.expiresAt;

  // 2. Check for any detected (0-conf) payment — UX-only signal.
  const hasDetected = payments.some((p) => p.status === "detected");

  // 3. Aggregate confirmed+solid payments.
  const solidPayments = filterConfirmedSolid(payments, latestSolidBlock);
  const agg = aggregatePayments(payments, latestSolidBlock, band);

  // 4. Decision tree.

  // 4a. Solid payments present → evaluate paid/overpaid/underpaid.
  if (agg.hasAnyConfirmedSolid) {
    if (agg.decision === "paid") {
      return {
        newStatus: "paid",
        changed: currentStatus !== "paid",
        webhookEvent: "invoice.paid",
        amountReceived: agg.totalString,
        paidAt: now,
        qualifyingPayments: solidPayments,
      };
    }
    if (agg.decision === "overpaid") {
      return {
        newStatus: "overpaid",
        changed: currentStatus !== "overpaid",
        webhookEvent: "invoice.overpaid",
        amountReceived: agg.totalString,
        paidAt: now, // overpaid treated as paid + excess
        qualifyingPayments: solidPayments,
      };
    }
    // agg.decision === "underpaid" but window may still be open.
    if (expired) {
      // Window closed with partial payment → underpaid.
      return {
        newStatus: "underpaid",
        changed: currentStatus !== "underpaid",
        webhookEvent: "invoice.underpaid",
        amountReceived: agg.totalString,
        paidAt: null,
        qualifyingPayments: solidPayments,
      };
    }
    // Partial payment, window still open — stay in payment_detected.
    return {
      newStatus: "payment_detected",
      changed: currentStatus !== "payment_detected",
      webhookEvent:
        currentStatus === "payment_detected" ? null : "invoice.payment_detected",
      amountReceived: agg.totalString,
      paidAt: null,
      qualifyingPayments: solidPayments,
    };
  }

  // 4b. No solid payments yet.
  if (expired) {
    // Nothing confirmed and TTL elapsed → expired.
    // Note: amountReceived is reset to "0.000000" intentionally — only solid
    // (confirmed+irreversible) funds count as real; detected-only payments are
    // discarded when the window closes.
    return {
      newStatus: "expired",
      changed: currentStatus !== "expired",
      webhookEvent: "invoice.expired",
      amountReceived: "0.000000",
      paidAt: null,
      qualifyingPayments: [],
    };
  }

  // 4c. 0-conf detected but not solid → payment_detected (UX only).
  if (hasDetected && currentStatus === "pending") {
    return {
      newStatus: "payment_detected",
      changed: true,
      webhookEvent: "invoice.payment_detected",
      amountReceived: agg.totalString,
      paidAt: null,
      qualifyingPayments: [],
    };
  }

  // 4d. Nothing new — no state change.
  return {
    newStatus: currentStatus,
    changed: false,
    webhookEvent: null,
    amountReceived: agg.totalString,
    paidAt: invoice.paidAt,
    qualifyingPayments: [],
  };
}

// ── Cancel transition ─────────────────────────────────────────────────────────

/**
 * Attempt to cancel an invoice.
 * Only allowed while status === "pending".
 *
 * @throws {LifecycleError} if invoice is not in `pending` state.
 */
export class LifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}

export interface CancelResult {
  newStatus: "canceled";
  webhookEvent: "invoice.canceled";
}

export function cancelInvoice(invoice: Pick<InvoiceRow, "status" | "id">): CancelResult {
  if (invoice.status !== "pending") {
    throw new LifecycleError(
      "CANCEL_NOT_PENDING",
      `Invoice ${invoice.id} cannot be canceled from status "${invoice.status}"; only "pending" invoices can be canceled`,
    );
  }
  return {
    newStatus: "canceled",
    webhookEvent: "invoice.canceled",
  };
}

