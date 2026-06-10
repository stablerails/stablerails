/**
 * Tron USDT receipt scanner.
 *
 * Uses /wallet/gettransactioninfobyid (universal full-node endpoint, available
 * on any Tron full-node, not TronGrid-exclusive) to independently verify
 * on-chain tx receipts for both the primary AND secondary providers.
 *
 * SECURITY INVARIANT: the authoritative credit decision comes EXCLUSIVELY from
 * BOTH providers independently parsing the on-chain tx receipt event logs.
 * The TronGrid /v1 indexer is DISCOVERY ONLY (primary) — untrusted for credit.
 *
 * Receipt format verified on real mainnet tx via gettransactioninfobyid:
 *   { blockNumber, receipt:{ result:"SUCCESS"|... }, result?:"FAILED", log?:[...] }
 *
 * Log entry format:
 *   address:  40 hex chars, NO "41" prefix  → prepend "41" → hexToBase58 = contract
 *   topics[0]: Transfer event keccak256 (TRANSFER_EVENT_TOPIC, without 0x)
 *   topics[1]: from — 64 hex; first 24 MUST be zeros; last 40 + "41" → hexToBase58
 *   topics[2]: to   — 64 hex; first 24 MUST be zeros; last 40 + "41" → hexToBase58
 *   data:     amount — exactly 64 hex; BigInt("0x" + data)
 *
 * Hex normalization: an optional leading "0x"/"0X" is stripped (case-insensitive)
 * and the value lowercased on ALL of address, topics[0..2], and data before any
 * validation. After normalization, fields must be STRICT hex
 * (/^[0-9a-f]{40}$/ for address, /^[0-9a-f]{64}$/ for topics and data).
 *
 * Rejection criteria (any of these → skip, never credit; FAIL CLOSED):
 *   - top-level result === "FAILED"
 *   - receipt.result !== "SUCCESS" (absence is NOT acceptance — success must be
 *     positively asserted; a successful USDT transfer always carries
 *     receipt.result === "SUCCESS", verified live)
 *   - log field is not an array / log entry is not an object (malformed receipt
 *     yields "no transfers" — denial-of-credit at worst, never an uncaught throw)
 *   - log address is not strict 40-char hex (after normalization)
 *   - log address → Base58 ≠ TRON_USDT_CONTRACT_BASE58
 *   - topics is not an array of exactly 3 strings
 *   - topics[0] ≠ TRANSFER_EVENT_TOPIC
 *   - topics[1]/[2] not strict 64-char hex, or first 24 hex chars not all zeros
 *   - topics[1]/[2] last 40 chars → not a valid Base58 address
 *   - topics[2] (to) ≠ depositAddressBase58
 *   - data not strict 64-char hex (after normalization)
 *   - amountMicro <= dustThreshold
 */

import type { TronHttpClient } from "../../lib/http.js";
import { TRON_USDT_CONTRACT_BASE58, TRANSFER_EVENT_TOPIC } from "./usdt.js";
import { hexToBase58 } from "./addressCodec.js";

// ── Receipt type definitions ─────────────────────────────────────────────────

export interface TxReceiptLog {
  /** 40 hex chars — NO "41" prefix. */
  address: string;
  /** Array of 64-char hex topic strings (may include 0x prefix on some nodes). */
  topics: string[];
  /** 64-char hex uint256 amount. */
  data: string;
}

export interface TxReceiptMetadata {
  /** "SUCCESS", "REVERT", etc. */
  result?: string;
}

export interface TxReceipt {
  /** Confirmed block height. Absent → tx not yet in a block. */
  blockNumber?: number;
  /** Contract execution receipt. */
  receipt?: TxReceiptMetadata;
  /** Top-level "FAILED" only present on failed transactions. */
  result?: string;
  /** Event logs emitted during contract execution. */
  log?: TxReceiptLog[];
}

// ── Parsed transfer type ─────────────────────────────────────────────────────

export interface ParsedReceiptTransfer {
  /** Position in the receipt's log[] array — authoritative log index. */
  receiptLogIndex: number;
  /** Token contract (Base58) — always TRON_USDT_CONTRACT_BASE58 after parsing. */
  contractBase58: string;
  /** Sender (Base58). */
  fromBase58: string;
  /** Recipient (Base58) — equals depositAddressBase58. */
  toBase58: string;
  /** Transfer amount in micro-USDT (> dustThreshold). */
  amountMicro: bigint;
}

// ── Constants ────────────────────────────────────────────────────────────────

// Transfer event topic without 0x prefix (for comparison with receipt topics).
const TRANSFER_TOPIC_HEX = (
  TRANSFER_EVENT_TOPIC.startsWith("0x")
    ? TRANSFER_EVENT_TOPIC.slice(2)
    : TRANSFER_EVENT_TOPIC
).toLowerCase();

// Strict hex validators (applied AFTER normalizeHex). length checks alone are
// not enough: Buffer.from(..., "hex") silently truncates at the first invalid
// character, so a non-hex "address" or topic could otherwise decode to garbage
// instead of being rejected.
const HEX_40_RE = /^[0-9a-f]{40}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;

const ZERO_PAD_24 = "000000000000000000000000";

/**
 * Normalize an untrusted hex field: must be a string; strip ONE optional
 * leading "0x"/"0X" (case-insensitive); lowercase. Returns null for any
 * non-string input so callers can reject malformed entries uniformly.
 */
function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const stripped =
    value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return stripped.toLowerCase();
}

// ── fetchTransactionReceipt ───────────────────────────────────────────────────

