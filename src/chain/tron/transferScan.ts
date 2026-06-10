/**
 * TRC-20 USDT transfer scanner for a deposit address.
 *
 * Polls TronGrid /v1/accounts/{addr}/transactions/trc20 with:
 *   - contract_address = TRON_USDT_CONTRACT_BASE58
 *   - only_confirmed=false (so 0-conf is visible)
 *   - min_timestamp cursor for incremental polling
 *
 * CHARTER: Reject dust/zero-value/fake-contract. Address normalization is
 * applied on BOTH sides before matching `to` field.
 *
 * Returns raw transfer rows; callers (watcher.ts) apply filtering.
 *
 * BLOCK NUMBER STRATEGY (M-1 fix):
 *   TronGrid's /v1/accounts/{addr}/transactions/trc20 does NOT return a block
 *   number. Deriving it from block_timestamp (timestamp/3000) yields ~593_000_000
 *   at mainnet-current-time while latestSolidBlock is ~83_000_000 — the gate
 *   blockNumber <= latestSolidBlock is permanently FALSE, so no invoice ever pays.
 *
 *   Fix: the watcher obtains the REAL block number from the dual-receipt path
 *   (fetchTransactionReceipt in receiptScan.ts, /wallet/gettransactioninfobyid)
 *   and never derives it from timestamps on the finality path.
 */

import type { TronHttpClient } from "../../lib/http.js";
import { TRON_USDT_CONTRACT_BASE58 } from "./usdt.js";
import { normalizeToBase58 } from "./addressCodec.js";
import { formatMicro } from "../../lib/decimal.js";

// ── TronGrid response shapes ──────────────────────────────────────────────────

export interface TronTrc20TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
  name: string;
  /** Log index within the transaction (TronGrid-specific extension). */
  log_index?: number;
}

export interface TronTrc20Transfer {
  transaction_id: string;
  /** ISO8601 or block_timestamp in ms */
  block_timestamp: number;
  /** Block hash (may be absent in unconfirmed). */
  block_hash?: string;
  /** Sender address (may be hex or Base58). */
  from: string;
  /** Recipient address (may be hex or Base58). */
  to: string;
  /** Amount as decimal string (in the token's smallest unit — micro-USDT). */
  value: string;
  token_info?: TronTrc20TokenInfo;
}

interface TronTrc20TransferResponse {
  data?: TronTrc20Transfer[];
  meta?: {
    at?: number;
    page_size?: number;
    fingerprint?: string;
  };
  success?: boolean;
  Error?: string;
}

// ── Normalized transfer ───────────────────────────────────────────────────────

/**
 * A normalized TRC-20 transfer record ready for the watcher to process.
 */
export interface NormalizedTransfer {
  txHash: string;
  /** Log index within the transaction (0 if not present). */
  logIndex: number;
  /** Block number (as bigint). */
  blockNumber: bigint;
  /** Block hash (empty string if not yet confirmed). */
  blockHash: string;
  /** Sender address (Base58). */
  fromAddress: string;
  /** Recipient address (Base58). */
  toAddress: string;
  /** Transfer amount in micro-USDT as decimal string ("1.000000" = 1 USDT). */
  amountUsdt: string;
  /** Raw amount bigint. */
  amountMicro: bigint;
  /** Contract address (Base58) — always TRON_USDT_CONTRACT_BASE58 after filtering. */
  contractAddress: string;
  /** Whether the transfer is confirmed (block_hash present). */
  isConfirmed: boolean;
  /** Timestamp in ms. */
  blockTimestampMs: number;
}

// ── Fetch transfers ───────────────────────────────────────────────────────────

const MAX_PAGES = 20; // safety cap to avoid infinite pagination

/**
 * Fetch TRC-20 USDT transfers for the given deposit address.
 *
 * Uses only_confirmed=false so 0-conf transfers are visible.
 * Filters for the pinned USDT contract address only.
 * Normalizes all address fields to Base58.
 *
 * @param client           TronHttpClient (primary or secondary).
 * @param depositAddress   Deposit address in Base58 or hex — normalized internally.
 * @param minTimestampMs   Minimum block_timestamp cursor (ms). Pass 0 for full scan.
 */
