/**
 * Gas funding CLI tests — `gas address` / `gas fund` (offline, mocked node).
 *
 * Covers:
 *   (a) top-up computation — funds to target, skips already-funded addresses;
 *   (b) hard caps — per-run and per-address caps abort BEFORE anything is signed;
 *   (c) malicious node — mismatched to_address / tampered amount / fake txID
 *       all abort before signing/broadcast;
 *   (d) unactivated account — empty /wallet/getaccount response treated as 0;
 *   (e) SIGN-2 reuse — a pin-mismatched intent aborts before any node call;
 *   plus dry-run (no TRON_RPC_PRIMARY_URL → plan only, nothing broadcast)
 *   and `gas address` (prints the address, never the private key).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import TronWeb from "tronweb";
import type { ApiClient } from "../apiClient.js";
import {
  registerGasCommands,
  computeTopUps,
  assertCaps,
  parseAccountBalanceSun,
  parseTrxToSun,
  verifyCreatedGasTx,
} from "../commands/gas.js";
import { deriveGasWallet } from "../../signer/gasWallet.js";
import { base58ToHex } from "../../chain/tron/addressCodec.js";

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  promptPassphrase: vi.fn(),
  promptSeedPassphrase: vi.fn(),
}));

vi.mock("../../lib/http.js", () => ({
  TronHttpClient: class {
    post = mocks.post;
  },
}));

vi.mock("../prompt.js", () => ({
  promptPassphrase: mocks.promptPassphrase,
  promptSeedPassphrase: mocks.promptSeedPassphrase,
}));

vi.mock("../seedStore.js", () => ({
  encryptedSeedFromEnv: vi.fn(() => ({
    version: 2,
    salt: "00",
    iv: "00",
    ciphertext: "00",
    authTag: "00",
  })),
}));

vi.mock("../../signer/seed.js", () => ({
  // Argon2 decryption skipped — tests inject the well-known test mnemonic.
  decryptSeed: vi.fn(
    async () =>
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  ),
  encryptSeed: vi.fn(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/** SIGN-2 pin (main wallet) — matches the intent fixture's toAddressBase58. */
const PIN = "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe";
const PIN_HEX = "415a67fa7cc56bd6d043a98e17d329c1dc9e14753f";

/** Deposit address being swept (and gas-funded). */
const DEPOSIT = "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH";
const DEPOSIT_HEX = "41c8599111f29c1e1e061265b4af93ea1f274ad78a";

// Gas wallet for the test mnemonic at m/44'/195'/2000000000'/0/0 (real derivation).
const GAS_WALLET = deriveGasWallet(TEST_MNEMONIC);
const GAS_HEX = base58ToHex(GAS_WALLET.address).toLowerCase();

const SUN = 1_000_000n;

function makeIntentItem(): Record<string, unknown> {
  // SIGN-2b: signable bytes must be self-consistent with toAddressBase58 +
  // amountMicroStr — same canonical fixture as cli.test.ts (100 USDT to PIN).
  return {
    address: DEPOSIT,
    account: 0,
    index: 0,
    amountMicroStr: "100000000",
    txHash: null,
    unsignedTx: {
      contractAddressHex: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c",
      contractAddressBase58: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      fromAddressHex: DEPOSIT_HEX,
      fromAddressBase58: DEPOSIT,
      toAddressHex: PIN_HEX,
      toAddressBase58: PIN,
      amountMicro: "100000000",
      callData:
        "a9059cbb0000000000000000000000005a67fa7cc56bd6d043a98e17d329c1dc9e14753f0000000000000000000000000000000000000000000000000000000005f5e100",
      feeLimitSun: "15000000",
      memo: "",
    },
  };
}

function makeRawIntent(items: Array<Record<string, unknown>> = [makeIntentItem()]) {
  return {
    id: "intent_gas_1",
    eventId: "ev_1",
    status: "prepared",
    createdAt: new Date().toISOString(),
    items,
  };
}

function makeMockApi(intent: unknown): ApiClient {
  return { getSweep: vi.fn().mockResolvedValue(intent) } as unknown as ApiClient;
}

