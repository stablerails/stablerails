/**
 * rpc.ts — two-RPC agreement tests.
 *
 * Tests the agree() logic without real HTTP calls.
 */

import { describe, it, expect } from "vitest";
import { transfersAgree, type CanonicalTransfer } from "../rpc.js";

function makeTransfer(overrides: Partial<CanonicalTransfer> = {}): CanonicalTransfer {
  return {
    txHash: "tx001",
    logIndex: 0,
    to: "TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy",
    value: "100.000000",
    blockNumber: 100n,
    blockHash: "bh001",
    fromAddress: "THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC",
    ...overrides,
  };
}

describe("transfersAgree", () => {
  it("returns true when all key fields match", () => {
    const a = makeTransfer();
    const b = makeTransfer();
    expect(transfersAgree(a, b)).toBe(true);
  });

  it("returns false when txHash differs", () => {
    const a = makeTransfer({ txHash: "tx001" });
    const b = makeTransfer({ txHash: "tx002" });
    expect(transfersAgree(a, b)).toBe(false);
  });

  it("returns false when logIndex differs", () => {
    const a = makeTransfer({ logIndex: 0 });
    const b = makeTransfer({ logIndex: 1 });
    expect(transfersAgree(a, b)).toBe(false);
  });

  it("returns false when to address differs", () => {
    const a = makeTransfer({ to: "TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy" });
    const b = makeTransfer({ to: "THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC" });
    expect(transfersAgree(a, b)).toBe(false);
  });

  it("returns false when value differs", () => {
    const a = makeTransfer({ value: "100.000000" });
    const b = makeTransfer({ value: "50.000000" });
    expect(transfersAgree(a, b)).toBe(false);
  });

  it("blockNumber does not affect transfersAgree (content-only predicate)", () => {
    // transfersAgree checks content fields only: txHash, logIndex, to, value.
    // Block number agreement for finality is enforced separately in the watcher:
    // processInvoice independently fetches block numbers from BOTH providers via
    // gettransactioninfobyid and uses max(primaryBN, secondaryBN) as the effective
    // block number for the latestSolidBlock gate (WATCH-1 fix).
    const a = makeTransfer({ blockNumber: 100n });
    const b = makeTransfer({ blockNumber: 200n }); // different block
    expect(transfersAgree(a, b)).toBe(true);
  });

  it("agrees even when blockHash differs (reorg scenario — not part of key)", () => {
    const a = makeTransfer({ blockHash: "hash-a" });
    const b = makeTransfer({ blockHash: "hash-b" });
    expect(transfersAgree(a, b)).toBe(true);
  });

  it("agrees even when fromAddress differs (not part of key)", () => {
    const a = makeTransfer({ fromAddress: "addr-a" });
    const b = makeTransfer({ fromAddress: "addr-b" });
    expect(transfersAgree(a, b)).toBe(true);
  });
});
