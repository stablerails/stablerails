import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBase58 } from "./addressCodec.js";

/** BIP32 mainnet xpub version bytes (0x0488B21E). */
const BIP32_MAINNET_PUBLIC = 0x0488b21e;

function assertAccountXpub(node: HDKey): void {
  if (node.privateKey !== null)
    throw new Error("SECURITY: xpubAccount contains a private key -- pass the public xpub only");
  if (node.versions.public !== BIP32_MAINNET_PUBLIC)
    throw new Error("SECURITY: xpubAccount has wrong version bytes (expected mainnet xpub 0x0488b21e, got 0x" + node.versions.public.toString(16) + ")");
  if (node.depth !== 3)
    throw new Error("SECURITY: xpubAccount has wrong depth (expected 3 for m/44'/coin'/account', got " + node.depth + ")");
}

export function deriveAddress(xpubAccount: string, derivationIndex: number): string {
  if (!Number.isInteger(derivationIndex) || derivationIndex < 0)
    throw new Error("derivationIndex must be a non-negative integer, got " + derivationIndex);
  const accountNode = HDKey.fromExtendedKey(xpubAccount);
  assertAccountXpub(accountNode);
  const childNode = accountNode.deriveChild(0).deriveChild(derivationIndex);
  const compressedPub = childNode.publicKey;
  if (compressedPub === null || compressedPub.length !== 33)
    throw new Error("Expected 33-byte compressed public key, got " + (compressedPub?.length ?? "null"));
  const uncompressed = secp256k1.ProjectivePoint.fromHex(compressedPub).toRawBytes(false);
  const hash = keccak_256(uncompressed.subarray(1));
  const raw21 = new Uint8Array(21); raw21[0] = 0x41; raw21.set(hash.subarray(12), 1);
  return hexToBase58(Buffer.from(raw21).toString("hex"));
}
export function deriveCompressedPubkey(xpubAccount: string, derivationIndex: number): Uint8Array {
  const accountNode = HDKey.fromExtendedKey(xpubAccount);
  assertAccountXpub(accountNode);
  const childNode = accountNode.deriveChild(0).deriveChild(derivationIndex);
  const compressedPub = childNode.publicKey;
  if (compressedPub === null || compressedPub.length !== 33) throw new Error("Expected 33-byte compressed public key");
  return compressedPub;
}
