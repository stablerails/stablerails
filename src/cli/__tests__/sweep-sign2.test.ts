/**
 * SIGN-2 / SIGN-2b tests — local main-wallet pin for sweep destination.
 *
 * Tests:
 *   1. toSignerIntent aborts when toAddressBase58 mismatches the local pin.
 *   2. toSignerIntent succeeds when the blob is fully self-consistent.
 *   3. When STABLERAILS_MAIN_WALLET is unset, require fails with a clear error
 *      instructing the operator to set it.
 *   4. SIGN-2b: a blob where toAddressBase58 equals the pin but callData /
 *      toAddressHex encode a DIFFERENT destination (the display-vs-signed-bytes
 *      attack) is rejected.
 *   5. SIGN-2b: a blob where callData encodes a different AMOUNT than
 *      amountMicroStr is rejected.
 *   6. SIGN-2b: feeLimitSun outside (0, 1000 TRX] is rejected.
 *   7. getMainWalletPin rejects a pin with valid charset but bad Base58Check
 *      checksum (typo scenario).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  toSignerIntentWithPin,
  getMainWalletPin,
} from "../commands/sweep.js";
import { buildTransfer } from "../../chain/tron/buildTransfer.js";
import { base58ToHex } from "../../chain/tron/addressCodec.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const PINNED_MAIN_WALLET = "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe";
// Valid charset, INVALID Base58Check checksum (last char flipped e→f).
const TYPO_MAIN_WALLET = "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCf";
// Invalid checksum on purpose — only used where the string-compare pin check
// must fire BEFORE any decoding happens.
const ATTACKER_WALLET = "TAttacker111111111111111111111111111";
// Checksum-VALID address that is NOT the pin — used for the SIGN-2b
// signable-bytes substitution attack (here: the USDT contract address).
const ATTACKER_WALLET_VALID = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const DEPOSIT_ADDRESS = "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH";
const AMOUNT_MICRO = 100_000_000n;

/**
 * Build a server-side SweepIntent JSON with one item.
 *
 * By default the unsignedTx is fully self-consistent (callData/toAddressHex
 * derived from `toAddressBase58` + amount via the canonical builder).
 * `unsignedTxOverrides` lets tests inject inconsistent (attacker) bytes.
 */
function makeRawIntent(
  toAddressBase58: string,
  unsignedTxOverrides: Record<string, string> = {},
) {
  // For the consistent base case derive real bytes; for ATTACKER_WALLET
  // (invalid checksum) we cannot encode — fall back to pin-derived bytes,
  // the string pin check fires before any byte comparison anyway.
  const encodeTo =
    toAddressBase58 === ATTACKER_WALLET ? PINNED_MAIN_WALLET : toAddressBase58;
  const canonical = buildTransfer({
    fromAddress: DEPOSIT_ADDRESS,
    toAddress: encodeTo,
    amountMicro: AMOUNT_MICRO,
    feeLimitSun: 15_000_000n,
  });

  return {
    id: "intent_sign2_test",
    eventId: "ev_sign2",
    status: "prepared",
    createdAt: new Date().toISOString(),
    items: [
      {
        address: DEPOSIT_ADDRESS,
        account: 0,
        index: 0,
        amountMicroStr: AMOUNT_MICRO.toString(),
        unsignedTx: {
          contractAddressHex: canonical.contractAddressHex,
          contractAddressBase58: canonical.contractAddressBase58,
          fromAddressHex: canonical.fromAddressHex,
          fromAddressBase58: canonical.fromAddressBase58,
          toAddressHex: canonical.toAddressHex,
          toAddressBase58,
          amountMicro: AMOUNT_MICRO.toString(),
          callData: canonical.callData,
          feeLimitSun: "15000000",
          memo: "",
          ...unsignedTxOverrides,
        },
      },
    ],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SIGN-2: getMainWalletPin", () => {
  let savedPin: string | undefined;

  beforeEach(() => {
    savedPin = process.env["STABLERAILS_MAIN_WALLET"];
  });
  afterEach(() => {
    if (savedPin !== undefined) {
      process.env["STABLERAILS_MAIN_WALLET"] = savedPin;
    } else {
      delete process.env["STABLERAILS_MAIN_WALLET"];
    }
  });

  it("returns the pinned address when STABLERAILS_MAIN_WALLET is set", () => {
    process.env["STABLERAILS_MAIN_WALLET"] = PINNED_MAIN_WALLET;
    expect(getMainWalletPin()).toBe(PINNED_MAIN_WALLET);
  });

  it("throws with clear guidance when STABLERAILS_MAIN_WALLET is unset", () => {
    delete process.env["STABLERAILS_MAIN_WALLET"];
    expect(() => getMainWalletPin()).toThrow(/STABLERAILS_MAIN_WALLET/);
  });

  it("throws when STABLERAILS_MAIN_WALLET is set but does not start with T (invalid format)", () => {
    process.env["STABLERAILS_MAIN_WALLET"] = "notavalidaddress";
    expect(() => getMainWalletPin()).toThrow(/not a valid Tron address/);
  });

  it("throws when STABLERAILS_MAIN_WALLET is set but too short (typo scenario)", () => {
    process.env["STABLERAILS_MAIN_WALLET"] = "TShort";
    expect(() => getMainWalletPin()).toThrow(/not a valid Tron address/);
  });

  it("throws when STABLERAILS_MAIN_WALLET contains invalid Base58 characters (e.g. 0 or O)", () => {
    // 34 chars starting with T but contains '0' (invalid Base58)
    process.env["STABLERAILS_MAIN_WALLET"] = "T000000000000000000000000000000000";
    expect(() => getMainWalletPin()).toThrow(/not a valid Tron address/);
  });

  it("throws when the pin has a valid charset but a bad Base58Check checksum (one-char typo)", () => {
    process.env["STABLERAILS_MAIN_WALLET"] = TYPO_MAIN_WALLET;
    expect(() => getMainWalletPin()).toThrow(/checksum/i);
  });

  it("accepts a well-formed 34-char T... address", () => {
    process.env["STABLERAILS_MAIN_WALLET"] = PINNED_MAIN_WALLET;
    expect(() => getMainWalletPin()).not.toThrow();
  });
});

