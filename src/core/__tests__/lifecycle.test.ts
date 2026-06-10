import { describe, it, expect } from "vitest";
import {
  transitionInvoice,
  cancelInvoice,
  isTerminal,
  LifecycleError,
} from "../lifecycle.js";
import type { InvoiceRow, PaymentRow } from "../ports.js";
import { computeToleranceBand } from "../pricing.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const AMOUNT = 100_000_000n; // 100 USDT
const BAND = computeToleranceBand(AMOUNT);
const SOLID_BLOCK = 1000n;

const BASE_NOW = new Date("2025-06-01T12:00:00Z");
const EXPIRES_FUTURE = new Date(BASE_NOW.getTime() + 30 * 60 * 1000); // +30min
const EXPIRES_PAST = new Date(BASE_NOW.getTime() - 1); // already expired

function makeInvoice(
  overrides: Partial<InvoiceRow> = {},
): InvoiceRow {
  return {
    id: "inv_test",
    eventId: "evt_test",
    status: "pending",
    priceFiat: "100.000000",
    fiatCurrency: "USD",
    amountUsdt: "100.000000",
    amountReceived: "0.000000",
    rateLockedAt: new Date("2025-06-01T00:00:00Z"),
    network: "TRON",
    depositAddress: "TAddr_deposit",
    derivationIndex: 0,
    expiresAt: EXPIRES_FUTURE,
    metadata: null,
    createdAt: new Date("2025-06-01T00:00:00Z"),
    paidAt: null,
    ...overrides,
  };
}

function makePayment(
  overrides: Partial<PaymentRow> & { amountUsdt: string },
): PaymentRow {
  return {
    id: "pay_" + Math.random().toString(36).slice(2),
    invoiceId: "inv_test",
    txHash: "0xabc" + Math.random().toString(36).slice(2),
    logIndex: 0,
    network: "TRON",
    fromAddress: "TAddr",
    blockNumber: 900n,
    blockHash: "0xblock",
    status: "confirmed",
    detectedAt: new Date(),
    confirmedAt: new Date(),
    ...overrides,
  };
}

// ── isTerminal ────────────────────────────────────────────────────────────────

describe("isTerminal", () => {
  it("paid is terminal", () => expect(isTerminal("paid")).toBe(true));
  it("overpaid is terminal", () => expect(isTerminal("overpaid")).toBe(true));
  it("underpaid is terminal", () => expect(isTerminal("underpaid")).toBe(true));
  it("expired is terminal", () => expect(isTerminal("expired")).toBe(true));
  it("canceled is terminal", () => expect(isTerminal("canceled")).toBe(true));
  it("pending is NOT terminal", () => expect(isTerminal("pending")).toBe(false));
  it("payment_detected is NOT terminal", () => expect(isTerminal("payment_detected")).toBe(false));
  it("overdue IS terminal (sticky late-funds state)", () => expect(isTerminal("overdue")).toBe(true));
});

// ── cancelInvoice ─────────────────────────────────────────────────────────────

describe("cancelInvoice (pure)", () => {
  it("allows cancel on pending", () => {
    const result = cancelInvoice({ id: "inv1", status: "pending" });
    expect(result.newStatus).toBe("canceled");
    expect(result.webhookEvent).toBe("invoice.canceled");
  });

  it("throws LifecycleError on payment_detected", () => {
    expect(() =>
      cancelInvoice({ id: "inv1", status: "payment_detected" }),
    ).toThrow(LifecycleError);
  });

  it("throws LifecycleError on paid", () => {
    expect(() =>
      cancelInvoice({ id: "inv1", status: "paid" }),
    ).toThrow(LifecycleError);
  });

  it("throws LifecycleError on expired", () => {
    expect(() =>
      cancelInvoice({ id: "inv1", status: "expired" }),
    ).toThrow(LifecycleError);
  });
});

// ── transitionInvoice ─────────────────────────────────────────────────────────

