import { describe, it, expect } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { deriveAccountXpub, deriveInvoiceKey, verifyXpubMatch } from "../provision.js";
const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const XPUBS: Record<number, string> = {
  0: "xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd",
  1: "xpub6D1AabNHCupeoA3sb15rvtDPuaeZSRWg39QsynNZQETJfbuy3fFsEqY44mJEP2j4XxLgZUbZZxuFWf67Srqf6Ucu9spE8AmbWZu5ZET1ELw",
  2: "xpub6D1AabNHCupeqrgoiEdCZcrjnb6hCgHHD1kM2Jdjpv9mK3J9RWmPi9gpKedkELpZ8TDgi661K6iXBKtDeTM33Fe7ex5jnEiNj5yFjrprikJ",
};
describe("provision -- deriveAccountXpub", () => {
  it("produces expected xpubs for known accounts", () => {
    for (const [a, xpub] of Object.entries(XPUBS)) {
      const r = deriveAccountXpub(M, parseInt(a, 10)); expect(r.xpub).toBe(xpub); expect(r.account).toBe(parseInt(a, 10));
    }
  });
  it("loaded xpub has privateKey === null", () => {
    for (const a of [0, 1, 2]) expect(HDKey.fromExtendedKey(deriveAccountXpub(M, a).xpub).privateKey).toBeNull();
  });
  it("different accounts produce different xpubs", () => {
    expect(deriveAccountXpub(M, 0).xpub).not.toBe(deriveAccountXpub(M, 1).xpub);
  });
  it("xpub starts with 'xpub'", () => { expect(deriveAccountXpub(M, 0).xpub.startsWith("xpub")).toBe(true); });
  it("throws for negative account", () => { expect(() => deriveAccountXpub(M, -1)).toThrow(/non-negative integer/i); });
  it("throws for non-integer account", () => { expect(() => deriveAccountXpub(M, 1.5)).toThrow(/non-negative integer/i); });
});
describe("provision -- deriveInvoiceKey", () => {
  it("produces 32-byte privkey and 33-byte pubkey", () => {
    const k = deriveInvoiceKey(M, 0, 0); expect(k.privateKey.length).toBe(32); expect(k.publicKey.length).toBe(33);
  });
  it("matches node derived directly from seed", () => {
    const k = deriveInvoiceKey(M, 0, 0);
    const n = HDKey.fromMasterSeed(mnemonicToSeedSync(M)).derive("m/44'/195'/0'/0/0");
    expect(Buffer.from(k.privateKey).toString("hex")).toBe(Buffer.from(n.privateKey!).toString("hex"));
    expect(Buffer.from(k.publicKey).toString("hex")).toBe(Buffer.from(n.publicKey!).toString("hex"));
  });
  it("different indices produce different keys", () => {
    expect(Buffer.from(deriveInvoiceKey(M,0,0).privateKey).toString("hex")).not.toBe(Buffer.from(deriveInvoiceKey(M,0,1).privateKey).toString("hex"));
  });
  it("different accounts produce different keys at same index", () => {
    expect(Buffer.from(deriveInvoiceKey(M,0,0).privateKey).toString("hex")).not.toBe(Buffer.from(deriveInvoiceKey(M,1,0).privateKey).toString("hex"));
  });
  it("throws for negative account", () => { expect(() => deriveInvoiceKey(M, -1, 0)).toThrow(/non-negative integer/i); });
  it("throws for negative index", () => { expect(() => deriveInvoiceKey(M, 0, -1)).toThrow(/non-negative integer/i); });
});
describe("provision -- verifyXpubMatch", () => {
  it("returns true when matches", () => { const { xpub } = deriveAccountXpub(M, 0); expect(verifyXpubMatch(M, 0, xpub)).toBe(true); });
  it("returns false when account differs", () => { const { xpub } = deriveAccountXpub(M, 0); expect(verifyXpubMatch(M, 1, xpub)).toBe(false); });
  it("returns false when xpub is for different account", () => { expect(verifyXpubMatch(M, 0, deriveAccountXpub(M, 1).xpub)).toBe(false); });
});
