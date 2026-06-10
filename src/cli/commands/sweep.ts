/**
 * CLI commands for sweeps.
 *
 * sweep prepare --event <id>         — Build unsigned txs server-side (read-only).
 * sweep execute --intent <id>        — Sign + broadcast locally (passphrase-gated).
 * sweep status  <id>                 — Show sweep intent status.
 *
 * SECURITY — THE HUMAN PASSPHRASE GATE:
 *   `sweep execute` reads the passphrase via a hidden TTY readline prompt.
 *   The passphrase is NEVER:
 *     - a CLI flag or argument (not in commander options, not in process.argv)
 *     - an env var
 *     - an MCP tool parameter
 *     - anything an automated agent can supply
 *   `promptPassphrase` enforces `process.stdin.isTTY === true` and THROWS if
 *   stdin is not an interactive terminal (piped input, CI, MCP, automated agents).
 *   Funds CANNOT move without a human typing the passphrase at a real terminal.
 *
 * BROADCAST GATE:
 *   `sweep execute` is LIVE only when `TRON_RPC_PRIMARY_URL` (canonical; legacy
 *   `TRON_RPC_PRIMARY` also accepted) is set in the environment.
 *   Without it the command runs as an explicit DRY-RUN: signs locally, prints the
 *   signed txID, and does NOT post any broadcast-result to the server.
 *   A fabricated success txHash is NEVER emitted — only real broadcast txIDs from
 *   an actual node response are recorded.
 *
 * LIVE TX CONSTRUCTION (SIGN-3 go-live):
 *   On the live path the real transaction is built via the node's
 *   POST /wallet/triggersmartcontract using LOCALLY-derived bytes, then the
 *   node's response is verified field-by-field against the local expectation
 *   (txID = sha256(raw_data_hex), JSON↔bytes protobuf binding, destination /
 *   amount / contract / owner / fee_limit). ALL node txs are built and verified
 *   BEFORE anything is signed — a single tampered response aborts the whole sweep.
 */

import type { Command } from "commander";
import { promptPassphrase, promptSeedPassphrase } from "../prompt.js";
import { encryptedSeedFromEnv } from "../seedStore.js";
import { executeSweep } from "../../signer/sweep.js";
import type { SweepIntent, SweepItem } from "../../signer/sweep.js";
import {
  buildMockTxId,
  assertNotMockTxIdOnLivePath,
  verifyTxIdMatchesRawData,
  verifyRawDataBindsToTxId,
} from "../../signer/sign.js";
import type { SignableTx } from "../../signer/sign.js";
import { isValidBase58Address } from "../../chain/tron/addressCodec.js";
import { buildTransfer } from "../../chain/tron/buildTransfer.js";
import type { UnsignedTrc20Transfer } from "../../chain/tron/buildTransfer.js";
import type { ApiClient } from "../apiClient.js";
// Type-only imports — erased at compile time, so the heavy RPC modules are
// still loaded lazily (dynamic import) only on the live path.
import type {
  TriggerSmartContractRequest,
  TronNodeTransaction,
} from "../../chain/tron/broadcast.js";
import type { HttpClientConfig } from "../../lib/http.js";

// ── SIGN-2: local main-wallet destination pin ─────────────────────────────────

/**
 * Return the locally-pinned main wallet address from STABLERAILS_MAIN_WALLET.
 *
 * This env var is the operator's local safeguard: it is independent of the
 * server. The sweep command asserts every item's toAddressBase58 equals this
 * pin BEFORE signing anything — a server/DB/admin-key compromise that mutates
 * mainWalletAddress cannot redirect funds silently.
 *
 * @throws Error if STABLERAILS_MAIN_WALLET is not set, guiding the operator to
 *         configure it before running `sweep execute`.
 */
