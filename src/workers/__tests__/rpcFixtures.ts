/**
 * Mock TronHttpClient factory and fixture helpers for offline tests.
 *
 * Creates TronHttpClient instances whose `get` / `post` methods are replaced
 * with pre-programmed fixture responses.  No real HTTP calls are made.
 *
 * PRODUCTION-ACCURATE fixtures:
 *   - TronGrid's /v1/accounts/{addr}/transactions/trc20 does NOT include a
 *     block_number field — the fixture intentionally omits it to match production.
 *   - gettransactioninfobyid now returns a FULL receipt with Transfer event logs,
 *     matching the verified-live receipt format from the Tron full-node.
 *   - Solid block numbers use mainnet-scale values (e.g. 83_000_000) to ensure
 *     tests catch the M-1 class of bug.
 *
 * RECEIPT FORMAT (auto-built from each TransferFixture):
 *   { blockNumber, receipt:{ result:"SUCCESS" }, log:[{ address, topics, data }] }
 *   where:
 *     address = contract hex sans "41" prefix (40 chars)
 *     topics[0] = Transfer keccak256 (without 0x)
 *     topics[1] = "000000000000000000000000" + from hex sans "41" (64 chars)
 *     topics[2] = "000000000000000000000000" + to hex sans "41" (64 chars)
 *     data = amount as 64-char hex
 */

import type { TronTrc20Transfer } from "../../chain/tron/transferScan.js";
import { TRON_USDT_CONTRACT_BASE58, TRANSFER_EVENT_TOPIC } from "../../chain/tron/usdt.js";
import { base58ToHex } from "../../chain/tron/addressCodec.js";
import { TronHttpClient } from "../../lib/http.js";

// ── Fixture shapes ─────────────────────────────────────────────────────────────

export interface TransferFixture {
  txHash: string;
  logIndex?: number;
  from: string;
  to: string;
  /** Amount in micro-USDT smallest unit (integer string, e.g. "100000000" = 100 USDT). */
  value: string;
  blockTimestamp: number;
  blockHash?: string;
  /** Override contract address (defaults to TRON_USDT_CONTRACT_BASE58). */
  contractAddress?: string;
  /**
   * Override the contract address ONLY in the RECEIPT's log entry
   * (defaults to contractAddress ?? TRON_USDT_CONTRACT_BASE58).
   * Lets tests make the /v1 discovery row claim USDT (passing the untrusted
   * prefilter) while the AUTHORITATIVE receipt log is emitted by a different,
   * non-pinned contract — proving the receipt parser's contract pin.
   */
  receiptContractAddress?: string;
  confirmed?: boolean;
  /**
   * REAL block number — used for both the receipt's blockNumber field AND the
   * gettransactioninfobyid response.
   *
   * MUST be a mainnet-scale bigint (e.g. 82_999_990n for a confirmed tx at
   * solid=83_000_000n). Pass null / omit to simulate an unconfirmed transfer
   * (gettransactioninfobyid returns empty body {} — receipt is null).
   *
   * NEVER use tiny values like 16n alongside a tiny solidBlockNumber like 100n.
   */
  blockNumber?: bigint | null;
  /**
   * Override receipt.result (defaults to "SUCCESS").
   * Set to "REVERT" or other value to test non-success receipt rejection.
   */
  receiptResult?: string;
  /**
   * Set to true to inject top-level result:"FAILED" into the receipt,
   * simulating a failed transaction.
   */
  txFailed?: boolean;
}

export interface MockRpcConfig {
  /** Latest solid block number from /walletsolidity/getnowblock. Use mainnet-scale! */
  solidBlockNumber: number;
  /** Transfers returned by /v1/accounts/{addr}/transactions/trc20. */
  transfers: TransferFixture[];
}

// ── Transfer event topic without 0x prefix ────────────────────────────────────

const TRANSFER_TOPIC_HEX = TRANSFER_EVENT_TOPIC.startsWith("0x")
  ? TRANSFER_EVENT_TOPIC.slice(2)
  : TRANSFER_EVENT_TOPIC;

