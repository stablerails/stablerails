/**
 * Tron USDT watcher worker.
 *
 * Poll loop for active deposit addresses:
 *   1. Fetch solid blocks from BOTH providers independently — NO silent failover.
 *      Provider error = "no agreement / skip this tick", not a fallback.
 *   2. Reject zero-value/dust + non-pinned-contract (enforced in normalizeTransfer).
 *   3. Match to invoice by normalized deposit address.
 *   4. For each agreed transfer, call gettransactioninfobyid to get the REAL
 *      block number (M-1 fix: never derive block number from timestamp).
 *   5. Atomic credit: upsert Payment + promote detected→confirmed + transition invoice
 *      + enqueue WebhookDelivery all happen in ONE Prisma $transaction with a
 *      SELECT...FOR UPDATE row lock on the invoice row.
 *      In-memory path: same logical unit modeled as a single callback (no shared
 *      mutable state escapes the callback before it completes).
 *   6. Replay (created=false): if the existing payment is still "detected" and now
 *      solid, re-run transition to let it reach confirmed/paid.
 *   7. Crash-safe replay: on replay of a terminal invoice that has NO enqueued
 *      webhook for its current status, re-enqueue (idempotent on eventUid).
 *   8. Pre-solid reorg detection: if blockHash for a "detected" payment changes →
 *      orphaned + aggregate recomputed + transition re-run.
 *      "paid" status NEVER reverts.
 *   8a. Orphan revival: if the SAME (network, txHash, logIndex) is re-observed by
 *      BOTH providers with a confirmed block placement (real block number from
 *      both, non-empty blockHash), an "orphaned" payment is revived to
 *      "detected" with the fresh block coordinates (handled inside
 *      paymentRepo.upsert). Crediting then goes through the NORMAL
 *      detected→confirmed solid gate on this or a later tick — a revived
 *      payment never jumps straight to confirmed/paid.
 *   9. Late funds → overdue handled by transitionInvoice.
 *  10. ChainCursor.lastScannedBlock = real block height (not Date.now()).
 *      Scan timestamp cursor stored separately to avoid confusing block height
 *      with milliseconds (N-1 fix).
 *
 * CHARTER RULES enforced here:
 *   - `paid` ONLY at solid block height (blockNumber <= latestSolidBlock).
 *   - `paid` never reverts (only pre-solid detected payments can orphan).
 *   - 0-conf detection triggers `payment_detected` only (nothing irreversible).
 *   - Crediting idempotent on (network, txHash, logIndex).
 *   - Pinned USDT contract only; dust/zero-value rejected.
 *   - Two-RPC agreement required with INDEPENDENT pinned endpoints (no failover);
 *     on disagreement → no credit + alert/log.
 *   - eventUid = `{eventType}:{invoiceId}:{version}` — NOT timestamp-based.
 *   - Injected clock used everywhere; no raw Date.now().
 *   - Block number obtained via /wallet/gettransactioninfobyid — NEVER from
 *     block_timestamp division (timestamp/3000 ≈ 593_000_000 >> solid ≈ 83_000_000).
 */

import { rootLogger } from "../lib/logger.js";
import { isPausedAsync } from "../server/killswitch.js";
import { normalizeToBase58 } from "../chain/tron/addressCodec.js";
import { TRON_USDT_CONTRACT_BASE58, DUST_THRESHOLD_MICRO } from "../chain/tron/usdt.js";
import { fetchTransfersForAddress } from "../chain/tron/transferScan.js";
import {
  fetchTransactionReceipt,
  parseUsdtReceiptTransfers,
} from "../chain/tron/receiptScan.js";
import { fetchLatestSolidBlock } from "../chain/tron/solidBlock.js";
import { TronHttpClient } from "../lib/http.js";
import { formatMicro, parseMicro } from "../lib/decimal.js";
import { classifyPayment } from "../core/payments.js";
import { transitionInvoice } from "../core/lifecycle.js";
import { computeToleranceBand } from "../core/pricing.js";
import { UNCONFIRMED_BLOCK_SENTINEL } from "../core/ports.js";
import type {
  InvoiceRepository,
  PaymentRepository,
  Network,
  InvoiceRow,
  PaymentRow,
  ActiveInvoiceProjection,
} from "../core/ports.js";
import type { ChainCursorRepository } from "./db/ChainCursorRepository.js";
import type {
  WebhookDeliveryRepository,
  WebhookEndpointRepository,
} from "./db/WebhookDeliveryRepository.js";

const log = rootLogger.child("watcher");

// ── Watcher config ────────────────────────────────────────────────────────────

export interface WatcherConfig {
  network: Network;
  /** Poll interval in milliseconds. Default: 5000ms */
  pollIntervalMs?: number;
  /** Dust threshold in micro-USDT (exclusive). Default: 0n */
  dustThresholdMicro?: bigint;
}

// ── TransactionRunner port ────────────────────────────────────────────────────