/**
 * Build a REAL protobuf-consistent TransferContract tx (raw_data_hex is the
 * actual protobuf encoding of raw_data, txID = sha256(raw_data_hex)) so the
 * full verification chain in verifyCreatedGasTx can pass — exactly like a
 * honest node response.
 */
function makeConsistentTx(ownerHex: string, toHex: string, amountSun: bigint) {
  const rawData = {
    contract: [
      {
        parameter: {
          value: {
            amount: Number(amountSun),
            owner_address: ownerHex.toLowerCase(),
            to_address: toHex.toLowerCase(),
          },
          type_url: "type.googleapis.com/protocol.TransferContract",
        },
        type: "TransferContract",
      },
    ],
    ref_block_bytes: "b089",
    ref_block_hash: "d4357c0db8e9c43b",
    expiration: 1750000000000,
    timestamp: 1749999940000,
  };
  const pb = TronWeb.utils.transaction.txJsonToPb({
    visible: false,
    raw_data: rawData,
    signature: [],
  });
  const rawDataHex = TronWeb.utils.transaction.txPbToRawDataHex(pb).toLowerCase();
  const txID = TronWeb.utils.transaction.txPbToTxID(pb).replace(/^0x/, "").toLowerCase();
  return { visible: false, txID, raw_data: rawData, raw_data_hex: rawDataHex };
}

/** Wire the mocked node: getaccount / createtransaction / broadcasttransaction. */
function mockNodeRoutes(opts?: {
  depositBalanceSun?: number;
  gasBalanceSun?: number;
  /** Override the to_address the "node" encodes (malicious-node simulation). */
  createTo?: string;
}): void {
  mocks.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
    if (path === "/wallet/getaccount") {
      const addr = String(body["address"]).toLowerCase();
      if (addr === GAS_HEX) {
        return { data: { balance: opts?.gasBalanceSun ?? 1_000_000_000 }, provider: "primary" };
      }
      if (opts?.depositBalanceSun !== undefined) {
        return { data: { balance: opts.depositBalanceSun }, provider: "primary" };
      }
      // (d) Unactivated account: the node returns an EMPTY object — must be
      // treated as a 0 balance, not an error.
      return { data: {}, provider: "primary" };
    }
    if (path === "/wallet/createtransaction") {
      const toHex = opts?.createTo ?? String(body["to_address"]);
      return {
        data: makeConsistentTx(String(body["owner_address"]), toHex, BigInt(body["amount"] as number)),
        provider: "primary",
      };
    }
    if (path === "/wallet/broadcasttransaction") {
      return { data: { result: true, txid: (body as { txID: string }).txID }, provider: "primary" };
    }
    throw new Error(`unexpected node path: ${path}`);
  });
}

function postCalls(path: string): unknown[][] {
  return mocks.post.mock.calls.filter((c) => c[0] === path);
}

async function runGas(api: ApiClient, args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerGasCommands(program, () => api);
  await program.parseAsync(["node", "stablerails", "gas", ...args]);
}

// ── Env isolation ─────────────────────────────────────────────────────────────

const ENV_KEYS = [
  "TRON_RPC_PRIMARY_URL",
  "TRON_RPC_PRIMARY_API_KEY",
  "TRON_RPC_SECONDARY_URL",
  "TRON_RPC_SECONDARY_API_KEY",
  "TRON_RPC_PRIMARY",
  "STABLERAILS_MAIN_WALLET",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["STABLERAILS_MAIN_WALLET"] = PIN;
  process.env["TRON_RPC_PRIMARY_URL"] = "https://tron-node-primary.example";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
});

// ── (a) Top-up computation ────────────────────────────────────────────────────

describe("computeTopUps", () => {
  it("tops each address up to the target and skips already-funded ones", () => {
    const target = 30n * SUN;
    const plan = computeTopUps(
      [
        { address: "Tempty", balanceSun: 0n },
        { address: "Tpartial", balanceSun: 25n * SUN },
        { address: "TatTarget", balanceSun: 30n * SUN },
        { address: "Tabove", balanceSun: 40n * SUN },
      ],
      target,
    );
    expect(plan).toEqual([
      { address: "Tempty", balanceSun: 0n, topUpSun: 30n * SUN },
      { address: "Tpartial", balanceSun: 25n * SUN, topUpSun: 5n * SUN },
    ]);
  });
});