/**
 * Fetch the full transaction receipt from /wallet/gettransactioninfobyid.
 *
 * Returns null when:
 *   - Response is an empty object {} (tx not yet in a block)
 *   - blockNumber field is absent or not a positive number
 *
 * Throws on network/RPC errors — callers must skip the candidate this tick.
 *
 * @param client   TronHttpClient pointing at primary or secondary node.
 * @param txHash   Transaction hash (hex string).
 */
export async function fetchTransactionReceipt(
  client: TronHttpClient,
  txHash: string,
): Promise<TxReceipt | null> {
  const path = `/wallet/gettransactioninfobyid?value=${encodeURIComponent(txHash)}`;
  const { data } = await client.get<TxReceipt>(path);

  // Empty {} means the tx is not yet in a block.
  if (!data || typeof data !== "object" || Object.keys(data as object).length === 0) {
    return null;
  }

  // blockNumber absent or <= 0 means not yet confirmed in a block.
  if (typeof (data as TxReceipt).blockNumber !== "number" || (data as TxReceipt).blockNumber! <= 0) {
    return null;
  }

  return data as TxReceipt;
}

// ── parseUsdtReceiptTransfers ─────────────────────────────────────────────────

/**
 * Parse USDT Transfer events from a confirmed transaction receipt.
 *
 * Applies ALL the format and security checks described in the module header.
 * Returns only log entries that pass every check and target depositAddressBase58.
 *
 * PURE function — no I/O, no side effects.
 *
 * @param receipt               Full receipt from fetchTransactionReceipt.
 * @param depositAddressBase58  Expected recipient address (Base58).
 * @param dustThreshold         Reject transfers with amountMicro <= dustThreshold.
 */
export function parseUsdtReceiptTransfers(
  receipt: TxReceipt,
  depositAddressBase58: string,
  dustThreshold = 0n,
): ParsedReceiptTransfer[] {
  // Reject if transaction failed at the top level.
  if (receipt.result === "FAILED") {
    return [];
  }

  // FAIL CLOSED: success must be POSITIVE. The contract-execution receipt must
  // explicitly carry result === "SUCCESS" (verified live: every successful USDT
  // transfer does). An absent receipt object, absent result, or any other value
  // is NOT creditable evidence → reject the whole tx.
  if (receipt.receipt?.result !== "SUCCESS") {
    return [];
  }

  // A malformed (non-array) log field yields "no transfers", never a throw.
  const logs = Array.isArray(receipt.log) ? receipt.log : [];
  const results: ParsedReceiptTransfer[] = [];

  for (let i = 0; i < logs.length; i++) {
    // Per-log isolation: one malformed log entry must be SKIPPED, not abort
    // crediting for the whole invoice. Worst case is denial-of-credit (the
    // entry is ignored this tick), never an uncaught TypeError.
    try {
      const logEntry = logs[i];

      // Null-safety: log entry must be a real object.
      if (!logEntry || typeof logEntry !== "object") continue;

      // Check 1: address — normalize (optional 0x + lowercase), strict 40-hex
      // (NO "41" prefix).
      const address = normalizeHex(logEntry.address);
      if (!address || !HEX_40_RE.test(address)) continue;

      // Check 2: contract → prepend "41" → decode → must equal pinned USDT contract.
      let contractBase58: string;
      try {
        contractBase58 = hexToBase58("41" + address);
      } catch {
        continue;
      }
      if (contractBase58 !== TRON_USDT_CONTRACT_BASE58) continue;

      // Check 3: topics must be an array of exactly 3 entries.
      if (!Array.isArray(logEntry.topics) || logEntry.topics.length !== 3) continue;

      // Check 4: topics[0] must be the Transfer event hash.
      const topic0 = normalizeHex(logEntry.topics[0]);
      if (!topic0 || topic0 !== TRANSFER_TOPIC_HEX) continue;

      // Check 5: topics[1] = from address — strict 64 hex, first 24 must be zeros.
      const topic1 = normalizeHex(logEntry.topics[1]);
      if (!topic1 || !HEX_64_RE.test(topic1)) continue;
      if (!topic1.startsWith(ZERO_PAD_24)) continue;
      let fromBase58: string;
      try {
        fromBase58 = hexToBase58("41" + topic1.slice(24));
      } catch {
        continue;
      }

      // Check 6: topics[2] = to address — strict 64 hex, first 24 must be zeros.
      const topic2 = normalizeHex(logEntry.topics[2]);
      if (!topic2 || !HEX_64_RE.test(topic2)) continue;
      if (!topic2.startsWith(ZERO_PAD_24)) continue;
      let toBase58: string;
      try {
        toBase58 = hexToBase58("41" + topic2.slice(24));
      } catch {
        continue;
      }

      // Check 7: to address must equal the expected deposit address.
      if (toBase58 !== depositAddressBase58) continue;

      // Check 8: data — normalize (optional 0x + lowercase), strict 64 hex.
      const data = normalizeHex(logEntry.data);
      if (!data || !HEX_64_RE.test(data)) continue;

      // Check 9: parse amount and reject dust.
      let amountMicro: bigint;
      try {
        amountMicro = BigInt("0x" + data);
      } catch {
        continue;
      }
      if (amountMicro <= dustThreshold) continue;

      results.push({
        receiptLogIndex: i,
        contractBase58,
        fromBase58,
        toBase58,
        amountMicro,
      });
    } catch {
      // Unexpected malformation in this log entry — skip it, keep scanning.
      continue;
    }
  }

  return results;
}
