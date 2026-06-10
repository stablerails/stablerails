/**
 * Signer sweep tests — Sprint 7.
 *
 * Tests:
 *   1. executeSweep decrypts seed → derives keys → signs → broadcasts.
 *   2. Wrong passphrase is rejected (decryptSeed throws).
 *   3. Broadcast errors are captured per-item (not thrown).
 *   4. Empty intent returns zero results.
 */

import { describe, it, expect } from "vitest";
import { executeSweep } from "../sweep.js";
import type { SweepIntent, SweepItem, BroadcastFn, BuildSignableTxFn } from "../sweep.js";
import { encryptSeed } from "../seed.js";
import { buildMockTxId, signTransfer } from "../sign.js";
import { buildTransfer } from "../../chain/tron/buildTransfer.js";
import { deriveInvoiceKey, deriveAccountXpub } from "../provision.js";
import { deriveAddress } from "../../chain/tron/deriveAddress.js";
import type { SignedTronTransaction } from "../../chain/tron/broadcast.js";

// ── Test constants ────────────────────────────────────────────────────────────

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_PASSPHRASE = "test-sweep-passphrase-2025";
const WRONG_PASSPHRASE = "wrong-passphrase-XXXXXXX";

// Real addresses from the M6 golden vectors (account=0, index=0 and index=1).
const ADDR_0_0 = "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH";
const ADDR_0_1 = "TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK";
const MAIN_WALLET = "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEncryptedSeed() {
  // encryptSeed is async (native argon2 KDF) — callers await the promise.
  return encryptSeed(TEST_MNEMONIC, TEST_PASSPHRASE);
}

function makeItems(): SweepItem[] {
  const xpub = deriveAccountXpub(TEST_MNEMONIC, 0).xpub;
  const addr0 = deriveAddress(xpub, 0);
  const addr1 = deriveAddress(xpub, 1);

  expect(addr0).toBe(ADDR_0_0);
  expect(addr1).toBe(ADDR_0_1);

  const makeItem = (index: number, address: string, amountMicro: bigint): SweepItem => {
    const transfer = buildTransfer({
      fromAddress: address,
      toAddress: MAIN_WALLET,
      amountMicro,
    });
    const txID = buildMockTxId(transfer, index);
    return {
      address,
      account: 0,
      index,
      amountMicro,
      signableTx: {
        txID,
        raw_data_hex: transfer.callData,
        raw_data: { contract: [], fee_limit: 40_000_000 },
      },
    };
  };

  return [
    makeItem(0, ADDR_0_0, 100_000_000n),
    makeItem(1, ADDR_0_1, 50_000_000n),
  ];
}

function makeMockIntent(items: SweepItem[]): SweepIntent {
  return {
    id: "intent_test_001",
    eventId: "ev_test_1",
    status: "prepared",
    items,
    createdAt: new Date().toISOString(),
  };
}

function makeMockBroadcast(capturedTxs: SignedTronTransaction[]): BroadcastFn {
  return async (signedTx) => {
    capturedTxs.push(signedTx);
    return { txId: signedTx.txID, success: true };
  };
}

const buildSignableTx: BuildSignableTxFn = async (item) => item.signableTx;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("executeSweep — happy path", () => {
  it("decrypts seed, derives keys, signs, and broadcasts each item", async () => {
    const encryptedSeed = await makeEncryptedSeed();
    const items = makeItems();
    const intent = makeMockIntent(items);
    const capturedTxs: SignedTronTransaction[] = [];
    const broadcast = makeMockBroadcast(capturedTxs);

    const result = await executeSweep(intent, {
      encryptedSeed,
      passphrase: TEST_PASSPHRASE,
      broadcast,
      buildSignableTx,
    });

    expect(result.intentId).toBe("intent_test_001");
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(2);

    for (const r of result.results) {
      expect(r.success).toBe(true);
      expect(r.txHash).toBeTruthy();
      expect(r.error).toBeUndefined();
    }

    // broadcast was called twice.
    expect(capturedTxs).toHaveLength(2);

    // Each signed tx has a signature array.
    for (const tx of capturedTxs) {
      expect(Array.isArray(tx.signature)).toBe(true);
      expect((tx.signature as string[]).length).toBeGreaterThan(0);
      // Signature is 65 bytes = 130 hex chars.
      expect((tx.signature as string[])[0]).toHaveLength(130);
    }
  });

  it("signs produce address-specific keys (different txIDs for different addresses)", async () => {
    const encryptedSeed = await makeEncryptedSeed();
    const items = makeItems();
    const intent = makeMockIntent(items);
    const capturedTxs: SignedTronTransaction[] = [];

    await executeSweep(intent, {
      encryptedSeed,
      passphrase: TEST_PASSPHRASE,
      broadcast: makeMockBroadcast(capturedTxs),
      buildSignableTx,
    });

    // The two signed txs must have different txIDs (different keys, different tx data).
    expect(capturedTxs[0]!.txID).not.toBe(capturedTxs[1]!.txID);
    // And different signatures.
    expect((capturedTxs[0]!.signature as string[])[0]).not.toBe(
      (capturedTxs[1]!.signature as string[])[0],
    );
  });
});