/**
 * Unit-of-work port: wraps the entire credit sequence in one atomic boundary.
 *
 * Prisma implementation: opens a Prisma interactive transaction, runs
 * `SELECT ... FOR UPDATE` on the Invoice row to acquire a row-level lock,
 * then calls `fn(tx)` with the transaction client so every repo operation
 * inside the credit path shares the same Postgres transaction.
 *
 * In-memory implementation: simply calls `fn(undefined)` — no shared mutable
 * state escapes the callback before it completes (sequential in tests).
 */
export interface TransactionRunner {
  runInCredit<T>(invoiceId: string, fn: (tx: unknown) => Promise<T>): Promise<T>;
}

// ── Watcher ports ─────────────────────────────────────────────────────────────

export interface WatcherPorts {
  invoiceRepo: InvoiceRepository;
  paymentRepo: PaymentRepository;
  chainCursorRepo: ChainCursorRepository;
  webhookRepo: WebhookDeliveryRepository;
  /**
   * Endpoint repository for fan-out: resolves real WebhookEndpoint rows before
   * enqueueing deliveries. MUST NOT be given a fabricated id — if no endpoints
   * are registered, enqueue nothing.
   */
  endpointRepo: WebhookEndpointRepository;
  /**
   * Unit-of-work runner for the credit path.
   * Prisma impl: $transaction + SELECT FOR UPDATE on invoice row.
   * In-memory impl: sequential callback (no real DB; models the same invariant).
   */
  txRunner: TransactionRunner;
  /**
   * Primary TronHttpClient.
   * MUST be pinned to a specific endpoint — no internal failover for the
   * two-RPC agreement path.
   */
  primaryClient: TronHttpClient;
  /**
   * Secondary TronHttpClient.
   * MUST be pinned to a DIFFERENT endpoint than primaryClient.
   * No internal failover — an error from either provider = "no agreement / skip".
   */
  secondaryClient: TronHttpClient;
  /** Injected clock for testability. Default: () => new Date() */
  clock?: { now: () => Date };
}

// ── Active invoice shape for watcher ─────────────────────────────────────────

/** Re-exported from ports so callers don't need two imports. */
export type ActiveInvoice = ActiveInvoiceProjection;

// ── Watcher class ─────────────────────────────────────────────────────────────

export class TronWatcher {
  private readonly config: Required<WatcherConfig>;
  private readonly ports: WatcherPorts;
  private running = false;

  constructor(config: WatcherConfig, ports: WatcherPorts) {
    this.config = {
      network: config.network,
      pollIntervalMs: config.pollIntervalMs ?? 5_000,
      dustThresholdMicro: config.dustThresholdMicro ?? DUST_THRESHOLD_MICRO,
    };
    this.ports = ports;
  }

  // ── Main entry point ────────────────────────────────────────────────────────

  /**
   * Start the poll loop.
   * Runs until `stop()` is called.
   */
  async start(): Promise<void> {
    this.running = true;
    log.info("watcher started", { network: this.config.network });

    while (this.running) {
      try {
        await this.pollOnce();
      } catch (err) {
        log.error("poll iteration failed", {
          network: this.config.network,
          error: String(err),
        });
      }

      if (this.running) {
        await sleep(this.config.pollIntervalMs);
      }
    }

    log.info("watcher stopped", { network: this.config.network });
  }

  stop(): void {
    this.running = false;
  }

  // ── Single poll cycle ───────────────────────────────────────────────────────

