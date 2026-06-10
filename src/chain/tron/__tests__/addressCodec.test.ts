import { describe, it, expect } from "vitest";
import { hexToBase58, base58ToHex, isValidBase58Address, isValidHexAddress, normalizeToBase58 } from "../addressCodec.js";
const KV = [
  { hex: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c", base58: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
  { hex: "4177944d19c052b73ee2286823aa83f8138cb7032f", base58: "TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy" },
  { hex: "41517591d35d313bf6a5e33098284502b045e2bc08", base58: "THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC" },
] as const;
const G = { hex: "41c8599111f29c1e1e061265b4af93ea1f274ad78a", base58: "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH" };
describe("addressCodec -- hex <-> Base58Check round-trips", () => {
  it("encodes known hex to correct Base58Check", () => { for (const { hex, base58 } of KV) expect(hexToBase58(hex)).toBe(base58); expect(hexToBase58(G.hex)).toBe(G.base58); });
  it("decodes known Base58Check to correct hex", () => { for (const { hex, base58 } of KV) expect(base58ToHex(base58)).toBe(hex); expect(base58ToHex(G.base58)).toBe(G.hex); });
  it("round-trips hex -> base58 -> hex", () => { for (const { hex } of KV) expect(base58ToHex(hexToBase58(hex))).toBe(hex); expect(base58ToHex(hexToBase58(G.hex))).toBe(G.hex); });
  it("round-trips base58 -> hex -> base58", () => { for (const { base58 } of KV) expect(hexToBase58(base58ToHex(base58))).toBe(base58); expect(hexToBase58(base58ToHex(G.base58))).toBe(G.base58); });
  it("accepts 0x-prefixed hex", () => { expect(hexToBase58("0x" + G.hex)).toBe(G.base58); expect(hexToBase58("0x" + KV[0].hex)).toBe(KV[0].base58); });
});
describe("addressCodec -- checksum verification", () => {
  it("rejects flipped checksum character", () => {
    const last = G.base58[G.base58.length - 1];
    expect(() => base58ToHex(G.base58.slice(0, -1) + (last === "H" ? "G" : "H"))).toThrow(/checksum/i);
  });
  it("rejects invalid Base58 chars", () => {
    expect(() => base58ToHex("TUEZSdKsoDHQMe0wihtdoBiN46zxhGWYdH")).toThrow(/invalid base58/i);
    expect(() => base58ToHex("TUEZSdKsoDHQMeIwihtdoBiN46zxhGWYdH")).toThrow(/invalid base58/i);
  });
  it("rejects wrong prefix byte", () => { expect(() => hexToBase58("42" + G.hex.slice(2))).toThrow(/prefix/i); });
  it("rejects wrong length", () => {
    expect(() => hexToBase58(G.hex.slice(0, -2))).toThrow(/length/i);
    expect(() => hexToBase58(G.hex + "00")).toThrow(/length/i);
  });
});
describe("addressCodec -- validation helpers", () => {
  it("isValidBase58Address true for valid T addresses", () => {
    expect(isValidBase58Address(G.base58)).toBe(true);
    for (const { base58 } of KV) expect(isValidBase58Address(base58)).toBe(true);
  });
  it("isValidBase58Address false for invalid inputs", () => {
    expect(isValidBase58Address("")).toBe(false);
    expect(isValidBase58Address("not-an-address")).toBe(false);
    expect(isValidBase58Address(G.hex)).toBe(false);
  });
  it("isValidHexAddress true for valid 41-prefix hex", () => {
    expect(isValidHexAddress(G.hex)).toBe(true);
    expect(isValidHexAddress("0x" + G.hex)).toBe(true);
  });
  it("isValidHexAddress false for invalid hex", () => {
    expect(isValidHexAddress("")).toBe(false);
    expect(isValidHexAddress(G.base58)).toBe(false);
    expect(isValidHexAddress("0xdeadbeef")).toBe(false);
  });
  it("normalizeToBase58 accepts both forms", () => {
    expect(normalizeToBase58(G.base58)).toBe(G.base58);
    expect(normalizeToBase58(G.hex)).toBe(G.base58);
    expect(normalizeToBase58("0x" + G.hex)).toBe(G.base58);
  });
});