/** Tron mainnet Base58Check address: starts with T, 34 chars total. */
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function getMainWalletPin(): string {
  const pin = process.env["STABLERAILS_MAIN_WALLET"];
  if (!pin) {
    throw new Error(
      "STABLERAILS_MAIN_WALLET is not set.\n" +
        "Set it to your main wallet's Base58 address (T...) before running sweep execute.\n" +
        "Example: export STABLERAILS_MAIN_WALLET=TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe\n" +
        "This pin is the local safeguard against a server-side destination substitution.",
    );
  }
  if (!TRON_ADDRESS_RE.test(pin)) {
    throw new Error(
      `STABLERAILS_MAIN_WALLET is not a valid Tron address: "${pin}".\n` +
        "A valid Tron mainnet address starts with T and is 34 characters long (Base58).\n" +
        "Example: export STABLERAILS_MAIN_WALLET=TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
    );
  }
  // The regex above is only a cheap charset pre-filter. Verify the Base58Check
  // checksum too: a single-character typo with a valid charset would otherwise
  // pass and pin sweeps to a non-existent (fund-burning) destination.
  if (!isValidBase58Address(pin)) {
    throw new Error(
      `STABLERAILS_MAIN_WALLET is not a valid Tron address (Base58Check checksum failed): "${pin}".\n` +
        "The address has a valid format but its checksum does not verify — likely a typo.\n" +
        "Copy the address again from a trusted source and re-export STABLERAILS_MAIN_WALLET.",
    );
  }
  return pin;
}

/**
 * Convert the server's API SweepIntent JSON into the signer's SweepIntent type,
 * asserting every item's destination matches the locally-pinned main wallet.
 *
 * SIGN-2: Aborts the ENTIRE sweep (throws before signing anything) if any item's
 * toAddressBase58 does not equal the local pin from STABLERAILS_MAIN_WALLET.
 *
 * SIGN-2b: Additionally recomputes the signable bytes (toAddressHex, callData)
 * locally from the pin + amountMicroStr, asserts the server-provided values
 * match, bounds-checks feeLimitSun, and signs ONLY the locally-derived bytes.
 * A server that displays the pinned address but encodes an attacker destination
 * or different amount in callData is rejected.
 *
 * @throws Error  If STABLERAILS_MAIN_WALLET is unset (no silent trust of server).
 * @throws Error  If any item's toAddressBase58 mismatches the local pin.
 * @throws Error  If any item's toAddressHex/callData mismatches the locally-derived
 *                transfer, or feeLimitSun is out of bounds.
 */
export function toSignerIntentWithPin(raw: Record<string, unknown>): SweepIntent {
  const localPin = getMainWalletPin();
  return toSignerIntentChecked(raw, localPin);
}

/**
 * SIGN-2b: maximum accepted fee limit for a sweep tx, in SUN.
 * 1000 TRX = 1_000_000_000 SUN — the Tron network's own per-tx fee_limit
 * ceiling. A normal USDT transfer needs ~15–65 TRX; anything above 1000 TRX is
 * either a server bug or a compromised server trying to burn the operator's
 * TRX as fees. Fail closed.
 */
const MAX_SWEEP_FEE_LIMIT_SUN = 1_000_000_000n;

/** Normalize a hex string for comparison: strip optional 0x, lowercase. */
function normalizeHex(hex: string): string {
  return (hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex).toLowerCase();
}

/**
 * Internal: convert + pin-check. Separated so `sweep execute` can call the
 * exported version while tests can call this directly.
 */
