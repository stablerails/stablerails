/**
 * Gas wallet derivation tests.
 *
 * Verifies the reserved derivation slot (m/44'/195'/2000000000'/0/0), the
 * address computation (cross-checked against tronweb's independent
 * implementation), and that the slot cannot collide with deposit slots.
 */

import { describe, it, expect } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import TronWeb from "tronweb";
import {
  deriveGasWallet,
  GAS_WALLET_ACCOUNT,
  GAS_WALLET_INDEX,
  GAS_WALLET_PATH,
} from "../gasWallet.js";
import { deriveInvoiceKey } from "../provision.js";
import { isValidBase58Address } from "../../chain/tron/addressCodec.js";

const M =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("gasWallet -- reserved derivation slot", () => {
  it("uses account 2_000_000_000 (hardened-safe: below 2^31)", () => {
    expect(GAS_WALLET_ACCOUNT).toBe(2_000_000_000);
    expect(GAS_WALLET_ACCOUNT).toBeLessThan(2 ** 31);
    expect(GAS_WALLET_INDEX).toBe(0);
    expect(GAS_WALLET_PATH).toBe("m/44'/195'/2000000000'/0/0");
  });

  it("private key matches direct HDKey derivation at the reserved path", () => {
    const wallet = deriveGasWallet(M);
    const node = HDKey.fromMasterSeed(mnemonicToSeedSync(M)).derive(GAS_WALLET_PATH);
    expect(Buffer.from(wallet.privateKey).toString("hex")).toBe(
      Buffer.from(node.privateKey!).toString("hex"),
    );
  });
});

describe("gasWallet -- deriveGasWallet", () => {
  it("returns a 32-byte private key and a valid Base58 Tron address", () => {
    const wallet = deriveGasWallet(M);
    expect(wallet.privateKey.length).toBe(32);
    expect(isValidBase58Address(wallet.address)).toBe(true);
  });

  it("address matches tronweb's independent fromPrivateKey implementation", () => {
    const wallet = deriveGasWallet(M);
    const privHex = Buffer.from(wallet.privateKey).toString("hex");
    expect(wallet.address).toBe(TronWeb.address.fromPrivateKey(privHex));
  });

  it("matches the golden vector for the test mnemonic", () => {
    // Pinned so an accidental path/codec change cannot silently move the
    // operator's pre-funded TRX to an unreachable address.
    expect(deriveGasWallet(M).address).toBe("TSkmVYs1dJ8dzfVTZH63fABDhHoPi1GBJ4");
  });

  it("is deterministic", () => {
    const a = deriveGasWallet(M);
    const b = deriveGasWallet(M);
    expect(a.address).toBe(b.address);
    expect(Buffer.from(a.privateKey).toString("hex")).toBe(
      Buffer.from(b.privateKey).toString("hex"),
    );
  });

  it("differs from the first invoice deposit slot (account 0, index 0)", () => {
    const wallet = deriveGasWallet(M);
    const invoiceKey = deriveInvoiceKey(M, 0, 0);
    expect(Buffer.from(wallet.privateKey).toString("hex")).not.toBe(
      Buffer.from(invoiceKey.privateKey).toString("hex"),
    );
  });
});
