import { argon2id as nobleArgon2id } from "@noble/hashes/argon2.js";
import argon2 from "argon2";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

// ── KDF version map (TRUSTED, compiled-in) ────────────────────────────────────
// Params are NEVER read from blob.params — an attacker who can edit the blob
// must not be able to downgrade the KDF cost. blob.params is informational only.
//
// v1 (legacy, decrypt-only): pure-JS @noble argon2id at the OWASP minimum.
//    Kept byte-for-byte identical so existing encrypted seeds keep decrypting.
const V1_PARAMS = { m: 19456, t: 2, p: 1, dkLen: 32 } as const;
// v2 (current): NATIVE argon2 (node-argon2) at 64 MiB / t=3 / p=1.
//    The native addon runs on the libuv threadpool — it does NOT block the
//    event loop and takes tens of ms, vs ~2.4 s for the same cost in pure JS.
const V2_PARAMS = { memoryCost: 65536, timeCost: 3, parallelism: 1, hashLength: 32 } as const;

const CURRENT_VERSION = 2;
const KNOWN_VERSIONS = [1, 2] as const;

export interface EncryptedSeedBlob {
  version: number; salt: string; iv: string; ciphertext: string; authTag: string;
  params: { m: number; t: number; p: number; dkLen: number };
}

function deriveKeyV1(passphrase: string, saltHex: string): Promise<Uint8Array> {
  // Legacy pure-JS path. Synchronous (blocks ~1 s) — acceptable for the rare
  // decrypt of an old v1 blob; new blobs always use the native v2 path.
  return Promise.resolve(
    nobleArgon2id(new TextEncoder().encode(passphrase), Uint8Array.from(Buffer.from(saltHex, "hex")), V1_PARAMS),
  );
}

async function deriveKeyV2(passphrase: string, saltHex: string): Promise<Uint8Array> {
  // Native argon2id, raw 32-byte key output (async, off the event loop).
  const key = await argon2.hash(passphrase, {
    type: argon2.argon2id,
    raw: true,
    salt: Buffer.from(saltHex, "hex"),
    ...V2_PARAMS,
  });
  return Uint8Array.from(key);
}

const KDF_BY_VERSION: Record<number, (passphrase: string, saltHex: string) => Promise<Uint8Array>> = {
  1: deriveKeyV1,
  2: deriveKeyV2,
};

export async function encryptSeed(mnemonic: string, passphrase: string): Promise<EncryptedSeedBlob> {
  const saltBytes = randomBytes(32); const ivBytes = randomBytes(12);
  const saltHex = saltBytes.toString("hex"); const ivHex = ivBytes.toString("hex");
  const key = await deriveKeyV2(passphrase, saltHex);
  const cipher = createCipheriv("aes-256-gcm", key, ivBytes);
  const ciphertextBuf = Buffer.concat([cipher.update(Buffer.from(mnemonic, "utf8")), cipher.final()]);
  return { version: CURRENT_VERSION, salt: saltHex, iv: ivHex,
    ciphertext: ciphertextBuf.toString("hex"), authTag: cipher.getAuthTag().toString("hex"),
    // Informational only — decryption uses the compiled-in map keyed by version.
    params: { m: V2_PARAMS.memoryCost, t: V2_PARAMS.timeCost, p: V2_PARAMS.parallelism, dkLen: V2_PARAMS.hashLength } };
}

export async function decryptSeed(blob: EncryptedSeedBlob, passphrase: string): Promise<string> {
  const kdf = KDF_BY_VERSION[blob.version];
  if (!kdf) throw new Error("Unsupported blob version: " + blob.version + " (known versions: " + KNOWN_VERSIONS.join(", ") + ")");
  const authTagBytes = Buffer.from(blob.authTag, "hex");
  if (authTagBytes.length !== 16) throw new Error("SECURITY: authTag must be exactly 16 bytes (got " + authTagBytes.length + ") -- truncated or tampered tag rejected");
  const key = await kdf(passphrase, blob.salt);
  // NOTE: the returned mnemonic is a JS string (immutable; cannot be zeroed). Callers should minimize its lifetime.
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"), { authTagLength: 16 });
  decipher.setAuthTag(authTagBytes);
  try { return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, "hex")), decipher.final()]).toString("utf8"); }
  catch { throw new Error("Decryption failed: wrong passphrase or tampered blob"); }
}