describe("SIGN-2: toSignerIntentWithPin — destination pin enforcement", () => {
  let savedPin: string | undefined;

  beforeEach(() => {
    savedPin = process.env["STABLERAILS_MAIN_WALLET"];
  });
  afterEach(() => {
    if (savedPin !== undefined) {
      process.env["STABLERAILS_MAIN_WALLET"] = savedPin;
    } else {
      delete process.env["STABLERAILS_MAIN_WALLET"];
    }
  });

  it("aborts (throws) when server-provided toAddressBase58 mismatches the local pin", () => {
    process.env["STABLERAILS_MAIN_WALLET"] = PINNED_MAIN_WALLET;
    const rawIntent = makeRawIntent(ATTACKER_WALLET);

    expect(() => toSignerIntentWithPin(rawIntent as Record<string, unknown>)).toThrow(
      /destination mismatch/i,
    );
  });

  it("names both addresses in the mismatch error", () => {
    process.env["STABLERAILS_MAIN_WALLET"] = PINNED_MAIN_WALLET;
    const rawIntent = makeRawIntent(ATTACKER_WALLET);

    expect(() => toSignerIntentWithPin(rawIntent as Record<string, unknown>)).toThrow(
      ATTACKER_WALLET,
    );
  });

  it("also mentions the locally-pinned address in the mismatch error", () => {
    process.env["STABLERAILS_MAIN_WALLET"] = PINNED_MAIN_WALLET;
    const rawIntent = makeRawIntent(ATTACKER_WALLET);

    expect(() => toSignerIntentWithPin(rawIntent as Record<string, unknown>)).toThrow(
      PINNED_MAIN_WALLET,
    );
  });

  it("succeeds and returns a SweepIntent when the blob is self-consistent and matches the pin", () => {
    process.env["STABLERAILS_MAIN_WALLET"] = PINNED_MAIN_WALLET;
    const rawIntent = makeRawIntent(PINNED_MAIN_WALLET);

    const intent = toSignerIntentWithPin(rawIntent as Record<string, unknown>);
    expect(intent.id).toBe("intent_sign2_test");
    expect(intent.items).toHaveLength(1);
    expect(intent.items[0]!.amountMicro).toBe(AMOUNT_MICRO);
  });

  it("throws when STABLERAILS_MAIN_WALLET is unset — refuses to silently trust server", () => {
    delete process.env["STABLERAILS_MAIN_WALLET"];
    const rawIntent = makeRawIntent(PINNED_MAIN_WALLET);

    expect(() => toSignerIntentWithPin(rawIntent as Record<string, unknown>)).toThrow(
      /STABLERAILS_MAIN_WALLET/,
    );
  });
});

