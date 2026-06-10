/**
 * receiptScan.ts — unit tests for parseUsdtReceiptTransfers and fetchTransactionReceipt.
 *
 * Verifies the authoritative receipt-log parser that replaces per-provider /v1
 * transfer agreement. All checks enforced here directly enforce money-safety:
 * wrong contract, wrong encoding, failed tx, dust — all must return zero transfers.
 */

import { describe, it, expect } from "vitest";
import {
  parseUsdtReceiptTransfers,
  fetchTransactionReceipt,
  type TxReceipt,
} from "../receiptScan.js";
import { TRON_USDT_CONTRACT_BASE58, TRANSFER_EVENT_TOPIC } from "../usdt.js";
import { base58ToHex } from "../addressCodec.js";
import { TronHttpClient } from "../../../lib/http.js";

// ── Test addresses ────────────────────────────────────────────────────────────

const DEPOSIT_ADDR = "TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy";
const FROM_ADDR = "THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC";
const FAKE_CONTRACT = "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH";

// Precomputed hex values
const CONTRACT_HEX_NO41 = base58ToHex(TRON_USDT_CONTRACT_BASE58).slice(2); // 40 chars
const FROM_HEX_NO41 = base58ToHex(FROM_ADDR).slice(2); // 40 chars
const DEPOSIT_HEX_NO41 = base58ToHex(DEPOSIT_ADDR).slice(2); // 40 chars
const FAKE_CONTRACT_HEX_NO41 = base58ToHex(FAKE_CONTRACT).slice(2); // 40 chars
const TOPIC0 = TRANSFER_EVENT_TOPIC.startsWith("0x")
  ? TRANSFER_EVENT_TOPIC.slice(2)
  : TRANSFER_EVENT_TOPIC;
const TOPIC1_FROM = "000000000000000000000000" + FROM_HEX_NO41; // 64 chars
const TOPIC2_TO = "000000000000000000000000" + DEPOSIT_HEX_NO41; // 64 chars
const AMOUNT_HEX_100_USDT = BigInt("100000000").toString(16).padStart(64, "0"); // 100 USDT

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeValidReceipt(overrides: Partial<TxReceipt> = {}): TxReceipt {
  return {
    blockNumber: 82_999_990,
    receipt: { result: "SUCCESS" },
    log: [
      {
        address: CONTRACT_HEX_NO41,
        topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
        data: AMOUNT_HEX_100_USDT,
      },
    ],
    ...overrides,
  };
}

// ── Tests: parseUsdtReceiptTransfers ─────────────────────────────────────────

describe("parseUsdtReceiptTransfers — happy path", () => {
  it("parses a valid Transfer log and returns one entry", () => {
    const receipt = makeValidReceipt();
    const result = parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n);

    expect(result).toHaveLength(1);
    const t = result[0]!;
    expect(t.receiptLogIndex).toBe(0);
    expect(t.contractBase58).toBe(TRON_USDT_CONTRACT_BASE58);
    expect(t.fromBase58).toBe(FROM_ADDR);
    expect(t.toBase58).toBe(DEPOSIT_ADDR);
    expect(t.amountMicro).toBe(100_000_000n);
  });

  it("returns correct logIndex when transfer is at position 2 in log array", () => {
    const receipt: TxReceipt = {
      blockNumber: 82_999_990,
      receipt: { result: "SUCCESS" },
      log: [
        { address: "0".repeat(40), topics: [], data: "0".repeat(64) }, // irrelevant at 0
        { address: "0".repeat(40), topics: [], data: "0".repeat(64) }, // irrelevant at 1
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: AMOUNT_HEX_100_USDT,
        }, // Transfer at 2
      ],
    };

    const result = parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n);
    expect(result).toHaveLength(1);
    expect(result[0]!.receiptLogIndex).toBe(2);
  });

  it("returns two entries for two Transfer logs in the same receipt", () => {
    const AMOUNT2 = BigInt("50000000").toString(16).padStart(64, "0");
    const receipt: TxReceipt = {
      blockNumber: 82_999_990,
      receipt: { result: "SUCCESS" },
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: AMOUNT_HEX_100_USDT,
        },
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: AMOUNT2,
        },
      ],
    };

    const result = parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n);
    expect(result).toHaveLength(2);
    expect(result[0]!.receiptLogIndex).toBe(0);
    expect(result[1]!.receiptLogIndex).toBe(1);
    expect(result[0]!.amountMicro).toBe(100_000_000n);
    expect(result[1]!.amountMicro).toBe(50_000_000n);
  });
});

