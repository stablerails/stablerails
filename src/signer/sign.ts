/**
 * Offline signer for TRC-20 transfers.
 *
 * SECURITY: This module handles private keys — it MUST NOT be imported by
 * src/server/** or src/workers/**. ESLint enforces this boundary.
 *
 * Takes a derived private key + a signable transaction object and produces a
 * signed transaction ready for broadcast.
 *
 * In production the unsigned transaction object (with txID) comes from the
 * Tron full node via a `triggerSmartContract` API call. For our sweep flow:
 *   - Server prepares SweepIntent (addresses + amounts, NO keys)
 *   - CLI fetches intent, calls `triggerSmartContract` on a full node to get
 *     the real tx object with a real txID, then calls signTransfer() here.
 * For offline tests a mock txID derived from transfer params is used.
 */

import { createHash } from "node:crypto";
import TronWeb from "tronweb";
import type { UnsignedTrc20Transfer } from "../chain/tron/buildTransfer.js";
import type { SignedTronTransaction } from "../chain/tron/broadcast.js";

/**
 * A Tron transaction object ready to be signed.
 * In production this comes from the full node's triggerSmartContract response.
 */
export interface SignableTx {
  /** Transaction ID (hex, 64 chars). In production = SHA256(raw_data_pb). */
  txID: string;
  /** Protobuf-serialized raw_data as hex. In production = real bytes from node. */
  raw_data_hex: string;
  /** Decoded raw_data object. Opaque to the signer — broadcast needs it. */
  raw_data: unknown;
  /** Optional fields from the full node response. */
  [key: string]: unknown;
}

/**
 * Sign a TRC-20 transfer offline.
 *
 * @param privateKey  32-byte private key derived from the HD wallet.
 * @param signableTx  The transaction object containing the txID to sign.
 *                    The signer uses only the txID bytes — no network call.
 * @returns           Signed transaction ready for broadcast.
 *
 * @throws            If privateKey length is wrong or signing fails.
 */
export function signTransfer(
  privateKey: Uint8Array,
  signableTx: SignableTx,
): SignedTronTransaction {
  if (privateKey.length !== 32) {
    throw new Error(
      `signTransfer: expected 32-byte private key, got ${privateKey.length}`,
    );
  }

  // Validate txID looks like a 64-char hex string.
  if (!/^[0-9a-fA-F]{64}$/.test(signableTx.txID)) {
    throw new Error(
      `signTransfer: txID must be a 64-char hex string, got "${signableTx.txID}"`,
    );
  }

  const privKeyHex = Buffer.from(privateKey).toString("hex");

  // TronWeb.utils.crypto.signTransaction: signs txID bytes with the private key
  // via ECDSA secp256k1. Pure offline — no network call.
  const signed = TronWeb.utils.crypto.signTransaction(privKeyHex, {
    ...signableTx,
    signature: [],
  }) as SignedTronTransaction;

  if (!Array.isArray(signed.signature) || signed.signature.length === 0) {
    throw new Error("signTransfer: signature was not produced");
  }

  return signed;
}

/**
 * Build a deterministic mock txID for offline tests.
 *
 * This is NOT a real Tron txID (which requires a node call).
 * Use only in tests/mocks where a real node is unavailable.
 *
 * @param transfer  The unsigned transfer params.
 * @param nonce     Differentiates multiple transfers in a batch.
 */
export function buildMockTxId(
  transfer: UnsignedTrc20Transfer,
  nonce: number = 0,
): string {
  const input = [
    transfer.fromAddressHex,
    transfer.toAddressHex,
    transfer.amountMicro.toString(),
    transfer.callData,
    String(nonce),
  ].join(":");
  return createHash("sha256").update(input).digest("hex");
}

/**
 * SIGN-3 safety: detect a stub/mock SignableTx by inspecting raw_data.
 *
 * A mock tx produced by buildMockTxId has raw_data.contract = [] (empty array).
 * A real Tron full-node tx always has at least one contract entry in raw_data.contract.
 */
function isMockSignableTx(signableTx: SignableTx): boolean {
  const rawData = signableTx.raw_data as Record<string, unknown> | null | undefined;
  if (!rawData) return true; // no raw_data is also a stub
  const contract = rawData["contract"];
  return Array.isArray(contract) && contract.length === 0;
}

