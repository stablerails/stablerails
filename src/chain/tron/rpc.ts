/**
 * Two-RPC agreement helpers for Tron transfer scanning.
 *
 * CHARTER: On disagreement between providers → DO NOT credit + alert (log).
 * Agreement = same (txHash, logIndex, to, value).
 *
 * NOTE: `fetchAgreedTransfers` has been removed (M-6 fix). It was dead code with
 * the same blockNumber bug as transferScan.ts (it derived blockNumber from
 * BigInt(raw.block_timestamp) — same class of error: mainnet timestamp >> solid
 * block height). The watcher implements the two-RPC agreement directly in
 * processInvoice, which is the only path that actually runs in production.
 *
 * This file retains `CanonicalTransfer` (for tests) and `transfersAgree`
 * (the pure agreement predicate used in rpc.test.ts).
 */

import { normalizeToBase58 } from "./addressCodec.js";

// ── Canonical transfer shape ──────────────────────────────────────────────────

/**
 * A transfer record reduced to the fields that BOTH providers must agree on
 * for us to credit the payment.
 */
export interface CanonicalTransfer {
  txHash: string;
  logIndex: number;
  /** Recipient address normalized to Base58. */
  to: string;
  /** Transfer value as decimal string (micro-USDT). */
  value: string;
  blockNumber: bigint;
  blockHash: string;
  fromAddress: string;
}

// ── Agreement key ─────────────────────────────────────────────────────────────

function agreementKey(t: CanonicalTransfer): string {
  // Key on the four fields the charter specifies: txHash, logIndex, to, value
  return `${t.txHash}:${t.logIndex}:${t.to}:${t.value}`;
}

/**
 * Check if TWO individual canonical transfers agree on the key fields.
 * Used in tests to verify the agreement function directly.
 */
export function transfersAgree(a: CanonicalTransfer, b: CanonicalTransfer): boolean {
  return agreementKey(a) === agreementKey(b);
}

// Keep normalizeToBase58 imported so the module compiles (used by toCanonical if re-added).
void normalizeToBase58;