describe("parseTrxToSun", () => {
  it("converts whole TRX to SUN", () => {
    expect(parseTrxToSun("30", "--topup-trx")).toBe(30n * SUN);
  });

  it("rejects non-integer and non-positive values", () => {
    expect(() => parseTrxToSun("1.5", "--topup-trx")).toThrow(/whole number/);
    expect(() => parseTrxToSun("0", "--topup-trx")).toThrow(/positive/);
    expect(() => parseTrxToSun("-3", "--topup-trx")).toThrow(/whole number/);
  });
});

// ── (b) Hard caps ─────────────────────────────────────────────────────────────

describe("assertCaps", () => {
  it("throws when a single top-up exceeds the 100 TRX per-address cap", () => {
    expect(() =>
      assertCaps([{ address: "Tx", balanceSun: 0n, topUpSun: 101n * SUN }], 1_000n * SUN),
    ).toThrow(/Per-address gas cap exceeded/);
  });

  it("throws when the run total exceeds the per-run cap", () => {
    const plan = [
      { address: "T1", balanceSun: 0n, topUpSun: 30n * SUN },
      { address: "T2", balanceSun: 0n, topUpSun: 30n * SUN },
    ];
    expect(() => assertCaps(plan, 50n * SUN)).toThrow(/Per-run gas cap exceeded/);
  });

  it("passes when within both caps", () => {
    const plan = [{ address: "T1", balanceSun: 0n, topUpSun: 30n * SUN }];
    expect(() => assertCaps(plan, 500n * SUN)).not.toThrow();
  });
});

describe("gas fund — cap enforcement aborts before signing", () => {
  it("per-run cap exceeded → rejects, nothing signed or broadcast, no prompts", async () => {
    mockNodeRoutes(); // deposits unactivated → 0 balance → 30 TRX each
    const api = makeMockApi(makeRawIntent([makeIntentItem(), makeIntentItem()]));

    await expect(
      runGas(api, ["fund", "--intent", "intent_gas_1", "--max-total-trx", "50"]),
    ).rejects.toThrow(/Per-run gas cap exceeded/);

    expect(postCalls("/wallet/createtransaction")).toHaveLength(0);
    expect(postCalls("/wallet/broadcasttransaction")).toHaveLength(0);
    expect(mocks.promptPassphrase).not.toHaveBeenCalled();
    expect(mocks.promptSeedPassphrase).not.toHaveBeenCalled();
  });

  it("--topup-trx above the per-address cap → rejects before any node call", async () => {
    const api = makeMockApi(makeRawIntent());

    await expect(
      runGas(api, ["fund", "--intent", "intent_gas_1", "--topup-trx", "150"]),
    ).rejects.toThrow(/per-address hard cap/);

    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.promptSeedPassphrase).not.toHaveBeenCalled();
  });
});

// ── (c) Malicious node — fail-closed verification ─────────────────────────────

describe("verifyCreatedGasTx", () => {
  const expected = { ownerHex: GAS_HEX, toHex: DEPOSIT_HEX, amountSun: 30n * SUN };

  it("accepts an honest, protobuf-consistent node response", () => {
    const tx = makeConsistentTx(GAS_HEX, DEPOSIT_HEX, 30n * SUN);
    expect(() => verifyCreatedGasTx(tx, expected)).not.toThrow();
  });

  it("rejects a redirected to_address", () => {
    // Node builds a self-consistent tx — but paying the ATTACKER (here: PIN_HEX
    // stands in as "not the deposit address").
    const tx = makeConsistentTx(GAS_HEX, PIN_HEX, 30n * SUN);
    expect(() => verifyCreatedGasTx(tx, expected)).toThrow(/to_address mismatch/);
  });

  it("rejects an inflated amount", () => {
    const tx = makeConsistentTx(GAS_HEX, DEPOSIT_HEX, 99n * SUN);
    expect(() => verifyCreatedGasTx(tx, expected)).toThrow(/amount mismatch/);
  });

  it("rejects JSON raw_data that does not re-serialize to txID (JSON/bytes split)", () => {
    const tx = makeConsistentTx(GAS_HEX, DEPOSIT_HEX, 30n * SUN);
    // JSON shows the honest destination, but raw_data_hex still encodes a
    // different transfer — the txCheck binding must catch the split.
    tx.raw_data.contract[0]!.parameter.value.to_address = PIN_HEX;
    expect(() => verifyCreatedGasTx(tx, expected)).toThrow(/does not re-serialize/);
  });

  it("rejects a fabricated txID (not sha256 of raw_data_hex)", () => {
    const tx = makeConsistentTx(GAS_HEX, DEPOSIT_HEX, 30n * SUN);
    tx.txID = "00".repeat(32);
    expect(() => verifyCreatedGasTx(tx, expected)).toThrow(/does not match sha256/);
  });

  it("rejects a node error response", () => {
    expect(() => verifyCreatedGasTx({ Error: "class org.tron... : Validate error" }, expected)).toThrow(
      /node returned an error/,
    );
  });
});

