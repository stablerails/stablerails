/**
 * solidBlock.ts — mock RPC tests for fetchLatestSolidBlock.
 *
 * Uses a mock TronHttpClient — no real network calls.
 */

import { describe, it, expect } from "vitest";
import { fetchLatestSolidBlock } from "../solidBlock.js";
import { TronHttpClient } from "../../../lib/http.js";

function buildMockClientWithSolid(blockNumber: number): TronHttpClient {
  const client = new TronHttpClient({
    primary: { url: "http://mock.local" },
    secondary: { url: "http://mock2.local" },
  });

  (client as unknown as { get: unknown }).get = async <T>(
    path: string,
  ): Promise<{ data: T; provider: "primary" }> => {
    if (path.includes("walletsolidity/getnowblock")) {
      return {
        data: {
          block_header: {
            raw_data: { number: blockNumber },
          },
        } as T,
        provider: "primary",
      };
    }
    throw new Error(`Unexpected path: ${path}`);
  };

  return client;
}

function buildErrorClient(errorMsg: string): TronHttpClient {
  const client = new TronHttpClient({
    primary: { url: "http://mock.local" },
    secondary: { url: "http://mock2.local" },
  });

  (client as unknown as { get: unknown }).get = async <T>(): Promise<{
    data: T;
    provider: "primary";
  }> => {
    return { data: { Error: errorMsg } as T, provider: "primary" };
  };

  return client;
}

function buildMalformedClient(): TronHttpClient {
  const client = new TronHttpClient({
    primary: { url: "http://mock.local" },
    secondary: { url: "http://mock2.local" },
  });

  (client as unknown as { get: unknown }).get = async <T>(): Promise<{
    data: T;
    provider: "primary";
  }> => {
    return { data: {} as T, provider: "primary" };
  };

  return client;
}

describe("fetchLatestSolidBlock", () => {
  it("returns solid block number as bigint", async () => {
    const client = buildMockClientWithSolid(54321);
    const block = await fetchLatestSolidBlock(client);
    expect(block).toBe(54321n);
  });

  it("returns 0 for block number 0", async () => {
    const client = buildMockClientWithSolid(0);
    const block = await fetchLatestSolidBlock(client);
    expect(block).toBe(0n);
  });

  it("throws on RPC error response", async () => {
    const client = buildErrorClient("Node is syncing");
    await expect(fetchLatestSolidBlock(client)).rejects.toThrow(
      /fetchLatestSolidBlock RPC error/,
    );
  });

  it("throws on malformed response (no block_header)", async () => {
    const client = buildMalformedClient();
    await expect(fetchLatestSolidBlock(client)).rejects.toThrow(
      /unexpected response shape/,
    );
  });

  it("handles large block numbers correctly", async () => {
    const largeBlock = 60_000_000; // realistic Tron block
    const client = buildMockClientWithSolid(largeBlock);
    const block = await fetchLatestSolidBlock(client);
    expect(block).toBe(BigInt(largeBlock));
  });
});