describe("SIGN-2b: toSignerIntentWithPin — signable-bytes verification", () => {
  let savedPin: string | undefined;

  beforeEach(() => {
    savedPin = process.env["STABLERAILS_MAIN_WALLET"];
    process.env["STABLERAILS_MAIN_WALLET"] = PINNED_MAIN_WALLET;
  });
  afterEach(() => {
    if (savedPin !== undefined) {
      process.env["STABLERAILS_MAIN_WALLET"] = savedPin;
    } else {
      delete process.env["STABLERAILS_MAIN_WALLET"];
    }
  });

  it("rejects a blob where toAddressBase58 equals the pin but callData+toAddressHex pay an attacker (core regression)", () => {
    // The display-vs-signed-bytes attack: pin check + TTY display see the
    // operator's wallet, but the bytes that get SIGNED encode an attacker.
    const attackerBytes = buildTransfer({
      fromAddress: DEPOSIT_ADDRESS,
      toAddress: ATTACKER_WALLET_VALID,
      amountMicro: AMOUNT_MICRO,
    });
    const rawIntent = makeRawIntent(PINNED_MAIN_WALLET, {
      toAddressHex: attackerBytes.toAddressHex,
      callData: attackerBytes.callData,
    });

    expect(() => toSignerIntentWithPin(rawIntent as Record<string, unknown>)).toThrow(
      /hex mismatch/i,
    );
  });

  it("rejects a blob where only callData encodes an attacker destination (toAddressHex untouched)", () => {
    const attackerBytes = buildTransfer({
      fromAddress: DEPOSIT_ADDRESS,
      toAddress: ATTACKER_WALLET_VALID,
      amountMicro: AMOUNT_MICRO,
    });
    const rawIntent = makeRawIntent(PINNED_MAIN_WALLET, {
      callData: attackerBytes.callData,
    });

    expect(() => toSignerIntentWithPin(rawIntent as Record<string, unknown>)).toThrow(
      /callData mismatch/i,
    );
  });

  it("rejects a blob where callData encodes a different AMOUNT than amountMicroStr", () => {
    const inflated = buildTransfer({
      fromAddress: DEPOSIT_ADDRESS,
      toAddress: PINNED_MAIN_WALLET,
      amountMicro: 999_000_000n, // != amountMicroStr (100_000_000)
    });
    const rawIntent = makeRawIntent(PINNED_MAIN_WALLET, {
      callData: inflated.callData,
    });

    expect(() => toSignerIntentWithPin(rawIntent as Record<string, unknown>)).toThrow(
      /callData mismatch/i,
    );
  });

  it("rejects an absurd feeLimitSun (TRX-burning attack)", () => {
    const rawIntent = makeRawIntent(PINNED_MAIN_WALLET, {
      feeLimitSun: "2000000000", // 2000 TRX > 1000 TRX cap
    });

    expect(() => toSignerIntentWithPin(rawIntent as Record<string, unknown>)).toThrow(
      /fee limit out of bounds/i,
    );
  });

  it("rejects a non-positive feeLimitSun", () => {
    const rawIntent = makeRawIntent(PINNED_MAIN_WALLET, { feeLimitSun: "0" });

    expect(() => toSignerIntentWithPin(rawIntent as Record<string, unknown>)).toThrow(
      /fee limit out of bounds/i,
    );
  });

  it("accepts case/0x-prefix variations of matching hex values", () => {
    const canonical = buildTransfer({
      fromAddress: DEPOSIT_ADDRESS,
      toAddress: PINNED_MAIN_WALLET,
      amountMicro: AMOUNT_MICRO,
    });
    const rawIntent = makeRawIntent(PINNED_MAIN_WALLET, {
      toAddressHex: "0x" + canonical.toAddressHex.toUpperCase(),
      callData: canonical.callData.toUpperCase(),
    });

    expect(() => toSignerIntentWithPin(rawIntent as Record<string, unknown>)).not.toThrow();
  });

  it("signs ONLY locally-derived bytes — signableTx callData equals the canonical local encoding", () => {
    const canonical = buildTransfer({
      fromAddress: DEPOSIT_ADDRESS,
      toAddress: PINNED_MAIN_WALLET,
      amountMicro: AMOUNT_MICRO,
      feeLimitSun: 15_000_000n,
    });
    const rawIntent = makeRawIntent(PINNED_MAIN_WALLET);

    const intent = toSignerIntentWithPin(rawIntent as Record<string, unknown>);
    expect(intent.items[0]!.signableTx.raw_data_hex).toBe(canonical.callData);
    // Destination embedded in callData is the pin (sanity: ABI word 1 = pin hex sans 41 prefix).
    const pinHexNoPrefix = base58ToHex(PINNED_MAIN_WALLET).slice(2);
    expect(canonical.callData).toContain(pinHexNoPrefix);
  });
});