describe("transitionInvoice — expiry", () => {
  it("pending + expired + no payments → expired", () => {
    const invoice = makeInvoice({ expiresAt: EXPIRES_PAST });
    const result = transitionInvoice(invoice, [], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.newStatus).toBe("expired");
    expect(result.changed).toBe(true);
    expect(result.webhookEvent).toBe("invoice.expired");
    expect(result.paidAt).toBeNull();
  });

  it("pending + not expired + no payments → no change", () => {
    const invoice = makeInvoice();
    const result = transitionInvoice(invoice, [], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.changed).toBe(false);
    expect(result.newStatus).toBe("pending");
  });

  it("idempotent: already expired + no change", () => {
    const invoice = makeInvoice({ status: "expired", expiresAt: EXPIRES_PAST });
    const result = transitionInvoice(invoice, [], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.changed).toBe(false);
    expect(result.webhookEvent).toBeNull();
  });
});

describe("transitionInvoice — payment_detected (0-conf)", () => {
  it("pending + 0-conf detected → payment_detected", () => {
    const invoice = makeInvoice();
    const p = makePayment({
      amountUsdt: "100.000000",
      blockNumber: 1001n, // above solid block
      status: "detected",
      confirmedAt: null,
    });
    const result = transitionInvoice(invoice, [p], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.newStatus).toBe("payment_detected");
    expect(result.webhookEvent).toBe("invoice.payment_detected");
  });

  it("already payment_detected + another 0-conf → no duplicate webhook", () => {
    const invoice = makeInvoice({ status: "payment_detected" });
    const p = makePayment({
      amountUsdt: "100.000000",
      blockNumber: 1001n,
      status: "detected",
      confirmedAt: null,
    });
    const result = transitionInvoice(invoice, [p], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.newStatus).toBe("payment_detected");
    expect(result.webhookEvent).toBeNull(); // no duplicate
  });
});

describe("transitionInvoice — paid", () => {
  it("solid exact payment → paid", () => {
    const invoice = makeInvoice();
    const p = makePayment({ amountUsdt: "100.000000", blockNumber: 900n });
    const result = transitionInvoice(invoice, [p], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.newStatus).toBe("paid");
    expect(result.changed).toBe(true);
    expect(result.webhookEvent).toBe("invoice.paid");
    expect(result.paidAt).toEqual(BASE_NOW);
    expect(result.amountReceived).toBe("100.000000");
  });

  it("solid payment at lower bound = paid", () => {
    const invoice = makeInvoice();
    const p = makePayment({ amountUsdt: "99.000000", blockNumber: 900n });
    const result = transitionInvoice(invoice, [p], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.newStatus).toBe("paid");
  });

  it("solid payment at upper bound = paid", () => {
    const invoice = makeInvoice();
    const p = makePayment({ amountUsdt: "101.000000", blockNumber: 900n });
    const result = transitionInvoice(invoice, [p], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.newStatus).toBe("paid");
  });

  it("paid is idempotent (called again = no change)", () => {
    const invoice = makeInvoice({
      status: "paid",
      amountReceived: "100.000000",
      paidAt: BASE_NOW,
    });
    const p = makePayment({ amountUsdt: "100.000000", blockNumber: 900n });
    const result = transitionInvoice(invoice, [p], SOLID_BLOCK, BAND, BASE_NOW);
    // paid is terminal → checks late_funds only; same total → no change
    expect(result.changed).toBe(false);
    expect(result.webhookEvent).toBeNull();
  });
});

describe("transitionInvoice — overpaid", () => {
  it("solid payment just above upper bound → overpaid", () => {
    const invoice = makeInvoice();
    const p = makePayment({ amountUsdt: "101.000001", blockNumber: 900n });
    const result = transitionInvoice(invoice, [p], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.newStatus).toBe("overpaid");
    expect(result.webhookEvent).toBe("invoice.overpaid");
    expect(result.paidAt).toEqual(BASE_NOW); // treated as paid
  });
});

