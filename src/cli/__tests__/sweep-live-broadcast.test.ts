/**
 * Live-broadcast (go-live SIGN-3 closure) tests — real triggerSmartContract wiring.
 *
 * Tests:
 *   a. Happy path: node returns a consistent tx → signed and broadcast called.
 *   b. Node returns mismatched `data` (different destination) → abort, nothing signed.
 *   c. Node returns a txID that does not hash-match raw_data_hex → abort.
 *   d. Env reconciliation: canonical TRON_RPC_PRIMARY_URL + legacy TRON_RPC_PRIMARY
 *      fallback both trigger live mode; API keys are passed through.
 *
 * The node is mocked at the injectable TriggerSmartContractFn seam
 * (makeLiveBuildSignableTx) — no network access. Consistent node responses are
 * built with tronweb's protobuf utils so txID = sha256(raw_data_hex) and the
 * JSON↔bytes binding (txCheck) genuinely hold, exactly like a real node.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import TronWeb from "tronweb";
import {
  makeLiveBuildSignableTx,
  resolveLiveRpcConfig,
  verifyNodeTransaction,
} from "../commands/sweep.js";
import type { TriggerSmartContractFn } from "../commands/sweep.js";
import { buildTransfer } from "../../chain/tron/buildTransfer.js";
import { buildMockTxId, isLiveBroadcastEnv } from "../../signer/sign.js";
import { encryptSeed } from "../../signer/seed.js";
import { deriveAccountXpub } from "../../signer/provision.js";
import { deriveAddress } from "../../chain/tron/deriveAddress.js";
import { executeSweep } from "../../signer/sweep.js";
import type { SweepItem, BroadcastFn } from "../../signer/sweep.js";
import type {
  TriggerSmartContractRequest,
  TronNodeTransaction,
} from "../../chain/tron/broadcast.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_PASSPHRASE = "test-sweep-passphrase-2025";
const MAIN_WALLET = "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe";
// Checksum-valid address that is NOT the pin (the USDT contract address).
const ATTACKER_WALLET_VALID = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const DEPOSIT_ADDRESS = "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH";
const AMOUNT_MICRO = 100_000_000n;
const FEE_LIMIT_SUN = 15_000_000n;

const RPC_ENV_VARS = [
  "TRON_RPC_PRIMARY_URL",
  "TRON_RPC_PRIMARY_API_KEY",
  "TRON_RPC_SECONDARY_URL",
  "TRON_RPC_SECONDARY_API_KEY",
  "TRON_RPC_PRIMARY",
  "TRON_RPC_SECONDARY",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of RPC_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of RPC_ENV_VARS) {
    const value = savedEnv[key];
    if (value !== undefined) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }
  }
});

/** Build a sweep item carrying the validated (mock) signableTx, like toSignerIntentChecked does. */
function makeItem(depositAddress: string): SweepItem {
  const transfer = buildTransfer({
    fromAddress: depositAddress,
    toAddress: MAIN_WALLET,
    amountMicro: AMOUNT_MICRO,
    feeLimitSun: FEE_LIMIT_SUN,
  });
  return {
    address: depositAddress,
    account: 0,
    index: 0,
    amountMicro: AMOUNT_MICRO,
    signableTx: {
      txID: buildMockTxId(transfer, 0),
      raw_data_hex: transfer.callData,
      raw_data: { contract: [], fee_limit: Number(FEE_LIMIT_SUN) },
    },
  };
}

/**
 * Simulate an HONEST Tron full node: assemble the protobuf raw_data around the
 * requested call, so txID = sha256(raw_data_hex) AND the JSON re-serializes to
 * the same bytes (txCheck passes) — exactly like a real node response.
 */
