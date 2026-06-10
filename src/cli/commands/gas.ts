/**
 * CLI commands for TRX gas funding of sweep deposit addresses.
 *
 * gas address              — Derive + print the gas wallet address (passphrase-gated).
 * gas balance              — Show gas wallet (and per-intent deposit) TRX balances.
 * gas fund --intent <id>   — Top up deposit addresses of a pin-validated sweep
 *                            intent with TRX from the gas wallet (passphrase-gated).
 *
 * THE PROBLEM: Tron fees are paid by the SENDER. Deposit addresses receive
 * USDT but hold 0 TRX — they cannot pay for their own sweep (first-spend
 * account activation ~1.1 TRX + TRC-20 transfer energy, worst case ~30 TRX
 * if burned). The dedicated gas wallet (src/signer/gasWallet.ts — derived from
 * the same seed at reserved slot m/44'/195'/2000000000'/0/0) is pre-funded by
 * the operator and `gas fund` distributes TRX to deposit addresses BEFORE
 * `sweep execute`.
 *
 * SECURITY INVARIANTS (non-negotiable):
 *   1. The gas wallet private key is derived in-memory after a TTY passphrase
 *      prompt — never a flag/env/MCP parameter, never logged, never persisted.
 *   2. Funding destinations come ONLY from a SIGN-2 pin-validated sweep intent
 *      (toSignerIntentWithPin re-used from sweep.ts). A compromised server
 *      cannot point gas at an arbitrary address: any destination mismatch
 *      aborts the whole run before anything is signed.
 *   3. Node-returned transaction bytes are re-verified fail-closed BEFORE
 *      signing (verifyCreatedGasTx): txID === sha256(raw_data_hex), the JSON
 *      raw_data re-serializes to the same txID (txCheck binding — closes the
 *      JSON/bytes split), and owner/to/amount equal exactly what WE requested.
 *      A malicious node cannot redirect TRX or inflate the amount.
 *   4. Hard caps fail-closed: per-address 100 TRX, per-run --max-total-trx
 *      (default 500 TRX). The run aborts BEFORE any prompt or signature if
 *      the plan exceeds either cap.
 *   5. Explicit y/N TTY confirmation of the full plan before the passphrase.
 *   6. LIVE-ONLY: gas funding is inherently live. Without TRON_RPC_PRIMARY_URL
 *      the command prints what WOULD be sent and exits 0 ("dry-run, nothing
 *      broadcast") — no mock hashes, nothing signed, nothing broadcast.
 */

import type { Command } from "commander";
import { promptPassphrase, promptSeedPassphrase } from "../prompt.js";
import { encryptedSeedFromEnv } from "../seedStore.js";
import { decryptSeed } from "../../signer/seed.js";
import { deriveGasWallet, GAS_WALLET_PATH } from "../../signer/gasWallet.js";
import {
  signTransfer,
  verifyTxIdMatchesRawData,
  verifyRawDataBindsToTxId,
} from "../../signer/sign.js";
import type { SignableTx } from "../../signer/sign.js";
import { base58ToHex, isValidBase58Address } from "../../chain/tron/addressCodec.js";
import { toSignerIntentWithPin } from "./sweep.js";
import type { ApiClient } from "../apiClient.js";
import { TronHttpClient } from "../../lib/http.js";
import { broadcastTransaction } from "../../chain/tron/broadcast.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SUN_PER_TRX = 1_000_000n;

/** Default per-address top-up target: covers activation + worst-case energy burn. */
const DEFAULT_TOPUP_TRX = 30;

/**
 * Hard per-address cap. A TRC-20 transfer never legitimately needs more than
 * ~65k energy (~30 TRX burned) + activation; 100 TRX is a generous ceiling.
 * Anything above is an operator typo or an attack — fail closed.
 */
const PER_ADDRESS_CAP_SUN = 100n * SUN_PER_TRX;

/** Default per-run cap (overridable via --max-total-trx, still cap-checked). */
const DEFAULT_MAX_TOTAL_TRX = 500;

// ── Pure helpers (exported for tests) ─────────────────────────────────────────

/** One planned top-up for a deposit address. */
export interface TopUpPlanItem {
  address: string;
  balanceSun: bigint;
  topUpSun: bigint;
}

