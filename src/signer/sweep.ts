/**
 * Local sweep executor.
 *
 * SECURITY CRITICAL — enforced by ESLint:
 *   - This file MUST NOT be imported by src/server/** or src/workers/**
 *   - The passphrase MUST come from a TTY prompt — never a CLI flag, env var,
 *     MCP tool parameter, or anything an automated agent can supply.
 *   - Private keys are derived in memory and never persisted or logged.
 *
 * Flow:
 *   1. Decrypt seed (AES-256-GCM + Argon2id) using the human-supplied passphrase.
 *   2. For each SweepItem, derive the address's private key from the HD wallet
 *      at the path m/44'/195'/<account>'/0/<index>.
 *   3. Build a SignableTx for the item (in production: from node; in tests: mock).
 *   4. Sign offline via signTransfer().
 *   5. Broadcast via the injected broadcast function.
 *   6. Return per-address results (txHash or error).
 */

import { decryptSeed } from "./seed.js";
import { deriveInvoiceKey } from "./provision.js";
import {
  signTransfer,
  assertNotMockTxIdOnLivePath,
  verifyTxIdMatchesRawData,
  isLiveBroadcastEnv,
} from "./sign.js";
import type { SignableTx } from "./sign.js";
import type { EncryptedSeedBlob } from "./seed.js";
import type { SignedTronTransaction, BroadcastResult } from "../chain/tron/broadcast.js";
import type { UnsignedTrc20Transfer } from "../chain/tron/buildTransfer.js";

// ── Domain types ─────────────────────────────────────────────────────────────

/** One address entry from a SweepIntent. */
export interface SweepItem {
  /** Deposit address (Base58). */
  address: string;
  /** HD derivation account (matches the event's derivationAccount). */
  account: number;
  /** HD derivation index (matches the invoice's derivationIndex). */
  index: number;
  /** Amount to sweep in micro-USDT (bigint). */
  amountMicro: bigint;
  /** Unsigned TRC-20 payload used by the CLI live path to call triggerSmartContract. */
  unsignedTx?: UnsignedTrc20Transfer;
  /** Pre-built unsigned transaction (txID + raw_data). From server prepare. */
  signableTx: SignableTx;
}

/** A SweepIntent as returned from POST /v1/sweeps/prepare. */
export interface SweepIntent {
  id: string;
  eventId: string;
  status: "prepared" | "broadcasting" | "done" | "failed";
  items: SweepItem[];
  createdAt: string;
}

/** Result for a single address in the sweep. */
export interface SweepItemResult {
  address: string;
  txHash: string | null;
  success: boolean;
  error?: string;
}

/** Aggregate result from executeSweep(). */
export interface SweepResult {
  intentId: string;
  results: SweepItemResult[];
  /** Count of addresses where broadcast succeeded. */
  succeeded: number;
  /** Count of addresses where broadcast failed. */
  failed: number;
}

// ── Injected dependencies ─────────────────────────────────────────────────────

/**
 * Injectable broadcast function — real adapter uses broadcastTransaction from
 * src/chain/tron/broadcast.ts; tests inject a mock that captures signed txs.
 */
export type BroadcastFn = (
  signedTx: SignedTronTransaction,
) => Promise<BroadcastResult>;

/**
 * Injectable signable-tx builder. In production this would call the full node's
 * triggerSmartContract to get a real txID + raw_data_hex. In tests we use the
 * mock builder from sign.ts.
 */
export type BuildSignableTxFn = (item: SweepItem) => Promise<SignableTx>;

export interface ExecuteSweepOpts {
  /** Encrypted seed blob (persisted locally by the operator). */
  encryptedSeed: EncryptedSeedBlob;
  /** Passphrase — MUST be supplied by a human via TTY prompt. Never logged. */
  passphrase: string;
  /** How to broadcast a signed tx (injected for testability). */
  broadcast: BroadcastFn;
  /**
   * How to build the signable tx for each item.
   * In production: calls triggerSmartContract on a Tron full node.
   * In tests: uses buildMockTxId + constructs a mock SignableTx.
   */
  buildSignableTx: BuildSignableTxFn;
}

// ── Core executor ─────────────────────────────────────────────────────────────

/**
 * Execute a sweep intent locally.
 *
 * The passphrase is used only to decrypt the seed; it is not stored or logged.
 * Each private key is derived in memory, used once for signing, and then the
 * reference goes out of scope (JS strings are immutable and GC'd; we cannot
 * zero them, so callers should minimize the passphrase's lifetime).
 *
 * @throws  If the passphrase is wrong (decryptSeed will throw).
 * @throws  If any item has an invalid account/index.
 */
export async function executeSweep(
  intent: SweepIntent,
  opts: ExecuteSweepOpts,
): Promise<SweepResult> {
  const { encryptedSeed, passphrase, broadcast, buildSignableTx } = opts;

  // Step 1: Decrypt seed. Will throw on wrong passphrase.
  // NOTE: mnemonic is a JS string — immutable, cannot be zeroed.
  const mnemonic = await decryptSeed(encryptedSeed, passphrase);

  const results: SweepItemResult[] = [];

  for (const item of intent.items) {
    try {
      // Step 2: Derive the private key for this address.
      const invoiceKey = deriveInvoiceKey(mnemonic, item.account, item.index);

      // Step 3: Build the signable tx (real node call in production, mock in tests).
      const signableTx = await buildSignableTx(item);

      // SIGN-3: on the live path (TRON_RPC_PRIMARY_URL / legacy TRON_RPC_PRIMARY
      // set), refuse to sign a mock or stub transaction (raw_data.contract
      // empty). Throws before any signing so a fabricated txID can never be
      // broadcast. No-op on dry-run (no live RPC env).
      assertNotMockTxIdOnLivePath(signableTx);
      // SIGN-3: verify the txID matches sha256(raw_data_hex) — guards against a
      // tampered or fabricated txID being signed.
      // This will also reject the mock tx on the live path (correct behavior:
      // raw_data_hex is callData, not protobuf; only a real node-derived tx
      // passes — see the live buildSignableTx in src/cli/commands/sweep.ts).
      // No-op when the live RPC env is unset (skip sha256 check on dry-run).
      if (isLiveBroadcastEnv()) {
        verifyTxIdMatchesRawData(signableTx.txID, signableTx.raw_data_hex);
      }

      // Step 4: Sign offline.
      const signedTx = signTransfer(invoiceKey.privateKey, signableTx);

      // Step 5: Broadcast.
      const broadcastResult = await broadcast(signedTx);

      results.push({
        address: item.address,
        txHash: broadcastResult.txId,
        success: broadcastResult.success,
        error: broadcastResult.error,
      });
    } catch (err) {
      results.push({
        address: item.address,
        txHash: null,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  return {
    intentId: intent.id,
    results,
    succeeded,
    failed,
  };
}