function toSignerIntentChecked(raw: Record<string, unknown>, localPin: string): SweepIntent {
  const items = (raw["items"] as Array<Record<string, unknown>>).map((item, idx): SweepItem => {
    const amountMicro = BigInt(item["amountMicroStr"] as string);

    // Reconstruct the UnsignedTrc20Transfer with bigint fields.
    const unsignedTx = item["unsignedTx"] as Record<string, unknown>;
    const toAddressBase58 = unsignedTx["toAddressBase58"] as string;

    // ── SIGN-2: hard-assert destination before building any signable tx ──────
    // Abort the ENTIRE sweep if ANY item points to an unexpected destination.
    // This is a local check using STABLERAILS_MAIN_WALLET — independent of server.
    if (toAddressBase58 !== localPin) {
      throw new Error(
        `Sweep destination mismatch — ABORTING (nothing signed).\n` +
          `  Local pin (STABLERAILS_MAIN_WALLET): ${localPin}\n` +
          `  Server-provided destination (item ${idx}):  ${toAddressBase58}\n` +
          `A server-side or DB compromise may have substituted the destination address.\n` +
          `Verify your server, DB, and STABLERAILS_MAIN_WALLET config before retrying.`,
      );
    }
    // ── end SIGN-2 destination check ─────────────────────────────────────────

    // ── SIGN-2b: never trust server-provided signable bytes ──────────────────
    // The pin check above only covers the DISPLAY field (toAddressBase58). The
    // bytes that actually get signed are toAddressHex + callData — a compromised
    // server could show the pinned address while encoding an attacker destination
    // (or a different amount) in callData. Recompute the transfer LOCALLY from
    // the trusted pin + amountMicro, hard-assert the server values match, and
    // sign ONLY the locally-derived bytes (server values are advisory display).

    // Fee-limit sanity: a compromised server must not be able to burn the
    // operator's TRX via an absurd fee_limit. See MAX_SWEEP_FEE_LIMIT_SUN.
    const feeLimitSun = BigInt(unsignedTx["feeLimitSun"] as string);
    if (feeLimitSun <= 0n || feeLimitSun > MAX_SWEEP_FEE_LIMIT_SUN) {
      throw new Error(
        `Sweep fee limit out of bounds — ABORTING (nothing signed).\n` +
          `  Server-provided feeLimitSun (item ${idx}): ${feeLimitSun}\n` +
          `  Allowed range: 1..${MAX_SWEEP_FEE_LIMIT_SUN} SUN (max 1000 TRX — Tron network cap).\n` +
          `A server-side compromise may be attempting to burn TRX as fees.`,
      );
    }

    // Rebuild the canonical transfer from local trust anchors only:
    //   destination = localPin (STABLERAILS_MAIN_WALLET), amount = amountMicroStr,
    //   contract = local TRON_USDT_CONTRACT constants inside buildTransfer.
    const expectedTransfer = buildTransfer({
      fromAddress: unsignedTx["fromAddressBase58"] as string,
      toAddress: localPin,
      amountMicro,
      feeLimitSun,
      memo: (unsignedTx["memo"] as string) ?? "",
    });

    const serverToAddressHex = unsignedTx["toAddressHex"] as string;
    if (normalizeHex(serverToAddressHex) !== normalizeHex(expectedTransfer.toAddressHex)) {
      throw new Error(
        `Sweep destination hex mismatch — ABORTING (nothing signed).\n` +
          `  Locally derived from STABLERAILS_MAIN_WALLET: ${expectedTransfer.toAddressHex}\n` +
          `  Server-provided toAddressHex (item ${idx}):  ${serverToAddressHex}\n` +
          `The server-provided signable bytes do not pay the pinned destination.\n` +
          `A server-side or DB compromise may have substituted the destination address.`,
      );
    }

    const serverCallData = unsignedTx["callData"] as string;
    if (normalizeHex(serverCallData) !== normalizeHex(expectedTransfer.callData)) {
      throw new Error(
        `Sweep callData mismatch — ABORTING (nothing signed).\n` +
          `  Locally derived transfer(${localPin}, ${amountMicro}): ${expectedTransfer.callData}\n` +
          `  Server-provided callData (item ${idx}):                ${serverCallData}\n` +
          `The ABI-encoded destination/amount the server wants signed does not match\n` +
          `the pinned destination + item amount. A server-side compromise may be\n` +
          `redirecting funds or altering the amount.`,
      );
    }
    // ── end SIGN-2b signable-bytes check ──────────────────────────────────────

    // Use ONLY the locally-derived transfer for signing. Server-provided
    // toAddressHex/callData/contract fields were verified above but never
    // enter the signable tx — the strongest form of the pin.
    const trc20Transfer = expectedTransfer;

    // Build a deterministic txID from the transfer params.
    // Dry-run only: on the LIVE path this mock is REPLACED by a real node tx
    // (makeLiveBuildSignableTx → triggerSmartContract). The mock still carries
    // the validated fee_limit + locally-derived callData forward for the live
    // builder to consume.
    const txID = buildMockTxId(trc20Transfer, item["index"] as number);

    return {
      address: item["address"] as string,
      account: item["account"] as number,
      index: item["index"] as number,
      amountMicro,
      signableTx: {
        txID,
        raw_data_hex: trc20Transfer.callData,
        raw_data: {
          contract: [],
          fee_limit: Number(trc20Transfer.feeLimitSun),
        },
      },
    };
  });

  return {
    id: raw["id"] as string,
    eventId: raw["eventId"] as string,
    status: raw["status"] as SweepIntent["status"],
    items,
    createdAt: raw["createdAt"] as string,
  };
}