/**
 * Detect whether the live-broadcast environment is configured.
 *
 * Canonical env name: TRON_RPC_PRIMARY_URL — matches the worker, .env.example
 * and docker-compose naming. Legacy fallback: TRON_RPC_PRIMARY (pre-go-live
 * CLI naming), kept so existing operator setups keep working.
 *
 * Used by every SIGN-3 live-path gate — if it returned false while the CLI
 * considered itself live, the mock-tx and sha256 guards would silently no-op,
 * so this MUST recognize the same env names the CLI uses for its live gate.
 */
export function isLiveBroadcastEnv(): boolean {
  return Boolean(
    process.env["TRON_RPC_PRIMARY_URL"] || process.env["TRON_RPC_PRIMARY"],
  );
}

/**
 * SIGN-3 safety guard: on the live broadcast path (TRON_RPC_PRIMARY_URL or
 * legacy TRON_RPC_PRIMARY set), refuse to sign/broadcast a mock or stub
 * transaction.
 *
 * Call this BEFORE signTransfer() on the live path. Throws if the tx
 * was not produced by a real Tron full node (detected by empty raw_data.contract).
 *
 * Safe to call on the dry-run path (no live RPC env) — is a no-op there.
 *
 * @throws Error  If the live RPC env is set and the tx looks like a mock/stub.
 */
export function assertNotMockTxIdOnLivePath(signableTx: SignableTx): void {
  if (!isLiveBroadcastEnv()) {
    // Dry-run / sign-only mode — mock txIDs are acceptable.
    return;
  }
  if (isMockSignableTx(signableTx)) {
    throw new Error(
      "refusing to broadcast a mock/unverified transaction — " +
        "live node txID derivation not wired: raw_data.contract is empty. " +
        "Go-live step: call triggerSmartContract on a real Tron full node " +
        "to obtain a real txID + raw_data before signing.",
    );
  }
}

/**
 * SIGN-3 verification: assert that a txID equals SHA256(raw_data_hex bytes).
 *
 * On a real Tron transaction the txID is the SHA256 hash of the protobuf-encoded
 * raw_data. This check guards against a tampered or fabricated txID being signed.
 *
 * Call this on the live path after obtaining the tx from the full node.
 *
 * @param txID          64-char hex transaction ID.
 * @param raw_data_hex  Hex-encoded raw_data bytes (from the full node response).
 * @throws Error        If txID !== sha256(raw_data_hex bytes).
 */
export function verifyTxIdMatchesRawData(txID: string, raw_data_hex: string): void {
  const rawBytes = raw_data_hex.length === 0
    ? Buffer.alloc(0)
    : Buffer.from(raw_data_hex, "hex");
  const expected = createHash("sha256").update(rawBytes).digest("hex");
  if (txID !== expected) {
    throw new Error(
      `txID does not match sha256(raw_data_hex): ` +
        `expected=${expected}, got=${txID}. ` +
        `This may indicate a tampered or fabricated transaction — refusing to sign.`,
    );
  }
}

/**
 * SIGN-3 verification: assert the JSON raw_data object re-serializes (via
 * tronweb's protobuf encoder) to the exact bytes whose sha256 is txID.
 *
 * Why this matters: the signer signs txID = sha256(raw_data_hex). All semantic
 * checks (destination / amount / contract / owner) inspect the JSON raw_data —
 * WITHOUT this binding a malicious node could return honest-looking JSON
 * alongside a raw_data_hex that protobuf-encodes a DIFFERENT transfer, and the
 * signature would authorize the evil bytes. txCheck re-encodes the JSON
 * raw_data and compares the resulting txID, closing that JSON/bytes split.
 *
 * Combine with verifyTxIdMatchesRawData (txID = sha256(raw_data_hex)): the two
 * together prove raw_data_hex == protobuf(raw_data JSON), so verifying the
 * JSON fields verifies the signed bytes.
 *
 * @throws Error  If raw_data does not re-serialize to txID, or is malformed.
 */
export function verifyRawDataBindsToTxId(signableTx: SignableTx): void {
  let ok = false;
  try {
    ok = TronWeb.utils.transaction.txCheck(signableTx as unknown as Record<string, unknown>);
  } catch {
    ok = false; // malformed/unknown contract shape — fail closed
  }
  if (!ok) {
    throw new Error(
      "raw_data does not re-serialize to the bytes behind txID — the node's " +
        "JSON raw_data and raw_data_hex describe different transactions. " +
        "Refusing to sign (possible malicious node response).",
    );
  }
}
