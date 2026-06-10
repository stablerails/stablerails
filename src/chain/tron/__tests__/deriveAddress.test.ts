/**
 * Direct unit tests for deriveAddress / deriveCompressedPubkey.
 * Covers: known-vector correctness, wrong-depth guard, xprv rejection,
 * invalid-index rejection, and deriveCompressedPubkey direct exercise.
 */
import { describe, it, expect } from "vitest";
import { deriveAddress, deriveCompressedPubkey } from "../deriveAddress.js";

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/**
 * Account-0 xpub (depth 3, m/44'/195'/0') from the golden-vector suite.
 * Verified by goldenVectors.test.ts against TronWeb and signer paths.
 */
const ACCOUNT0_XPUB = "xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd";

/**
 * Depth-2 xpub (m/44'/195') — account level NOT reached; depth guard must reject.
 * Derived from the same TEST_MNEMONIC.
 */
const DEPTH2_XPUB = "xpub6AmukNpN4yyVGhtfLdkFSbQuLzNBnEXg6Cpc88AGpboZzy3exPAWoADSsd5GGqNkoxyjBQposb86RoZUNNyXf8kk75QA6AXFUbhChRZoAY2";

/**
 * xprv for account-0 (depth 3, m/44'/195'/0') — contains private key; must be rejected.
 */
const ACCOUNT0_XPRV = "xprv9z1pB5qPNYGMVrGcyXt97Jwd9GBRoNFdhJfxqbHjzrBKeN1GMETuGFi1c73SQkP8kkKz5MVoMtLRcsDWggUcaPF32AXN4qNsNWBoJbaHcQ7";

describe("deriveAddress -- known-vector correctness", () => {
  it("derives the correct address for account=0, index=0", () => {
    expect(deriveAddress(ACCOUNT0_XPUB, 0)).toBe("TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH");
  });

  it("derives the correct address for account=0, index=1", () => {
    expect(deriveAddress(ACCOUNT0_XPUB, 1)).toBe("TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK");
  });

  it("derives the correct address for account=0, index=5", () => {
    expect(deriveAddress(ACCOUNT0_XPUB, 5)).toBe("TBdYXtwq18cAhi1BA574TrP6tw2G86anu1");
  });
});

describe("deriveAddress -- wrong-depth xpub is rejected", () => {
  it("throws SECURITY error on depth-2 xpub (m/44'/195' — account not yet derived)", () => {
    expect(() => deriveAddress(DEPTH2_XPUB, 0)).toThrow(/SECURITY.*depth/i);
  });

  it("throws and does NOT return silently on depth-2 xpub", () => {
    let threw = false;
    try { deriveAddress(DEPTH2_XPUB, 0); }
    catch { threw = true; }
    expect(threw).toBe(true);
  });
});

describe("deriveAddress -- xprv is rejected", () => {
  it("throws SECURITY error when passed a private extended key (xprv)", () => {
    expect(() => deriveAddress(ACCOUNT0_XPRV, 0)).toThrow(/SECURITY/i);
  });
});

describe("deriveAddress -- invalid derivation index is rejected", () => {
  it("throws on negative index", () => {
    expect(() => deriveAddress(ACCOUNT0_XPUB, -1)).toThrow(/non-negative integer/i);
  });

  it("throws on fractional index (1.5)", () => {
    expect(() => deriveAddress(ACCOUNT0_XPUB, 1.5)).toThrow(/non-negative integer/i);
  });

  it("throws on NaN", () => {
    expect(() => deriveAddress(ACCOUNT0_XPUB, NaN)).toThrow(/non-negative integer/i);
  });
});

describe("deriveCompressedPubkey -- direct exercise", () => {
  it("returns a 33-byte Uint8Array for a valid xpub + index", () => {
    const pub = deriveCompressedPubkey(ACCOUNT0_XPUB, 0);
    expect(pub).toBeInstanceOf(Uint8Array);
    expect(pub.length).toBe(33);
  });

  it("compressed pubkey at index=0 matches what deriveAddress internally uses (spot-check prefix byte)", () => {
    const pub = deriveCompressedPubkey(ACCOUNT0_XPUB, 0);
    // secp256k1 compressed public keys are 02 or 03 prefixed
    expect(pub[0] === 0x02 || pub[0] === 0x03).toBe(true);
  });

  it("returns different pubkeys for different indices", () => {
    const pub0 = deriveCompressedPubkey(ACCOUNT0_XPUB, 0);
    const pub1 = deriveCompressedPubkey(ACCOUNT0_XPUB, 1);
    expect(Buffer.from(pub0).toString("hex")).not.toBe(Buffer.from(pub1).toString("hex"));
  });

  it("throws SECURITY error on wrong-depth xpub", () => {
    expect(() => deriveCompressedPubkey(DEPTH2_XPUB, 0)).toThrow(/SECURITY.*depth/i);
  });

  it("throws SECURITY error on xprv", () => {
    expect(() => deriveCompressedPubkey(ACCOUNT0_XPRV, 0)).toThrow(/SECURITY/i);
  });
});