  /**
   * One full poll cycle:
   *   1. Fetch solid blocks from BOTH providers independently (no failover).
   *      Both must succeed — an error from either = skip this tick.
   *   2. Load chain cursor for the scan timestamp (N-1 fix: stored separately
   *      from the block height to avoid confusing ms with block numbers).
   *   3. Load all active invoices from the DB.
   *   4. For each invoice, fetch+agree+process transfers.
   *   5. Update chain cursor with the real solid block height.
   */
  async pollOnce(): Promise<void> {
    // Kill-switch: skip entire poll when watcher is paused.
    // isPausedAsync consults the DB-backed shared store (TTL cached) so the
    // watcher process responds to admin toggle without a restart.
    if (await isPausedAsync("watcher")) {
      log.debug("watcher paused — skipping poll tick");
      return;
    }

    const now = this.ports.clock
      ? this.ports.clock.now()
      : new Date();

    // Step 1: Fetch solid blocks from BOTH providers INDEPENDENTLY.
    // Both must succeed for us to proceed. A single-provider failure = skip tick
    // (cannot establish agreement without both nodes confirming the same height).
    let primarySolid: bigint;
    let secondarySolid: bigint;
    try {
      primarySolid = await fetchLatestSolidBlock(this.ports.primaryClient);
    } catch (err) {
      log.warn("primary provider failed to return solid block — skipping tick", {
        error: String(err),
      });
      return;
    }
    try {
      secondarySolid = await fetchLatestSolidBlock(this.ports.secondaryClient);
    } catch (err) {
      log.warn("secondary provider failed to return solid block — skipping tick", {
        error: String(err),
      });
      return;
    }

    // Use the MINIMUM of the two solid blocks as the finality fence.
    // This is the most conservative interpretation: both nodes agree this block
    // is irreversible, so credits at or below this height are safe.
    const latestSolidBlock = primarySolid < secondarySolid ? primarySolid : secondarySolid;

    log.debug("solid blocks fetched", {
      primarySolid: primarySolid.toString(),
      secondarySolid: secondarySolid.toString(),
      latestSolidBlock: latestSolidBlock.toString(),
    });

    // Step 2: Load chain cursor.
    // N-1 fix: minTimestampMs is a real wall-clock cursor for the TronGrid
    // min_timestamp parameter (milliseconds), tracked separately from the
    // block height. The lastSolidBlock stored in the cursor is the real block
    // height; converting it to ms (height * 3000) would confuse number spaces
    // and yield absurd timestamp values (e.g. 83_000_000 * 3000 = year ~10000).
    //
    // We store the scan timestamp as the block's approximate wall time by using
    // the known Tron genesis offset and block time, OR simply track it as the
    // wall-clock time at poll time minus a safety margin. Since TronGrid's
    // min_timestamp is a convenience filter (not a correctness gate), we use
    // last solid block converted to an approximate epoch ms with Tron's genesis:
    //   genesis block 0 ≈ 2017-08-04T00:00:00Z = 1501804800000 ms
    //   block height h → approx ms = 1_501_804_800_000 + h * 3_000
    // With a 120s safety margin.
    const TRON_GENESIS_MS = 1_501_804_800_000;
    const TRON_BLOCK_MS = 3_000;
    const cursor = await this.ports.chainCursorRepo.findByNetwork(this.config.network);
    const minTimestampMs = cursor
      ? Math.max(
          0,
          TRON_GENESIS_MS +
            Number(cursor.lastSolidBlock) * TRON_BLOCK_MS -
            120_000,
        )
      : 0;

    // Step 3: Load active invoices from DB.
    const activeInvoices = await this.ports.invoiceRepo.listActiveForWatch(this.config.network);

    log.debug("active invoices loaded", {
      count: activeInvoices.length,
      network: this.config.network,
    });

    // Step 4: Process each invoice.
    await this.processInvoices(activeInvoices, latestSolidBlock, minTimestampMs, now);

    // Step 5: Update chain cursor — store REAL block height, not Date.now().
    await this.ports.chainCursorRepo.upsert(
      this.config.network,
      latestSolidBlock, // lastScannedBlock = real block height
      latestSolidBlock,
    );
  }

  /**
   * Process a batch of active invoices — the core of the watcher.
   * Called per-poll with the current list of active deposit addresses.
   *
   * @param invoices          Active invoices to scan.
   * @param latestSolidBlock  Current solid block height from both providers.
   * @param minTimestampMs    Minimum timestamp cursor.
   * @param now               Current time.
   */
  async processInvoices(
    invoices: ActiveInvoice[],
    latestSolidBlock: bigint,
    minTimestampMs: number,
    now: Date,
  ): Promise<void> {
    for (const invoice of invoices) {
      try {
        const invoiceMinTimestampMs = this.needsUnresolvedFundsReplay(invoice)
          ? 0
          : minTimestampMs;
        await this.processInvoice(invoice, latestSolidBlock, invoiceMinTimestampMs, now);
      } catch (err) {
        log.error("failed to process invoice", {
          invoiceId: invoice.id,
          error: String(err),
        });
      }
    }
  }

  private needsUnresolvedFundsReplay(invoice: ActiveInvoice): boolean {
    // Full replay (minTimestampMs=0) is what lets the reorg sentinel sweep in
    // processInvoice see EVERY still-on-chain tx and thus identify reorged-out
    // `detected` payments. It must cover the SAME set listActiveForWatch returns:
    // non-terminal statuses AND terminal statuses inside the late-funds grace window.
    // Without the grace statuses a phantom `detected` payment on a terminal invoice
    // is never swept, and a later late-funds credit could promote it on stale height
    // (money-accounting corruption). markUnconfirmed only touches `detected` rows, so
    // re-replaying terminal invoices never alters confirmed/paid accounting.
    // (Perf follow-up: re-fetches receipts for grace-window invoices each tick;
    //  bounded by LATE_FUNDS_GRACE_DAYS + per-invoice addresses. Could later be
    //  narrowed to terminal invoices that actually hold a `detected` payment.)
    return [
      "pending",
      "payment_detected",
      "overdue",
      "paid",
      "overpaid",
      "underpaid",
      "expired",
      "canceled",
    ].includes(invoice.status);
  }