describe("gas fund — malicious node aborts the run", () => {
  it("node redirects to_address → run rejects, nothing broadcast", async () => {
    mockNodeRoutes({ createTo: PIN_HEX }); // node encodes attacker destination
    mocks.promptPassphrase.mockResolvedValue("y");
    mocks.promptSeedPassphrase.mockResolvedValue("test-pass");
    const api = makeMockApi(makeRawIntent());

    await expect(runGas(api, ["fund", "--intent", "intent_gas_1"])).rejects.toThrow(
      /to_address mismatch/,
    );

    expect(postCalls("/wallet/broadcasttransaction")).toHaveLength(0);
  });
});

// ── (d) Unactivated account = 0 balance ───────────────────────────────────────

describe("parseAccountBalanceSun", () => {
  it("treats an empty getaccount response (unactivated account) as 0", () => {
    expect(parseAccountBalanceSun({})).toBe(0n);
  });

  it("parses a numeric balance", () => {
    expect(parseAccountBalanceSun({ balance: 5_000_000 })).toBe(5_000_000n);
  });

  it("treats null/non-object as 0", () => {
    expect(parseAccountBalanceSun(null)).toBe(0n);
  });

  it("rejects garbage balance values", () => {
    expect(() => parseAccountBalanceSun({ balance: "lots" })).toThrow(/Unexpected balance/);
  });
});

// ── (e) SIGN-2 pin reuse ──────────────────────────────────────────────────────

describe("gas fund — SIGN-2 pin validation reuse", () => {
  it("pin-mismatched intent → aborts before ANY node call, nothing signed", async () => {
    // Local pin points somewhere else than the intent's sweep destination.
    process.env["STABLERAILS_MAIN_WALLET"] = DEPOSIT;
    const api = makeMockApi(makeRawIntent());

    await expect(runGas(api, ["fund", "--intent", "intent_gas_1"])).rejects.toThrow(
      /destination mismatch/i,
    );

    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.promptPassphrase).not.toHaveBeenCalled();
    expect(mocks.promptSeedPassphrase).not.toHaveBeenCalled();
  });
});

// ── Full happy path + skip-funded + dry-run ───────────────────────────────────