describe("parseUsdtReceiptTransfers — rejection cases", () => {
  it("rejects when top-level result === FAILED", () => {
    const receipt: TxReceipt = {
      blockNumber: 82_999_990,
      result: "FAILED",
      receipt: { result: "FAILED" },
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    };
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("rejects when receipt.result is present and not SUCCESS", () => {
    const receipt: TxReceipt = {
      blockNumber: 82_999_990,
      receipt: { result: "REVERT" },
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    };
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("skips log entry with non-pinned contract address", () => {
    const receipt: TxReceipt = {
      blockNumber: 82_999_990,
      receipt: { result: "SUCCESS" },
      log: [
        {
          address: FAKE_CONTRACT_HEX_NO41, // wrong contract
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    };
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("skips log entry with wrong topics length (not exactly 3)", () => {
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM], // only 2 topics
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("skips log entry with wrong topic[0] (not Transfer event hash)", () => {
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: ["a".repeat(64), TOPIC1_FROM, TOPIC2_TO], // wrong topic0
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("skips log entry with non-zero padding in from-topic (first 24 hex not zeros)", () => {
    const badTopic1 = "ff0000000000000000000000" + FROM_HEX_NO41; // wrong padding
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, badTopic1, TOPIC2_TO],
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("skips log entry with non-zero padding in to-topic (first 24 hex not zeros)", () => {
    const badTopic2 = "ff0000000000000000000000" + DEPOSIT_HEX_NO41; // wrong padding
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, badTopic2],
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("skips log entry when to-address does not match depositAddress", () => {
    // Same contract, correct from, but to = FROM_ADDR (not the deposit address)
    const wrongToTopic2 = "000000000000000000000000" + FROM_HEX_NO41;
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, wrongToTopic2],
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("skips log entry with data that is not exactly 64 hex chars", () => {
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: "12345678", // too short
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("skips log entry with amount <= dustThreshold", () => {
    const dustAmount = BigInt("100").toString(16).padStart(64, "0"); // tiny amount
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: dustAmount,
        },
      ],
    });
    // dustThreshold = 200 (reject amounts <= 200)
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 200n)).toHaveLength(0);
    // But dustThreshold = 0 (reject only zero) → 100 > 0 → accepted
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(1);
  });

  it("skips log entry with zero amount", () => {
    const zeroAmount = "0".repeat(64);
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: zeroAmount,
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("returns empty for receipt with no logs", () => {
    const receipt: TxReceipt = {
      blockNumber: 82_999_990,
      receipt: { result: "SUCCESS" },
      log: [],
    };
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("skips log entry with contract address that is not 40 hex chars", () => {
    const receipt = makeValidReceipt({
      log: [
        {
          address: "41" + CONTRACT_HEX_NO41, // 42 chars — has the 41 prefix (wrong)
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });
});

// ── Tests: fail-closed success requirement + malformed-receipt robustness ────

describe("parseUsdtReceiptTransfers — POSITIVE success requirement (fail-closed)", () => {
  it("rejects when receipt.result is ABSENT (empty receipt object)", () => {
    // Success must be POSITIVE: absence of receipt.result is NOT acceptance.
    const receipt = makeValidReceipt({ receipt: {} });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("rejects when the receipt object is missing entirely", () => {
    const receipt = makeValidReceipt();
    delete (receipt as { receipt?: unknown }).receipt;
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("still accepts when receipt.result === SUCCESS", () => {
    expect(parseUsdtReceiptTransfers(makeValidReceipt(), DEPOSIT_ADDR, 0n)).toHaveLength(1);
  });
});

describe("parseUsdtReceiptTransfers — malformed log robustness (no uncaught throw)", () => {
  it("skips a null log entry without throwing; sibling valid log is still parsed", () => {
    const receipt = makeValidReceipt({
      log: [
        null as unknown as TxReceipt["log"] extends Array<infer L> | undefined ? L : never,
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    });
    const result = parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n);
    expect(result).toHaveLength(1);
    expect(result[0]!.receiptLogIndex).toBe(1);
  });

  it("skips a log entry with a null topic without throwing", () => {
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, null as unknown as string, TOPIC2_TO],
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("skips a log entry with null data / null address without throwing", () => {
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: null as unknown as string,
        },
        {
          address: null as unknown as string,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("treats a non-array log field as no transfers", () => {
    const receipt = makeValidReceipt({ log: "garbage" as unknown as TxReceipt["log"] });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("skips non-string topics (numbers/objects) without throwing", () => {
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, 12345 as unknown as string, TOPIC2_TO],
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });
});

describe("parseUsdtReceiptTransfers — 0x normalization + strict hex", () => {
  it("accepts a valid log with 0x-prefixed address, topics, and data", () => {
    const receipt = makeValidReceipt({
      log: [
        {
          address: "0x" + CONTRACT_HEX_NO41,
          topics: ["0x" + TOPIC0, "0x" + TOPIC1_FROM, "0x" + TOPIC2_TO],
          data: "0x" + AMOUNT_HEX_100_USDT,
        },
      ],
    });
    const result = parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n);
    expect(result).toHaveLength(1);
    expect(result[0]!.amountMicro).toBe(100_000_000n);
    expect(result[0]!.toBase58).toBe(DEPOSIT_ADDR);
  });

  it("accepts uppercase 0X prefix and uppercase hex (case-insensitive normalization)", () => {
    const receipt = makeValidReceipt({
      log: [
        {
          address: "0X" + CONTRACT_HEX_NO41.toUpperCase(),
          topics: [
            "0X" + TOPIC0.toUpperCase(),
            "0X" + TOPIC1_FROM.toUpperCase(),
            "0X" + TOPIC2_TO.toUpperCase(),
          ],
          data: "0X" + AMOUNT_HEX_100_USDT.toUpperCase(),
        },
      ],
    });
    const result = parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n);
    expect(result).toHaveLength(1);
    expect(result[0]!.amountMicro).toBe(100_000_000n);
  });

  it("rejects non-hex data even when it is exactly 64 chars", () => {
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: "zz".repeat(32), // 64 chars, not hex
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("rejects non-hex characters in a topic even at correct length", () => {
    const badTopic1 = "000000000000000000000000" + "g".repeat(40); // 64 chars, non-hex tail
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, badTopic1, TOPIC2_TO],
          data: AMOUNT_HEX_100_USDT,
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });

  it("rejects data whose 64-char length only holds WITH the 0x prefix (62 hex chars after strip)", () => {
    const receipt = makeValidReceipt({
      log: [
        {
          address: CONTRACT_HEX_NO41,
          topics: [TOPIC0, TOPIC1_FROM, TOPIC2_TO],
          data: "0x" + AMOUNT_HEX_100_USDT.slice(2), // 64 total, 62 after strip
        },
      ],
    });
    expect(parseUsdtReceiptTransfers(receipt, DEPOSIT_ADDR, 0n)).toHaveLength(0);
  });
});

// ── Tests: fetchTransactionReceipt ────────────────────────────────────────────

describe("fetchTransactionReceipt", () => {
  function buildMockClientWithReceipt(receipt: unknown): TronHttpClient {
    const client = new TronHttpClient({
      primary: { url: "http://mock.local" },
      secondary: { url: "http://mock.local" },
      timeoutMs: 1_000,
    });
    (client as unknown as { get: unknown }).get = async <T>(
      path: string,
    ): Promise<{ data: T; provider: "primary" }> => {
      if (path.includes("gettransactioninfobyid")) {
        return { data: receipt as T, provider: "primary" };
      }
      throw new Error(`Unexpected path: ${path}`);
    };
    return client;
  }

  it("returns receipt object when blockNumber is present", async () => {
    const receipt = makeValidReceipt();
    const client = buildMockClientWithReceipt(receipt);
    const result = await fetchTransactionReceipt(client, "txhash-001");
    expect(result).not.toBeNull();
    expect(result!.blockNumber).toBe(82_999_990);
  });

  it("returns null for empty object (tx not in a block)", async () => {
    const client = buildMockClientWithReceipt({});
    const result = await fetchTransactionReceipt(client, "txhash-unconfirmed");
    expect(result).toBeNull();
  });

  it("returns null when blockNumber is absent", async () => {
    const client = buildMockClientWithReceipt({ receipt: { result: "SUCCESS" }, log: [] });
    const result = await fetchTransactionReceipt(client, "txhash-no-block");
    expect(result).toBeNull();
  });

  it("calls the correct path with the txHash encoded", async () => {
    const paths: string[] = [];
    const client = new TronHttpClient({
      primary: { url: "http://mock.local" },
      secondary: { url: "http://mock.local" },
    });
    (client as unknown as { get: unknown }).get = async <T>(path: string) => {
      paths.push(path);
      return { data: makeValidReceipt() as T, provider: "primary" as const };
    };
    await fetchTransactionReceipt(client, "abc123");
    expect(paths[0]).toContain("gettransactioninfobyid");
    expect(paths[0]).toContain("abc123");
  });
});
