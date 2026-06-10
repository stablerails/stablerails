import { describe, it, expect } from "vitest";
import {
  aggregatePayments,
  filterConfirmedSolid,
  sumConfirmedSolid,
} from "../aggregation.js";
import type { PaymentRow } from "../ports.js";
import type { ToleranceBand } from "../pricing.js";

// 100 USDT with ±1% tolerance
const BAND_100: ToleranceBand = {
  amount: 100_000_000n,
  lowerBound: 99_000_000n,
  upperBound: 101_000_000n,
};

const SOLID_BLOCK = 1000n;

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

describe("filterConfirmedSolid", () => {
  it("includes confirmed payments at or below solid block", () => {
    const p = makePayment({ amountUsdt: "100.000000", blockNumber: 1000n });
    const result = filterConfirmedSolid([p], SOLID_BLOCK);
    expect(result).toHaveLength(1);
  });

  it("excludes confirmed payments above solid block (0-conf)", () => {
    const p = makePayment({ amountUsdt: "100.000000", blockNumber: 1001n });
    const result = filterConfirmedSolid([p], SOLID_BLOCK);
    expect(result).toHaveLength(0);
  });

  it("excludes detected (0-conf) payments regardless of block", () => {
    const p = makePayment({
      amountUsdt: "100.000000",
      blockNumber: 900n,
      status: "detected",
      confirmedAt: null,
    });
    const result = filterConfirmedSolid([p], SOLID_BLOCK);
    expect(result).toHaveLength(0);
  });

  it("excludes orphaned payments", () => {
    const p = makePayment({ amountUsdt: "100.000000", status: "orphaned" });
    const result = filterConfirmedSolid([p], SOLID_BLOCK);
    expect(result).toHaveLength(0);
  });
});

describe("sumConfirmedSolid", () => {
  it("sums multiple solid payments", () => {
    const payments = [
      makePayment({ amountUsdt: "60.000000", blockNumber: 900n }),
      makePayment({ amountUsdt: "40.000000", blockNumber: 950n }),
    ];
    expect(sumConfirmedSolid(payments, SOLID_BLOCK)).toBe(100_000_000n);
  });

  it("returns 0 with empty array", () => {
    expect(sumConfirmedSolid([], SOLID_BLOCK)).toBe(0n);
  });
});

describe("aggregatePayments", () => {
  it("exact payment = 'paid'", () => {
    const p = makePayment({ amountUsdt: "100.000000" });
    const result = aggregatePayments([p], SOLID_BLOCK, BAND_100);
    expect(result.decision).toBe("paid");
    expect(result.totalMicro).toBe(100_000_000n);
    expect(result.hasAnyConfirmedSolid).toBe(true);
  });

  it("payment at lower bound = 'paid'", () => {
    const p = makePayment({ amountUsdt: "99.000000" }); // exactly lowerBound
    const result = aggregatePayments([p], SOLID_BLOCK, BAND_100);
    expect(result.decision).toBe("paid");
  });

  it("payment at upper bound = 'paid' (not overpaid)", () => {
    const p = makePayment({ amountUsdt: "101.000000" }); // exactly upperBound
    const result = aggregatePayments([p], SOLID_BLOCK, BAND_100);
    expect(result.decision).toBe("paid");
  });

  it("payment just above upper bound = 'overpaid'", () => {
    const p = makePayment({ amountUsdt: "101.000001" });
    const result = aggregatePayments([p], SOLID_BLOCK, BAND_100);
    expect(result.decision).toBe("overpaid");
  });

  it("payment just below lower bound = 'underpaid'", () => {
    const p = makePayment({ amountUsdt: "98.999999" });
    const result = aggregatePayments([p], SOLID_BLOCK, BAND_100);
    expect(result.decision).toBe("underpaid");
  });

  it("no solid payments = 'insufficient'", () => {
    const result = aggregatePayments([], SOLID_BLOCK, BAND_100);
    expect(result.decision).toBe("insufficient");
    expect(result.hasAnyConfirmedSolid).toBe(false);
  });

  it("double payment (two partial → total = paid)", () => {
    const p1 = makePayment({ amountUsdt: "60.000000", blockNumber: 900n });
    const p2 = makePayment({ amountUsdt: "40.000000", blockNumber: 950n });
    const result = aggregatePayments([p1, p2], SOLID_BLOCK, BAND_100);
    expect(result.decision).toBe("paid");
    expect(result.totalMicro).toBe(100_000_000n);
  });

  it("first partial not solid, second solid → uses only solid", () => {
    // p1 is above solid block (0-conf, detected)
    const p1 = makePayment({ amountUsdt: "60.000000", blockNumber: 1001n, status: "detected", confirmedAt: null });
    const p2 = makePayment({ amountUsdt: "40.000000", blockNumber: 950n });
    const result = aggregatePayments([p1, p2], SOLID_BLOCK, BAND_100);
    // Only p2 is solid → 40 USDT → underpaid
    expect(result.decision).toBe("underpaid");
    expect(result.totalMicro).toBe(40_000_000n);
  });

  it("totalString is formatted correctly", () => {
    const p = makePayment({ amountUsdt: "100.000000" });
    const result = aggregatePayments([p], SOLID_BLOCK, BAND_100);
    expect(result.totalString).toBe("100.000000");
  });
});