function buildConsistentNodeTx(
  req: TriggerSmartContractRequest,
  overrides: { data?: string; feeLimit?: number; callValue?: number } = {},
): TronNodeTransaction {
  const txJson = {
    raw_data: {
      contract: [
        {
          parameter: {
            value: {
              data: overrides.data ?? `a9059cbb${req.parameter}`,
              owner_address: req.owner_address,
              contract_address: req.contract_address,
              ...(overrides.callValue !== undefined
                ? { call_value: overrides.callValue }
                : {}),
            },
            type_url: "type.googleapis.com/protocol.TriggerSmartContract",
          },
          type: "TriggerSmartContract",
        },
      ],
      ref_block_bytes: "1234",
      ref_block_hash: "abcdef0123456789",
      expiration: 1_750_000_060_000,
      fee_limit: overrides.feeLimit ?? req.fee_limit,
      timestamp: 1_750_000_000_000,
    },
  };
  const pb = TronWeb.utils.transaction.txJsonToPb(txJson as unknown as Record<string, unknown>);
  const rawDataHex = TronWeb.utils.transaction.txPbToRawDataHex(pb).replace(/^0x/, "");
  const txID = TronWeb.utils.transaction.txPbToTxID(pb).replace(/^0x/, "");
  return { ...txJson, txID, raw_data_hex: rawDataHex } as unknown as TronNodeTransaction;
}

// ── a. Happy path: consistent node tx → signed + broadcast ───────────────────

describe("live broadcast: happy path (consistent node tx)", () => {
  it("builds via triggerSmartContract with locally-derived bytes, signs, and broadcasts", async () => {
    process.env["TRON_RPC_PRIMARY_URL"] = "https://api.trongrid.io";

    // Use a deposit address whose key we can actually derive, so signing works.
    const xpub = deriveAccountXpub(TEST_MNEMONIC, 0).xpub;
    const depositAddress = deriveAddress(xpub, 0);
    const item = makeItem(depositAddress);
    const expected = buildTransfer({
      fromAddress: depositAddress,
      toAddress: MAIN_WALLET,
      amountMicro: AMOUNT_MICRO,
      feeLimitSun: FEE_LIMIT_SUN,
    });

    const triggerRequests: TriggerSmartContractRequest[] = [];
    const trigger: TriggerSmartContractFn = async (req) => {
      triggerRequests.push(req);
      return buildConsistentNodeTx(req);
    };
    const liveBuild = makeLiveBuildSignableTx(trigger, MAIN_WALLET);

    const broadcastTxs: Array<{ txID: string; signature: unknown }> = [];
    const broadcast: BroadcastFn = async (signedTx) => {
      broadcastTxs.push({ txID: signedTx.txID, signature: signedTx.signature });
      return { txId: signedTx.txID, success: true };
    };

    const encryptedSeed = await encryptSeed(TEST_MNEMONIC, TEST_PASSPHRASE);
    const result = await executeSweep(
      {
        id: "intent_live_happy",
        eventId: "ev_live",
        status: "prepared",
        items: [item],
        createdAt: new Date().toISOString(),
      },
      {
        encryptedSeed,
        passphrase: TEST_PASSPHRASE,
        broadcast,
        buildSignableTx: liveBuild,
      },
    );

    // The node request was built from LOCAL bytes only.
    expect(triggerRequests).toHaveLength(1);
    const req = triggerRequests[0]!;
    expect(req.owner_address).toBe(expected.fromAddressHex);
    expect(req.contract_address).toBe(expected.contractAddressHex);
    expect(req.function_selector).toBe("transfer(address,uint256)");
    expect(req.parameter).toBe(expected.callData.slice(8)); // selector stripped
    expect(req.fee_limit).toBe(Number(FEE_LIMIT_SUN));
    expect(req.call_value).toBe(0);
    expect(req.visible).toBe(false);

    // Signed and broadcast with the REAL node txID (not the mock).
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(broadcastTxs).toHaveLength(1);
    expect(broadcastTxs[0]!.txID).not.toBe(item.signableTx.txID); // mock replaced
    expect(Array.isArray(broadcastTxs[0]!.signature)).toBe(true);
    expect((broadcastTxs[0]!.signature as string[]).length).toBeGreaterThan(0);
    expect(result.results[0]!.txHash).toBe(broadcastTxs[0]!.txID);
  });
});

// ── b. Node substitutes destination/amount in data → abort ───────────────────

