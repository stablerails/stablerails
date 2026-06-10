/**
 * SIGN-3 safety tests — live-path mock-txID rejection + sha256 verification.
 *
 * Tests:
 *   1. Live path (TRON_RPC_PRIMARY set): rejects a mock-derived txID before signing.
 *   2. sha256 verification helper rejects a txID that does NOT match sha256(raw_data_hex).
 *   3. sha256 verification helper accepts a txID that MATCHES sha256(raw_data_hex).
 *   4. Dry-run (no TRON_RPC_PRIMARY): signing still works with a mock txID.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  signTransfer,
  buildMockTxId,
  assertNotMockTxIdOnLivePath,
  verifyTxIdMatchesRawData,
} from "../sign.js";
import { buildTransfer } from "../../chain/tron/buildTransfer.js";
import { deriveInvoiceKey, deriveAccountXpub } from "../provision.js";
import { deriveAddress } from "../../chain/tron/deriveAddress.js";
import { executeSweep } from "../sweep.js";
import { encryptSeed } from "../seed.js";
import type { SweepItem, BroadcastFn, BuildSignableTxFn } from "../sweep.js";

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_PASSPHRASE = "test-sweep-passphrase-2025";
const ADDR_0_0 = "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH";
const MAIN_WALLET = "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe";

function makeTransfer() {
  return buildTransfer({ fromAddress: ADDR_0_0, toAddress: MAIN_WALLET, amountMicro: 100_000_000n });
}

describe("SIGN-3: assertNotMockTxIdOnLivePath", () => {
  let savedRpc: string | undefined;

  beforeEach(() => {
    savedRpc = process.env["TRON_RPC_PRIMARY"];
  });
  afterEach(() => {
    if (savedRpc !== undefined) {
      process.env["TRON_RPC_PRIMARY"] = savedRpc;
    } else {
      delete process.env["TRON_RPC_PRIMARY"];
    }
  });

  it("throws on live path when txID was produced by buildMockTxId (empty contract)", () => {
    process.env["TRON_RPC_PRIMARY"] = "https://api.trongrid.io";

    const transfer = makeTransfer();
    const mockTxId = buildMockTxId(transfer, 0);
    const signableTx = {
      txID: mockTxId,
      raw_data_hex: transfer.callData,
      raw_data: { contract: [], fee_limit: 40_000_000 }, // stub/mock raw_data
    };

    expect(() => assertNotMockTxIdOnLivePath(signableTx)).toThrow(
      /refusing to broadcast a mock\/unverified transaction/,
    );
  });

  it("does NOT throw on live path when raw_data.contract is non-empty (real node tx)", () => {
    process.env["TRON_RPC_PRIMARY"] = "https://api.trongrid.io";

    const transfer = makeTransfer();
    // Simulate a real node tx: raw_data.contract has actual contract entries
    const signableTx = {
      txID: "a".repeat(64),
      raw_data_hex: transfer.callData,
      raw_data: {
        contract: [{ type: "TriggerSmartContract", parameter: { value: {} } }],
        fee_limit: 40_000_000,
      },
    };

    expect(() => assertNotMockTxIdOnLivePath(signableTx)).not.toThrow();
  });

  it("does NOT throw in dry-run (no TRON_RPC_PRIMARY) even with mock txID", () => {
    delete process.env["TRON_RPC_PRIMARY"];

    const transfer = makeTransfer();
    const mockTxId = buildMockTxId(transfer, 0);
    const signableTx = {
      txID: mockTxId,
      raw_data_hex: transfer.callData,
      raw_data: { contract: [], fee_limit: 40_000_000 },
    };

    expect(() => assertNotMockTxIdOnLivePath(signableTx)).not.toThrow();
  });
});

describe("SIGN-3: verifyTxIdMatchesRawData", () => {
  it("accepts a txID that matches sha256(raw_data_hex)", () => {
    const rawDataHex = "deadbeef1234";
    const correctTxId = createHash("sha256").update(Buffer.from(rawDataHex, "hex")).digest("hex");

    // Must NOT throw
    expect(() => verifyTxIdMatchesRawData(correctTxId, rawDataHex)).not.toThrow();
  });

  it("throws when txID does NOT match sha256(raw_data_hex)", () => {
    const rawDataHex = "deadbeef1234";
    const wrongTxId = "b".repeat(64); // Not the sha256 of rawDataHex

    expect(() => verifyTxIdMatchesRawData(wrongTxId, rawDataHex)).toThrow(
      /txID does not match sha256/,
    );
  });

  it("throws on an empty raw_data_hex with a non-matching txID", () => {
    const rawDataHex = "";
    const wrongTxId = "a".repeat(64);

    expect(() => verifyTxIdMatchesRawData(wrongTxId, rawDataHex)).toThrow(
      /txID does not match sha256/,
    );
  });

  it("accepts when raw_data_hex is empty and txID is sha256(empty)", () => {
    const rawDataHex = "";
    const emptyHash = createHash("sha256").update(Buffer.alloc(0)).digest("hex");

    expect(() => verifyTxIdMatchesRawData(emptyHash, rawDataHex)).not.toThrow();
  });
});

// ── MUST-FIX 2: e2e — executeSweep on live path refuses mock intent ───────────
// This test verifies the guard is wired AT THE EXECUTOR LEVEL, not just helpers.
// It MUST fail before MUST-FIX 1 (wiring) is applied and pass after.

describe("SIGN-3 e2e: executeSweep on live path refuses mock-derived txID", () => {
  let savedRpc: string | undefined;

  beforeEach(() => {
    savedRpc = process.env["TRON_RPC_PRIMARY"];
    // Set TRON_RPC_PRIMARY to simulate live path.
    process.env["TRON_RPC_PRIMARY"] = "https://api.trongrid.io";
  });
  afterEach(() => {
    if (savedRpc !== undefined) {
      process.env["TRON_RPC_PRIMARY"] = savedRpc;
    } else {
      delete process.env["TRON_RPC_PRIMARY"];
    }
  });

  it("captures 'refusing to broadcast a mock' error per-item; broadcast is never reached", async () => {
    const encryptedSeed = await encryptSeed(TEST_MNEMONIC, TEST_PASSPHRASE);
    const xpub = deriveAccountXpub(TEST_MNEMONIC, 0).xpub;
    const addr0 = deriveAddress(xpub, 0);

    const transfer = buildTransfer({ fromAddress: addr0, toAddress: MAIN_WALLET, amountMicro: 100_000_000n });
    const mockTxId = buildMockTxId(transfer, 0);

    // Mock intent: raw_data.contract is [] — the hallmark of a stub tx.
    const item: SweepItem = {
      address: addr0,
      account: 0,
      index: 0,
      amountMicro: 100_000_000n,
      signableTx: {
        txID: mockTxId,
        raw_data_hex: transfer.callData,
        raw_data: { contract: [], fee_limit: 40_000_000 },
      },
    };

    const broadcastCalled: boolean[] = [];
    const mockBroadcast: BroadcastFn = async (tx) => {
      broadcastCalled.push(true);
      return { txId: tx.txID, success: true };
    };
    const buildSignableTx: BuildSignableTxFn = async (i) => i.signableTx;

    const result = await executeSweep(
      { id: "intent_live_mock", eventId: "ev_1", status: "prepared", items: [item], createdAt: new Date().toISOString() },
      { encryptedSeed, passphrase: TEST_PASSPHRASE, broadcast: mockBroadcast, buildSignableTx },
    );

    // Guard fired: item is failed, broadcast never reached.
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results[0]!.success).toBe(false);
    expect(result.results[0]!.error).toMatch(/refusing to broadcast a mock\/unverified transaction/);
    expect(broadcastCalled).toHaveLength(0);
  });

  it("dry-run (no TRON_RPC_PRIMARY): executeSweep still signs mock txIDs without error", async () => {
    // Override: this test needs dry-run, temporarily clear the RPC set in beforeEach.
    delete process.env["TRON_RPC_PRIMARY"];

    const encryptedSeed = await encryptSeed(TEST_MNEMONIC, TEST_PASSPHRASE);
    const xpub = deriveAccountXpub(TEST_MNEMONIC, 0).xpub;
    const addr0 = deriveAddress(xpub, 0);

    const transfer = buildTransfer({ fromAddress: addr0, toAddress: MAIN_WALLET, amountMicro: 50_000_000n });
    const mockTxId = buildMockTxId(transfer, 0);

    const item: SweepItem = {
      address: addr0, account: 0, index: 0, amountMicro: 50_000_000n,
      signableTx: { txID: mockTxId, raw_data_hex: transfer.callData, raw_data: { contract: [], fee_limit: 40_000_000 } },
    };

    const broadcastCalled: boolean[] = [];
    const mockBroadcast: BroadcastFn = async (tx) => { broadcastCalled.push(true); return { txId: tx.txID, success: true }; };
    const buildSignableTx: BuildSignableTxFn = async (i) => i.signableTx;

    const result = await executeSweep(
      { id: "intent_dry_2", eventId: "ev_2", status: "prepared", items: [item], createdAt: new Date().toISOString() },
      { encryptedSeed, passphrase: TEST_PASSPHRASE, broadcast: mockBroadcast, buildSignableTx },
    );

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(broadcastCalled).toHaveLength(1);
  });
});

describe("SIGN-3: dry-run signing still works with mock txID", () => {
  let savedRpc: string | undefined;

  beforeEach(() => {
    savedRpc = process.env["TRON_RPC_PRIMARY"];
    delete process.env["TRON_RPC_PRIMARY"];
  });
  afterEach(() => {
    if (savedRpc !== undefined) {
      process.env["TRON_RPC_PRIMARY"] = savedRpc;
    } else {
      delete process.env["TRON_RPC_PRIMARY"];
    }
  });

  it("signTransfer succeeds with a mock txID in dry-run (no TRON_RPC_PRIMARY)", () => {
    const key = deriveInvoiceKey(TEST_MNEMONIC, 0, 0);
    const transfer = makeTransfer();
    const mockTxId = buildMockTxId(transfer, 0);
    const signableTx = {
      txID: mockTxId,
      raw_data_hex: transfer.callData,
      raw_data: { contract: [], fee_limit: 40_000_000 },
    };

    const signed = signTransfer(key.privateKey, signableTx);
    expect(Array.isArray(signed.signature)).toBe(true);
    expect((signed.signature as string[]).length).toBeGreaterThan(0);
  });
});