// ── Receipt builder ───────────────────────────────────────────────────────────

/**
 * Build a full gettransactioninfobyid receipt from one or more TransferFixtures
 * belonging to the same txHash.
 *
 * Positions each transfer at its fixture.logIndex in the log[] array.
 * Fills other positions with placeholder (no-op) log entries so that
 * parseUsdtReceiptTransfers skips them (wrong contract/topics).
 *
 * Returns {} (empty) if all fixtures have blockNumber null/undefined
 * (simulates an unconfirmed transaction).
 */
function buildReceiptFromFixtures(fixtures: TransferFixture[]): object {
  // Use the first fixture's blockNumber for the tx (all logs in one tx share a block).
  const blockNumberRaw = fixtures[0]?.blockNumber;
  if (!blockNumberRaw) {
    // Not yet confirmed — return empty {} so fetchTransactionReceipt returns null.
    return {};
  }

  const blockNumber = Number(blockNumberRaw);
  const receiptResult = fixtures[0]?.receiptResult ?? "SUCCESS";
  const txFailed = fixtures[0]?.txFailed ?? false;

  // Determine the maximum logIndex to build the log array of the right size.
  const maxLogIndex = Math.max(...fixtures.map((f) => f.logIndex ?? 0));

  // Build the log array. Fill positions with placeholder entries; overwrite at
  // the fixture's logIndex with the real Transfer event.
  const logs: Array<{ address: string; topics: string[]; data: string }> = Array.from(
    { length: maxLogIndex + 1 },
    () => ({ address: "0".repeat(40), topics: [], data: "0".repeat(64) }),
  );

  for (const f of fixtures) {
    const logIndex = f.logIndex ?? 0;
    // Receipt-specific override first: receiptContractAddress lets the receipt's
    // emitter differ from the /v1 row (see TransferFixture docs).
    const contractAddr =
      f.receiptContractAddress ?? f.contractAddress ?? TRON_USDT_CONTRACT_BASE58;

    // contract address: hex without "41" prefix (40 chars)
    const contractHexNo41 = base58ToHex(contractAddr).slice(2);

    // from address topic: 24 zero chars + from hex without "41" (40 chars) = 64 chars
    const fromHexNo41 = base58ToHex(f.from).slice(2);
    const topic1 = "000000000000000000000000" + fromHexNo41;

    // to address topic: 24 zero chars + to hex without "41" (40 chars) = 64 chars
    const toHexNo41 = base58ToHex(f.to).slice(2);
    const topic2 = "000000000000000000000000" + toHexNo41;

    // amount data: 64-char hex
    const data = BigInt(f.value).toString(16).padStart(64, "0");

    logs[logIndex] = {
      address: contractHexNo41,
      topics: [TRANSFER_TOPIC_HEX, topic1, topic2],
      data,
    };
  }

  const receiptObj: Record<string, unknown> = {
    blockNumber,
    receipt: { result: receiptResult },
    log: logs,
  };

  if (txFailed) {
    receiptObj["result"] = "FAILED";
  }

  return receiptObj;
}

// ── Raw TRC-20 transfer builder ───────────────────────────────────────────────

/**
 * Build a raw TRC-20 transfer that accurately represents what TronGrid returns:
 * NO block_number field (the production endpoint omits it).
 * block_timestamp is present but is NOT used for block number derivation.
 */
export function buildRawTransfer(f: TransferFixture): TronTrc20Transfer {
  const contractAddr = f.contractAddress ?? TRON_USDT_CONTRACT_BASE58;
  // Deliberately do NOT include block_number — TronGrid trc20 endpoint omits it.
  return {
    transaction_id: f.txHash,
    block_timestamp: f.blockTimestamp,
    block_hash: f.blockHash ?? (f.confirmed !== false ? `hash-${f.txHash}` : ""),
    from: f.from,
    to: f.to,
    value: f.value,
    token_info: {
      symbol: "USDT",
      address: contractAddr,
      decimals: 6,
      name: "Tether USD",
      log_index: f.logIndex ?? 0,
    },
  };
}

