/**
 * buildTransfer.ts — unsigned TRC-20 transfer builder tests.
 */

import { describe, it, expect } from "vitest";
import { buildTransfer } from "../buildTransfer.js";
import { TRON_USDT_CONTRACT_BASE58, TRON_USDT_CONTRACT_HEX } from "../usdt.js";

const FROM = "TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy";
const TO = "THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC";

describe("buildTransfer", () => {
  it("builds a valid unsigned TRC-20 transfer", () => {
    const result = buildTransfer({
      fromAddress: FROM,
      toAddress: TO,
      amountMicro: 100_000_000n, // 100 USDT
    });

    expect(result.contractAddressBase58).toBe(TRON_USDT_CONTRACT_BASE58);
    expect(result.contractAddressHex).toBe(TRON_USDT_CONTRACT_HEX);
    expect(result.fromAddressBase58).toBe(FROM);
    expect(result.toAddressBase58).toBe(TO);
    expect(result.amountMicro).toBe(100_000_000n);
    expect(result.feeLimitSun).toBe(40_000_000n); // default 40 TRX
    expect(result.memo).toBe("");
  });

  it("encodes callData starting with transfer method ID", () => {
    const result = buildTransfer({
      fromAddress: FROM,
      toAddress: TO,
      amountMicro: 1_000_000n,
    });
    // a9059cbb = keccak256("transfer(address,uint256)")[:4]
    expect(result.callData.startsWith("a9059cbb")).toBe(true);
    // Total = 4 + 32 + 32 = 68 bytes = 136 hex chars
    expect(result.callData).toHaveLength(136);
  });

  it("ABI-encodes amount correctly", () => {
    const amount = 123_456_789n;
    const result = buildTransfer({
      fromAddress: FROM,
      toAddress: TO,
      amountMicro: amount,
    });
    const amountHex = amount.toString(16).padStart(64, "0");
    expect(result.callData.slice(72)).toBe(amountHex); // 8 (method) + 64 (addr) = 72 chars
  });

  it("accepts custom fee limit", () => {
    const result = buildTransfer({
      fromAddress: FROM,
      toAddress: TO,
      amountMicro: 1_000_000n,
      feeLimitSun: 60_000_000n,
    });
    expect(result.feeLimitSun).toBe(60_000_000n);
  });

  it("accepts memo string", () => {
    const result = buildTransfer({
      fromAddress: FROM,
      toAddress: TO,
      amountMicro: 1_000_000n,
      memo: "sweep-001",
    });
    expect(result.memo).toBe("sweep-001");
  });

  it("throws RangeError on zero amount", () => {
    expect(() =>
      buildTransfer({ fromAddress: FROM, toAddress: TO, amountMicro: 0n }),
    ).toThrow(RangeError);
  });

  it("throws RangeError on negative amount", () => {
    expect(() =>
      buildTransfer({ fromAddress: FROM, toAddress: TO, amountMicro: -1n }),
    ).toThrow(RangeError);
  });

  it("accepts hex from/to addresses and normalizes them", () => {
    const fromHex = "4177944d19c052b73ee2286823aa83f8138cb7032f";
    const toHex = "41517591d35d313bf6a5e33098284502b045e2bc08";
    const result = buildTransfer({
      fromAddress: fromHex,
      toAddress: toHex,
      amountMicro: 1_000_000n,
    });
    expect(result.fromAddressBase58).toBe("TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy");
    expect(result.toAddressBase58).toBe("THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC");
  });
});
