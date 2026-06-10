/**
 * transferScan.ts — normalizeTransfer unit tests.
 *
 * Uses pure in-memory logic — no network calls.
 *
 * The `blockNumber` parameter is caller-supplied (from gettransactioninfobyid).
 * Tests pass a realistic mainnet-scale block number or null for unconfirmed.
 */

import { describe, it, expect } from "vitest";
import { normalizeTransfer, type TronTrc20Transfer } from "../transferScan.js";
import {
  TRON_USDT_CONTRACT_BASE58,
} from "../usdt.js";

// Mainnet-scale block numbers (M-1 fix: must not use tiny values)
const MAINNET_BLOCK = 82_999_990n; // a confirmed tx just below solid=83_000_000

// Known test addresses
const DEPOSIT_ADDR_BASE58 = "TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy";
const FROM_ADDR = "THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC";
const FAKE_CONTRACT = "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH";

function makeRawTransfer(overrides: Partial<TronTrc20Transfer> = {}): TronTrc20Transfer {
  return {
    transaction_id: "tx001",
    block_timestamp: 1_000_000,
    block_hash: "bh001",
    from: FROM_ADDR,
    to: DEPOSIT_ADDR_BASE58,
    value: "100000000", // 100 USDT
    token_info: {
      symbol: "USDT",
      address: TRON_USDT_CONTRACT_BASE58,
      decimals: 6,
      name: "Tether USD",
      log_index: 0,
    },
    ...overrides,
  };
}

describe("normalizeTransfer", () => {
  it("returns normalized transfer for valid input", () => {
    const raw = makeRawTransfer();
    const result = normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, MAINNET_BLOCK);
    expect(result).not.toBeNull();
    expect(result!.txHash).toBe("tx001");
    expect(result!.toAddress).toBe(DEPOSIT_ADDR_BASE58);
    expect(result!.fromAddress).toBe(FROM_ADDR);
    expect(result!.amountMicro).toBe(100_000_000n);
    expect(result!.amountUsdt).toBe("100.000000");
    expect(result!.contractAddress).toBe(TRON_USDT_CONTRACT_BASE58);
  });

  it("uses the supplied blockNumber directly (mainnet-scale)", () => {
    const raw = makeRawTransfer();
    const result = normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, 82_999_990n);
    expect(result).not.toBeNull();
    // blockNumber must equal exactly what was passed — NOT timestamp-derived
    expect(result!.blockNumber).toBe(82_999_990n);
  });

  it("uses MAX_SAFE_INTEGER blockNumber when null (unconfirmed)", () => {
    const raw = makeRawTransfer({ block_hash: "" });
    const result = normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, null);
    expect(result).not.toBeNull();
    // null blockNumber → MAX_SAFE_INTEGER so blockNumber > any real solidBlock
    expect(result!.blockNumber).toBe(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it("confirmed tx at 82_999_990n is <= solid 83_000_000n (would be paid)", () => {
    const raw = makeRawTransfer({ block_hash: "bh-mainnet" });
    const result = normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, 82_999_990n);
    expect(result).not.toBeNull();
    const latestSolidBlock = 83_000_000n;
    // This is the finality gate — must be true for a solid payment
    expect(result!.blockNumber <= latestSolidBlock).toBe(true);
  });

  it("transfer above solid 83_000_000n stays detected (not paid)", () => {
    const raw = makeRawTransfer({ block_hash: "" });
    const result = normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, 83_000_050n);
    expect(result).not.toBeNull();
    const latestSolidBlock = 83_000_000n;
    // blockNumber > solid → should NOT be confirmed/paid
    expect(result!.blockNumber <= latestSolidBlock).toBe(false);
  });

  it("returns null for zero-value transfer", () => {
    const raw = makeRawTransfer({ value: "0" });
    expect(normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, MAINNET_BLOCK)).toBeNull();
  });

  it("returns null for dust transfer (below threshold)", () => {
    const raw = makeRawTransfer({ value: "5" });
    // dustThreshold = 5n → reject <= 5
    expect(normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, MAINNET_BLOCK, 5n)).toBeNull();
  });

  it("accepts transfer above dust threshold", () => {
    const raw = makeRawTransfer({ value: "6" });
    const result = normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, MAINNET_BLOCK, 5n);
    expect(result).not.toBeNull();
    expect(result!.amountMicro).toBe(6n);
  });

  it("returns null for fake-contract (not pinned USDT)", () => {
    const raw = makeRawTransfer({
      token_info: {
        symbol: "FAKE",
        address: FAKE_CONTRACT,
        decimals: 6,
        name: "Fake USDT",
        log_index: 0,
      },
    });
    expect(normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, MAINNET_BLOCK)).toBeNull();
  });

  it("returns null when recipient does not match deposit address", () => {
    const raw = makeRawTransfer({ to: FROM_ADDR }); // wrong destination
    expect(normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, MAINNET_BLOCK)).toBeNull();
  });

  it("matches hex deposit address (normalizes both sides)", () => {
    const depositHex = "4177944d19c052b73ee2286823aa83f8138cb7032f"; // DEPOSIT_ADDR_BASE58
    const raw = makeRawTransfer({ to: DEPOSIT_ADDR_BASE58 });
    const result = normalizeTransfer(raw, depositHex, MAINNET_BLOCK);
    expect(result).not.toBeNull();
    expect(result!.toAddress).toBe(DEPOSIT_ADDR_BASE58);
  });

  it("matches hex transfer recipient against Base58 deposit address", () => {
    // "to" field comes in as hex — should still match Base58 deposit
    const depositHex = "4177944d19c052b73ee2286823aa83f8138cb7032f";
    const raw = makeRawTransfer({ to: "4177944d19c052b73ee2286823aa83f8138cb7032f" });
    const result = normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, MAINNET_BLOCK);
    expect(result).not.toBeNull();
    // Verify hex deposit also works
    const result2 = normalizeTransfer(raw, depositHex, MAINNET_BLOCK);
    expect(result2).not.toBeNull();
  });

  it("sets isConfirmed=true when block_hash is present", () => {
    const raw = makeRawTransfer({ block_hash: "real-hash" });
    const result = normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, MAINNET_BLOCK);
    expect(result?.isConfirmed).toBe(true);
  });

  it("sets isConfirmed=false when block_hash is empty", () => {
    const raw = makeRawTransfer({ block_hash: "" });
    const result = normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, null);
    expect(result?.isConfirmed).toBe(false);
  });

  it("uses log_index from token_info", () => {
    const raw = makeRawTransfer({
      token_info: {
        symbol: "USDT",
        address: TRON_USDT_CONTRACT_BASE58,
        decimals: 6,
        name: "Tether USD",
        log_index: 3,
      },
    });
    const result = normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, MAINNET_BLOCK);
    expect(result?.logIndex).toBe(3);
  });

  it("defaults log_index to 0 if not present", () => {
    const raw = makeRawTransfer({
      token_info: {
        symbol: "USDT",
        address: TRON_USDT_CONTRACT_BASE58,
        decimals: 6,
        name: "Tether USD",
      },
    });
    const result = normalizeTransfer(raw, DEPOSIT_ADDR_BASE58, MAINNET_BLOCK);
    expect(result?.logIndex).toBe(0);
  });
});