  /**
   * Process one active invoice using dual-receipt agreement.
   *
   * Security model:
   *   - /v1 (TronGrid) = UNTRUSTED DISCOVERY by PRIMARY only. Used to bound which
   *     txHashes may have touched a deposit address. Never used for the credit decision.
   *   - Credit decision = EXCLUSIVELY from BOTH providers independently parsing the
   *     on-chain tx receipt event logs via /wallet/gettransactioninfobyid.
   *   - If either provider's receipt is null (tx not in a block), empty, or has no
   *     matching Transfer log → SKIP this candidate this tick. Recovers on next tick.
   *   - NO failover between providers. Error from either = skip that candidate.
   *
   * Agreement per (txHash, logIndex) key:
   *   Both providers must parse the SAME (contractBase58, fromBase58, toBase58, amountMicro).
   *   Any mismatch → warn + no credit.
   *
   * WATCH-1: effectiveBN = max(primaryBN, secondaryBN).
   *   - Missing blockNumber on either → receipt is null → candidate skipped this tick.
   *   - Only when BOTH are at/below solid does effectiveBN <= latestSolidBlock → confirmed.
   *
   * Reorg sentinel sweep (full-replay ticks, minTimestampMs === 0): any "detected"
   * payment NOT re-agreed by dual receipts this tick gets its stored blockNumber
   * reset to UNCONFIRMED_BLOCK_SENTINEL, so a reorged-out tx can never be credited
   * by the height-only promotion gate. Runs BEFORE crediting (see Step 4).
   *
   * Testnet and mainnet use IDENTICAL logic — no network-specific relaxation.
   */
  async processInvoice(
    activeInvoice: ActiveInvoice,
    latestSolidBlock: bigint,
    minTimestampMs: number,
    now: Date,
  ): Promise<void> {
    const depositAddress = normalizeToBase58(activeInvoice.depositAddress);

    // ── Step 1: PRIMARY /v1 discovery only ───────────────────────────────────
    // Fetches candidate txHashes. This is UNTRUSTED — the receipt parser is
    // the authoritative source for all credit decisions.
    let primaryRaw;
    try {
      primaryRaw = await fetchTransfersForAddress(
        this.ports.primaryClient,
        depositAddress,
        minTimestampMs,
      );
    } catch (err) {
      log.warn("primary RPC error fetching transfers — skipping invoice this tick", {
        invoiceId: activeInvoice.id,
        error: String(err),
      });
      return;
    }

    // Pre-filter: build candidate txHash set from /v1 data.
    // Only include transfers targeting the deposit address with the pinned USDT contract.
    // Also build txHash → blockHash map from /v1 for use in the credit object.
    const candidateTxHashes = new Set<string>();
    const txHashToBlockHash = new Map<string, string>();
    for (const raw of primaryRaw) {
      // Capture block_hash from /v1 discovery for the credit object.
      if (!txHashToBlockHash.has(raw.transaction_id)) {
        txHashToBlockHash.set(raw.transaction_id, raw.block_hash ?? "");
      }
      // Pre-filter: must be USDT contract
      const contractAddr = raw.token_info?.address;
      if (!contractAddr) continue;
      let normalizedContract: string;
      try {
        normalizedContract = normalizeToBase58(contractAddr);
      } catch {
        continue;
      }
      if (normalizedContract !== TRON_USDT_CONTRACT_BASE58) continue;
      // Pre-filter: must target the deposit address
      let toBase58: string;
      try {
        toBase58 = normalizeToBase58(raw.to);
      } catch {
        continue;
      }
      if (toBase58 !== depositAddress) continue;
      candidateTxHashes.add(raw.transaction_id);
    }

    // ── Step 2: For each candidate, fetch receipts from BOTH providers ────────
    // Either provider erroring or returning null → skip this candidate this tick.
    // The secondary is ONLY called for /wallet/gettransactioninfobyid (and
    // /walletsolidity/getnowblock) — NEVER for /v1 paths.

    // Maps: "txHash:logIndex" → { parsedTransfer, blockNumber }
    interface ReceiptEntry {
      txHash: string;
      receiptLogIndex: number;
      contractBase58: string;
      fromBase58: string;
      toBase58: string;
      amountMicro: bigint;
      blockNumber: bigint;
    }
    const primaryReceiptMap = new Map<string, ReceiptEntry>();
    const secondaryReceiptMap = new Map<string, ReceiptEntry>();

    for (const txHash of candidateTxHashes) {
      // Fetch receipt from primary
      let primaryReceipt;
      try {
        primaryReceipt = await fetchTransactionReceipt(this.ports.primaryClient, txHash);
      } catch (err) {
        log.warn("primary receipt fetch failed — skipping candidate this tick", {
          txHash,
          invoiceId: activeInvoice.id,
          error: String(err),
        });
        continue;
      }
      if (!primaryReceipt) {
        log.debug("primary receipt not yet in block — skipping candidate", {
          txHash,
          invoiceId: activeInvoice.id,
        });
        continue;
      }

      // Fetch receipt from secondary
      let secondaryReceipt;
      try {
        secondaryReceipt = await fetchTransactionReceipt(this.ports.secondaryClient, txHash);
      } catch (err) {
        log.warn("secondary receipt fetch failed — skipping candidate this tick", {
          txHash,
          invoiceId: activeInvoice.id,
          error: String(err),
        });
        continue;
      }
      if (!secondaryReceipt) {
        log.debug("secondary receipt not yet in block — skipping candidate", {
          txHash,
          invoiceId: activeInvoice.id,
        });
        continue;
      }

      // Parse Transfer events from both receipts
      const primaryTransfers = parseUsdtReceiptTransfers(
        primaryReceipt,
        depositAddress,
        this.config.dustThresholdMicro,
      );
      const secondaryTransfers = parseUsdtReceiptTransfers(
        secondaryReceipt,
        depositAddress,
        this.config.dustThresholdMicro,
      );

      // Primary receipt blockNumber (valid per fetchTransactionReceipt contract)
      const primaryBN = BigInt(primaryReceipt.blockNumber!);
      const secondaryBN = BigInt(secondaryReceipt.blockNumber!);

      // Build per-provider maps keyed by txHash:logIndex
      for (const t of primaryTransfers) {
        primaryReceiptMap.set(`${txHash}:${t.receiptLogIndex}`, {
          txHash,
          receiptLogIndex: t.receiptLogIndex,
          contractBase58: t.contractBase58,
          fromBase58: t.fromBase58,
          toBase58: t.toBase58,
          amountMicro: t.amountMicro,
          blockNumber: primaryBN,
        });
      }
      for (const t of secondaryTransfers) {
        secondaryReceiptMap.set(`${txHash}:${t.receiptLogIndex}`, {
          txHash,
          receiptLogIndex: t.receiptLogIndex,
          contractBase58: t.contractBase58,
          fromBase58: t.fromBase58,
          toBase58: t.toBase58,
          amountMicro: t.amountMicro,
          blockNumber: secondaryBN,
        });
      }
    }

    // ── Step 3: Agreement — collect transfers confirmed by BOTH providers ─────
    // For each key in primaryReceiptMap: must be present in secondaryReceiptMap
    // with identical (contractBase58, fromBase58, toBase58, amountMicro).
    // Agreed transfers are COLLECTED here and credited in Step 5 — the reorg
    // sentinel sweep (Step 4) must run before any crediting (see below).
    interface AgreedTransfer {
      txHash: string;
      logIndex: number;
      blockNumber: bigint;
      blockHash: string;
      fromAddress: string;
      toAddress: string;
      amountUsdt: string;
      amountMicro: bigint;
      isConfirmed: boolean;
      blockTimestampMs: number;
    }
    const agreedKeys = new Set<string>();
    const agreedTransfers: AgreedTransfer[] = [];

    for (const [key, primaryEntry] of primaryReceiptMap.entries()) {
      const secondaryEntry = secondaryReceiptMap.get(key);
      if (!secondaryEntry) {
        log.warn("transfer only seen in primary receipt — no credit", {
          txHash: primaryEntry.txHash,
          logIndex: primaryEntry.receiptLogIndex,
          invoiceId: activeInvoice.id,
        });
        continue;
      }

      // Field agreement check
      if (
        primaryEntry.contractBase58 !== secondaryEntry.contractBase58 ||
        primaryEntry.toBase58 !== secondaryEntry.toBase58 ||
        primaryEntry.amountMicro !== secondaryEntry.amountMicro ||
        primaryEntry.fromBase58 !== secondaryEntry.fromBase58
      ) {
        log.warn("receipt disagreement on transfer fields — no credit", {
          txHash: primaryEntry.txHash,
          logIndex: primaryEntry.receiptLogIndex,
          primaryAmount: primaryEntry.amountMicro.toString(),
          secondaryAmount: secondaryEntry.amountMicro.toString(),
          invoiceId: activeInvoice.id,
        });
        continue;
      }

      // WATCH-1: effectiveBN = max(primaryBN, secondaryBN).
      // Receipt blockNumbers are already validated (> 0) by fetchTransactionReceipt,
      // so they are real values. The max ensures BOTH must be at/below solid for
      // the credit gate to fire.
      const effectiveBN =
        primaryEntry.blockNumber > secondaryEntry.blockNumber
          ? primaryEntry.blockNumber
          : secondaryEntry.blockNumber;

      // blockHash comes from /v1 discovery (not in receipt).
      const blockHash = txHashToBlockHash.get(primaryEntry.txHash) ?? "";

      agreedKeys.add(key);
      agreedTransfers.push({
        txHash: primaryEntry.txHash,
        logIndex: primaryEntry.receiptLogIndex,
        blockNumber: effectiveBN,
        blockHash,
        fromAddress: primaryEntry.fromBase58,
        toAddress: primaryEntry.toBase58,
        amountUsdt: formatMicro(primaryEntry.amountMicro),
        amountMicro: primaryEntry.amountMicro,
        isConfirmed: false, // not used in creditTransfer; status derived from blockNumber
        blockTimestampMs: 0, // not used in creditTransfer
      });
    }

    // Log secondary-only receipt entries (not seen by primary)
    for (const [key, secondaryEntry] of secondaryReceiptMap.entries()) {
      if (!primaryReceiptMap.has(key)) {
        log.warn("transfer only seen in secondary receipt — no credit", {
          txHash: secondaryEntry.txHash,
          logIndex: secondaryEntry.receiptLogIndex,
          invoiceId: activeInvoice.id,
        });
      }
    }

    // ── Step 4: Reorg sentinel sweep (full-replay ticks only) ─────────────────
    // FALSE-CREDIT PROTECTION: a "detected" pre-solid payment whose tx is
    // reorged OUT keeps its stale stored blockNumber; once solid passes that
    // height, the promotion loop in transitionAndEnqueue
    // (status === "detected" && blockNumber <= latestSolidBlock) would credit
    // funds that are no longer on-chain.
    //
    // A full-replay tick (minTimestampMs === 0 — exactly the
    // needsUnresolvedFundsReplay case, plus the cursor-less first tick)
    // re-discovers every still-on-chain tx for this address, so a "detected"
    // payment whose (txHash, logIndex) is NOT in this tick's agreed set is
    // genuinely gone (reorged out, or at least not currently provable by both
    // providers — e.g. a transient receipt error; fail closed either way).
    // Reset its stored blockNumber to UNCONFIRMED_BLOCK_SENTINEL so the height
    // gate can never fire on it. If the tx is later re-mined, the agreement
    // path re-credits it with a real blockNumber via upsert's
    // "refresh blockNumber while detected" rule.
    //
    // This makes dual-receipt re-confirmation — not the /v1-supplied
    // blockHash — the PRIMARY reorg protection.
    //
    // MUST run BEFORE Step 5: crediting any agreed transfer triggers
    // transitionAndEnqueue, whose promotion loop scans ALL payments of the
    // invoice — a stale phantom must be sentineled before that loop can see it.
    if (minTimestampMs === 0) {
      await this.ports.txRunner.runInCredit(activeInvoice.id, async (tx) => {
        const result = await this.ports.invoiceRepo.findWithPayments(activeInvoice.id, tx);
        if (!result) return;
        for (const p of result.payments) {
          if (p.status !== "detected") continue;
          if (p.blockNumber === UNCONFIRMED_BLOCK_SENTINEL) continue; // already sentineled
          if (agreedKeys.has(`${p.txHash}:${p.logIndex}`)) continue;
          log.warn(
            "detected payment absent from full-replay agreed set — resetting blockNumber to sentinel (reorged out?)",
            {
              paymentId: p.id,
              txHash: p.txHash,
              logIndex: p.logIndex,
              staleBlockNumber: p.blockNumber.toString(),
              invoiceId: activeInvoice.id,
            },
          );
          await this.ports.paymentRepo.markUnconfirmed(p.id, tx);
        }
      });
    }

    // ── Step 5: Credit agreed transfers ────────────────────────────────────────
    for (const transferToCredit of agreedTransfers) {
      await this.creditTransfer(
        activeInvoice,
        transferToCredit,
        latestSolidBlock,
        now,
      );
    }
  }