describe("transitionInvoice — underpaid", () => {
  it("partial solid + expired window → underpaid", () => {
    const invoice = makeInvoice({ expiresAt: EXPIRES_PAST });
    const p = makePayment({ amountUsdt: "50.000000", blockNumber: 900n });
    const result = transitionInvoice(invoice, [p], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.newStatus).toBe("underpaid");
    expect(result.webhookEvent).toBe("invoice.underpaid");
    expect(result.paidAt).toBeNull();
  });

  it("partial solid + window still open → stays payment_detected (top-up possible)", () => {
    const invoice = makeInvoice({ status: "payment_detected" });
    const p = makePayment({ amountUsdt: "50.000000", blockNumber: 900n });
    const result = transitionInvoice(invoice, [p], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.newStatus).toBe("payment_detected");
    expect(result.webhookEvent).toBeNull();
  });
});

describe("transitionInvoice — top-up scenario", () => {
  it("first partial payment solid, then second tops up to paid", () => {
    const invoice = makeInvoice({ status: "payment_detected", amountReceived: "50.000000" });
    const p1 = makePayment({ amountUsdt: "50.000000", blockNumber: 900n });
    const p2 = makePayment({ amountUsdt: "50.000000", blockNumber: 950n });
    // Both solid
    const result = transitionInvoice(invoice, [p1, p2], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.newStatus).toBe("paid");
    expect(result.totalMicro ?? result.amountReceived).toBeTruthy();
  });
});

describe("transitionInvoice — late funds / overdue (spec §15 tie-break)", () => {
  it("new solid payment after invoice is paid → late_funds (overdue)", () => {
    // Invoice already paid with 100 USDT
    const invoice = makeInvoice({
      status: "paid",
      amountReceived: "100.000000",
      paidAt: BASE_NOW,
    });
    // Now 3 payments: 100 (original, solid) + 20 (new, solid)
    const p1 = makePayment({ amountUsdt: "100.000000", blockNumber: 900n });
    const p2 = makePayment({ amountUsdt: "20.000000", blockNumber: 990n });
    const result = transitionInvoice(invoice, [p1, p2], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.webhookEvent).toBe("invoice.late_funds");
    expect(result.newStatus).toBe("overdue");
    expect(result.amountReceived).toBe("120.000000");
  });

  it("overpay-vs-late tie-break: payment confirms BEFORE paid is set → overpaid, not late", () => {
    // Invoice is pending (not yet terminal)
    const invoice = makeInvoice({ status: "pending" });
    // Two solid payments summing to overpaid — arrives while still pending
    const p1 = makePayment({ amountUsdt: "80.000000", blockNumber: 900n });
    const p2 = makePayment({ amountUsdt: "25.000000", blockNumber: 910n }); // total 105 > upperBound 101
    const result = transitionInvoice(invoice, [p1, p2], SOLID_BLOCK, BAND, BASE_NOW);
    // invoice is NOT terminal, so these count toward overpaid
    expect(result.newStatus).toBe("overpaid");
    expect(result.webhookEvent).toBe("invoice.overpaid");
  });

  it("new solid payment after invoice is expired → late_funds (overdue)", () => {
    const invoice = makeInvoice({
      status: "expired",
      amountReceived: "0.000000",
      expiresAt: EXPIRES_PAST,
    });
    const p = makePayment({ amountUsdt: "50.000000", blockNumber: 900n });
    const result = transitionInvoice(invoice, [p], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.webhookEvent).toBe("invoice.late_funds");
    expect(result.newStatus).toBe("overdue");
  });

  it("new solid payment after invoice is underpaid → late_funds (overdue)", () => {
    const invoice = makeInvoice({
      status: "underpaid",
      amountReceived: "50.000000",
      expiresAt: EXPIRES_PAST,
    });
    // 50 already counted; now another 60 arrives solid
    const p1 = makePayment({ amountUsdt: "50.000000", blockNumber: 900n });
    const p2 = makePayment({ amountUsdt: "60.000000", blockNumber: 990n });
    const result = transitionInvoice(invoice, [p1, p2], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.webhookEvent).toBe("invoice.late_funds");
    expect(result.newStatus).toBe("overdue");
  });

  it("no new solid funds after terminal status → no change (idempotent)", () => {
    const invoice = makeInvoice({
      status: "paid",
      amountReceived: "100.000000",
      paidAt: BASE_NOW,
    });
    // Same payment that made it paid — already recorded in amountReceived
    const p = makePayment({ amountUsdt: "100.000000", blockNumber: 900n });
    const result = transitionInvoice(invoice, [p], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.changed).toBe(false);
    expect(result.webhookEvent).toBeNull();
  });
});