// ── Live RPC env resolution ───────────────────────────────────────────────────

/**
 * Resolve the Tron RPC configuration for the LIVE broadcast path.
 *
 * Canonical env names (same as the worker / .env.example / docker-compose):
 *   TRON_RPC_PRIMARY_URL   + TRON_RPC_PRIMARY_API_KEY
 *   TRON_RPC_SECONDARY_URL + TRON_RPC_SECONDARY_API_KEY
 *
 * Legacy fallback (pre-go-live CLI naming, kept for backward compatibility):
 *   TRON_RPC_PRIMARY / TRON_RPC_SECONDARY (URL-only, no API key vars).
 *
 * @returns  The TronHttpClient config, or null = DRY-RUN (no live RPC env set).
 */
export function resolveLiveRpcConfig(): HttpClientConfig | null {
  const primaryUrl =
    process.env["TRON_RPC_PRIMARY_URL"] || process.env["TRON_RPC_PRIMARY"];
  if (!primaryUrl) {
    return null; // dry-run: sign locally, never broadcast
  }
  const secondaryUrl =
    process.env["TRON_RPC_SECONDARY_URL"] ||
    process.env["TRON_RPC_SECONDARY"] ||
    // broadcast/trigger are single-node operations (no two-RPC agreement needed
    // — every node response is verified locally); reuse primary if no secondary.
    primaryUrl;
  return {
    primary: { url: primaryUrl, apiKey: process.env["TRON_RPC_PRIMARY_API_KEY"] },
    secondary: { url: secondaryUrl, apiKey: process.env["TRON_RPC_SECONDARY_API_KEY"] },
  };
}

// ── Live node-tx construction + verification (go-live SIGN-3 closure) ─────────

/** Injectable seam for tests: how to call POST /wallet/triggersmartcontract. */
export type TriggerSmartContractFn = (
  req: TriggerSmartContractRequest,
) => Promise<TronNodeTransaction>;

/** First 4 bytes (8 hex chars) of callData = keccak selector for transfer(address,uint256). */
const SELECTOR_HEX_LEN = 8;

/**
 * Verify a node-returned transaction against the locally-derived transfer.
 *
 * NEVER trust the node blindly (same philosophy as SIGN-2b). Verification chain:
 *   1. txID === sha256(raw_data_hex)            — txID binds to the signed bytes.
 *   2. protobuf(raw_data JSON) reproduces txID  — the inspectable JSON binds to
 *      the signed bytes (tronweb txCheck). 1+2 together: raw_data_hex encodes
 *      exactly the JSON we inspect below.
 *   3. raw_data.contract is exactly ONE TriggerSmartContract whose
 *      owner_address / contract_address / data equal the LOCALLY-derived
 *      transfer (pin + amount + pinned USDT contract).
 *   4. raw_data.fee_limit equals the validated fee limit.
 *
 * Any mismatch throws — the caller aborts the WHOLE sweep before signing.
 *
 * @throws Error  On any deviation from the locally-derived expectation.
 */