  /**
   * Credit one agreed transfer — ATOMIC UNIT (M-3a fix):
   *
   * The entire sequence runs inside ONE real Prisma `$transaction` via
   * `this.ports.txRunner.runInCredit(invoiceId, async (tx) => { ... })`.
   * The Prisma TransactionRunner acquires a `SELECT ... FOR UPDATE` row lock
   * on the Invoice row before calling fn(tx), so no concurrent tick can
   * interleave mutations on the same invoice row.
   *
   * Steps inside the transaction (tx threaded through every repo call):
   *   1. Row lock (done by TransactionRunner before fn is invoked).
   *   2. Classify payment status.
   *   3. Upsert Payment (idempotent on txHash+logIndex).
   *   3a. First insert → transitionAndEnqueue.
   *   3b. Replay: payment still detected but block now solid → re-transition.
   *   3c. Crash-safe: terminal invoice, webhook missing → re-enqueue.
   *   4. Reorg: blockHash changed on pre-solid payment → orphan + re-transition.
   *
   * In-memory path: TransactionRunner calls fn(undefined) sequentially.
   */
  private async creditTransfer(
    activeInvoice: ActiveInvoice,
    transfer: {
      txHash: string;
      logIndex: number;
      blockNumber: bigint;
      blockHash: string;
      fromAddress: string;
      toAddress: string;
      amountUsdt: string;
      amountMicro: bigint;
      isConfirmed: boolean;
      blockTimestampMs: number;
    },
    latestSolidBlock: bigint,
    now: Date,
  ): Promise<void> {
    await this.ports.txRunner.runInCredit(activeInvoice.id, async (tx) => {
      // Classify: initial status
      const initialStatus =
        transfer.blockNumber <= latestSolidBlock ? "confirmed" : "detected";

      // Idempotent upsert Payment — pass tx so it runs inside the transaction
      const { row: paymentRow, created } = await this.ports.paymentRepo.upsert(
        {
          invoiceId: activeInvoice.id,
          txHash: transfer.txHash,
          logIndex: transfer.logIndex,
          network: this.config.network,
          fromAddress: transfer.fromAddress,
          amountUsdt: transfer.amountUsdt,
          blockNumber: transfer.blockNumber,
          blockHash: transfer.blockHash,
          status: initialStatus,
        },
        tx,
      );

      if (created) {
        // First insert — transition invoice (may reach paid if solid)
        await this.transitionAndEnqueue(
          activeInvoice.id,
          latestSolidBlock,
          activeInvoice.amountUsdt,
          now,
          tx,
        );
        return;
      }

      // Payment already existed — check for reorg (pre-solid only).
      const wasOrphaned = await this.checkReorg(
        paymentRow,
        transfer.blockHash,
        latestSolidBlock,
        now,
        tx,
      );

      if (wasOrphaned) {
        // Reorg happened: recompute aggregate + re-transition (M-5).
        await this.transitionAndEnqueue(
          activeInvoice.id,
          latestSolidBlock,
          activeInvoice.amountUsdt,
          now,
          tx,
        );
        return;
      }

      // M-4: Replay re-transition.
      // If the existing payment is "detected" but its block is NOW solid,
      // re-run transition so the invoice can reach confirmed/paid.
      if (
        paymentRow.status === "detected" &&
        paymentRow.blockNumber <= latestSolidBlock
      ) {
        await this.transitionAndEnqueue(
          activeInvoice.id,
          latestSolidBlock,
          activeInvoice.amountUsdt,
          now,
          tx,
        );
        return;
      }

      // M-3c: Crash-safe replay — re-enqueue idempotently if webhook is missing.
      await this.replayMissingWebhook(activeInvoice.id, now, tx);
    });
  }

