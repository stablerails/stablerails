import { describe, expect, it } from "vitest";
import { broadcastTransaction, type SignedTronTransaction } from "../broadcast.js";
import type { TronHttpClient } from "../../../lib/http.js";

function makeTx(overrides: Partial<SignedTronTransaction> = {}): SignedTronTransaction {
  return {
    txID: "a".repeat(64),
    raw_data: { contract: [{ type: "TriggerSmartContract" }] },
    raw_data_hex: "00",
    signature: ["signature"],
    ...overrides,
  };
}

function makeClient(data: unknown): TronHttpClient {
  return {
    async post() {
      return { data, provider: "primary" as const };
    },
  } as unknown as TronHttpClient;
}

describe("broadcastTransaction", () => {
  it("rejects a successful node response with an invalid txid format", async () => {
    await expect(
      broadcastTransaction(makeClient({ result: true, txid: "not-a-hex-txid" }), makeTx()),
    ).rejects.toThrow(/invalid txid/i);
  });

  it("rejects a successful node response whose txid differs from the signed transaction", async () => {
    await expect(
      broadcastTransaction(makeClient({ result: true, txid: "b".repeat(64) }), makeTx()),
    ).rejects.toThrow(/does not match/i);
  });

  // ── FIX 1: duplicate-broadcast treated as success ─────────────────────────

  it("returns success:true when node returns result:false with code DUP_TRANSACTION_ERROR", async () => {
    const tx = makeTx();
    const result = await broadcastTransaction(
      makeClient({ result: false, code: "DUP_TRANSACTION_ERROR" }),
      tx,
    );
    expect(result.success).toBe(true);
    expect(result.txId).toBe(tx.txID);
  });

  it("returns success:true and duplicate:true when node signals a dup via code", async () => {
    const tx = makeTx();
    const result = await broadcastTransaction(
      makeClient({ result: false, code: "DUP_TRANSACTION_ERROR" }),
      tx,
    );
    expect(result.success).toBe(true);
    expect((result as { duplicate?: boolean }).duplicate).toBe(true);
  });

  it("returns success:true when node returns result:false with message containing 'already exists'", async () => {
    const tx = makeTx();
    const result = await broadcastTransaction(
      makeClient({ result: false, code: "CONTRACT_VALIDATE_ERROR", message: "already exists" }),
      tx,
    );
    expect(result.success).toBe(true);
    expect(result.txId).toBe(tx.txID);
  });

  it("returns success:true when node returns result:false with message containing 'dup'", async () => {
    const tx = makeTx();
    const result = await broadcastTransaction(
      makeClient({ result: false, message: "dup transaction" }),
      tx,
    );
    expect(result.success).toBe(true);
    expect(result.txId).toBe(tx.txID);
  });

  it("returns success:true when node returns result:false with message containing 'DUP_TRANSACTION'", async () => {
    const tx = makeTx();
    const result = await broadcastTransaction(
      makeClient({ result: false, message: "DUP_TRANSACTION detected" }),
      tx,
    );
    expect(result.success).toBe(true);
  });

  it("returns success:false for SIGERROR — a genuine non-dup failure", async () => {
    const result = await broadcastTransaction(
      makeClient({ result: false, code: "SIGERROR" }),
      makeTx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("returns success:false for BANDWITH_ERROR — a genuine non-dup failure", async () => {
    const result = await broadcastTransaction(
      makeClient({ result: false, code: "BANDWITH_ERROR" }),
      makeTx(),
    );
    expect(result.success).toBe(false);
  });

  it("returns success:false for TAPOS_ERROR — a genuine non-dup failure", async () => {
    const result = await broadcastTransaction(
      makeClient({ result: false, code: "TAPOS_ERROR" }),
      makeTx(),
    );
    expect(result.success).toBe(false);
  });

  it("returns success:false for CONTRACT_VALIDATE_ERROR without dup message", async () => {
    const result = await broadcastTransaction(
      makeClient({ result: false, code: "CONTRACT_VALIDATE_ERROR", message: "contract validate error" }),
      makeTx(),
    );
    expect(result.success).toBe(false);
  });
});