export async function fetchTransfersForAddress(
  client: TronHttpClient,
  depositAddress: string,
  minTimestampMs: number,
): Promise<TronTrc20Transfer[]> {
  const normalizedAddr = normalizeToBase58(depositAddress);

  const results: TronTrc20Transfer[] = [];
  let fingerprint: string | undefined;
  let page = 0;

  while (page < MAX_PAGES) {
    const params = new URLSearchParams({
      contract_address: TRON_USDT_CONTRACT_BASE58,
      only_confirmed: "false",
      min_timestamp: String(minTimestampMs),
      limit: "50",
    });
    if (fingerprint) {
      params.set("fingerprint", fingerprint);
    }

    const path = `/v1/accounts/${normalizedAddr}/transactions/trc20?${params.toString()}`;
    const { data: response } = await client.get<TronTrc20TransferResponse>(path);

    if (response.Error) {
      throw new Error(`fetchTransfersForAddress RPC error: ${response.Error}`);
    }

    const transfers = response.data ?? [];
    results.push(...transfers);

    // Check pagination
    const nextFingerprint = response.meta?.fingerprint;
    if (!nextFingerprint || transfers.length === 0) {
      break;
    }
    fingerprint = nextFingerprint;
    page++;
  }

  return results;
}

/**
 * Normalize a raw TronGrid TRC-20 transfer into a `NormalizedTransfer`.
 * Rejects:
 *   - Non-pinned contract address
 *   - Zero or dust amounts
 *   - Transfers not targeting the expected deposit address
 *
 * @param raw              Raw TronGrid transfer.
 * @param depositAddress   Expected recipient (Base58 or hex — normalized for comparison).
 * @param blockNumber      REAL block number from gettransactioninfobyid. Pass null for
 *                         unconfirmed (0-conf) transfers — they get
 *                         Number.MAX_SAFE_INTEGER so blockNumber > latestSolidBlock
 *                         always holds until the real height is known.
 * @param dustThreshold    Reject transfers with amountMicro <= dustThreshold. Default: 0n.
 */
export function normalizeTransfer(
  raw: TronTrc20Transfer,
  depositAddress: string,
  blockNumber: bigint | null,
  dustThreshold = 0n,
): NormalizedTransfer | null {
  // Normalize contract address — reject if not USDT
  const contractAddr = raw.token_info?.address;
  if (!contractAddr) return null;

  let normalizedContract: string;
  try {
    normalizedContract = normalizeToBase58(contractAddr);
  } catch {
    return null;
  }
  if (normalizedContract !== TRON_USDT_CONTRACT_BASE58) {
    return null;
  }

  // Normalize to/from addresses
  let toBase58: string;
  let fromBase58: string;
  try {
    toBase58 = normalizeToBase58(raw.to);
    fromBase58 = normalizeToBase58(raw.from);
  } catch {
    return null;
  }

  // Check recipient matches deposit address
  let normalizedDeposit: string;
  try {
    normalizedDeposit = normalizeToBase58(depositAddress);
  } catch {
    return null;
  }
  if (toBase58 !== normalizedDeposit) {
    return null;
  }

  // Parse amount (micro-USDT bigint)
  let amountMicro: bigint;
  try {
    amountMicro = BigInt(raw.value);
  } catch {
    return null;
  }

  // Reject dust and zero
  if (amountMicro <= dustThreshold) {
    return null;
  }

  const logIndex = raw.token_info?.log_index ?? 0;
  const isConfirmed = Boolean(raw.block_hash && raw.block_hash.length > 0);

  // Block number: caller MUST supply the real block number obtained via
  // /wallet/gettransactioninfobyid. Passing null means "not yet confirmed on
  // chain" — we use Number.MAX_SAFE_INTEGER so blockNumber > latestSolidBlock
  // always holds (payment stays "detected") until the real height is known.
  //
  // We NEVER derive blockNumber from block_timestamp because at mainnet-current-
  // time, timestamp/3000 ≈ 593_000_000 while latestSolidBlock ≈ 83_000_000,
  // making blockNumber <= latestSolidBlock permanently false → no invoice ever pays.
  const resolvedBlockNumber: bigint =
    blockNumber !== null ? blockNumber : BigInt(Number.MAX_SAFE_INTEGER);

  return {
    txHash: raw.transaction_id,
    logIndex,
    blockNumber: resolvedBlockNumber,
    blockHash: raw.block_hash ?? "",
    fromAddress: fromBase58,
    toAddress: toBase58,
    amountUsdt: formatMicro(amountMicro),
    amountMicro,
    contractAddress: normalizedContract,
    isConfirmed,
    blockTimestampMs: raw.block_timestamp,
  };
}