export function verifyNodeTransaction(
  nodeTx: TronNodeTransaction,
  expected: UnsignedTrc20Transfer,
): void {
  // 1. txID = sha256(raw_data_hex) — the standard Tron invariant.
  verifyTxIdMatchesRawData(nodeTx.txID, nodeTx.raw_data_hex);
  // 2. JSON raw_data re-serializes to the same txID (binds JSON ↔ signed bytes).
  verifyRawDataBindsToTxId(nodeTx as unknown as SignableTx);

  // 3. Semantic checks on the (now bytes-bound) JSON raw_data.
  const rawData = nodeTx.raw_data as Record<string, unknown> | null | undefined;
  const contracts = rawData?.["contract"];
  if (!Array.isArray(contracts) || contracts.length !== 1) {
    throw new Error(
      `Node tx verification failed — ABORTING (nothing signed).\n` +
        `  Expected exactly 1 contract entry in raw_data.contract, got ` +
        `${Array.isArray(contracts) ? contracts.length : "none"}.`,
    );
  }
  const contract = contracts[0] as Record<string, unknown>;
  if (contract["type"] !== "TriggerSmartContract") {
    throw new Error(
      `Node tx verification failed — ABORTING (nothing signed).\n` +
        `  Expected contract type TriggerSmartContract, got "${String(contract["type"])}".`,
    );
  }
  const value = (contract["parameter"] as Record<string, unknown> | undefined)?.[
    "value"
  ] as Record<string, unknown> | undefined;
  const ownerAddress = value?.["owner_address"];
  const contractAddress = value?.["contract_address"];
  const data = value?.["data"];
  if (
    typeof ownerAddress !== "string" ||
    typeof contractAddress !== "string" ||
    typeof data !== "string"
  ) {
    throw new Error(
      `Node tx verification failed — ABORTING (nothing signed).\n` +
        `  raw_data.contract[0].parameter.value is missing owner_address / ` +
        `contract_address / data.`,
    );
  }
  if (normalizeHex(ownerAddress) !== normalizeHex(expected.fromAddressHex)) {
    throw new Error(
      `Node tx owner_address mismatch — ABORTING (nothing signed).\n` +
        `  Expected (deposit address): ${expected.fromAddressHex}\n` +
        `  Node returned:              ${ownerAddress}`,
    );
  }
  if (normalizeHex(contractAddress) !== normalizeHex(expected.contractAddressHex)) {
    throw new Error(
      `Node tx contract_address mismatch — ABORTING (nothing signed).\n` +
        `  Expected (pinned USDT contract): ${expected.contractAddressHex}\n` +
        `  Node returned:                   ${contractAddress}\n` +
        `A malicious node may be substituting the token contract.`,
    );
  }
  if (normalizeHex(data) !== normalizeHex(expected.callData)) {
    throw new Error(
      `Node tx callData mismatch — ABORTING (nothing signed).\n` +
        `  Locally derived: ${expected.callData}\n` +
        `  Node returned:   ${data}\n` +
        `A malicious node may be substituting the destination or amount.`,
    );
  }
  // call_value must be absent or 0: a TriggerSmartContract carrying TRX
  // call_value would transfer the operator's TRX alongside the TRC-20 call.
  // We always request call_value: 0 — any other returned value is hostile.
  const callValue = value && Object.hasOwn(value, "call_value") ? value["call_value"] : 0;
  if (Number(callValue) !== 0) {
    throw new Error(
      `Node tx call_value mismatch — ABORTING (nothing signed).\n` +
        `  Expected: 0 (TRC-20 transfers never carry TRX)\n` +
        `  Node returned: ${String(callValue)}\n` +
        `A malicious node may be attempting to drain TRX via call_value.`,
    );
  }
  // 4. fee_limit must equal the validated value we requested.
  const feeLimit = rawData?.["fee_limit"];
  if (
    typeof feeLimit !== "number" ||
    !Number.isSafeInteger(feeLimit) ||
    BigInt(feeLimit) !== expected.feeLimitSun
  ) {
    throw new Error(
      `Node tx fee_limit mismatch — ABORTING (nothing signed).\n` +
        `  Requested: ${expected.feeLimitSun} SUN\n` +
        `  Node returned: ${String(feeLimit)}\n` +
        `A malicious node may be attempting to burn TRX as fees.`,
    );
  }
}

/**
 * Extract the validated fee limit embedded in the item's (mock) signableTx by
 * toSignerIntentChecked — it was bounds-checked there. Re-validate anyway
 * (defense in depth: this value goes into the node request).
 */
function extractValidatedFeeLimitSun(item: SweepItem): bigint {
  const rawData = item.signableTx.raw_data as Record<string, unknown> | null | undefined;
  const feeLimit = rawData?.["fee_limit"];
  if (
    typeof feeLimit !== "number" ||
    !Number.isSafeInteger(feeLimit) ||
    feeLimit <= 0 ||
    BigInt(feeLimit) > MAX_SWEEP_FEE_LIMIT_SUN
  ) {
    throw new Error(
      `Sweep item fee limit invalid — ABORTING (nothing signed).\n` +
        `  Item ${item.address}: fee_limit=${String(feeLimit)}\n` +
        `  Allowed range: 1..${MAX_SWEEP_FEE_LIMIT_SUN} SUN.`,
    );
  }
  return BigInt(feeLimit);
}