describe("gas fund — happy path (mocked live node)", () => {
  it("funds an unactivated deposit address to the 30 TRX target", async () => {
    mockNodeRoutes(); // deposit unactivated → 0, gas wallet 1000 TRX
    mocks.promptPassphrase.mockResolvedValue("y");
    mocks.promptSeedPassphrase.mockResolvedValue("test-pass");
    const api = makeMockApi(makeRawIntent());

    await runGas(api, ["fund", "--intent", "intent_gas_1"]);

    // Confirmation + passphrase both happened at the TTY mocks.
    expect(mocks.promptPassphrase).toHaveBeenCalledOnce();
    expect(mocks.promptSeedPassphrase).toHaveBeenCalledOnce();

    // Exactly one createtransaction with OUR owner/to/amount.
    const creates = postCalls("/wallet/createtransaction");
    expect(creates).toHaveLength(1);
    expect(creates[0]![1]).toEqual({
      owner_address: GAS_HEX,
      to_address: DEPOSIT_HEX,
      amount: 30_000_000,
    });

    // Exactly one broadcast, carrying a real signature.
    const broadcasts = postCalls("/wallet/broadcasttransaction");
    expect(broadcasts).toHaveLength(1);
    const signedTx = broadcasts[0]![1] as { signature: string[] };
    expect(Array.isArray(signedTx.signature)).toBe(true);
    expect(signedTx.signature.length).toBe(1);
  });

  it("skips deposit addresses already at/above the target — no prompts, no txs", async () => {
    mockNodeRoutes({ depositBalanceSun: 50_000_000 }); // 50 TRX ≥ 30 target
    const api = makeMockApi(makeRawIntent());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runGas(api, ["fund", "--intent", "intent_gas_1"]);
    } finally {
      logSpy.mockRestore();
    }

    expect(postCalls("/wallet/createtransaction")).toHaveLength(0);
    expect(postCalls("/wallet/broadcasttransaction")).toHaveLength(0);
    expect(mocks.promptPassphrase).not.toHaveBeenCalled();
    expect(mocks.promptSeedPassphrase).not.toHaveBeenCalled();
  });

  it("partial balance is topped up by the difference only", async () => {
    mockNodeRoutes({ depositBalanceSun: 25_000_000 }); // 25 TRX → +5 TRX
    mocks.promptPassphrase.mockResolvedValue("y");
    mocks.promptSeedPassphrase.mockResolvedValue("test-pass");
    const api = makeMockApi(makeRawIntent());

    await runGas(api, ["fund", "--intent", "intent_gas_1"]);

    const creates = postCalls("/wallet/createtransaction");
    expect(creates).toHaveLength(1);
    expect((creates[0]![1] as { amount: number }).amount).toBe(5_000_000);
  });

  it("aborts before signing when the gas wallet balance cannot cover the total", async () => {
    mockNodeRoutes({ gasBalanceSun: 10_000_000 }); // 10 TRX < 30 TRX needed
    mocks.promptPassphrase.mockResolvedValue("y");
    mocks.promptSeedPassphrase.mockResolvedValue("test-pass");
    const api = makeMockApi(makeRawIntent());

    await expect(runGas(api, ["fund", "--intent", "intent_gas_1"])).rejects.toThrow(
      /Gas wallet balance is insufficient/,
    );

    expect(postCalls("/wallet/createtransaction")).toHaveLength(0);
    expect(postCalls("/wallet/broadcasttransaction")).toHaveLength(0);
  });
});

describe("gas fund — dry-run (no TRON_RPC_PRIMARY_URL)", () => {
  it("prints the plan, broadcasts nothing, never prompts, exits cleanly", async () => {
    delete process.env["TRON_RPC_PRIMARY_URL"];
    const api = makeMockApi(makeRawIntent());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runGas(api, ["fund", "--intent", "intent_gas_1"]); // resolves — exit 0
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain("dry-run, nothing broadcast");
      expect(output).toContain(DEPOSIT); // the plan shows WHAT would be funded
    } finally {
      logSpy.mockRestore();
    }

    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.promptPassphrase).not.toHaveBeenCalled();
    expect(mocks.promptSeedPassphrase).not.toHaveBeenCalled();
  });
});

// ── gas address ───────────────────────────────────────────────────────────────

describe("gas address", () => {
  it("derives behind the passphrase gate and prints the address — never the key", async () => {
    mocks.promptSeedPassphrase.mockResolvedValue("test-pass");
    const api = makeMockApi(makeRawIntent());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await runGas(api, ["address"]);
      const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(output).toContain(GAS_WALLET.address);
      expect(output).toContain("m/44'/195'/2000000000'/0/0");
      // The private key must NEVER appear in any output.
      expect(output).not.toContain(Buffer.from(GAS_WALLET.privateKey).toString("hex"));
    } finally {
      logSpy.mockRestore();
    }

    expect(mocks.promptSeedPassphrase).toHaveBeenCalledOnce();
    expect(mocks.post).not.toHaveBeenCalled(); // nothing moves, nothing queried
  });
});
