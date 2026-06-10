import { describe, it, expect } from "vitest";
import {
  classifyPayment,
  isLatePayment,
  PaymentValidationError,
  type OnChainTransfer,
} from "../payments.js";
import type { InvoiceRow } from "../ports.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SOLID_BLOCK = 1000n;

function makeTransfer(overrides: Partial<OnChainTransfer> = {}): OnChainTransfer {
  return {
    txHash: "0xabc123",
    logIndex: 0,
    network: "TRON",
    fromAddress: "TFrom123",
    amountUsdt: "100.000000",
    blockNumber: 900n,
    blockHash: "0xblock",
    ...overrides,
  };
}

function makeInvoice(overrides: Partial<Pick<InvoiceRow, "depositAddress" | "network" | "status">> = {}) {
  return {
    depositAddress: "TDepositAddr",
    network: "TRON" as const,
    status: "pending" as InvoiceRow["status"],
    ...overrides,
  };
}

// ── classifyPayment ───────────────────────────────────────────────────────────

describe("classifyPayment", () => {
  it("classifies as confirmed when blockNumber <= solidBlock", () => {
    const t = makeTransfer({ blockNumber: 1000n });
    const result = classifyPayment(t, makeInvoice(), SOLID_BLOCK);
    expect(result.initialStatus).toBe("confirmed");
  });

  it("classifies as detected when blockNumber > solidBlock (0-conf)", () => {
    const t = makeTransfer({ blockNumber: 1001n });
    const result = classifyPayment(t, makeInvoice(), SOLID_BLOCK);
    expect(result.initialStatus).toBe("detected");
  });

  it("classifies as confirmed at exactly solidBlock", () => {
    const t = makeTransfer({ blockNumber: 1000n });
    const result = classifyPayment(t, makeInvoice(), SOLID_BLOCK);
    expect(result.initialStatus).toBe("confirmed");
  });

  it("returns amountMicro parsed correctly", () => {
    const t = makeTransfer({ amountUsdt: "50.500000" });
    const result = classifyPayment(t, makeInvoice(), SOLID_BLOCK);
    expect(result.amountMicro).toBe(50_500_000n);
  });

  it("throws NETWORK_MISMATCH when networks differ", () => {
    const t = makeTransfer({ network: "TRON" });
    // Casting to force a mismatch scenario (hypothetical future network)
    const invoice = { depositAddress: "TAddr", network: "TRON" as const };
    // This won't throw — same network. Let's test with a forced mismatch.
    // We have to cast since Network is currently only "TRON":
    const t2 = { ...makeTransfer(), network: "ETH" as "TRON" };
    expect(() => classifyPayment(t2, invoice, SOLID_BLOCK)).toThrow(PaymentValidationError);
  });

  it("throws MISSING_TX_HASH on empty txHash", () => {
    const t = makeTransfer({ txHash: "" });
    expect(() => classifyPayment(t, makeInvoice(), SOLID_BLOCK)).toThrow(
      PaymentValidationError,
    );
  });

  it("throws INVALID_LOG_INDEX on negative logIndex", () => {
    const t = makeTransfer({ logIndex: -1 });
    expect(() => classifyPayment(t, makeInvoice(), SOLID_BLOCK)).toThrow(
      PaymentValidationError,
    );
  });

  it("throws ZERO_AMOUNT on zero amount", () => {
    const t = makeTransfer({ amountUsdt: "0.000000" });
    expect(() => classifyPayment(t, makeInvoice(), SOLID_BLOCK)).toThrow(
      PaymentValidationError,
    );
  });

  it("throws INVALID_AMOUNT on invalid decimal string", () => {
    const t = makeTransfer({ amountUsdt: "not-a-number" });
    expect(() => classifyPayment(t, makeInvoice(), SOLID_BLOCK)).toThrow(
      PaymentValidationError,
    );
  });

  it("logIndex = 0 is valid", () => {
    const t = makeTransfer({ logIndex: 0 });
    const result = classifyPayment(t, makeInvoice(), SOLID_BLOCK);
    expect(result.initialStatus).toBe("confirmed");
  });
});

// ── isLatePayment ─────────────────────────────────────────────────────────────

describe("isLatePayment", () => {
  it("paid is late", () => expect(isLatePayment("paid")).toBe(true));
  it("overpaid is late", () => expect(isLatePayment("overpaid")).toBe(true));
  it("underpaid is late", () => expect(isLatePayment("underpaid")).toBe(true));
  it("expired is late", () => expect(isLatePayment("expired")).toBe(true));
  it("canceled is late", () => expect(isLatePayment("canceled")).toBe(true));
  it("pending is NOT late", () => expect(isLatePayment("pending")).toBe(false));
  it("payment_detected is NOT late", () =>
    expect(isLatePayment("payment_detected")).toBe(false));
  it("overdue IS late (additional funds on an already-overdue invoice are also late)", () =>
    expect(isLatePayment("overdue")).toBe(true));
});
