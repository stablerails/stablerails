/**
 * Solid (irreversible) block fetcher for Tron.
 *
 * CHARTER RULE: `paid` ONLY at Tron SOLID-block height.
 * This module is the authoritative source for latestSolidBlock.
 *
 * Tron's /wallet/getnowblock returns the HEAD block from the full-node endpoint.
 * The solidity endpoint (/walletsolidity/getnowblock) returns the latest
 * SOLID (irreversible) block — the one we must use for finality decisions.
 *
 * When using TronGrid, append `/walletsolidity/getnowblock` to the solidity URL.
 * Primary: TRON_RPC_PRIMARY_URL  (full-node — TronGrid or similar)
 * Solidity: TRON_RPC_SOLIDITY_URL  (solidity endpoint)
 *
 * We call the SOLIDITY endpoint to get the latest solid block.
 * This is injected into core via the watcher.
 */

import { TronHttpClient } from "../../lib/http.js";

// TronGrid solidity endpoint response shape
interface NowBlockResponse {
  block_header?: {
    raw_data?: {
      number?: number;
    };
  };
  // Error shape from TronGrid
  Error?: string;
}

/**
 * Fetch the latest SOLID (irreversible) block number from TronGrid.
 *
 * Uses the solidity endpoint (TRON_RPC_SOLIDITY_URL) if provided,
 * otherwise falls back to appending /walletsolidity/getnowblock to primary URL.
 *
 * @param client  TronHttpClient pointing at primary / secondary nodes.
 * @returns       The latest solid block number as bigint.
 */
export async function fetchLatestSolidBlock(client: TronHttpClient): Promise<bigint> {
  // TronGrid solidity path — gets the irreversible block
  const path = "/walletsolidity/getnowblock";

  const { data } = await client.get<NowBlockResponse>(path);

  if (data.Error) {
    throw new Error(`fetchLatestSolidBlock RPC error: ${data.Error}`);
  }

  const blockNumber = data.block_header?.raw_data?.number;
  if (typeof blockNumber !== "number" || !Number.isFinite(blockNumber) || blockNumber < 0) {
    throw new Error(
      `fetchLatestSolidBlock: unexpected response shape — blockNumber=${JSON.stringify(blockNumber)}`,
    );
  }

  return BigInt(blockNumber);
}
