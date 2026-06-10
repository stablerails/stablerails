import { describe, it, expect } from "vitest";
import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import { randomBytes, createCipheriv } from "node:crypto";
import { encryptSeed, decryptSeed, type EncryptedSeedBlob } from "../seed.js";
const M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const P = "test-passphrase-123"; const WRONG = "wrong-passphrase-XYZ";

// Hand-built v1 blob: replicates the legacy pure-JS algorithm byte-for-byte
// (noble argon2id m=19456/t=2/p=1 + AES-256-GCM) — proves old seeds still decrypt.
const V1_PARAMS = { m: 19456, t: 2, p: 1, dkLen: 32 } as const;
function buildV1Blob(mnemonic: string, passphrase: string): EncryptedSeedBlob {
  const saltBytes = randomBytes(32); const ivBytes = randomBytes(12);
  const saltHex = saltBytes.toString("hex");
  const key = nobleArgon2id(new TextEncoder().encode(passphrase), Uint8Array.from(saltBytes), V1_PARAMS);
  const cipher = createCipheriv("aes-256-gcm", key, ivBytes);
  const ciphertextBuf = Buffer.concat([cipher.update(Buffer.from(mnemonic, "utf8")), cipher.final()]);
  return { version: 1, salt: saltHex, iv: ivBytes.toString("hex"),
    ciphertext: ciphertextBuf.toString("hex"), authTag: cipher.getAuthTag().toString("hex"),
    params: { ...V1_PARAMS } };
}

describe("seed -- encrypt/decrypt round-trip (v2 native argon2)", () => {
  it("decrypts to original mnemonic", async () => { expect(await decryptSeed(await encryptSeed(M, P), P)).toBe(M); });
  it("works for 24-word mnemonic", async () => {
    const m24 = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";
    expect(await decryptSeed(await encryptSeed(m24, P), P)).toBe(m24);
  });
  it("works with special-char passphrase", async () => { const sp = "p@$$w0rd!#%^&*()"; expect(await decryptSeed(await encryptSeed(M, sp), sp)).toBe(M); });
});
describe("seed -- v1 legacy blob backward compatibility", () => {
  it("decrypts a hand-built v1 blob (legacy noble argon2id path)", async () => {
    const v1Blob = buildV1Blob(M, P);
    expect(v1Blob.version).toBe(1);
    expect(await decryptSeed(v1Blob, P)).toBe(M);
  });
  it("rejects wrong passphrase on a v1 blob", async () => {
    await expect(decryptSeed(buildV1Blob(M, P), WRONG)).rejects.toThrow(/decryption failed/i);
  });
});
describe("seed -- wrong passphrase MUST fail", () => {
  it("throws on wrong passphrase", async () => { await expect(decryptSeed(await encryptSeed(M, P), WRONG)).rejects.toThrow(/decryption failed/i); });
  it("throws on empty when non-empty used", async () => { await expect(decryptSeed(await encryptSeed(M, P), "")).rejects.toThrow(/decryption failed/i); });
  it("throws on non-empty when empty used", async () => { await expect(decryptSeed(await encryptSeed(M, ""), P)).rejects.toThrow(/decryption failed/i); });
});
describe("seed -- tampered blob MUST fail", () => {
  it("throws when ciphertext modified", async () => {
    const blob = await encryptSeed(M, P); const ct = Buffer.from(blob.ciphertext, "hex"); ct[0] = ct[0]! ^ 0xff;
    await expect(decryptSeed({ ...blob, ciphertext: ct.toString("hex") }, P)).rejects.toThrow(/decryption failed/i);
  });
  it("throws when authTag modified", async () => {
    const blob = await encryptSeed(M, P); const tag = Buffer.from(blob.authTag, "hex"); tag[0] = tag[0]! ^ 0x01;
    await expect(decryptSeed({ ...blob, authTag: tag.toString("hex") }, P)).rejects.toThrow(/decryption failed/i);
  });
  it("throws on unsupported version with known versions listed", async () => {
    await expect(decryptSeed({ ...(await encryptSeed(M, P)), version: 99 } as EncryptedSeedBlob, P))
      .rejects.toThrow(/Unsupported blob version: 99.*known versions: 1, 2/i);
  });
  it("throws SECURITY error on 8-byte (truncated) authTag", async () => {
    const blob = await encryptSeed(M, P);
    // Truncate the 16-byte tag to 8 bytes — simulates a tag-length downgrade attack
    const truncatedTag = Buffer.from(blob.authTag, "hex").subarray(0, 8).toString("hex");
    await expect(decryptSeed({ ...blob, authTag: truncatedTag }, P)).rejects.toThrow(/SECURITY.*authTag.*16 bytes/i);
  });
});
describe("seed -- anti-downgrade: blob.params is informational only", () => {
  it("ignores attacker-weakened params and still decrypts via trusted map", async () => {
    const blob = await encryptSeed(M, P);
    // Attacker rewrites params to trivially weak values; decryptSeed must use
    // the compiled-in per-version params and succeed regardless.
    const weakened: EncryptedSeedBlob = { ...blob, params: { m: 8, t: 1, p: 1, dkLen: 32 } };
    expect(await decryptSeed(weakened, P)).toBe(M);
  });
  it("ignores weakened params on a v1 blob too", async () => {
    const v1Blob = buildV1Blob(M, P);
    const weakened: EncryptedSeedBlob = { ...v1Blob, params: { m: 8, t: 1, p: 1, dkLen: 32 } };
    expect(await decryptSeed(weakened, P)).toBe(M);
  });
});
describe("seed -- blob structure and freshness", () => {
  it("has all required fields with correct v2 Argon2id params", async () => {
    const b = await encryptSeed(M, P);
    expect(b.version).toBe(2); expect(b.params.m).toBe(65536); expect(b.params.t).toBe(3);
    expect(b.params.p).toBe(1); expect(b.params.dkLen).toBe(32);
  });
  it("salt = 64 hex chars (32 bytes)", async () => { expect((await encryptSeed(M, P)).salt).toHaveLength(64); });
  it("IV = 24 hex chars (12 bytes)", async () => { expect((await encryptSeed(M, P)).iv).toHaveLength(24); });
  it("authTag = 32 hex chars (16 bytes)", async () => { expect((await encryptSeed(M, P)).authTag).toHaveLength(32); });
  it("generates fresh salt + IV on each call", async () => {
    const b1 = await encryptSeed(M, P); const b2 = await encryptSeed(M, P);
    expect(b1.salt).not.toBe(b2.salt); expect(b1.iv).not.toBe(b2.iv); expect(b1.ciphertext).not.toBe(b2.ciphertext);
    expect(await decryptSeed(b1, P)).toBe(M); expect(await decryptSeed(b2, P)).toBe(M);
  });
  it("is JSON round-trip serializable", async () => {
    expect(await decryptSeed(JSON.parse(JSON.stringify(await encryptSeed(M, P))) as EncryptedSeedBlob, P)).toBe(M);
  });
});