  /**
   * Check for reorg on an existing payment.
   * If the payment is "detected" (pre-solid) and the blockHash has changed → orphan.
   * "paid" status NEVER reverts.
   *
   * Returns true if the payment was orphaned (caller should recompute + re-transition).
   */
  private async checkReorg(
    existingPayment: PaymentRow,
    newBlockHash: string,
    latestSolidBlock: bigint,
    _now: Date,
    tx: unknown,
  ): Promise<boolean> {
    // Only reorg-check pre-solid payments
    if (existingPayment.blockNumber <= latestSolidBlock) {
      return false;
    }

    if (
      existingPayment.status === "detected" &&
      newBlockHash.length > 0 &&
      existingPayment.blockHash.length > 0 &&
      newBlockHash !== existingPayment.blockHash
    ) {
      log.warn("reorg detected — orphaning payment", {
        paymentId: existingPayment.id,
        txHash: existingPayment.txHash,
        oldBlockHash: existingPayment.blockHash,
        newBlockHash,
      });
      await this.ports.paymentRepo.updateStatus(existingPayment.id, "orphaned", undefined, tx);
      return true;
    }

    return false;
  }

  /**
   * Load invoice + all payments, promote detected→confirmed where now solid,
   * run transitionInvoice, persist status change, enqueue WebhookDelivery.
   *
   * All repo calls are made with the supplied `tx` so they participate in the
   * caller's Prisma transaction (Prisma path) or run sequentially (in-memory).
   *
   * M-3b fix: version comes from webhookRepo.maxVersionForInvoice(invoiceId, tx)
   * which runs MAX(version) inside the same transaction → monotonic versions.
   */
  private async transitionAndEnqueue(
    invoiceId: string,
    latestSolidBlock: bigint,
    invoiceAmountUsdt: string,
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const result = await this.ports.invoiceRepo.findWithPayments(invoiceId, tx);
    if (!result) {
      log.error("invoice not found during transition", { invoiceId });
      return;
    }

    const { invoice, payments } = result;

    // Promote detected payments whose block is now solid
    for (const p of payments) {
      if (p.status === "detected" && p.blockNumber <= latestSolidBlock) {
        await this.ports.paymentRepo.updateStatus(p.id, "confirmed", now, tx);
      }
    }

    // Re-fetch payments with updated statuses
    const refreshed = await this.ports.invoiceRepo.findWithPayments(invoiceId, tx);
    if (!refreshed) return;

    const band = computeToleranceBand(parseMicro(invoiceAmountUsdt));

    const transition = transitionInvoice(
      refreshed.invoice,
      refreshed.payments,
      latestSolidBlock,
      band,
      now,
    );

    const amountReceivedChanged =
      transition.amountReceived !== refreshed.invoice.amountReceived;

    if (transition.changed || amountReceivedChanged) {
      await this.ports.invoiceRepo.updateStatus(
        invoice.id,
        transition.newStatus,
        { amountReceived: transition.amountReceived, paidAt: transition.paidAt ?? undefined },
        tx,
      );
    }

    if (transition.changed) {
      log.info("invoice status changed", {
        invoiceId: invoice.id,
        from: invoice.status,
        to: transition.newStatus,
        webhookEvent: transition.webhookEvent,
      });

      if (transition.webhookEvent) {
        // Version is computed PER ENDPOINT inside enqueueWebhookForInvoice.
        // This avoids @@unique([invoiceId, endpointId, version]) collisions when
        // >=2 endpoints are registered — each gets its own independent counter.
        await this.enqueueWebhookForInvoice(
          invoice.id,
          invoice.eventId,
          transition.webhookEvent,
          transition.newStatus,
          transition.amountReceived,
          now,
          tx,
        );
      }
    }
  }

