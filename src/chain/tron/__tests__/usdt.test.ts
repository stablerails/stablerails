/**
 * usdt.ts — constant correctness tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TRON_USDT_CONTRACT_BASE58,
  TRON_USDT_CONTRACT_HEX,
  USDT_DECIMALS_TRON,
  TRANSFER_EVENT_TOPIC,
  DUST_THRESHOLD_MICRO,
} from "../usdt.js";
import { hexToBase58, base58ToHex } from "../addressCodec.js";

const MAINNET_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const NILE_BASE58 = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";

describe("usdt constants", () => {
  it("TRON_USDT_CONTRACT_BASE58 is a valid Tron Base58 address", () => {
    expect(TRON_USDT_CONTRACT_BASE58).toBe(MAINNET_BASE58);
    // Round-trip: Base58 → hex → Base58
    const hex = base58ToHex(TRON_USDT_CONTRACT_BASE58);
    expect(hexToBase58(hex)).toBe(TRON_USDT_CONTRACT_BASE58);
  });

  it("TRON_USDT_CONTRACT_HEX matches TRON_USDT_CONTRACT_BASE58", () => {
    expect(hexToBase58(TRON_USDT_CONTRACT_HEX)).toBe(TRON_USDT_CONTRACT_BASE58);
    expect(base58ToHex(TRON_USDT_CONTRACT_BASE58)).toBe(TRON_USDT_CONTRACT_HEX);
  });

  it("USDT_DECIMALS_TRON is 6", () => {
    expect(USDT_DECIMALS_TRON).toBe(6);
  });

  it("TRANSFER_EVENT_TOPIC is correct keccak of Transfer(address,address,uint256)", () => {
    // Known correct value
    expect(TRANSFER_EVENT_TOPIC).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
  });

  it("DUST_THRESHOLD_MICRO is 0n", () => {
    expect(DUST_THRESHOLD_MICRO).toBe(0n);
  });
});

describe("TRON_USDT_CONTRACT env override", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env["TRON_USDT_CONTRACT"];
    vi.resetModules();
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env["TRON_USDT_CONTRACT"];
    } else {
      process.env["TRON_USDT_CONTRACT"] = savedEnv;
    }
    vi.resetModules();
  });

  it("(a) unset env → mainnet contract base58 and hex unchanged", async () => {
    delete process.env["TRON_USDT_CONTRACT"];
    const mod = await import("../usdt.js?unset");
    expect(mod.TRON_USDT_CONTRACT_BASE58).toBe(MAINNET_BASE58);
    expect(mod.TRON_USDT_CONTRACT_HEX).toBe(base58ToHex(MAINNET_BASE58));
  });

  it("(b) env set to Nile USDT contract → Nile contract used with correct hex", async () => {
    process.env["TRON_USDT_CONTRACT"] = NILE_BASE58;
    const mod = await import("../usdt.js?nile");
    expect(mod.TRON_USDT_CONTRACT_BASE58).toBe(NILE_BASE58);
    expect(mod.TRON_USDT_CONTRACT_HEX).toBe(base58ToHex(NILE_BASE58));
  });

  it("empty string env → falls back to mainnet (safe default)", async () => {
    process.env["TRON_USDT_CONTRACT"] = "";
    const mod = await import("../usdt.js?empty");
    expect(mod.TRON_USDT_CONTRACT_BASE58).toBe(MAINNET_BASE58);
  });

  it("invalid base58 env → falls back to mainnet (safe default)", async () => {
    process.env["TRON_USDT_CONTRACT"] = "NOTAVALIDTRONADDRESS";
    const mod = await import("../usdt.js?invalid");
    expect(mod.TRON_USDT_CONTRACT_BASE58).toBe(MAINNET_BASE58);
  });
});
