/**
 * Gas wallet derivation — a dedicated TRX wallet derived from the SAME seed
 * as the deposit addresses, at a reserved derivation slot.
 *
 * WHY: Tron fees are paid by the SENDER. Deposit addresses (HD-derived per
 * invoice) receive USDT but hold 0 TRX, so they cannot pay for their own
 * sweep (first-spend account activation ~1.1 TRX + TRC-20 transfer energy,
 * worst case ~30 TRX if burned). The operator pre-funds this gas wallet with
 * TRX; `stablerails gas fund` then tops up deposit addresses before sweeping.
 *
 * RESERVED SLOT: account 2_000_000_000, index 0 — path m/44'/195'/2000000000'/0/0.
 *   - Hardened-safe: BIP32 hardened derivation adds 2^31 to the account number,
 *     so the account must be < 2^31 (2_147_483_648). 2_000_000_000 fits.
 *   - Collision-safe: event derivation accounts are small sequential integers
 *     allocated per event; 2 billion is unreachably far above any realistic
 *     event count, so the gas wallet can never collide with a deposit slot.
 *   - Same seed: one passphrase-gated backup covers deposits AND gas.
 *
 * SECURITY: This module handles private keys — it MUST NOT be imported by
 * src/server/** or src/workers/** (ESLint boundary, same as the rest of
 * src/signer/). The private key is derived in-memory after the operator's
 * TTY passphrase and is never logged or persisted.
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { hexToBase58 } from "../chain/tron/addressCodec.js";
import { deriveInvoiceKey } from "./provision.js";

/** Reserved HD account for the gas wallet. See module doc for the rationale. */
export const GAS_WALLET_ACCOUNT = 2_000_000_000;

/** Reserved HD index for the gas wallet (single wallet — always 0). */
export const GAS_WALLET_INDEX = 0;

/** Full derivation path of the gas wallet (display/documentation). */
export const GAS_WALLET_PATH = `m/44'/195'/${GAS_WALLET_ACCOUNT}'/0/${GAS_WALLET_INDEX}`;

export interface GasWallet {
  /** Tron Base58Check address (T...). */
  address: string;
  /** 32-byte secp256k1 private key. NEVER log or persist. */
  privateKey: Uint8Array;
}

/**
 * Compute a Tron Base58 address from a 33-byte compressed secp256k1 pubkey.
 * Same algorithm as src/chain/tron/deriveAddress.ts: keccak256(uncompressed
 * pubkey without the 0x04 prefix), last 20 bytes, 0x41 prefix, Base58Check.
 */
function pubkeyToTronAddress(compressedPub: Uint8Array): string {
  const uncompressed = secp256k1.ProjectivePoint.fromHex(compressedPub).toRawBytes(false);
  const hash = keccak_256(uncompressed.subarray(1));
  const raw21 = new Uint8Array(21);
  raw21[0] = 0x41;
  raw21.set(hash.subarray(12), 1);
  return hexToBase58(Buffer.from(raw21).toString("hex"));
}

/**
 * Derive the gas wallet from the seed mnemonic at the reserved slot.
 *
 * @param mnemonic  Decrypted seed mnemonic (from decryptSeed after TTY passphrase).
 * @returns         Gas wallet address + private key (in-memory only).
 */
export function deriveGasWallet(mnemonic: string): GasWallet {
  const key = deriveInvoiceKey(mnemonic, GAS_WALLET_ACCOUNT, GAS_WALLET_INDEX);
  return {
    address: pubkeyToTronAddress(key.publicKey),
    privateKey: key.privateKey,
  };
}