  /**
   * Compute next monotonic version for a specific (invoice, endpoint) pair.
   * Each endpoint gets its own independent version counter so concurrent
   * fan-out to >=2 endpoints does not collide on @@unique([invoiceId, endpointId, version]).
   * Passes tx through so the MAX query runs in the same Prisma transaction.
   */
  private async nextWebhookVersionForEndpoint(
    invoiceId: string,
    endpointId: string,
    tx: unknown,
  ): Promise<number> {
    const maxVersion = await this.ports.webhookRepo.maxVersionForInvoiceEndpoint(
      invoiceId,
      endpointId,
      tx,
    );
    return maxVersion + 1;
  }

  /**
   * M-3c fix: Crash-safe replay for missing webhooks.
   * Runs inside the caller's transaction (tx passed through to all repo calls).
   */
  private async replayMissingWebhook(invoiceId: string, now: Date, tx: unknown): Promise<void> {
    const result = await this.ports.invoiceRepo.findWithPayments(invoiceId, tx);
    if (!result) return;

    const { invoice, payments } = result;

    const webhookStatuses: Array<string> = [
      "paid",
      "overpaid",
      "underpaid",
      "overdue",
      "payment_detected",
    ];
    if (!webhookStatuses.includes(invoice.status)) return;

    const statusToEvent: Record<string, string> = {
      paid: "invoice.paid",
      overpaid: "invoice.overpaid",
      underpaid: "invoice.underpaid",
      overdue: "invoice.late_funds",
      payment_detected: "invoice.payment_detected",
    };
    const eventType = statusToEvent[invoice.status];
    if (!eventType) return;

    // Check if ANY webhook exists for this invoice (global max across all endpoints).
    const globalMax = await this.ports.webhookRepo.maxVersionForInvoice(invoiceId, tx);
    if (globalMax === 0) {
      const band = computeToleranceBand(parseMicro(invoice.amountUsdt));
      const transition = transitionInvoice(
        invoice,
        payments,
        BigInt(Number.MAX_SAFE_INTEGER),
        band,
        now,
      );

      // enqueueWebhookForInvoice computes per-endpoint version internally.
      await this.enqueueWebhookForInvoice(
        invoiceId,
        invoice.eventId,
        eventType,
        invoice.status,
        transition.amountReceived ?? invoice.amountReceived,
        now,
        tx,
      );
      log.info("re-enqueued missing webhook (crash-safe replay)", {
        invoiceId,
        status: invoice.status,
        eventType,
      });
    }
  }