describe("live broadcast: malicious node responses are rejected", () => {
  it("rejects a node tx whose data encodes a DIFFERENT destination (nothing signed)", async () => {
    process.env["TRON_RPC_PRIMARY_URL"] = "https://api.trongrid.io";
    const item = makeItem(DEPOSIT_ADDRESS);

    const attackerTransfer = buildTransfer({
      fromAddress: DEPOSIT_ADDRESS,
      toAddress: ATTACKER_WALLET_VALID,
      amountMicro: AMOUNT_MICRO,
      feeLimitSun: FEE_LIMIT_SUN,
    });
    // Internally-consistent tx (txID/raw_data_hex/JSON all bind) — but the
    // data pays the attacker. Only the semantic callData check can catch it.
    const trigger: TriggerSmartContractFn = async (req) =>
      buildConsistentNodeTx(req, { data: attackerTransfer.callData });
    const liveBuild = makeLiveBuildSignableTx(trigger, MAIN_WALLET);

    await expect(liveBuild(item)).rejects.toThrow(/callData mismatch/i);
  });

  it("rejects a node tx whose data encodes a DIFFERENT amount", async () => {
    process.env["TRON_RPC_PRIMARY_URL"] = "https://api.trongrid.io";
    const item = makeItem(DEPOSIT_ADDRESS);

    const inflatedTransfer = buildTransfer({
      fromAddress: DEPOSIT_ADDRESS,
      toAddress: MAIN_WALLET,
      amountMicro: 999_000_000n, // != item.amountMicro
      feeLimitSun: FEE_LIMIT_SUN,
    });
    const trigger: TriggerSmartContractFn = async (req) =>
      buildConsistentNodeTx(req, { data: inflatedTransfer.callData });
    const liveBuild = makeLiveBuildSignableTx(trigger, MAIN_WALLET);

    await expect(liveBuild(item)).rejects.toThrow(/callData mismatch/i);
  });

  it("rejects a node tx carrying non-zero call_value (TRX drain)", async () => {
    process.env["TRON_RPC_PRIMARY_URL"] = "https://api.trongrid.io";
    const item = makeItem(DEPOSIT_ADDRESS);

    // Internally-consistent tx, but the TriggerSmartContract carries TRX
    // call_value — signing it would send the operator's TRX along with the
    // TRC-20 call. We always request call_value: 0.
    const trigger: TriggerSmartContractFn = async (req) =>
      buildConsistentNodeTx(req, { callValue: 5_000_000 });
    const liveBuild = makeLiveBuildSignableTx(trigger, MAIN_WALLET);

    await expect(liveBuild(item)).rejects.toThrow(/call_value mismatch/i);
  });

  it("rejects a node tx whose fee_limit deviates from the validated value", async () => {
    process.env["TRON_RPC_PRIMARY_URL"] = "https://api.trongrid.io";
    const item = makeItem(DEPOSIT_ADDRESS);

    const trigger: TriggerSmartContractFn = async (req) =>
      buildConsistentNodeTx(req, { feeLimit: 999_000_000 });
    const liveBuild = makeLiveBuildSignableTx(trigger, MAIN_WALLET);

    await expect(liveBuild(item)).rejects.toThrow(/fee_limit mismatch/i);
  });

  it("rejects the JSON/bytes split attack: honest JSON, evil raw_data_hex+txID", async () => {
    process.env["TRON_RPC_PRIMARY_URL"] = "https://api.trongrid.io";
    const item = makeItem(DEPOSIT_ADDRESS);

    const attackerTransfer = buildTransfer({
      fromAddress: DEPOSIT_ADDRESS,
      toAddress: ATTACKER_WALLET_VALID,
      amountMicro: AMOUNT_MICRO,
      feeLimitSun: FEE_LIMIT_SUN,
    });
    const trigger: TriggerSmartContractFn = async (req) => {
      const honest = buildConsistentNodeTx(req);
      const evil = buildConsistentNodeTx(req, { data: attackerTransfer.callData });
      // Node shows honest JSON fields but the SIGNED bytes (raw_data_hex →
      // txID) encode the attacker transfer. txID=sha256(raw_data_hex) still
      // holds — only the protobuf re-serialization binding can catch this.
      return { ...honest, txID: evil.txID, raw_data_hex: evil.raw_data_hex };
    };
    const liveBuild = makeLiveBuildSignableTx(trigger, MAIN_WALLET);

    await expect(liveBuild(item)).rejects.toThrow(/does not re-serialize/i);
  });
});

// ── c. txID does not hash-match raw_data_hex → abort ─────────────────────────