describe("transitionInvoice — re-evaluation of already-overdue invoice (regression)", () => {
  // These are the root-cause gap tests: prior suite only checked the FIRST transition
  // INTO overdue; these verify that re-evaluating an overdue invoice behaves correctly.

  it("(a) additional confirmed-solid funds on overdue → emits late_funds, stays overdue, amountReceived increases", () => {
    // Invoice is already overdue with 120 USDT received (100 original + 20 late)
    const invoice = makeInvoice({
      status: "overdue",
      amountReceived: "120.000000",
      paidAt: BASE_NOW,
    });
    // Watcher re-evaluates with the original 100, previous late 20, and a NEW 30
    const p1 = makePayment({ amountUsdt: "100.000000", blockNumber: 900n });
    const p2 = makePayment({ amountUsdt: "20.000000", blockNumber: 990n });
    const p3 = makePayment({ amountUsdt: "30.000000", blockNumber: 995n });
    const result = transitionInvoice(invoice, [p1, p2, p3], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.webhookEvent).toBe("invoice.late_funds");
    expect(result.newStatus).toBe("overdue");
    // H1 fix: changed = true even when status stays "overdue", because aggregate increased.
    // This ensures amountReceived is persisted and a new invoice.late_funds webhook fires.
    expect(result.changed).toBe(true);
    expect(result.amountReceived).toBe("150.000000");
  });

  it("(b) no new solid funds on overdue → changed:false, no webhook (no phantom event)", () => {
    // Invoice already overdue with 120 USDT; watcher polls again with same payments
    const invoice = makeInvoice({
      status: "overdue",
      amountReceived: "120.000000",
      paidAt: BASE_NOW,
    });
    const p1 = makePayment({ amountUsdt: "100.000000", blockNumber: 900n });
    const p2 = makePayment({ amountUsdt: "20.000000", blockNumber: 990n });
    const result = transitionInvoice(invoice, [p1, p2], SOLID_BLOCK, BAND, BASE_NOW);
    // 100 + 20 = 120 === stored 120 → no new funds
    expect(result.changed).toBe(false);
    expect(result.webhookEvent).toBeNull();
    expect(result.newStatus).toBe("overdue");
  });

  it("(c) additional late funds never regress to overpaid/underpaid/expired", () => {
    const invoice = makeInvoice({
      status: "overdue",
      amountReceived: "50.000000",
      paidAt: null,
    });
    // Add a big new payment that would have been "overpaid" if invoice were still live
    const p1 = makePayment({ amountUsdt: "50.000000", blockNumber: 900n });
    const p2 = makePayment({ amountUsdt: "200.000000", blockNumber: 995n });
    const result = transitionInvoice(invoice, [p1, p2], SOLID_BLOCK, BAND, BASE_NOW);
    // Must stay overdue (late_funds), never flip to overpaid/underpaid/expired
    expect(result.newStatus).toBe("overdue");
    expect(result.webhookEvent).toBe("invoice.late_funds");
    expect(result.newStatus).not.toBe("overpaid");
    expect(result.newStatus).not.toBe("underpaid");
    expect(result.newStatus).not.toBe("expired");
  });
});

describe("transitionInvoice — double-payment to single invoice", () => {
  it("two separate payments both solid, sum = exact → paid", () => {
    const invoice = makeInvoice();
    const p1 = makePayment({ amountUsdt: "70.000000", blockNumber: 900n });
    const p2 = makePayment({ amountUsdt: "30.000000", blockNumber: 900n, logIndex: 1 });
    const result = transitionInvoice(invoice, [p1, p2], SOLID_BLOCK, BAND, BASE_NOW);
    expect(result.newStatus).toBe("paid");
    expect(result.amountReceived).toBe("100.000000");
  });
});
