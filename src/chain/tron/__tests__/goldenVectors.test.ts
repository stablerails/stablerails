/**
 * M6 GOLDEN VECTOR TEST -- mandatory per spec section 12.
 * 6 (account, index) pairs verified three independent ways.
 * PERMANENT -- do NOT modify without spec approval.
 */
import { describe, it, expect } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import TronWeb from "tronweb";
import { deriveAddress } from "../deriveAddress.js";
import { deriveAccountXpub, deriveInvoiceKey } from "../../../signer/provision.js";
import { hexToBase58 } from "../addressCodec.js";

const TEST_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GV = [
  { account: 0, index:  0, xpub: "xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd", expectedAddress: "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH" },
  { account: 0, index:  1, xpub: "xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd", expectedAddress: "TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK" },
  { account: 0, index:  5, xpub: "xpub6D1AabNHCupeiLM65ZR9UStMhJ1vCpyV4XbZdyhMZBiJXALQtmn9p42VTQckoHVn8WNqS7dqnJokZHAHcHGoaQgmv8D45oNUKx6DZMNZBCd", expectedAddress: "TBdYXtwq18cAhi1BA574TrP6tw2G86anu1" },
  { account: 1, index:  0, xpub: "xpub6D1AabNHCupeoA3sb15rvtDPuaeZSRWg39QsynNZQETJfbuy3fFsEqY44mJEP2j4XxLgZUbZZxuFWf67Srqf6Ucu9spE8AmbWZu5ZET1ELw",  expectedAddress: "TLrpNTBuCpGMrB9TyVwgEhNVRhtWEQPHh4" },
  { account: 1, index:  3, xpub: "xpub6D1AabNHCupeoA3sb15rvtDPuaeZSRWg39QsynNZQETJfbuy3fFsEqY44mJEP2j4XxLgZUbZZxuFWf67Srqf6Ucu9spE8AmbWZu5ZET1ELw",  expectedAddress: "TCLAUiJ8Y1B7Q4RJgddEZ3cjmMXCUw8rSb" },
  { account: 2, index: 10, xpub: "xpub6D1AabNHCupeqrgoiEdCZcrjnb6hCgHHD1kM2Jdjpv9mK3J9RWmPi9gpKedkELpZ8TDgi661K6iXBKtDeTM33Fe7ex5jnEiNj5yFjrprikJ", expectedAddress: "TB1DK2ho5YSaSZfPRhvkQSoV1m9PupK7MT" },
] as const;

function addrFromPub(pub: Uint8Array): string {
  const hash = keccak_256(secp256k1.ProjectivePoint.fromHex(pub).toRawBytes(false).subarray(1));
  const r = new Uint8Array(21); r[0] = 0x41; r.set(hash.subarray(12), 1);
  return hexToBase58(Buffer.from(r).toString("hex"));
}

describe("M6 Golden Vectors -- 3-way byte-identical Tron address derivation", () => {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC));
  for (const v of GV) {
    const lbl = "account=" + v.account + " index=" + v.index;
    it("[" + lbl + "] all three paths derive " + v.expectedAddress, () => {
      const { xpub } = deriveAccountXpub(TEST_MNEMONIC, v.account);
      expect(xpub).toBe(v.xpub);
      const watcherAddr = deriveAddress(xpub, v.index);
      const ik = deriveInvoiceKey(TEST_MNEMONIC, v.account, v.index);
      const signerAddr = addrFromPub(ik.publicKey);
      const tronwebAddr = TronWeb.address.fromPrivateKey(Buffer.from(ik.privateKey).toString("hex"));
      expect(watcherAddr).toBe(v.expectedAddress);
      expect(signerAddr).toBe(v.expectedAddress);
      expect(tronwebAddr).toBe(v.expectedAddress);
      expect(watcherAddr).toBe(signerAddr); expect(signerAddr).toBe(tronwebAddr);
    });
    it("[" + lbl + "] watch-only xpub has privateKey === null", () => {
      expect(HDKey.fromExtendedKey(deriveAccountXpub(TEST_MNEMONIC, v.account).xpub).privateKey).toBeNull();
    });
  }
  it("hardened derivation from xpub throws", () => {
    const n = HDKey.fromExtendedKey(deriveAccountXpub(TEST_MNEMONIC, 0).xpub);
    expect(() => n.deriveChild(0x80000000)).toThrow();
    expect(() => n.deriveChild(0x80000001)).toThrow();
  });
  it("full-path derive matches stepwise deriveChild", () => {
    const f = root.derive("m/44'/195'/0'/0/0");
    const s = root.deriveChild(0x80000000+44).deriveChild(0x80000000+195).deriveChild(0x80000000+0).deriveChild(0).deriveChild(0);
    expect(Buffer.from(f.publicKey!).toString("hex")).toBe(Buffer.from(s.publicKey!).toString("hex"));
  });
});
describe("M6 Golden Vectors -- summary (tabular evidence)", () => {
  it("prints all 6 vectors with 3-way match confirmation", () => {
    const results: string[] = [];
    for (const v of GV) {
      const xpub = deriveAccountXpub(TEST_MNEMONIC, v.account).xpub;
      const wa = deriveAddress(xpub, v.index);
      const ik = deriveInvoiceKey(TEST_MNEMONIC, v.account, v.index);
      const sa = addrFromPub(ik.publicKey);
      const ta = TronWeb.address.fromPrivateKey(Buffer.from(ik.privateKey).toString("hex"));
      const ok = wa === sa && sa === ta && wa === v.expectedAddress;
      results.push("  account=" + v.account + " index=" + String(v.index).padStart(2) + ": " + wa + "  match=" + ok);
      expect(ok).toBe(true);
    }
    // eslint-disable-next-line no-console
    console.log("\nGolden Vector Results (Watcher == Signer == TronWeb):");
    // eslint-disable-next-line no-console
    for (const l of results) console.log(l);
  });
});