/**
 * Parse a whole-TRX CLI flag value into SUN. Integers only — money values are
 * bigint everywhere in this codebase; float TRX flags are rejected.
 */
export function parseTrxToSun(value: string, flagName: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${flagName} must be a positive whole number of TRX, got "${value}"`);
  }
  const trx = BigInt(value);
  if (trx <= 0n) {
    throw new Error(`${flagName} must be a positive whole number of TRX, got "${value}"`);
  }
  return trx * SUN_PER_TRX;
}

/**
 * Extract a TRX balance (in SUN) from a /wallet/getaccount response.
 * An UNACTIVATED account returns an empty object — that means 0 balance,
 * not an error (the address simply does not exist on-chain yet).
 */
export function parseAccountBalanceSun(resp: unknown): bigint {
  if (resp === null || typeof resp !== "object") return 0n;
  const bal = (resp as Record<string, unknown>)["balance"];
  if (bal === undefined || bal === null) return 0n;
  if (typeof bal === "number" && Number.isSafeInteger(bal) && bal >= 0) return BigInt(bal);
  if (typeof bal === "string" && /^[0-9]+$/.test(bal)) return BigInt(bal);
  throw new Error(`Unexpected balance value from node: ${String(bal)}`);
}

/**
 * Compute per-address top-ups: each address is brought up to targetSun.
 * Addresses already at/above the target are skipped (no entry returned).
 */
export function computeTopUps(
  balances: Array<{ address: string; balanceSun: bigint }>,
  targetSun: bigint,
): TopUpPlanItem[] {
  return balances
    .map(({ address, balanceSun }) => ({
      address,
      balanceSun,
      topUpSun: balanceSun >= targetSun ? 0n : targetSun - balanceSun,
    }))
    .filter((p) => p.topUpSun > 0n);
}

/**
 * Hard caps — fail closed BEFORE any prompt or signature.
 *
 * @throws Error if any single top-up exceeds PER_ADDRESS_CAP_SUN, or the run
 *         total exceeds maxTotalSun.
 */
export function assertCaps(plan: TopUpPlanItem[], maxTotalSun: bigint): void {
  let totalSun = 0n;
  for (const p of plan) {
    if (p.topUpSun > PER_ADDRESS_CAP_SUN) {
      throw new Error(
        `Per-address gas cap exceeded — ABORTING (nothing signed).\n` +
          `  ${p.address} would receive ${formatTrx(p.topUpSun)} TRX ` +
          `(cap: ${formatTrx(PER_ADDRESS_CAP_SUN)} TRX).\n` +
          `A deposit address never needs more than the cap for one sweep.`,
      );
    }
    totalSun += p.topUpSun;
  }
  if (totalSun > maxTotalSun) {
    throw new Error(
      `Per-run gas cap exceeded — ABORTING (nothing signed).\n` +
        `  Planned total: ${formatTrx(totalSun)} TRX across ${plan.length} address(es).\n` +
        `  Cap (--max-total-trx): ${formatTrx(maxTotalSun)} TRX.\n` +
        `Raise --max-total-trx explicitly if this run is intentional.`,
    );
  }
}

/** Format SUN as a decimal TRX string ("30.000000"). */
export function formatTrx(sun: bigint): string {
  const sign = sun < 0n ? "-" : "";
  const abs = sun < 0n ? -sun : sun;
  return `${sign}${abs / SUN_PER_TRX}.${(abs % SUN_PER_TRX).toString().padStart(6, "0")}`;
}

// ── Node response verification (exported for tests) ──────────────────────────

/** What we asked the node to build — the trust anchor for verification. */
export interface ExpectedGasTransfer {
  /** Gas wallet address, hex (41...), lowercased for comparison. */
  ownerHex: string;
  /** Deposit address, hex (41...), lowercased for comparison. */
  toHex: string;
  /** Top-up amount in SUN. */
  amountSun: bigint;
}

function normHex(hex: string): string {
  return (hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex).toLowerCase();
}

function gasTxAbort(detail: string): Error {
  return new Error(
    `Gas funding tx verification failed — ABORTING run (nothing further signed).\n  ${detail}\n` +
      `The node response does not match the transfer we requested — ` +
      `a malicious or broken node must not redirect TRX or inflate the amount.`,
  );
}

/**
 * Fail-closed verification of a /wallet/createtransaction response.
 *
 * Chain of trust (all three required before signing):
 *   1. txID === sha256(raw_data_hex)        — the txID we sign binds the bytes.
 *   2. raw_data JSON re-serializes to txID  — txCheck (verifyRawDataBindsToTxId)
 *      proves raw_data_hex == protobuf(raw_data JSON), so inspecting the JSON
 *      fields is equivalent to inspecting the signed bytes.
 *   3. Semantic match against OUR request   — exactly one TransferContract with
 *      owner_address / to_address / amount equal to what we asked for.
 *
 * @throws Error on any mismatch or malformed response.
 */
export function verifyCreatedGasTx(resp: unknown, expected: ExpectedGasTransfer): SignableTx {
  if (resp === null || typeof resp !== "object") {
    throw gasTxAbort("node returned a non-object response");
  }
  const tx = resp as Record<string, unknown>;
  if (typeof tx["Error"] === "string") {
    throw gasTxAbort(`node returned an error: ${tx["Error"]}`);
  }

  const txID = tx["txID"];
  const rawDataHex = tx["raw_data_hex"];
  const rawData = tx["raw_data"];
  if (typeof txID !== "string" || typeof rawDataHex !== "string") {
    throw gasTxAbort("node response is missing txID / raw_data_hex");
  }
  if (rawData === null || typeof rawData !== "object") {
    throw gasTxAbort("node response is missing raw_data");
  }

  // (1) txID binds the signable bytes.
  verifyTxIdMatchesRawData(txID, rawDataHex);

  // (2) JSON raw_data binds to txID (protobuf re-encode). Without this a
  // malicious node could return honest-looking JSON next to raw_data_hex that
  // encodes a DIFFERENT transfer — and the signature authorizes the bytes.
  verifyRawDataBindsToTxId(tx as unknown as SignableTx);

  // (3) Semantic match: exactly one TransferContract paying exactly our request.
  const contracts = (rawData as Record<string, unknown>)["contract"];
  if (!Array.isArray(contracts) || contracts.length !== 1) {
    throw gasTxAbort(
      `expected exactly 1 contract in raw_data, got ${Array.isArray(contracts) ? contracts.length : "none"}`,
    );
  }
  const contract = contracts[0] as Record<string, unknown>;
  if (contract["type"] !== "TransferContract") {
    throw gasTxAbort(`expected contract type TransferContract, got ${String(contract["type"])}`);
  }
  const parameter = contract["parameter"] as Record<string, unknown> | undefined;
  const value = parameter?.["value"] as Record<string, unknown> | undefined;
  if (!value) {
    throw gasTxAbort("contract has no parameter.value");
  }

  const owner = value["owner_address"];
  if (typeof owner !== "string" || normHex(owner) !== normHex(expected.ownerHex)) {
    throw gasTxAbort(
      `owner_address mismatch: requested ${expected.ownerHex}, node returned ${String(owner)}`,
    );
  }
  const to = value["to_address"];
  if (typeof to !== "string" || normHex(to) !== normHex(expected.toHex)) {
    throw gasTxAbort(
      `to_address mismatch: requested ${expected.toHex}, node returned ${String(to)}`,
    );
  }

  const amountRaw = value["amount"];
  let amountSun: bigint;
  if (typeof amountRaw === "number" && Number.isSafeInteger(amountRaw) && amountRaw > 0) {
    amountSun = BigInt(amountRaw);
  } else if (typeof amountRaw === "string" && /^[0-9]+$/.test(amountRaw)) {
    amountSun = BigInt(amountRaw);
  } else {
    throw gasTxAbort(`amount is not a positive integer: ${String(amountRaw)}`);
  }
  if (amountSun !== expected.amountSun) {
    throw gasTxAbort(
      `amount mismatch: requested ${expected.amountSun} SUN, node returned ${amountSun} SUN`,
    );
  }

  return tx as unknown as SignableTx;
}

// ── Node client ───────────────────────────────────────────────────────────────

/**
 * Build a TronHttpClient from the canonical env names (mirrors
 * src/workers/index.ts). Returns null when TRON_RPC_PRIMARY_URL is unset —
 * gas funding then runs as a plan-only dry-run (nothing signed/broadcast).
 */
function buildNodeClientFromEnv(): TronHttpClient | null {
  const primaryUrl = process.env["TRON_RPC_PRIMARY_URL"];
  if (!primaryUrl) return null;
  const secondaryUrl = process.env["TRON_RPC_SECONDARY_URL"];
  return new TronHttpClient({
    primary: { url: primaryUrl, apiKey: process.env["TRON_RPC_PRIMARY_API_KEY"] },
    secondary: secondaryUrl
      ? { url: secondaryUrl, apiKey: process.env["TRON_RPC_SECONDARY_API_KEY"] }
      // Pin secondary to primary when unset, like the worker's pinned clients —
      // failover only ever re-hits the same node.
      : { url: primaryUrl, apiKey: process.env["TRON_RPC_PRIMARY_API_KEY"] },
    timeoutMs: 10_000,
  });
}

/** Query an address's TRX balance in SUN. Unactivated account = 0n. */
async function fetchTrxBalanceSun(client: TronHttpClient, base58Address: string): Promise<bigint> {
  const { data } = await client.post<unknown>("/wallet/getaccount", {
    address: base58ToHex(base58Address),
  });
  return parseAccountBalanceSun(data);
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerGasCommands(parent: Command, getApi: () => ApiClient): void {
  const gas = parent.command("gas").description("Manage TRX gas funding for sweeps");

  // gas address
  gas
    .command("address")
    .description(
      [
        "Derive and print the gas wallet address (LOCAL — requires passphrase).",
        "",
        `The gas wallet lives at the reserved seed slot ${GAS_WALLET_PATH}.`,
        "Nothing is signed or moved — this only shows WHERE to send TRX so the",
        "operator can pre-fund gas for sweeps.",
      ].join("\n"),
    )
    .action(async () => {
      // TTY passphrase gate — promptSeedPassphrase enforces isTTY === true.
      const passphrase = await promptSeedPassphrase(
        "Enter seed passphrase to derive the gas wallet address: ",
      );
      const mnemonic = await decryptSeed(encryptedSeedFromEnv(), passphrase);
      const wallet = deriveGasWallet(mnemonic);
      // Only the ADDRESS is printed — the private key never leaves memory.
      console.log(`Gas wallet (${GAS_WALLET_PATH}):`);
      console.log(`  ${wallet.address}`);
      console.log("");
      console.log("Pre-fund this address with TRX. It pays activation + energy for");
      console.log("deposit-address sweeps via `stablerails gas fund --intent <id>`.");
    });

  // gas balance
  gas
    .command("balance")
    .description(
      [
        "Show the gas wallet TRX balance (live node read — requires TRON_RPC_PRIMARY_URL).",
        "",
        "By default the gas wallet address is derived from the seed (passphrase",
        "prompt). Pass --address to skip derivation entirely.",
        "With --intent, also shows each deposit address's TRX balance.",
      ].join("\n"),
    )
    .option("--address <base58>", "Gas wallet address (T...) — skips passphrase-gated derivation")
    .option("--intent <id>", "SweepIntent id — also show per-deposit-address TRX balances")
    .action(async (opts: { address?: string; intent?: string }) => {
      const client = buildNodeClientFromEnv();
      if (!client) {
        console.error(
          "TRON_RPC_PRIMARY_URL is not set — balance queries are live node reads.\n" +
            "Set TRON_RPC_PRIMARY_URL (and optionally TRON_RPC_PRIMARY_API_KEY) and retry.",
        );
        process.exit(1);
      }

      let gasAddress: string;
      if (opts.address) {
        if (!isValidBase58Address(opts.address)) {
          console.error(`Not a valid Tron Base58 address: ${opts.address}`);
          process.exit(1);
        }
        gasAddress = opts.address;
      } else {
        const passphrase = await promptSeedPassphrase(
          "Enter seed passphrase to derive the gas wallet address: ",
        );
        const mnemonic = await decryptSeed(encryptedSeedFromEnv(), passphrase);
        gasAddress = deriveGasWallet(mnemonic).address;
      }

      const gasBalance = await fetchTrxBalanceSun(client, gasAddress);
      console.log(`Gas wallet ${gasAddress}: ${formatTrx(gasBalance)} TRX`);

      if (opts.intent) {
        const raw = (await getApi().getSweep(opts.intent)) as Record<string, unknown>;
        const items = raw["items"];
        if (Array.isArray(items)) {
          console.log(`Deposit addresses in sweep intent ${opts.intent}:`);
          for (const it of items as Array<Record<string, unknown>>) {
            const addr = it["address"];
            if (typeof addr === "string") {
              const bal = await fetchTrxBalanceSun(client, addr);
              console.log(`  ${addr}: ${formatTrx(bal)} TRX`);
            }
          }
        }
      }
    });

  // gas fund
  gas
    .command("fund")
    .description(
      [
        "Top up deposit addresses of a sweep intent with TRX from the gas wallet",
        "(LOCAL signing — requires passphrase).",
        "",
        "Destinations come ONLY from a SIGN-2 pin-validated sweep intent — the",
        "server cannot redirect gas. Node-built transactions are re-verified",
        "fail-closed (owner/to/amount + txID hash binding) before signing.",
        "",
        "LIVE: requires TRON_RPC_PRIMARY_URL. Without it the command prints the",
        "plan (balances assumed 0) and exits — dry-run, nothing broadcast.",
      ].join("\n"),
    )
    .requiredOption("--intent <id>", "SweepIntent id (from `sweep prepare`)")
    .option(
      "--topup-trx <n>",
      "Per-address TRX target balance (whole TRX)",
      String(DEFAULT_TOPUP_TRX),
    )
    .option(
      "--max-total-trx <n>",
      "Hard cap on the total TRX sent in this run (whole TRX)",
      String(DEFAULT_MAX_TOTAL_TRX),
    )
    .action(async (opts: { intent: string; topupTrx: string; maxTotalTrx: string }) => {
      const targetSun = parseTrxToSun(opts.topupTrx, "--topup-trx");
      const maxTotalSun = parseTrxToSun(opts.maxTotalTrx, "--max-total-trx");
      // Fail early: a target above the per-address cap can never be satisfied.
      if (targetSun > PER_ADDRESS_CAP_SUN) {
        throw new Error(
          `--topup-trx exceeds the per-address hard cap of ${formatTrx(PER_ADDRESS_CAP_SUN)} TRX — ABORTING.`,
        );
      }

      // ── SIGN-2 reuse: pin-validate the intent BEFORE anything else ─────────
      // toSignerIntentWithPin asserts every item's destination equals the local
      // STABLERAILS_MAIN_WALLET pin and that the signable bytes match (SIGN-2b).
      // Gas goes only to item.address values from a pin-validated intent — a
      // compromised server cannot inject an arbitrary funding destination.
      const rawIntent = await getApi().getSweep(opts.intent);
      const intent = toSignerIntentWithPin(rawIntent as Record<string, unknown>);

      if (intent.items.length === 0) {
        console.error("No items in sweep intent — nothing to fund.");
        process.exit(1);
      }

      const client = buildNodeClientFromEnv();
      const dryRun = client === null;

      // Balances: live node reads. In dry-run (no RPC env) we cannot query —
      // assume 0 (worst case) so the printed plan shows the maximum send.
      const balances: Array<{ address: string; balanceSun: bigint }> = [];
      for (const item of intent.items) {
        const balanceSun =
          client === null ? 0n : await fetchTrxBalanceSun(client, item.address);
        balances.push({ address: item.address, balanceSun });
      }

      const plan = computeTopUps(balances, targetSun);
      if (plan.length === 0) {
        console.log(
          `All ${intent.items.length} deposit address(es) are already at/above ` +
            `${formatTrx(targetSun)} TRX — nothing to fund.`,
        );
        return;
      }

      // ── Hard caps: abort BEFORE any prompt or signature ────────────────────
      assertCaps(plan, maxTotalSun);

      let totalSun = 0n;
      for (const p of plan) totalSun += p.topUpSun;

      console.log("\n========== GAS FUNDING PLAN ==========");
      console.log(`  Intent: ${intent.id} (event ${intent.eventId})`);
      console.log(`  Target per address: ${formatTrx(targetSun)} TRX`);
      for (const p of plan) {
        console.log(
          `    ${p.address}  current ${formatTrx(p.balanceSun)} TRX  →  +${formatTrx(p.topUpSun)} TRX`,
        );
      }
      const skipped = intent.items.length - plan.length;
      if (skipped > 0) {
        console.log(`    (${skipped} address(es) already at/above target — skipped)`);
      }
      console.log(`  Total to send: ${formatTrx(totalSun)} TRX from the gas wallet`);
      console.log("======================================\n");

      if (dryRun) {
        console.log("DRY-RUN: TRON_RPC_PRIMARY_URL is not set — gas funding is inherently live.");
        console.log("Balances assumed 0 (worst case); the plan above is what WOULD be sent.");
        console.log("dry-run, nothing broadcast");
        return;
      }

      // ── Explicit operator confirmation at the TTY, BEFORE the passphrase ───
      const confirmation = await promptPassphrase(
        `Send ${formatTrx(totalSun)} TRX to ${plan.length} deposit address(es)? [y/N]: `,
      );
      if (confirmation.trim().toLowerCase() !== "y") {
        console.error("Gas funding aborted by operator.");
        process.exit(1);
      }

      // ── HUMAN PASSPHRASE GATE ───────────────────────────────────────────────
      // promptSeedPassphrase enforces process.stdin.isTTY === true — piped or
      // non-interactive input is rejected before the seed is touched.
      const passphrase = await promptSeedPassphrase("Enter seed passphrase to sign gas top-ups: ");
      const encryptedSeed = encryptedSeedFromEnv();
      const mnemonic = await decryptSeed(encryptedSeed, passphrase);
      const gasWallet = deriveGasWallet(mnemonic);
      const ownerHex = base58ToHex(gasWallet.address);
      // ── END GATE — private key stays in gasWallet.privateKey, never logged ──

      // Sanity: the gas wallet must hold at least the planned total (fees are
      // bandwidth-cheap for plain TRX transfers but the balance must cover sends).
      const gasBalanceSun = await fetchTrxBalanceSun(client, gasWallet.address);
      if (gasBalanceSun < totalSun) {
        throw new Error(
          `Gas wallet balance is insufficient — ABORTING (nothing signed).\n` +
            `  Gas wallet ${gasWallet.address}: ${formatTrx(gasBalanceSun)} TRX\n` +
            `  Planned total: ${formatTrx(totalSun)} TRX\n` +
            `Fund the gas wallet (see \`stablerails gas address\`) and retry.`,
        );
      }

      let succeeded = 0;
      let failed = 0;
      for (const p of plan) {
        const toHex = base58ToHex(p.address);
        // Build a plain TRX TransferContract on the node. Amounts are capped at
        // 100 TRX (1e8 SUN) — safely within Number range for the node JSON API.
        const { data } = await client.post<unknown>("/wallet/createtransaction", {
          owner_address: ownerHex,
          to_address: toHex,
          amount: Number(p.topUpSun),
        });

        // Fail-closed verification of the node-returned bytes. Throws — and
        // thereby ABORTS the remaining run — on any mismatch: continuing to
        // sign against a node that already lied once is never acceptable.
        const signable = verifyCreatedGasTx(data, { ownerHex, toHex, amountSun: p.topUpSun });

        // Reuse the signer's generic offline signing primitive (signs txID
        // bytes via secp256k1 — not TRC-20 specific despite the name).
        const signed = signTransfer(gasWallet.privateKey, signable);

        const result = await broadcastTransaction(client, signed);
        if (result.success) {
          succeeded++;
          console.log(`  ✓ ${p.address}  +${formatTrx(p.topUpSun)} TRX  txID=${result.txId}`);
        } else {
          failed++;
          console.error(`  ✗ ${p.address}  broadcast failed: ${result.error ?? "unknown"}`);
        }
      }

      console.log(`\nGas funding complete: ${succeeded} succeeded, ${failed} failed.`);
      if (failed > 0) {
        process.exit(1);
      }
    });
}