// ── Mock client factory ───────────────────────────────────────────────────────

/**
 * Build a mock TronHttpClient that serves fixture responses.
 *
 * Handles:
 * - GET /walletsolidity/getnowblock → solid block fixture
 * - GET /v1/accounts/{addr}/transactions/trc20 → transfer list fixture (PRIMARY only)
 * - GET /wallet/gettransactioninfobyid?value=<txHash> → FULL receipt auto-built
 *   from TransferFixtures for that txHash (includes Transfer event logs)
 *
 * The full receipt format enables the receipt-based agreement logic in watcher.ts
 * to verify transfers from BOTH providers independently via receipt event logs.
 */
export function buildMockClient(cfg: MockRpcConfig): TronHttpClient {
  // Create client with dummy config (no real URLs needed)
  const client = new TronHttpClient({
    primary: { url: "http://mock-primary.local" },
    secondary: { url: "http://mock-secondary.local" },
    timeoutMs: 5_000,
  });

  // Group fixtures by txHash to build complete receipts (one receipt per tx,
  // potentially containing multiple Transfer log entries at different logIndex positions).
  const txFixtureMap = new Map<string, TransferFixture[]>();
  for (const f of cfg.transfers) {
    const arr = txFixtureMap.get(f.txHash) ?? [];
    arr.push(f);
    txFixtureMap.set(f.txHash, arr);
  }

  // Build receipt map: txHash → full receipt object
  const receiptMap = new Map<string, object>();
  for (const [txHash, fixtures] of txFixtureMap.entries()) {
    receiptMap.set(txHash, buildReceiptFromFixtures(fixtures));
  }

  const rawTransfers = cfg.transfers.map(buildRawTransfer);

  // Replace get method
  (client as unknown as { get: unknown }).get = async <T>(
    path: string,
  ): Promise<{ data: T; provider: "primary" }> => {
    if (path.includes("walletsolidity/getnowblock")) {
      const response = {
        block_header: {
          raw_data: {
            number: cfg.solidBlockNumber,
          },
        },
      };
      return { data: response as T, provider: "primary" };
    }

    if (path.includes("/transactions/trc20")) {
      const minTimestampMatch = path.match(/[?&]min_timestamp=([^&]+)/);
      const minTimestamp = minTimestampMatch
        ? Number(decodeURIComponent(minTimestampMatch[1]!))
        : 0;
      const response = {
        data: rawTransfers.filter((t) => t.block_timestamp >= minTimestamp),
        meta: {},
        success: true,
      };
      return { data: response as T, provider: "primary" };
    }

    if (path.includes("gettransactioninfobyid")) {
      // Extract txHash from query string: ?value=<txHash>
      const match = path.match(/[?&]value=([^&]+)/);
      const txHash = match ? decodeURIComponent(match[1]!) : "";
      // Return the pre-built full receipt, or empty {} for unknown txHashes.
      const receipt = receiptMap.get(txHash) ?? {};
      return { data: receipt as T, provider: "primary" };
    }

    throw new Error(`Mock client: unexpected path: ${path}`);
  };

  // Replace post method (not used by watcher, but for completeness)
  (client as unknown as { post: unknown }).post = async <T>(): Promise<{
    data: T;
    provider: "primary";
  }> => {
    throw new Error("Mock client: post not supported");
  };

  return client;
}

/**
 * Build a pair of mock clients (primary + secondary) that return the same data.
 * Used for the "happy path" two-RPC agreement tests.
 */
export function buildAgreementClients(
  primary: MockRpcConfig,
  secondary?: MockRpcConfig,
): { primaryClient: TronHttpClient; secondaryClient: TronHttpClient } {
  return {
    primaryClient: buildMockClient(primary),
    secondaryClient: buildMockClient(secondary ?? primary),
  };
}