describe("executeSweep — wrong passphrase", () => {
  it("throws when passphrase is wrong (before any broadcast)", async () => {
    const encryptedSeed = await makeEncryptedSeed();
    const items = makeItems();
    const intent = makeMockIntent(items);
    const capturedTxs: SignedTronTransaction[] = [];

    await expect(
      executeSweep(intent, {
        encryptedSeed,
        passphrase: WRONG_PASSPHRASE,
        broadcast: makeMockBroadcast(capturedTxs),
        buildSignableTx,
      }),
    ).rejects.toThrow(/decryption failed/i);

    // No broadcasts happened.
    expect(capturedTxs).toHaveLength(0);
  });

  it("throws on empty passphrase when non-empty was used", async () => {
    const encryptedSeed = await makeEncryptedSeed();
    const intent = makeMockIntent(makeItems());
    const capturedTxs: SignedTronTransaction[] = [];

    await expect(
      executeSweep(intent, {
        encryptedSeed,
        passphrase: "",
        broadcast: makeMockBroadcast(capturedTxs),
        buildSignableTx,
      }),
    ).rejects.toThrow(/decryption failed/i);
  });
});

describe("executeSweep — broadcast errors captured per-item", () => {
  it("captures broadcast failure and continues with other items", async () => {
    const encryptedSeed = await makeEncryptedSeed();
    const items = makeItems();
    const intent = makeMockIntent(items);
    let callCount = 0;

    const failingBroadcast: BroadcastFn = async (signedTx) => {
      callCount++;
      if (callCount === 1) {
        return { txId: signedTx.txID, success: false, error: "RPC timeout" };
      }
      return { txId: signedTx.txID, success: true };
    };

    const result = await executeSweep(intent, {
      encryptedSeed,
      passphrase: TEST_PASSPHRASE,
      broadcast: failingBroadcast,
      buildSignableTx,
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0]!.success).toBe(false);
    expect(result.results[0]!.error).toBe("RPC timeout");
    expect(result.results[1]!.success).toBe(true);
  });

  it("captures exception from buildSignableTx as per-item failure", async () => {
    const encryptedSeed = await makeEncryptedSeed();
    const items = makeItems();
    const intent = makeMockIntent(items);
    const capturedTxs: SignedTronTransaction[] = [];

    const throwingBuildTx: BuildSignableTxFn = async (item) => {
      if (item.index === 0) {
        throw new Error("Node RPC unreachable");
      }
      return item.signableTx;
    };

    const result = await executeSweep(intent, {
      encryptedSeed,
      passphrase: TEST_PASSPHRASE,
      broadcast: makeMockBroadcast(capturedTxs),
      buildSignableTx: throwingBuildTx,
    });

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0]!.success).toBe(false);
    expect(result.results[0]!.error).toMatch(/RPC unreachable/);
    expect(result.results[1]!.success).toBe(true);
  });
});

describe("executeSweep — empty intent", () => {
  it("returns zero results for an empty items array", async () => {
    const encryptedSeed = await makeEncryptedSeed();
    const intent = makeMockIntent([]);
    const capturedTxs: SignedTronTransaction[] = [];

    const result = await executeSweep(intent, {
      encryptedSeed,
      passphrase: TEST_PASSPHRASE,
      broadcast: makeMockBroadcast(capturedTxs),
      buildSignableTx,
    });

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(capturedTxs).toHaveLength(0);
  });
});

// ── sign.ts direct tests ──────────────────────────────────────────────────────

describe("signTransfer", () => {
  it("produces a 65-byte (130 hex) ECDSA signature", () => {
    const key = deriveInvoiceKey(TEST_MNEMONIC, 0, 0);
    const transfer = buildTransfer({
      fromAddress: ADDR_0_0,
      toAddress: MAIN_WALLET,
      amountMicro: 100_000_000n,
    });
    const txID = buildMockTxId(transfer, 0);
    const signableTx = { txID, raw_data_hex: transfer.callData, raw_data: {} };

    const signed = signTransfer(key.privateKey, signableTx);

    expect(Array.isArray(signed.signature)).toBe(true);
    expect((signed.signature as string[]).length).toBe(1);
    expect((signed.signature as string[])[0]).toHaveLength(130);
  });

  it("throws on private key with wrong length", () => {
    const shortKey = new Uint8Array(16);
    const txID = "a".repeat(64);
    expect(() =>
      signTransfer(shortKey, { txID, raw_data_hex: "", raw_data: {} }),
    ).toThrow(/32-byte/);
  });

  it("throws on invalid txID format", () => {
    const key = deriveInvoiceKey(TEST_MNEMONIC, 0, 0);
    expect(() =>
      signTransfer(key.privateKey, { txID: "notahex", raw_data_hex: "", raw_data: {} }),
    ).toThrow(/64-char hex/);
  });

  it("two different keys produce different signatures for the same tx", () => {
    const key0 = deriveInvoiceKey(TEST_MNEMONIC, 0, 0);
    const key1 = deriveInvoiceKey(TEST_MNEMONIC, 0, 1);
    const transfer = buildTransfer({
      fromAddress: ADDR_0_0,
      toAddress: MAIN_WALLET,
      amountMicro: 100_000_000n,
    });
    const txID = buildMockTxId(transfer, 0);
    const signableTx = { txID, raw_data_hex: transfer.callData, raw_data: {} };

    const sig0 = (signTransfer(key0.privateKey, signableTx).signature as string[])[0];
    const sig1 = (signTransfer(key1.privateKey, signableTx).signature as string[])[0];

    expect(sig0).not.toBe(sig1);
  });
});