describe("live broadcast: txID/raw_data_hex hash binding", () => {
  it("rejects a node tx whose txID is not sha256(raw_data_hex)", async () => {
    process.env["TRON_RPC_PRIMARY_URL"] = "https://api.trongrid.io";
    const item = makeItem(DEPOSIT_ADDRESS);

    const trigger: TriggerSmartContractFn = async (req) => {
      const tx = buildConsistentNodeTx(req);
      return { ...tx, txID: "b".repeat(64) }; // fabricated txID
    };
    const liveBuild = makeLiveBuildSignableTx(trigger, MAIN_WALLET);

    await expect(liveBuild(item)).rejects.toThrow(/txID does not match sha256/);
  });

  it("verifyNodeTransaction accepts a fully consistent node tx", () => {
    const expected = buildTransfer({
      fromAddress: DEPOSIT_ADDRESS,
      toAddress: MAIN_WALLET,
      amountMicro: AMOUNT_MICRO,
      feeLimitSun: FEE_LIMIT_SUN,
    });
    const nodeTx = buildConsistentNodeTx({
      owner_address: expected.fromAddressHex,
      contract_address: expected.contractAddressHex,
      function_selector: "transfer(address,uint256)",
      parameter: expected.callData.slice(8),
      fee_limit: Number(FEE_LIMIT_SUN),
      call_value: 0,
      visible: false,
    });

    expect(() => verifyNodeTransaction(nodeTx, expected)).not.toThrow();
  });
});

// ── d. Env reconciliation: canonical names + legacy fallback ──────────────────

describe("live broadcast: RPC env resolution", () => {
  it("returns null (dry-run) when no RPC env is set", () => {
    expect(resolveLiveRpcConfig()).toBeNull();
    expect(isLiveBroadcastEnv()).toBe(false);
  });

  it("uses canonical TRON_RPC_PRIMARY_URL/_API_KEY (worker naming)", () => {
    process.env["TRON_RPC_PRIMARY_URL"] = "https://api.trongrid.io";
    process.env["TRON_RPC_PRIMARY_API_KEY"] = "key-primary";
    process.env["TRON_RPC_SECONDARY_URL"] = "https://tron-rpc.publicnode.com";
    process.env["TRON_RPC_SECONDARY_API_KEY"] = "key-secondary";

    const config = resolveLiveRpcConfig();
    expect(config).not.toBeNull();
    expect(config!.primary.url).toBe("https://api.trongrid.io");
    expect(config!.primary.apiKey).toBe("key-primary");
    expect(config!.secondary.url).toBe("https://tron-rpc.publicnode.com");
    expect(config!.secondary.apiKey).toBe("key-secondary");
    expect(isLiveBroadcastEnv()).toBe(true);
  });

  it("legacy TRON_RPC_PRIMARY still triggers live mode (backward compat)", () => {
    process.env["TRON_RPC_PRIMARY"] = "https://legacy.trongrid.io";

    const config = resolveLiveRpcConfig();
    expect(config).not.toBeNull();
    expect(config!.primary.url).toBe("https://legacy.trongrid.io");
    // No secondary configured — reuse primary (broadcast is single-node).
    expect(config!.secondary.url).toBe("https://legacy.trongrid.io");
    expect(isLiveBroadcastEnv()).toBe(true);
  });

  it("canonical name takes precedence over the legacy name", () => {
    process.env["TRON_RPC_PRIMARY_URL"] = "https://canonical.trongrid.io";
    process.env["TRON_RPC_PRIMARY"] = "https://legacy.trongrid.io";

    const config = resolveLiveRpcConfig();
    expect(config!.primary.url).toBe("https://canonical.trongrid.io");
  });

  it("SIGN-3 live gates fire with ONLY the canonical env name set (no legacy var)", async () => {
    // Regression for the env reconciliation: before the rename the signer gates
    // keyed on TRON_RPC_PRIMARY only — an operator setting just _URL would have
    // silently disabled the mock-tx and sha256 guards.
    process.env["TRON_RPC_PRIMARY_URL"] = "https://api.trongrid.io";

    const { assertNotMockTxIdOnLivePath } = await import("../../signer/sign.js");
    const item = makeItem(DEPOSIT_ADDRESS);
    expect(() => assertNotMockTxIdOnLivePath(item.signableTx)).toThrow(
      /refusing to broadcast a mock/,
    );
  });
});
