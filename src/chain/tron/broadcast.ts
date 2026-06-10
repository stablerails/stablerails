/**
 * Broadcast a signed Tron transaction to the network via RPC.
 *
 * Accepts a pre-signed transaction hex/object and submits it to:
 *   POST /wallet/broadcasttransaction
 *
 * Also builds UNSIGNED smart-contract transactions via:
 *   POST /wallet/triggersmartcontract
 *
 * The signer (src/signer/) produces the signed transaction.
 * This module is keyless — it only transmits / requests tx construction.
 */

import type { TronHttpClient } from "../../lib/http.js";

// ── Broadcast request / response ──────────────────────────────────────────────

/**
 * A signed Tron transaction ready for broadcast.
 * This is the raw JSON object returned by TronWeb signer
 * or constructed manually — the full signed tx including the `signature` field.
 */
export interface SignedTronTransaction {
  txID: string;
  raw_data: unknown;
  raw_data_hex: string;
  signature: string[];
  [key: string]: unknown;
}

interface BroadcastResponse {
  result?: boolean;
  txid?: string;
  message?: string;
  Error?: string;
  code?: string;
}

export interface BroadcastResult {
  /** The txID confirmed by the node. */
  txId: string;
  /** Whether the node accepted the broadcast. */
  success: boolean;
  /** Error message if not successful. */
  error?: string;
  /**
   * True when success is true because the node signalled the transaction was
   * already known (duplicate). The signed tx is on-chain exactly once — Tron
   * deduplicates by txID, so a dup response means our exact signed tx was
   * previously accepted.
   */
  duplicate?: boolean;
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

function isTxId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Returns true when a result:false node response indicates that the transaction
 * is a duplicate — i.e., our signed tx was already accepted by a prior broadcast
 * (typically the primary node accepted it but the response was lost, and the
 * retry reached the secondary which now rejects it as a known dup).
 *
 * Tron duplicate signals:
 *   - code === "DUP_TRANSACTION_ERROR"  (canonical code from java-tron)
 *   - code or message containing "DUP_TRANSACTION"  (some node variants)
 *   - message containing "already exists"  (contract-validate path on some nodes)
 *   - message containing "dup"  (case-insensitive; catches "dup transaction" etc.)
 *
 * Strictly excluded — genuine failures that must remain success:false:
 *   SIGERROR, BANDWITH_ERROR, TAPOS_ERROR, CONTRACT_EXP_BLOCK_NUM, and any
 *   CONTRACT_VALIDATE_ERROR whose message does NOT contain a dup signal.
 */
function isDuplicateBroadcast(resp: BroadcastResponse): boolean {
  const code = resp.code ?? "";
  const msg = resp.message ?? "";

  // Exact canonical code check first (most reliable signal)
  if (code === "DUP_TRANSACTION_ERROR") return true;

  // Substring checks for variant node responses (case-insensitive)
  const msgLower = msg.toLowerCase();
  if (code.includes("DUP_TRANSACTION")) return true;
  if (msgLower.includes("dup_transaction")) return true;
  if (msgLower.includes("already exists")) return true;
  // Known node phrasing variants only. Deliberately NOT a bare /\bdup\b/:
  // misclassifying an unrelated failure as "duplicate" would record a sweep
  // as broadcast when no funds moved. Unknown phrasings fail closed (success:false)
  // and surface to the operator for manual reconcile.
  if (/\bdup(licate)? transaction\b/i.test(msg)) return true;

  return false;
}

/**
 * Broadcast a signed Tron transaction.
 *
 * Tries the primary client. On failure, propagates the error — callers
 * decide retry/fallback strategy. The TronHttpClient already handles
 * 5xx fallback to secondary for availability, but broadcast is idempotent
 * so the caller may also retry.
 *
 * @param client      TronHttpClient (primary, falls back to secondary on 5xx).
 * @param signedTx    Signed transaction object.
 * @returns           BroadcastResult with txId and success flag.
 */
export async function broadcastTransaction(
  client: TronHttpClient,
  signedTx: SignedTronTransaction,
): Promise<BroadcastResult> {
  const { data } = await client.post<BroadcastResponse>(
    "/wallet/broadcasttransaction",
    signedTx,
  );

  if (data.Error) {
    return {
      txId: signedTx.txID,
      success: false,
      error: data.Error,
    };
  }

  if (!data.result) {
    // A duplicate-broadcast means our exact signed tx is already on-chain.
    // Tron dedups by txID — the funds moved exactly once. Treat as success.
    if (isDuplicateBroadcast(data)) {
      return {
        txId: signedTx.txID,
        success: true,
        duplicate: true,
      };
    }
    return {
      txId: signedTx.txID,
      success: false,
      error: data.message ?? data.code ?? "broadcast returned result=false",
    };
  }

  if (!isTxId(signedTx.txID)) {
    throw new Error("Signed transaction txID must be a 64-character hex string");
  }

  if (data.txid !== undefined) {
    if (!isTxId(data.txid)) {
      throw new Error("Node returned invalid txid format");
    }
    if (data.txid.toLowerCase() !== signedTx.txID.toLowerCase()) {
      throw new Error("Node txid does not match signed transaction txID");
    }
  }

  return {
    txId: data.txid ?? signedTx.txID,
    success: true,
  };
}

// ── triggerSmartContract (unsigned tx construction) ───────────────────────────

/** Request body for POST /wallet/triggersmartcontract (visible:false → hex addresses). */
export interface TriggerSmartContractRequest {
  /** Caller address, hex (41-prefixed, no 0x). */
  owner_address: string;
  /** Contract address, hex (41-prefixed, no 0x). */
  contract_address: string;
  /** e.g. "transfer(address,uint256)". */
  function_selector: string;
  /** ABI-encoded arguments, hex, WITHOUT the 4-byte method selector. */
  parameter: string;
  /** Max TRX fee in SUN. */
  fee_limit: number;
  /** TRX sent with the call — always 0 for TRC-20 transfers. */
  call_value: number;
  /** false = addresses in request/response are hex (not Base58). */
  visible: boolean;
}

/** The unsigned transaction object returned by a Tron full node. */
export interface TronNodeTransaction {
  txID: string;
  raw_data: unknown;
  raw_data_hex: string;
  [key: string]: unknown;
}

interface TriggerSmartContractResponse {
  result?: { result?: boolean; code?: string; message?: string };
  transaction?: Partial<TronNodeTransaction>;
  Error?: string;
}

/** Best-effort decode of the node's hex-encoded error message. */
function decodeNodeMessage(message: string | undefined): string {
  if (!message) return "(no message)";
  if (/^[0-9a-fA-F]+$/.test(message) && message.length % 2 === 0) {
    try {
      return Buffer.from(message, "hex").toString("utf8");
    } catch {
      return message;
    }
  }
  return message;
}

/**
 * Build an UNSIGNED TriggerSmartContract transaction on a Tron full node.
 *
 * POST /wallet/triggersmartcontract — the node assembles the protobuf raw_data
 * (ref block, expiration, timestamp) around the provided call and returns
 * { txID, raw_data, raw_data_hex }.
 *
 * Fail-closed: throws on any node error, result.result !== true, or a missing /
 * incomplete transaction object. SECURITY NOTE: the returned tx is NODE DATA —
 * callers MUST verify it against locally-derived bytes before signing (see
 * verifyNodeTransaction in src/cli/commands/sweep.ts).
 *
 * @throws Error  On node-reported errors or a malformed response.
 */
export async function triggerSmartContract(
  client: TronHttpClient,
  req: TriggerSmartContractRequest,
): Promise<TronNodeTransaction> {
  const { data } = await client.post<TriggerSmartContractResponse>(
    "/wallet/triggersmartcontract",
    req,
  );

  if (data.Error) {
    throw new Error(`triggerSmartContract: node error: ${data.Error}`);
  }
  if (data.result?.result !== true) {
    throw new Error(
      `triggerSmartContract: node rejected the call ` +
        `(code=${data.result?.code ?? "unknown"}): ${decodeNodeMessage(data.result?.message)}`,
    );
  }
  const tx = data.transaction;
  if (
    !tx ||
    typeof tx.txID !== "string" ||
    typeof tx.raw_data_hex !== "string" ||
    tx.raw_data === undefined ||
    tx.raw_data === null
  ) {
    throw new Error(
      "triggerSmartContract: node returned result=true but no complete transaction " +
        "(txID/raw_data/raw_data_hex missing) — refusing to proceed.",
    );
  }
  return tx as TronNodeTransaction;
}