/**
 * Build the LIVE per-item SignableTx constructor (go-live SIGN-3 closure).
 *
 * For each sweep item:
 *   1. Rebuild the canonical transfer LOCALLY (deposit address → pinned main
 *      wallet, item amount, pinned USDT contract) — local trust anchors only.
 *   2. Call POST /wallet/triggersmartcontract on the node with the
 *      locally-derived bytes (parameter = callData minus the 4-byte selector).
 *   3. Verify the node's response rigorously (verifyNodeTransaction) — any
 *      deviation throws and the caller aborts the whole sweep.
 *
 * @param trigger   Injectable node call (production: triggerSmartContract over
 *                  TronHttpClient; tests: a mock).
 * @param localPin  The validated STABLERAILS_MAIN_WALLET destination pin.
 */
export function makeLiveBuildSignableTx(
  trigger: TriggerSmartContractFn,
  localPin: string,
): (item: SweepItem) => Promise<SignableTx> {
  return async (item: SweepItem): Promise<SignableTx> => {
    const feeLimitSun = extractValidatedFeeLimitSun(item);

    // Local trust anchors only: deposit address (whose key we derive), the
    // pinned destination, the item amount, the locally-pinned USDT contract.
    const expected = buildTransfer({
      fromAddress: item.address,
      toAddress: localPin,
      amountMicro: item.amountMicro,
      feeLimitSun,
    });

    const nodeTx = await trigger({
      owner_address: expected.fromAddressHex,
      contract_address: expected.contractAddressHex,
      function_selector: "transfer(address,uint256)",
      // callData = [4-byte selector][ABI-encoded args]; the node expects the
      // args only and re-derives the selector from function_selector.
      parameter: expected.callData.slice(SELECTOR_HEX_LEN),
      fee_limit: Number(feeLimitSun),
      call_value: 0,
      visible: false,
    });

    // SECURITY: never trust the node blindly — see verifyNodeTransaction.
    verifyNodeTransaction(nodeTx, expected);

    const signableTx = nodeTx as unknown as SignableTx;
    // SIGN-3 defense-in-depth: a verified node tx always has a contract entry,
    // so this guard passes; it stays as the explicit live-path mock barrier.
    assertNotMockTxIdOnLivePath(signableTx);
    return signableTx;
  };
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerSweepCommands(parent: Command, getApi: () => ApiClient): void {
  const sweep = parent.command("sweep").description("Manage USDT sweeps");

  // sweep prepare
  sweep
    .command("prepare")
    .description(
      "Prepare a sweep intent: build unsigned txs for paid deposit addresses",
    )
    .requiredOption("--event <id>", "Event id")
    .option(
      "--addresses <list>",
      "Comma-separated list of deposit addresses to sweep (default: all paid)",
    )
    .action(async (opts: { event: string; addresses?: string }) => {
      const addresses = opts.addresses
        ? opts.addresses.split(",").map((a) => a.trim())
        : undefined;
      const result = await getApi().prepareSweep({ eventId: opts.event, addresses });
      console.log(JSON.stringify(result, null, 2));
    });

  // sweep execute
  // SECURITY: The passphrase is read via TTY readline — it is NEVER a flag,
  // argument, env var, or MCP tool parameter. promptPassphrase() enforces
  // process.stdin.isTTY === true and throws on piped/non-interactive stdin.
  //
  // BROADCAST GATE: Only posts broadcast-result with REAL hashes from an actual
  // node response. When neither TRON_RPC_PRIMARY_URL nor legacy TRON_RPC_PRIMARY
  // is set the command runs as DRY-RUN: signs locally and prints
  // "signed, NOT broadcast (no live RPC configured)".
  // No fabricated success hash is EVER sent to the server.
  sweep
    .command("execute")
    .description(
      [
        "Sign and broadcast a prepared sweep intent (LOCAL — requires passphrase).",
        "",
        "Fetches the intent from the server, then prompts for the seed passphrase",
        "on the terminal (hidden input). The passphrase is NEVER a flag or env var.",
        "Private keys are derived in memory and immediately discarded.",
        "",
        "BROADCAST: requires TRON_RPC_PRIMARY_URL (+ optional TRON_RPC_PRIMARY_API_KEY;",
        "legacy TRON_RPC_PRIMARY also accepted). Without it the command runs as a",
        "DRY-RUN — signs locally but does NOT broadcast or record hashes.",
      ].join("\n"),
    )
    .requiredOption("--intent <id>", "SweepIntent id (from `sweep prepare`)")
    .action(async (opts: { intent: string }) => {
      // Live gate: canonical TRON_RPC_PRIMARY_URL (+API key), legacy
      // TRON_RPC_PRIMARY fallback. null = dry-run (sign only, no broadcast).
      const rpcConfig = resolveLiveRpcConfig();
      const dryRun = rpcConfig === null;

      // Fetch the intent from the server.
      // SIGN-2: toSignerIntentWithPin asserts every item's toAddressBase58 ===
      // STABLERAILS_MAIN_WALLET (local pin). Throws before building any SignableTx
      // if the pin is unset or if ANY item's destination mismatches.
      const rawIntent = await getApi().getSweep(opts.intent);
      const intent = toSignerIntentWithPin(rawIntent as Record<string, unknown>);

      if (intent.items.length === 0) {
        console.error("No items in sweep intent — nothing to execute.");
        process.exit(1);
      }

      // ── SIGN-2: destination display + operator confirmation ────────────────
      // Show the verified destination address BEFORE prompting for passphrase.
      // The operator must see WHERE funds will go and confirm explicitly.
      const pinnedDestination = getMainWalletPin(); // already validated above
      let totalMicro = 0n;
      for (const item of intent.items) {
        totalMicro += item.amountMicro;
      }
      const totalUsdt = (Number(totalMicro) / 1_000_000).toFixed(6);

      console.log("\n========== SWEEP CONFIRMATION REQUIRED ==========");
      console.log(`  Destination (STABLERAILS_MAIN_WALLET): ${pinnedDestination}`);
      console.log(`  Items: ${intent.items.length} address(es) for event ${intent.eventId}`);
      for (const item of intent.items) {
        const usdt = (Number(item.amountMicro) / 1_000_000).toFixed(6);
        console.log(`    ${item.address}  ${usdt} USDT`);
      }
      console.log(`  Total: ${totalUsdt} USDT → ${pinnedDestination}`);
      console.log("=================================================\n");

      if (dryRun) {
        console.log(
          "DRY-RUN: no TRON_RPC_PRIMARY_URL configured — transactions will be signed locally",
        );
        console.log(
          "         but NOT broadcast. Set TRON_RPC_PRIMARY_URL to enable live broadcast (go-live step).",
        );
        console.log("");
      }

      // SIGN-2: require explicit y/N confirmation of the destination before passphrase.
      // promptPassphrase enforces isTTY — this readline also requires a real terminal.
      const confirmation = await promptPassphrase(
        `Confirm destination ${pinnedDestination} and proceed? [y/N]: `,
      );
      if (confirmation.trim().toLowerCase() !== "y") {
        console.error("Sweep aborted by operator (destination not confirmed).");
        process.exit(1);
      }

      // ── HUMAN PASSPHRASE GATE ──────────────────────────────────────────────
      // promptSeedPassphrase() (keychain-aware) enforces the same TTY gate as
      // promptPassphrase(): process.stdin.isTTY === true.
      // It THROWS if stdin is not a real terminal — piped input is REJECTED.
      // This check runs BEFORE loading the seed so non-TTY invocations are
      // blocked immediately (no side-effects from partial initialization).
      // See: src/cli/prompt.ts
      const passphrase = await promptSeedPassphrase(
        "Enter seed passphrase to sign and broadcast: ",
      );
      // Seed is loaded after the TTY gate passes — any errors here are
      // operator-config issues, not security bypasses.
      const encryptedSeed = encryptedSeedFromEnv();
      // ── END GATE ───────────────────────────────────────────────────────────

      // ── LIVE PATH: pre-build + verify ALL node txs BEFORE any signing ──────
      // SIGN-3 go-live: real transactions come from the node's
      // triggerSmartContract, verified field-by-field against LOCALLY-derived
      // bytes (verifyNodeTransaction). Building everything up-front means a
      // single tampered node response aborts the WHOLE sweep — nothing signed.
      // (Done after the passphrase prompt so node txs don't expire — Tron txs
      // have a ~60s expiration window — while the operator types.)
      // The RPC modules are imported lazily so dry-run / tests stay offline.
      const prebuiltNodeTxs = new Map<SweepItem, SignableTx>();
      if (!dryRun) {
        const { TronHttpClient } = await import("../../lib/http.js");
        const { triggerSmartContract } = await import("../../chain/tron/broadcast.js");
        const client = new TronHttpClient(rpcConfig!);
        const liveBuild = makeLiveBuildSignableTx(
          (req) => triggerSmartContract(client, req),
          pinnedDestination,
        );
        for (const item of intent.items) {
          prebuiltNodeTxs.set(item, await liveBuild(item));
        }
      }

      const broadcastItems: Array<{ address: string; txHash: string }> = [];

      const result = await executeSweep(intent, {
        encryptedSeed,
        passphrase,
        async broadcast(signedTx) {
          if (dryRun) {
            // DRY-RUN: local sign only — do NOT return a fabricated success hash.
            // Callers check success:false and skip recording broadcast results.
            console.log(
              `  [dry-run] signed txID=${signedTx.txID} — NOT broadcast (no live RPC configured — go-live step)`,
            );
            return { txId: signedTx.txID, success: false, error: "dry-run" };
          }
          // LIVE PATH: call real broadcastTransaction with TronHttpClient,
          // configured from the canonical TRON_RPC_*_URL/_API_KEY env vars
          // (legacy TRON_RPC_PRIMARY fallback) — see resolveLiveRpcConfig().
          const { TronHttpClient } = await import("../../lib/http.js");
          const { broadcastTransaction } = await import("../../chain/tron/broadcast.js");
          const client = new TronHttpClient(rpcConfig!);
          // signedTx already has the signature[] field from signTransfer().
          return broadcastTransaction(client, signedTx as import("../../chain/tron/broadcast.js").SignedTronTransaction);
        },
        async buildSignableTx(item) {
          if (dryRun) {
            // DRY-RUN: use the mock txID already embedded (no node available).
            // assertNotMockTxIdOnLivePath is a no-op here by definition.
            assertNotMockTxIdOnLivePath(item.signableTx);
            return item.signableTx;
          }
          // LIVE PATH: return the node tx pre-built + verified above.
          const nodeTx = prebuiltNodeTxs.get(item);
          if (!nodeTx) {
            // Unreachable: every intent item was pre-built before executeSweep.
            throw new Error(`internal: no pre-built node tx for item ${item.address}`);
          }
          return nodeTx;
        },
      });

      if (dryRun) {
        console.log(`\nDry-run complete: ${result.results.length} transaction(s) signed locally.`);
        console.log("No broadcast-result recorded. Re-run with TRON_RPC_PRIMARY_URL set to go live.");
        return;
      }

      console.log(`\nSweep complete: ${result.succeeded} succeeded, ${result.failed} failed`);

      for (const r of result.results) {
        if (r.success && r.txHash) {
          broadcastItems.push({ address: r.address, txHash: r.txHash });
          console.log(`  ✓ ${r.address}  txHash=${r.txHash}`);
        } else {
          console.error(`  ✗ ${r.address}  error=${r.error ?? "unknown"}`);
        }
      }

      // Record REAL broadcast results on the server (only live txHashes from node).
      if (broadcastItems.length > 0) {
        await getApi().broadcastSweepResult(intent.id, broadcastItems);
        console.log("\nBroadcast results recorded on server.");
      }

      if (result.failed > 0) {
        process.exit(1);
      }
    });

  // sweep status
  sweep
    .command("status <id>")
    .description("Show the status of a sweep intent")
    .action(async (id: string) => {
      const result = await getApi().getSweep(id);
      console.log(JSON.stringify(result, null, 2));
    });
}