  /**
   * Fan-out: enqueue ONE WebhookDelivery per REAL registered endpoint.
   *
   * Steps:
   *   1. Resolve active endpoints for the invoice's eventId via endpointRepo.
   *   2. If ZERO endpoints are registered, log and return (do NOT fabricate an id).
   *   3. For each real endpoint, compute its OWN version via
   *      maxVersionForInvoiceEndpoint(invoiceId, endpoint.id, tx)+1 so that
   *      each endpoint has an independent monotonic counter.
   *      This prevents @@unique([invoiceId, endpointId, version]) collisions
   *      when >=2 endpoints are registered (C-1 fix).
   *
   * eventUid = `{eventType}:{invoiceId}:{endpointId}:{version}` — unique per
   * (event, invoice, endpoint, version), idempotent on re-enqueue.
   * Uses the injected clock (no raw Date.now()).
   * Passes tx through to webhookRepo.enqueue so inserts are part of the
   * caller's Prisma transaction (in-memory: tx is ignored).
   */
  private async enqueueWebhookForInvoice(
    invoiceId: string,
    eventId: string,
    eventType: string,
    status: string,
    amountReceived: string,
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const endpoints = await this.ports.endpointRepo.listForEvent(eventId);

    if (endpoints.length === 0) {
      log.debug("no registered endpoints for event — skipping webhook enqueue", {
        invoiceId,
        eventId,
        eventType,
      });
      return;
    }

    const payload = {
      event: eventType,
      invoiceId,
      status,
      amountReceived,
      timestamp: now.toISOString(),
    };

    for (const endpoint of endpoints) {
      // C-1 fix: version is PER (invoice, endpoint) — independent for each endpoint.
      // Computing inside the loop (inside the credit transaction) guarantees that
      // @@unique([invoiceId, endpointId, version]) is never violated even when
      // an event-scoped endpoint and a global (eventId=null) endpoint are both active.
      const version = await this.nextWebhookVersionForEndpoint(invoiceId, endpoint.id, tx);

      // eventUid is unique per (eventType, invoiceId, endpointId, version)
      const eventUid = `${eventType}:${invoiceId}:${endpoint.id}:${version}`;

      await this.ports.webhookRepo.enqueue(
        {
          endpointId: endpoint.id,
          eventType: eventType as import("../core/lifecycle.js").WebhookEventType,
          invoiceId,
          payload,
          eventUid,
          version,
          nextAttemptAt: now,
        },
        tx,
      );
    }

    log.debug("webhook deliveries enqueued", {
      invoiceId,
      eventType,
      endpointCount: endpoints.length,
    });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ensure formatMicro + classifyPayment are used (avoid unused import lint errors)
void formatMicro;
void classifyPayment;
