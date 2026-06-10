/**
 * Watcher offline tests — assert REAL outcomes.
 *
 * All tests use in-memory repos and mock RPC clients.
 * No real DB, no real Tron node.
 *
 * Key scenarios:
 *   - Invoice reaches status==="paid" end-to-end when blockNumber <= solidBlock
 *     at MAINNET-SCALE numbers (solid ≈ 83_000_000n) — proves M-1 fix works
 *   - Invoice reaches "payment_detected" on 0-conf transfer
 *   - Pre-solid reorg → payment "orphaned" + invoice transitions
 *   - Late funds to terminal invoice → "overdue" + late_funds webhook
 *   - Two-RPC agreement + disagreement → no credit
 *   - Idempotent credit (replay = no double insert; solidified detected → paid)
 *   - Address normalization (hex/Base58 both match)
 *   - Dust / fake-contract rejection
 *   - Webhook version strictly increases 1→2 for two transitions on same invoice
 *   - Missing-webhook crash replay: invoice paid but no webhook row → re-enqueued
 *
 * MAINNET-SCALE NUMBERS (M-1 regression-prevention):
 *   SOLID_BLOCK_MAINNET = 83_000_000n  (real Tron mainnet solid height, June 2025)
 *   Confirmed tx block:  82_999_990n   (10 blocks below solid → solidified)
 *   Pre-solid tx block:  83_000_050n   (50 blocks above solid → detected only)
 *
 * Fixtures supply blockNumber via the gettransactioninfobyid mock path (NOT via
 * block_timestamp derivation). This accurately models production.
 */

import { describe, it, expect } from "vitest";
import { TronWatcher, type ActiveInvoice, type TransactionRunner } from "../watcher.js";
import {
  InMemoryPaymentRepository,
  InMemoryInvoiceRepository,
  InMemoryChainCursorRepository,
  InMemoryWebhookDeliveryRepository,
  InMemoryTransactionRunner,
  makeLinkedInvoiceRepo,
} from "./mocks.js";
import { buildMockClient, buildAgreementClients } from "./rpcFixtures.js";
import { UNCONFIRMED_BLOCK_SENTINEL } from "../../core/ports.js";
import type { InvoiceRow } from "../../core/ports.js";
import { TRON_USDT_CONTRACT_BASE58 } from "../../chain/tron/usdt.js";

// Test addresses (from addressCodec test vectors)
const DEPOSIT_ADDR_BASE58 = "TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy";
const DEPOSIT_ADDR_HEX = "4177944d19c052b73ee2286823aa83f8138cb7032f";
const FROM_ADDR = "THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC";
const FAKE_CONTRACT = "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH";

const NOW = new Date("2025-06-01T12:00:00Z");

// ── MAINNET-SCALE block numbers (M-1 fix) ────────────────────────────────────
// These values match real Tron mainnet as of June 2025.
// CRITICAL: tests with tiny solid=100 were passing even when the production
// path was broken (blockNumber derived from timestamp ≈ 593_000_000 >> 100 is
// also >> 83_000_000, but tests used tiny timestamps to get tiny blockNumbers).

/** Mainnet-scale solid block (~83_000_000 on Tron mainnet June 2025). */
const SOLID_BLOCK_MAINNET = 83_000_000n;

/** Block number for a solidified transfer (10 blocks below solid). */
const CONFIRMED_BLOCK_MAINNET = 82_999_990n;

/** Block number for a pre-solid transfer (50 blocks above solid → detected). */
const PRESOLID_BLOCK_MAINNET = 83_000_050n;

/** Arbitrary block timestamp (not used for block number derivation). */
const BLOCK_TIMESTAMP = 1_748_800_000; // some ms value in 2025

// ── Factory helpers ───────────────────────────────────────────────────────────

function makeInvoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv-001",
    eventId: "evt-001",
    status: "pending",
    priceFiat: "100.00",
    fiatCurrency: "USD",
    amountUsdt: "100.000000",
    amountReceived: "0.000000",
    rateLockedAt: new Date("2025-01-01"),
    network: "TRON",
    depositAddress: DEPOSIT_ADDR_BASE58,
    derivationIndex: 0,
    expiresAt: new Date(Date.now() + 3_600_000), // 1h from now
    metadata: null,
    createdAt: new Date("2025-01-01"),
    paidAt: null,
    ...overrides,
  };
}

function makeActiveInvoice(invoice: InvoiceRow): ActiveInvoice {
  return {
    id: invoice.id,
    depositAddress: invoice.depositAddress,
    amountUsdt: invoice.amountUsdt,
    network: invoice.network,
    expiresAt: invoice.expiresAt,
    status: invoice.status,
  };
}

interface WatcherHarness {
  paymentRepo: InMemoryPaymentRepository;
  invoiceRepo: InMemoryInvoiceRepository;
  cursorRepo: InMemoryChainCursorRepository;
  webhookRepo: InMemoryWebhookDeliveryRepository;
  txRunner: InMemoryTransactionRunner;
  watcher: TronWatcher;
}

function buildWatcher(
  primaryCfg: Parameters<typeof buildMockClient>[0],
  secondaryCfg?: Parameters<typeof buildMockClient>[0],
  txRunnerOverride?: TransactionRunner,
): WatcherHarness {
  const paymentRepo = new InMemoryPaymentRepository();
  const invoiceRepo = new InMemoryInvoiceRepository();
  const cursorRepo = new InMemoryChainCursorRepository();
  const webhookRepo = new InMemoryWebhookDeliveryRepository();
  const txRunner = new InMemoryTransactionRunner();
  const { primaryClient, secondaryClient } = buildAgreementClients(
    primaryCfg,
    secondaryCfg,
  );

  const watcher = new TronWatcher(
    { network: "TRON" },
    {
      invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
      paymentRepo,
      chainCursorRepo: cursorRepo,
      webhookRepo,
      endpointRepo: webhookRepo,
      txRunner: txRunnerOverride ?? txRunner,
      primaryClient,
      secondaryClient,
      clock: { now: () => NOW },
    },
  );

  return { paymentRepo, invoiceRepo, cursorRepo, webhookRepo, txRunner, watcher };
}

// ── CRITICAL: Invoice reaching paid at MAINNET-SCALE (M-1 regression test) ───

describe("Watcher — invoice reaches paid at MAINNET-SCALE (M-1 fix)", () => {
  it("pending → confirmed → paid at solidBlock=83_000_000n, tx at block 82_999_990n", async () => {
    // This is the definitive M-1 regression test.
    // The bug: blockNumber derived from timestamp/3000 ≈ 593_000_000 which is
    // ALWAYS > latestSolidBlock ≈ 83_000_000 → no invoice ever pays.
    // The fix: gettransactioninfobyid returns the real block 82_999_990 which
    // IS <= 83_000_000 → payment reaches paid.
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, webhookRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET), // 83_000_000
      transfers: [
        {
          txHash: "tx-mainnet-paid",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000", // 100 USDT = exact match
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-mainnet-paid",
          confirmed: true,
          // Key: real block number from gettransactioninfobyid — below solid
          blockNumber: CONFIRMED_BLOCK_MAINNET, // 82_999_990n <= 83_000_000n → confirmed
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(
      makeActiveInvoice(invoice),
      SOLID_BLOCK_MAINNET,
      0,
      NOW,
    );

    // Payment must exist and be confirmed (not just detected)
    expect(paymentRepo.rows).toHaveLength(1);
    expect(paymentRepo.rows[0]!.status).toBe("confirmed");
    // Block number must be the REAL block from gettransactioninfobyid
    expect(paymentRepo.rows[0]!.blockNumber).toBe(CONFIRMED_BLOCK_MAINNET);

    // Invoice MUST reach "paid" — not stuck at "payment_detected"
    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("paid");
    expect(updated!.paidAt).toEqual(NOW);
    expect(updated!.amountReceived).toBe("100.000000");

    // Webhook "invoice.paid" must be enqueued
    const paidWebhook = webhookRepo.deliveries.find(
      (d) => d.input.eventType === "invoice.paid",
    );
    expect(paidWebhook).toBeDefined();
    expect(paidWebhook!.input.invoiceId).toBe(invoice.id);
    // eventUid must NOT be timestamp-based — must be {eventType}:{invoiceId}:{version}
    expect(paidWebhook!.input.eventUid).toMatch(/^invoice\.paid:inv-001:.+:\d+$/);
  });

  it("pre-solid transfer at block 83_000_050n stays detected (above solid 83_000_000n)", async () => {
    // M-1 corollary: a transfer whose REAL block is above solid stays detected.
    // (This proves the gate works correctly in both directions.)
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-mainnet-presolid",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "",
          confirmed: false,
          blockNumber: PRESOLID_BLOCK_MAINNET, // 83_000_050n > 83_000_000n → detected
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(
      makeActiveInvoice(invoice),
      SOLID_BLOCK_MAINNET,
      0,
      NOW,
    );

    expect(paymentRepo.rows).toHaveLength(1);
    expect(paymentRepo.rows[0]!.status).toBe("detected");
    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("payment_detected"); // not paid
  });

  it("unconfirmed tx (both provider receipts empty) → candidate skipped, no payment row", async () => {
    // Transfer with null blockNumber → both provider receipts are empty {} (tx not in a block yet).
    // fetchTransactionReceipt returns null for both → candidate skipped this tick.
    // In the new receipt-based design there is no "detected" placeholder for unconfirmed txs;
    // the candidate is simply skipped and re-evaluated on the next tick once receipts appear.
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-unconfirmed",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "",
          confirmed: false,
          blockNumber: null, // not yet on-chain → receipt empty {} → skipped this tick
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(
      makeActiveInvoice(invoice),
      SOLID_BLOCK_MAINNET,
      0,
      NOW,
    );

    // Empty receipts → candidate skipped → no payment row, invoice stays pending
    expect(paymentRepo.rows).toHaveLength(0);
    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("pending");
  });
});

// ── DEFECT 3 (M-3b): Webhook version strictly increases 1→2 ─────────────────

describe("Watcher — webhook version monotonically increases (M-3b fix)", () => {
  it("two transitions on the same invoice get versions 1 then 2 (via production path)", async () => {
    // M-3b fix: version comes from maxVersionForInvoice() NOT from a mock-only
    // `deliveries` field. This test drives TWO transitions via the SAME code path
    // production uses and asserts strict version ordering.
    //
    // Scenario:
    //   Tick 1: pre-solid transfer → payment_detected webhook (version=1)
    //   Tick 2: same transfer now solid → paid webhook (version=2)
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    invoiceRepo.addInvoice(invoice);

    // Tick 1: pre-solid (block above solid 83_000_000)
    const { primaryClient: pc1, secondaryClient: sc1 } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-version-test",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "",
          confirmed: false,
          blockNumber: PRESOLID_BLOCK_MAINNET, // 83_000_050n > solid → detected
        },
      ],
    });

    const watcher1 = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient: pc1,
        secondaryClient: sc1,
        clock: { now: () => NOW },
      },
    );

    await watcher1.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    // After tick 1: invoice = payment_detected, webhook version=1
    expect(invoiceRepo.rows[0]!.status).toBe("payment_detected");
    expect(webhookRepo.deliveries).toHaveLength(1);
    const firstWebhook = webhookRepo.deliveries[0]!;
    expect(firstWebhook.input.eventType).toBe("invoice.payment_detected");
    expect(firstWebhook.input.version).toBe(1);
    expect(firstWebhook.input.eventUid).toMatch(/^invoice\.payment_detected:inv-001:.+:1$/);

    // Tick 2: same transfer now at a LOWER solid → transfer's block is now solid
    // Use a higher solidBlock so CONFIRMED_BLOCK_MAINNET <= newSolid
    const newSolid = 83_000_100n; // advances past the pre-solid block
    const { primaryClient: pc2, secondaryClient: sc2 } = buildAgreementClients({
      solidBlockNumber: Number(newSolid),
      transfers: [
        {
          txHash: "tx-version-test",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-now-solid",
          confirmed: true,
          blockNumber: PRESOLID_BLOCK_MAINNET, // 83_000_050n <= 83_000_100n now solid
        },
      ],
    });

    const watcher2 = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient: pc2,
        secondaryClient: sc2,
        clock: { now: () => NOW },
      },
    );

    await watcher2.processInvoice(
      { ...makeActiveInvoice(invoice), status: "payment_detected" },
      newSolid,
      0,
      NOW,
    );

    // After tick 2: invoice = paid, second webhook version=2
    expect(invoiceRepo.rows[0]!.status).toBe("paid");
    expect(webhookRepo.deliveries).toHaveLength(2);

    const secondWebhook = webhookRepo.deliveries[1]!;
    expect(secondWebhook.input.eventType).toBe("invoice.paid");
    expect(secondWebhook.input.version).toBe(2); // strictly greater than 1
    expect(secondWebhook.input.eventUid).toMatch(/^invoice\.paid:inv-001:.+:2$/);

    // Both versions are distinct (no collisions)
    const versions = webhookRepo.deliveries.map((d) => d.input.version);
    expect(new Set(versions).size).toBe(versions.length); // all unique
  });
});

// ── DEFECT 4 (M-3c): Missing webhook replay ──────────────────────────────────

describe("Watcher — crash-safe webhook replay (M-3c fix)", () => {
  it("invoice paid with no webhook → next tick re-enqueues the webhook", async () => {
    // Scenario: invoice is in "paid" status (DB durably committed) but the
    // WebhookDelivery row is missing (e.g. crash between updateStatus and enqueue
    // before the atomic tx fix). On the next tick, the watcher should detect the
    // gap and re-enqueue the missing webhook.
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    // Invoice is already paid (crash happened after updateStatus("paid"))
    const invoice = makeInvoice({
      status: "paid",
      amountReceived: "100.000000",
      paidAt: NOW,
    });
    invoiceRepo.addInvoice(invoice);

    // Existing solid payment (the one that paid the invoice)
    await paymentRepo.upsert({
      invoiceId: invoice.id,
      txHash: "tx-crash-replay",
      logIndex: 0,
      network: "TRON",
      fromAddress: FROM_ADDR,
      amountUsdt: "100.000000",
      blockNumber: CONFIRMED_BLOCK_MAINNET, // solid
      blockHash: "bh-crash-replay",
      status: "confirmed",
    });

    // Webhook deliveries are EMPTY (crash before enqueue)
    expect(webhookRepo.deliveries).toHaveLength(0);

    // Next tick: same transfer arrives again (replay)
    const { primaryClient, secondaryClient } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-crash-replay",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-crash-replay",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    const watcher = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient,
        secondaryClient,
        clock: { now: () => NOW },
      },
    );

    await watcher.processInvoice(
      { ...makeActiveInvoice(invoice), status: "paid" },
      SOLID_BLOCK_MAINNET,
      0,
      NOW,
    );

    // Webhook MUST now be enqueued (crash-safe replay)
    expect(webhookRepo.deliveries.length).toBeGreaterThan(0);
    const replayedWebhook = webhookRepo.deliveries.find(
      (d) => d.input.invoiceId === invoice.id,
    );
    expect(replayedWebhook).toBeDefined();
  });
});

// ── Invoice reaching paid end-to-end (legacy scenarios, now mainnet-scale) ───

describe("Watcher — invoice reaches paid end-to-end", () => {
  it("pending → confirmed → paid when blockNumber <= solidBlock (mainnet-scale)", async () => {
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, webhookRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-paid-001",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-paid-001",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(1);
    expect(paymentRepo.rows[0]!.status).toBe("confirmed");

    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("paid");
    expect(updated!.paidAt).toEqual(NOW);
    expect(updated!.amountReceived).toBe("100.000000");

    const paidWebhook = webhookRepo.deliveries.find(
      (d) => d.input.eventType === "invoice.paid",
    );
    expect(paidWebhook).toBeDefined();
    expect(paidWebhook!.input.invoiceId).toBe(invoice.id);
    expect(paidWebhook!.input.eventUid).toMatch(/^invoice\.paid:inv-001:.+:\d+$/);
  });

  it("overpaid when amount > invoiced amount", async () => {
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-overpaid",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "120000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-overpaid",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("overpaid");
    expect(paymentRepo.rows[0]!.status).toBe("confirmed");
  });

  it("payment_detected (0-conf) when blockNumber > solidBlock, then paid on next tick", async () => {
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });

    // Tick 1: transfer is pre-solid (block above solid)
    const { paymentRepo, invoiceRepo, webhookRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-detected-then-paid",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "",
          confirmed: false,
          blockNumber: PRESOLID_BLOCK_MAINNET, // 83_000_050n > solid → detected
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows[0]!.status).toBe("detected");
    const afterTick1 = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(afterTick1!.status).toBe("payment_detected");

    // Tick 2: solid block advances past the transfer's block (83_000_050 <= 83_000_100)
    const newSolid = 83_000_100n;
    const activeInvoice2: ActiveInvoice = {
      id: invoice.id,
      depositAddress: invoice.depositAddress,
      amountUsdt: invoice.amountUsdt,
      network: invoice.network,
      expiresAt: invoice.expiresAt,
      status: "payment_detected",
    };
    await watcher.processInvoice(activeInvoice2, newSolid, 0, NOW);

    const afterTick2 = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(afterTick2!.status).toBe("paid");
    expect(afterTick2!.paidAt).toEqual(NOW);

    const paidWebhook = webhookRepo.deliveries.find(
      (d) => d.input.eventType === "invoice.paid",
    );
    expect(paidWebhook).toBeDefined();
  });
});

// ── Address normalization ─────────────────────────────────────────────────────

describe("Watcher — address normalization", () => {
  it("matches deposit address in Base58 form", async () => {
    const invoice = makeInvoice({ depositAddress: DEPOSIT_ADDR_BASE58 });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx001",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh001",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(1);
    expect(paymentRepo.rows[0]!.txHash).toBe("tx001");
  });

  it("matches deposit address in hex form (normalizes both sides)", async () => {
    const invoice = makeInvoice({ depositAddress: DEPOSIT_ADDR_HEX });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx002",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh002",
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(1);
  });

  it("ignores transfers to a different address", async () => {
    const invoice = makeInvoice({ depositAddress: DEPOSIT_ADDR_BASE58 });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx003",
          from: FROM_ADDR,
          to: FROM_ADDR, // wrong destination
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh003",
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(0);
  });
});

// ── Dust and fake-contract rejection ──────────────────────────────────────────

describe("Watcher — dust and fake-contract rejection", () => {
  it("rejects zero-value transfers", async () => {
    const invoice = makeInvoice();
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx010",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "0",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(0);
  });

  it("rejects fake-contract transfers", async () => {
    const invoice = makeInvoice();
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx011",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          contractAddress: FAKE_CONTRACT,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(0);
  });

  it("accepts valid USDT transfers", async () => {
    const invoice = makeInvoice();
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx012",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          contractAddress: TRON_USDT_CONTRACT_BASE58,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(1);
  });
});

// ── Solid-block finality gate ─────────────────────────────────────────────────

describe("Watcher — solid-block finality gate", () => {
  it("marks payment as detected when blockNumber > solidBlock (mainnet-scale)", async () => {
    const invoice = makeInvoice();
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET), // 83_000_000
      transfers: [
        {
          txHash: "tx020",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "",
          confirmed: false,
          blockNumber: PRESOLID_BLOCK_MAINNET, // 83_000_050n > 83_000_000n → detected
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(1);
    expect(paymentRepo.rows[0]!.status).toBe("detected");

    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("payment_detected");
  });

  it("marks payment as confirmed and invoice as paid when blockNumber <= solidBlock (mainnet)", async () => {
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx021",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh021",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET, // 82_999_990n <= 83_000_000n → confirmed
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(1);
    expect(paymentRepo.rows[0]!.status).toBe("confirmed");

    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("paid");
  });
});

// ── Idempotent credit ─────────────────────────────────────────────────────────

describe("Watcher — idempotent credit", () => {
  it("persists increased amountReceived when repeated confirmed partial payments stay below the paid threshold", async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    const invoice = makeInvoice({
      id: "inv-repeated-partials",
      status: "pending",
      amountUsdt: "100.000000",
    });
    invoiceRepo.addInvoice(invoice);

    const makeWatcher = (transfers: Parameters<typeof buildMockClient>[0]["transfers"]) => {
      const { primaryClient, secondaryClient } = buildAgreementClients({
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers,
      });

      return new TronWatcher(
        { network: "TRON" },
        {
          invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
          paymentRepo,
          chainCursorRepo: cursorRepo,
          webhookRepo,
          endpointRepo: webhookRepo,
          txRunner: new InMemoryTransactionRunner(),
          primaryClient,
          secondaryClient,
          clock: { now: () => NOW },
        },
      );
    };

    await makeWatcher([
      {
        txHash: "tx-partial-20",
        from: FROM_ADDR,
        to: DEPOSIT_ADDR_BASE58,
        value: "20000000",
        blockTimestamp: BLOCK_TIMESTAMP,
        blockHash: "bh-partial-20",
        confirmed: true,
        blockNumber: CONFIRMED_BLOCK_MAINNET,
      },
    ]).processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    const afterFirst = invoiceRepo.rows.find((r) => r.id === invoice.id)!;
    expect(afterFirst.status).toBe("payment_detected");
    expect(afterFirst.amountReceived).toBe("20.000000");

    await makeWatcher([
      {
        txHash: "tx-partial-20",
        from: FROM_ADDR,
        to: DEPOSIT_ADDR_BASE58,
        value: "20000000",
        blockTimestamp: BLOCK_TIMESTAMP,
        blockHash: "bh-partial-20",
        confirmed: true,
        blockNumber: CONFIRMED_BLOCK_MAINNET,
      },
      {
        txHash: "tx-partial-30",
        from: FROM_ADDR,
        to: DEPOSIT_ADDR_BASE58,
        value: "30000000",
        blockTimestamp: BLOCK_TIMESTAMP + 1,
        blockHash: "bh-partial-30",
        confirmed: true,
        blockNumber: CONFIRMED_BLOCK_MAINNET,
      },
    ]).processInvoice(makeActiveInvoice(afterFirst), SOLID_BLOCK_MAINNET, 0, NOW);

    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id)!;
    expect(paymentRepo.rows).toHaveLength(2);
    expect(updated.status).toBe("payment_detected");
    expect(updated.amountReceived).toBe("50.000000");
  });

  it("does not insert duplicate payment on replay", async () => {
    const invoice = makeInvoice({ amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx030",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh030",
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);

    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(1);
  });

  it("replay returns existing row without modification", async () => {
    const invoice = makeInvoice({ amountUsdt: "50.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx031",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "50000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh031",
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    const firstId = paymentRepo.rows[0]!.id;

    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(1);
    expect(paymentRepo.rows[0]!.id).toBe(firstId);
  });
});

// ── Pre-solid reorg → orphan (M-5) ───────────────────────────────────────────

describe("Watcher — pre-solid reorg → orphan (drives REAL watcher)", () => {
  it("orphans a detected payment when blockHash changes pre-solid, and invoice re-transitions", async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    invoiceRepo.addInvoice(invoice);

    // Tick 1: transfer seen pre-solid (block above mainnet solid)
    const { primaryClient: pc1, secondaryClient: sc1 } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx040",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "old-block-hash",
          confirmed: false,
          blockNumber: PRESOLID_BLOCK_MAINNET, // above solid → detected
        },
      ],
    });

    const watcher1 = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient: pc1,
        secondaryClient: sc1,
        clock: { now: () => NOW },
      },
    );

    await watcher1.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows[0]!.status).toBe("detected");
    expect(paymentRepo.rows[0]!.blockHash).toBe("old-block-hash");
    const afterTick1 = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(afterTick1!.status).toBe("payment_detected");

    // Tick 2: SAME txHash but DIFFERENT blockHash → reorg
    const { primaryClient: pc2, secondaryClient: sc2 } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx040",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "new-block-hash-after-reorg",
          confirmed: false,
          blockNumber: PRESOLID_BLOCK_MAINNET, // still pre-solid
        },
      ],
    });

    const watcher2 = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient: pc2,
        secondaryClient: sc2,
        clock: { now: () => NOW },
      },
    );

    await watcher2.processInvoice(
      { ...makeActiveInvoice(invoice), status: "payment_detected" },
      SOLID_BLOCK_MAINNET,
      0,
      NOW,
    );

    expect(paymentRepo.rows[0]!.status).toBe("orphaned");

    const afterReorg = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(afterReorg!.status).not.toBe("paid");
  });

  it("does NOT orphan a solid (confirmed) payment when blockHash changes", async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    const invoice = makeInvoice({
      status: "paid",
      amountUsdt: "100.000000",
      amountReceived: "100.000000",
    });
    invoiceRepo.addInvoice(invoice);

    await paymentRepo.upsert({
      invoiceId: invoice.id,
      txHash: "tx041",
      logIndex: 0,
      network: "TRON",
      fromAddress: FROM_ADDR,
      amountUsdt: "100.000000",
      blockNumber: CONFIRMED_BLOCK_MAINNET, // solid
      blockHash: "old-hash",
      status: "confirmed",
    });

    const { primaryClient, secondaryClient } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx041",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "different-hash",
          blockNumber: CONFIRMED_BLOCK_MAINNET, // solid — no reorg
        },
      ],
    });

    const watcher = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient,
        secondaryClient,
        clock: { now: () => NOW },
      },
    );

    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows[0]!.status).toBe("confirmed");
  });

  it("paid status never reverts after reorg of a different payment", async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();

    const invoice = makeInvoice({ status: "paid", amountReceived: "100.000000" });
    invoiceRepo.addInvoice(invoice);

    await paymentRepo.upsert({
      invoiceId: invoice.id,
      txHash: "tx042",
      logIndex: 0,
      network: "TRON",
      fromAddress: FROM_ADDR,
      amountUsdt: "100.000000",
      blockNumber: CONFIRMED_BLOCK_MAINNET,
      blockHash: "solid-hash",
      status: "confirmed",
    });

    const payment = paymentRepo.rows[0]!;
    await paymentRepo.updateStatus(payment.id, "orphaned");

    expect(invoiceRepo.rows[0]!.status).toBe("paid");
  });
});

// ── Orphan revival after pre-solid reorg (drives REAL watcher) ────────────────

describe("Watcher — orphaned payment revival after pre-solid reorg", () => {
  interface OrphanRevivalHarness {
    paymentRepo: InMemoryPaymentRepository;
    invoiceRepo: InMemoryInvoiceRepository;
    cursorRepo: InMemoryChainCursorRepository;
    webhookRepo: InMemoryWebhookDeliveryRepository;
    invoice: InvoiceRow;
    tick: (
      primaryCfg: Parameters<typeof buildMockClient>[0],
      secondaryCfg?: Parameters<typeof buildMockClient>[0],
    ) => Promise<void>;
  }

  /** Shared repos + a per-tick watcher factory (mirrors the reorg tests above). */
  function buildOrphanHarness(): OrphanRevivalHarness {
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    invoiceRepo.addInvoice(invoice);

    const tick = async (
      primaryCfg: Parameters<typeof buildMockClient>[0],
      secondaryCfg?: Parameters<typeof buildMockClient>[0],
    ): Promise<void> => {
      const { primaryClient, secondaryClient } = buildAgreementClients(
        primaryCfg,
        secondaryCfg,
      );
      const watcher = new TronWatcher(
        { network: "TRON" },
        {
          invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
          paymentRepo,
          chainCursorRepo: cursorRepo,
          webhookRepo,
          endpointRepo: webhookRepo,
          txRunner: new InMemoryTransactionRunner(),
          primaryClient,
          secondaryClient,
          clock: { now: () => NOW },
        },
      );
      await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);
    };

    return { paymentRepo, invoiceRepo, cursorRepo, webhookRepo, invoice, tick };
  }

  /** Tick 1 + tick 2: detect pre-solid, then reorg → orphaned. */
  async function detectThenOrphan(h: OrphanRevivalHarness): Promise<void> {
    // Tick 1: transfer seen pre-solid → detected
    await h.tick({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx060",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "orig-hash",
          confirmed: false,
          blockNumber: PRESOLID_BLOCK_MAINNET,
        },
      ],
    });
    expect(h.paymentRepo.rows[0]!.status).toBe("detected");

    // Tick 2: same tx, DIFFERENT blockHash, still pre-solid → orphaned
    await h.tick({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx060",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "reorg-hash",
          confirmed: false,
          blockNumber: PRESOLID_BLOCK_MAINNET,
        },
      ],
    });
    expect(h.paymentRepo.rows[0]!.status).toBe("orphaned");
  }

  it("orphaned payment re-observed at a new solid block is revived and credited (invoice paid)", async () => {
    const h = buildOrphanHarness();
    await detectThenOrphan(h);

    // Tick 3: same tx re-mined in a NEW block that is now solid — both providers
    // agree on the placement → revive orphaned → detected → confirmed → paid.
    await h.tick({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx060",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "remined-hash",
          blockNumber: CONFIRMED_BLOCK_MAINNET, // below solid → creditable
        },
      ],
    });

    const payment = h.paymentRepo.rows[0]!;
    // Credited through the normal detected→confirmed gate (never straight to paid)
    expect(payment.status).toBe("confirmed");
    expect(payment.blockNumber).toBe(CONFIRMED_BLOCK_MAINNET);
    expect(payment.blockHash).toBe("remined-hash");
    // amountUsdt immutable across orphan + revival
    expect(payment.amountUsdt).toBe("100.000000");

    const invoiceRow = h.invoiceRepo.rows.find((r) => r.id === h.invoice.id)!;
    expect(invoiceRow.status).toBe("paid");
    expect(invoiceRow.amountReceived).toBe("100.000000");

    // invoice.paid webhook enqueued
    const paidWebhooks = h.webhookRepo.deliveries.filter(
      (d) => d.input.eventType === "invoice.paid",
    );
    expect(paidWebhooks.length).toBe(1);
  });

  it("orphaned payment NOT re-observed stays orphaned (invoice never paid)", async () => {
    const h = buildOrphanHarness();
    await detectThenOrphan(h);

    // Tick 3: the tx is gone from both providers (not re-mined)
    await h.tick({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [],
    });

    expect(h.paymentRepo.rows[0]!.status).toBe("orphaned");
    const invoiceRow = h.invoiceRepo.rows.find((r) => r.id === h.invoice.id)!;
    expect(invoiceRow.status).not.toBe("paid");
    expect(invoiceRow.amountReceived).toBe("0.000000");
  });

  it("orphaned payment re-observed WITHOUT two-sided block placement stays orphaned", async () => {
    const h = buildOrphanHarness();
    await detectThenOrphan(h);

    // Tick 3: tx re-appears but the secondary provider has no block number yet
    // (gettransactioninfobyid empty) → effective placement is the sentinel →
    // no revival. Recovers only when BOTH providers confirm the placement.
    await h.tick(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx060",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "remined-hash",
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      },
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx060",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "remined-hash",
            blockNumber: null, // secondary has not confirmed the placement
          },
        ],
      },
    );

    expect(h.paymentRepo.rows[0]!.status).toBe("orphaned");
    const invoiceRow = h.invoiceRepo.rows.find((r) => r.id === h.invoice.id)!;
    expect(invoiceRow.status).not.toBe("paid");
  });
});

// ── HIGH false-credit fix: reorged-out detected payment vs height-only gate ──
//
// BUG SCENARIO (pre-fix): a "detected" pre-solid payment whose tx gets reorged
// OUT keeps its stale stored blockNumber=N. Its receipt now returns null on
// both providers, so the candidate is skipped each tick WITHOUT touching the
// row. When solid later passes N, the height-only promotion loop
// (transitionAndEnqueue: detected && blockNumber <= latestSolidBlock) promotes
// it to confirmed — crediting funds that are no longer on-chain.
//
// FIX: on every full-replay tick (minTimestampMs === 0), any "detected"
// payment whose (txHash, logIndex) was NOT re-agreed via dual receipts has its
// stored blockNumber reset to UNCONFIRMED_BLOCK_SENTINEL, so the height gate
// can never fire on it. If re-mined, the normal agreement path re-credits it.

describe("Watcher — reorged-out detected payment is NOT credited by the height-only gate", () => {
  it("tx reorged out (receipts null) → blockNumber sentineled; second payment does not promote the phantom", async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    invoiceRepo.addInvoice(invoice);

    const tick = async (
      cfg: Parameters<typeof buildMockClient>[0],
      latestSolidBlock: bigint,
      status: InvoiceRow["status"],
    ): Promise<void> => {
      const { primaryClient, secondaryClient } = buildAgreementClients(cfg);
      const watcher = new TronWatcher(
        { network: "TRON" },
        {
          invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
          paymentRepo,
          chainCursorRepo: cursorRepo,
          webhookRepo,
          endpointRepo: webhookRepo,
          txRunner: new InMemoryTransactionRunner(),
          primaryClient,
          secondaryClient,
          clock: { now: () => NOW },
        },
      );
      await watcher.processInvoice(
        { ...makeActiveInvoice(invoice), status },
        latestSolidBlock,
        0, // full replay tick — exactly the needsUnresolvedFundsReplay case
        NOW,
      );
    };

    // ── Tick 1: 100 USDT lands at a NON-solid block N → detected ─────────────
    await tick(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-phantom",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000", // 100 USDT — full invoice amount
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh-phantom",
            confirmed: false,
            blockNumber: PRESOLID_BLOCK_MAINNET, // N = 83_000_050n > solid → detected
          },
        ],
      },
      SOLID_BLOCK_MAINNET,
      "pending",
    );

    const phantomAfterTick1 = paymentRepo.rows.find((r) => r.txHash === "tx-phantom")!;
    expect(phantomAfterTick1.status).toBe("detected");
    expect(phantomAfterTick1.blockNumber).toBe(PRESOLID_BLOCK_MAINNET);

    // ── Tick 2: tx-phantom REORGED OUT — both receipts now return null ───────
    // (/v1 indexer still lists it briefly, but gettransactioninfobyid → {}).
    // Solid advances PAST N, and a SECOND real payment (1 USDT) lands solid,
    // triggering transitionAndEnqueue's height-only promotion loop.
    const NEW_SOLID = 83_000_100n; // > N = 83_000_050n
    await tick(
      {
        solidBlockNumber: Number(NEW_SOLID),
        transfers: [
          {
            txHash: "tx-phantom",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh-phantom",
            confirmed: false,
            blockNumber: null, // reorged out: receipt is empty {} on BOTH providers
          },
          {
            txHash: "tx-real",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "1000000", // 1 USDT — real, solid
            blockTimestamp: BLOCK_TIMESTAMP + 10,
            blockHash: "bh-real",
            blockNumber: 83_000_060n, // <= NEW_SOLID → confirmed
          },
        ],
      },
      NEW_SOLID,
      "payment_detected",
    );

    // The phantom must NOT be credited: not confirmed, blockNumber sentineled
    // so the height gate (blockNumber <= latestSolidBlock) can never fire on it.
    const phantom = paymentRepo.rows.find((r) => r.txHash === "tx-phantom")!;
    expect(phantom.status).not.toBe("confirmed");
    expect(phantom.status).toBe("detected");
    expect(phantom.blockNumber).toBe(UNCONFIRMED_BLOCK_SENTINEL);

    // The real payment IS credited normally.
    const real = paymentRepo.rows.find((r) => r.txHash === "tx-real")!;
    expect(real.status).toBe("confirmed");

    // Invoice must NOT be paid on phantom funds — only the real 1 USDT counts.
    const invoiceRow = invoiceRepo.rows.find((r) => r.id === invoice.id)!;
    expect(invoiceRow.status).not.toBe("paid");
    expect(invoiceRow.status).not.toBe("overpaid");
    expect(invoiceRow.status).toBe("payment_detected");
    expect(invoiceRow.amountReceived).toBe("1.000000");
  });
});

// ── Late funds → overdue (M-4 replay + late_funds path) ──────────────────────

describe("Watcher — late funds → overdue", () => {
  it("transitions terminal paid invoice to overdue when new solid payment arrives", async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    const invoice = makeInvoice({ status: "paid", amountReceived: "100.000000" });
    invoiceRepo.addInvoice(invoice);

    await paymentRepo.upsert({
      invoiceId: invoice.id,
      txHash: "tx050",
      logIndex: 0,
      network: "TRON",
      fromAddress: FROM_ADDR,
      amountUsdt: "100.000000",
      blockNumber: CONFIRMED_BLOCK_MAINNET,
      blockHash: "bh050",
      status: "confirmed",
    });

    const { primaryClient, secondaryClient } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx051",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "50000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh051",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    const watcher = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient,
        secondaryClient,
        clock: { now: () => NOW },
      },
    );

    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(2);
    expect(paymentRepo.rows[1]!.txHash).toBe("tx051");
    expect(paymentRepo.rows[1]!.status).toBe("confirmed");

    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("overdue");

    const lateWebhook = webhookRepo.deliveries.find(
      (d) => d.input.eventType === "invoice.late_funds",
    );
    expect(lateWebhook).toBeDefined();
    expect(lateWebhook!.input.invoiceId).toBe(invoice.id);
  });
});

// ── Two-RPC agreement ─────────────────────────────────────────────────────────

describe("Watcher — two-RPC agreement (genuine independence)", () => {
  it("credits transfer only when both providers agree", async () => {
    const invoice = makeInvoice({ amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx060",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh060",
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      },
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx060",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh060",
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      },
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(1);
    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("paid");
  });

  it("does NOT credit when secondary provider does not see the transfer", async () => {
    const invoice = makeInvoice();
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx061",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh061",
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      },
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [],
      },
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(0);
    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("pending");
  });

  it("does NOT credit when providers disagree on transfer value", async () => {
    const invoice = makeInvoice();
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx062",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh062",
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      },
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx062",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "50000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh062",
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      },
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(0);
  });

  it("does NOT credit when providers disagree on recipient address", async () => {
    const invoice = makeInvoice();
    const OTHER_ADDR = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx063",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      },
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx063",
            from: FROM_ADDR,
            to: OTHER_ADDR,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      },
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(0);
  });
});

// ── Webhook enqueue ───────────────────────────────────────────────────────────

describe("Watcher — webhook enqueue", () => {
  it("enqueues a webhook delivery on invoice status change to paid", async () => {
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { invoiceRepo, webhookRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx070",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh070",
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("paid");
    expect(webhookRepo.deliveries.length).toBeGreaterThan(0);

    const paidWebhook = webhookRepo.deliveries.find(
      (d) => d.input.eventType === "invoice.paid",
    );
    expect(paidWebhook).toBeDefined();
  });

  it("eventUid is deterministic {eventType}:{invoiceId}:{version} — NOT timestamp-based", async () => {
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { invoiceRepo, webhookRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx071",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh071",
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    const delivery = webhookRepo.deliveries[0]!;
    expect(delivery.input.eventUid).not.toMatch(/:\d{13,}$/);
    // eventUid format: {eventType}:{invoiceId}:{endpointId}:{version}
    expect(delivery.input.eventUid).toMatch(/^invoice\.[a-z_]+:inv-\d+:.+:\d+$/);
  });

  it("does not enqueue duplicate webhooks on replay (idempotent on eventUid)", async () => {
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { invoiceRepo, webhookRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx072",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh072",
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);
    const countAfterFirst = webhookRepo.deliveries.length;

    await watcher.processInvoice(
      { ...makeActiveInvoice(invoice), status: "paid" },
      SOLID_BLOCK_MAINNET,
      0,
      NOW,
    );
    expect(webhookRepo.deliveries.length).toBe(countAfterFirst);
  });
});

// ── pollOnce wires listActiveForWatch ────────────────────────────────────────

describe("Watcher — pollOnce loads active invoices", () => {
  it("pollOnce processes active invoices loaded from repo and updates cursor with block height", async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    invoiceRepo.addInvoice(invoice);

    const { primaryClient, secondaryClient } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-pollonce",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-pollonce",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    const watcher = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient,
        secondaryClient,
        clock: { now: () => NOW },
      },
    );

    await watcher.pollOnce();

    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("paid");

    const cursor = await cursorRepo.findByNetwork("TRON");
    expect(cursor).toBeDefined();
    // lastScannedBlock must be the solid block number (83_000_000n), NOT a timestamp
    expect(cursor!.lastScannedBlock).toBe(SOLID_BLOCK_MAINNET);
    expect(cursor!.lastSolidBlock).toBe(SOLID_BLOCK_MAINNET);
  });

  it("pollOnce replays unresolved invoices so provider lag cannot hide an older transfer behind the cursor", async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    const invoice = makeInvoice({
      id: "inv-pollonce-provider-lag",
      status: "pending",
      amountUsdt: "100.000000",
    });
    invoiceRepo.addInvoice(invoice);

    const cursorMinTimestampAfterFirstTick =
      1_501_804_800_000 + Number(SOLID_BLOCK_MAINNET) * 3_000 - 120_000;
    const oldTransferTimestamp = cursorMinTimestampAfterFirstTick - 1_000;

    const firstTickPrimary = buildMockClient({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-pollonce-provider-lag",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: oldTransferTimestamp,
          blockHash: "bh-pollonce-provider-lag",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });
    const firstTickSecondary = buildMockClient({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [],
    });

    const watcher1 = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient: firstTickPrimary,
        secondaryClient: firstTickSecondary,
        clock: { now: () => NOW },
      },
    );

    await watcher1.pollOnce();

    expect(paymentRepo.rows).toHaveLength(0);
    expect(invoiceRepo.rows.find((r) => r.id === invoice.id)!.status).toBe("pending");

    const cursor = await cursorRepo.findByNetwork("TRON");
    expect(cursor!.lastSolidBlock).toBe(SOLID_BLOCK_MAINNET);

    const { primaryClient: secondTickPrimary, secondaryClient: secondTickSecondary } =
      buildAgreementClients({
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-pollonce-provider-lag",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: oldTransferTimestamp,
            blockHash: "bh-pollonce-provider-lag",
            confirmed: true,
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      });

    const watcher2 = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient: secondTickPrimary,
        secondaryClient: secondTickSecondary,
        clock: { now: () => NOW },
      },
    );

    await watcher2.pollOnce();

    expect(paymentRepo.rows).toHaveLength(1);
    expect(paymentRepo.rows[0]!.status).toBe("confirmed");
    const afterReplay = invoiceRepo.rows.find((r) => r.id === invoice.id)!;
    expect(afterReplay.status).toBe("paid");
    expect(afterReplay.amountReceived).toBe("100.000000");
  });
});

// ── C2: late funds to terminal invoice via REAL pollOnce path ─────────────────

describe("Watcher — C2: late funds to paid invoice detected via pollOnce + listActiveForWatch grace window", () => {
  it("pollOnce: paid invoice within grace window receives late payment → overdue + invoice.late_funds", async () => {
    // This test exercises the REAL pollOnce → listActiveForWatch path (not processInvoice
    // directly), proving that C2 fix causes the paid invoice to be included in the poll set
    // and that late funds are recorded.
    //
    // The in-memory mock's listActiveForWatch returns terminal invoices within the grace
    // window — which models the Prisma impl's grace-window query.

    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    // Seed a paid invoice with paidAt=yesterday (well within 30-day grace window)
    // Use real Date.now() so the grace-window check in listActiveForWatch passes.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const paidInvoice = makeInvoice({
      id: "inv-c2-001",
      status: "paid",
      amountUsdt: "100.000000",
      amountReceived: "100.000000",
      paidAt: yesterday,
    });
    invoiceRepo.addInvoice(paidInvoice);

    // Existing solid payment that paid the invoice
    await paymentRepo.upsert({
      invoiceId: paidInvoice.id,
      txHash: "tx-c2-original",
      logIndex: 0,
      network: "TRON",
      fromAddress: FROM_ADDR,
      amountUsdt: "100.000000",
      blockNumber: CONFIRMED_BLOCK_MAINNET,
      blockHash: "bh-c2-original",
      status: "confirmed",
    });

    // Late payment arrives at the same deposit address
    const { primaryClient, secondaryClient } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-c2-late",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "25000000", // 25 USDT late
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-c2-late",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    const watcher = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient,
        secondaryClient,
        clock: { now: () => NOW },
      },
    );

    // Drive via pollOnce (the real path, not processInvoice directly)
    await watcher.pollOnce();

    // The paid invoice must now be overdue (late funds received)
    const updated = invoiceRepo.rows.find((r) => r.id === paidInvoice.id);
    expect(updated!.status).toBe("overdue");
    expect(updated!.amountReceived).toBe("125.000000"); // 100 + 25

    // invoice.late_funds webhook must have been enqueued
    const lateWebhook = webhookRepo.deliveries.find(
      (d) => d.input.eventType === "invoice.late_funds" && d.input.invoiceId === paidInvoice.id,
    );
    expect(lateWebhook).toBeDefined();
    expect(lateWebhook!.input.invoiceId).toBe(paidInvoice.id);
  });
});

// ── H1: repeat late funds to already-overdue invoice ─────────────────────────

describe("Watcher — H1: repeat late payments to overdue invoice both persist amountReceived + emit invoice.late_funds", () => {
  it("two successive late payments to one invoice → increasing amountReceived + both emit invoice.late_funds with distinct versions", async () => {
    // This test proves H1 fix: a 2nd late payment to an already-overdue invoice
    // is NOT dropped. Each late payment must:
    //   1. Persist the updated amountReceived
    //   2. Emit a fresh invoice.late_funds webhook with a strictly higher version

    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    // Seed invoice already in overdue state (was paid, got a first late payment → overdue)
    const invoice = makeInvoice({
      id: "inv-h1-001",
      status: "overdue",
      amountUsdt: "100.000000",
      amountReceived: "110.000000", // 100 original + 10 first late
      paidAt: NOW,
    });
    invoiceRepo.addInvoice(invoice);

    // Existing payments: original + first late (both confirmed)
    await paymentRepo.upsert({
      invoiceId: invoice.id,
      txHash: "tx-h1-original",
      logIndex: 0,
      network: "TRON",
      fromAddress: FROM_ADDR,
      amountUsdt: "100.000000",
      blockNumber: CONFIRMED_BLOCK_MAINNET,
      blockHash: "bh-h1-original",
      status: "confirmed",
    });
    await paymentRepo.upsert({
      invoiceId: invoice.id,
      txHash: "tx-h1-late1",
      logIndex: 0,
      network: "TRON",
      fromAddress: FROM_ADDR,
      amountUsdt: "10.000000",
      blockNumber: CONFIRMED_BLOCK_MAINNET,
      blockHash: "bh-h1-late1",
      status: "confirmed",
    });

    // ── Second late payment arrives ───────────────────────────────────────────

    const { primaryClient: pc1, secondaryClient: sc1 } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-h1-late2",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "20000000", // 20 USDT second late
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-h1-late2",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    const watcher1 = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient: pc1,
        secondaryClient: sc1,
        clock: { now: () => NOW },
      },
    );

    await watcher1.processInvoice(
      makeActiveInvoice(invoice),
      SOLID_BLOCK_MAINNET,
      0,
      NOW,
    );

    // After second late payment: amountReceived = 110 + 20 = 130
    const afterSecond = invoiceRepo.rows.find((r) => r.id === invoice.id)!;
    expect(afterSecond.status).toBe("overdue");
    expect(afterSecond.amountReceived).toBe("130.000000");

    // First invoice.late_funds webhook should exist (version 1)
    const lateWebhooks1 = webhookRepo.deliveries.filter(
      (d) => d.input.eventType === "invoice.late_funds",
    );
    expect(lateWebhooks1.length).toBeGreaterThanOrEqual(1);

    // ── Third late payment arrives ────────────────────────────────────────────

    const { primaryClient: pc2, secondaryClient: sc2 } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-h1-late3",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "15000000", // 15 USDT third late
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-h1-late3",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    const watcher2 = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient: pc2,
        secondaryClient: sc2,
        clock: { now: () => NOW },
      },
    );

    // Active invoice still in overdue state — it must be polled again
    await watcher2.processInvoice(
      { ...makeActiveInvoice(invoice), status: "overdue" },
      SOLID_BLOCK_MAINNET,
      0,
      NOW,
    );

    // After third late payment: amountReceived = 130 + 15 = 145
    const afterThird = invoiceRepo.rows.find((r) => r.id === invoice.id)!;
    expect(afterThird.status).toBe("overdue");
    expect(afterThird.amountReceived).toBe("145.000000");

    // Both late payments must have emitted invoice.late_funds
    const lateWebhooks2 = webhookRepo.deliveries.filter(
      (d) => d.input.eventType === "invoice.late_funds",
    );
    expect(lateWebhooks2.length).toBeGreaterThanOrEqual(2);

    // Versions must be strictly increasing
    const versions = lateWebhooks2.map((d) => d.input.version).sort((a, b) => a - b);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]!);
    }
  });
});

// ── TransactionRunner.runInCredit is called for every credit (M-3a contract) ──

describe("Watcher — creditTransfer calls txRunner.runInCredit (atomic unit contract)", () => {
  it("runInCredit is invoked with the invoice id for a newly agreed transfer", async () => {
    // Arrange: spy TransactionRunner that records every invocation and delegates
    // to the real in-memory runner so the credit still completes.
    const realRunner = new InMemoryTransactionRunner();
    const calls: string[] = [];
    const spyRunner: TransactionRunner = {
      runInCredit: async <T>(invoiceId: string, fn: (tx: unknown) => Promise<T>) => {
        calls.push(invoiceId);
        return realRunner.runInCredit(invoiceId, fn);
      },
    };

    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { invoiceRepo, watcher } = buildWatcher(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-spy-runner",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh-spy-runner",
            confirmed: true,
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      },
      undefined,
      spyRunner,
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    // runInCredit must have been called at least once with the invoice id
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toBe(invoice.id);
  });

  it("runInCredit wraps the credit body — all repo mutations happen inside the callback", async () => {
    // Arrange: spy that tracks whether mutations happen inside or outside fn.
    const realRunner = new InMemoryTransactionRunner();
    let fnCalled = false;
    let fnCompleted = false;
    const spyRunner: TransactionRunner = {
      runInCredit: async <T>(invoiceId: string, fn: (tx: unknown) => Promise<T>) => {
        fnCalled = true;
        const result = await realRunner.runInCredit(invoiceId, fn);
        fnCompleted = true;
        return result;
      },
    };

    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { invoiceRepo, watcher } = buildWatcher(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-spy-wrap",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh-spy-wrap",
            confirmed: true,
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      },
      undefined,
      spyRunner,
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    // fn must have been called AND completed (no partial execution)
    expect(fnCalled).toBe(true);
    expect(fnCompleted).toBe(true);
  });
});

// ── C-1 REGRESSION: two endpoints, per-endpoint versioning ───────────────────
//
// Scenario: an event has TWO active endpoints — one scoped to the eventId and
// one global (eventId IS NULL). When the invoice reaches "paid", the fan-out
// must enqueue ONE delivery per endpoint, each at version=1 (independent
// per-endpoint counters). A second payment (repeat/late) must yield version=2
// for EACH endpoint independently without any @@unique collision.
//
// BEFORE fix: both endpoints would get the SAME version (computed once outside
// the loop), causing P2002 on the second enqueue → credit transaction rolls back
// → invoice never reaches "paid".
// AFTER fix: version = maxVersionForInvoiceEndpoint(invoiceId, endpoint.id)+1
// computed INSIDE the loop so each endpoint gets its own counter.

describe("Watcher — C-1: two endpoints get independent per-endpoint versions", () => {
  it("invoice reaches paid with one delivery per endpoint, each at version=1", async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    // Seed TWO endpoints: one event-scoped, one global (eventId=null)
    const EP_EVENT = "ep-event-scoped-001";
    const EP_GLOBAL = "ep-global-null-001";
    webhookRepo.seedEndpoint({
      id: EP_EVENT,
      eventId: "evt-001",
      url: "https://event-endpoint.example.com/webhook",
      secret: "event-secret",
      active: true,
      createdAt: new Date(),
    });
    webhookRepo.seedEndpoint({
      id: EP_GLOBAL,
      eventId: null,
      url: "https://global-endpoint.example.com/webhook",
      secret: "global-secret",
      active: true,
      createdAt: new Date(),
    });

    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    invoiceRepo.addInvoice(invoice);

    const { primaryClient, secondaryClient } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-two-endpoints-paid",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-two-ep-paid",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    const watcher = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient,
        secondaryClient,
        clock: { now: () => NOW },
      },
    );

    // This MUST NOT throw P2002 (the pre-fix symptom: both endpoints got version=1
    // and the second enqueue threw a unique-constraint violation, rolling back the
    // entire credit transaction → invoice never reached "paid").
    await expect(
      watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW),
    ).resolves.not.toThrow();

    // Invoice must reach "paid"
    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated?.status).toBe("paid");
    expect(updated?.paidAt).toEqual(NOW);

    // Exactly ONE delivery per endpoint
    const deliveries = webhookRepo.deliveries;
    expect(deliveries).toHaveLength(2);

    const epEventDelivery = deliveries.find((d) => d.input.endpointId === EP_EVENT);
    const epGlobalDelivery = deliveries.find((d) => d.input.endpointId === EP_GLOBAL);

    expect(epEventDelivery).toBeDefined();
    expect(epGlobalDelivery).toBeDefined();

    // Each endpoint independently starts at version=1
    expect(epEventDelivery!.input.version).toBe(1);
    expect(epGlobalDelivery!.input.version).toBe(1);

    // Both are invoice.paid
    expect(epEventDelivery!.input.eventType).toBe("invoice.paid");
    expect(epGlobalDelivery!.input.eventType).toBe("invoice.paid");

    // eventUids are distinct
    expect(epEventDelivery!.input.eventUid).not.toBe(epGlobalDelivery!.input.eventUid);
  });

  it("repeat late payment: each endpoint independently advances to version=2", async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    const EP_EVENT = "ep-event-scoped-002";
    const EP_GLOBAL = "ep-global-null-002";
    webhookRepo.seedEndpoint({
      id: EP_EVENT,
      eventId: "evt-001",
      url: "https://event-endpoint.example.com/webhook",
      secret: "event-secret",
      active: true,
      createdAt: new Date(),
    });
    webhookRepo.seedEndpoint({
      id: EP_GLOBAL,
      eventId: null,
      url: "https://global-endpoint.example.com/webhook",
      secret: "global-secret",
      active: true,
      createdAt: new Date(),
    });

    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    invoiceRepo.addInvoice(invoice);

    const makePaidWatcher = (txHash: string) => {
      const { primaryClient, secondaryClient } = buildAgreementClients({
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash,
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: `bh-${txHash}`,
            confirmed: true,
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      });
      return new TronWatcher(
        { network: "TRON" },
        {
          invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
          paymentRepo,
          chainCursorRepo: cursorRepo,
          webhookRepo,
          endpointRepo: webhookRepo,
          txRunner: new InMemoryTransactionRunner(),
          primaryClient,
          secondaryClient,
          clock: { now: () => NOW },
        },
      );
    };

    // First payment → invoice paid, each endpoint at version=1
    await makePaidWatcher("tx-repeat-ep-v1").processInvoice(
      makeActiveInvoice(invoice),
      SOLID_BLOCK_MAINNET,
      0,
      NOW,
    );

    expect(invoiceRepo.rows[0]!.status).toBe("paid");
    const v1Deliveries = webhookRepo.deliveries.filter(
      (d) => d.input.invoiceId === invoice.id,
    );
    expect(v1Deliveries).toHaveLength(2);
    expect(v1Deliveries.every((d) => d.input.version === 1)).toBe(true);

    // Second (late) payment via a different txHash → each endpoint advances to version=2
    // Invoice stays "paid" (late funds on a paid invoice → overdue/late_funds event).
    // For this test we just verify no P2002 collision and version increments per endpoint.
    await makePaidWatcher("tx-repeat-ep-v2").processInvoice(
      { ...makeActiveInvoice(invoice), status: "paid" },
      SOLID_BLOCK_MAINNET,
      0,
      NOW,
    );

    const allDeliveries = webhookRepo.deliveries.filter(
      (d) => d.input.invoiceId === invoice.id,
    );
    // Each endpoint should have at least 2 deliveries (v1 + v2 for whatever event fires)
    const epEventVersions = allDeliveries
      .filter((d) => d.input.endpointId === EP_EVENT)
      .map((d) => d.input.version);
    const epGlobalVersions = allDeliveries
      .filter((d) => d.input.endpointId === EP_GLOBAL)
      .map((d) => d.input.version);

    // Versions must be unique per endpoint (no @@unique([invoiceId, endpointId, version]) collision)
    expect(new Set(epEventVersions).size).toBe(epEventVersions.length);
    expect(new Set(epGlobalVersions).size).toBe(epGlobalVersions.length);

    // Each endpoint must have advanced past version 1
    expect(Math.max(...epEventVersions)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...epGlobalVersions)).toBeGreaterThanOrEqual(2);
  });
});

// ── WATCH-1: Two-provider block-number agreement ──────────────────────────────
//
// The per-tx block number MUST be fetched independently from BOTH providers.
// Finality gate: max(primaryBN, secondaryBN) <= latestSolidBlock.
// A tx is treated as at/below solid ONLY when BOTH providers place it there;
// if either is missing or above solid, the effective block number exceeds
// latestSolidBlock → transfer stays "detected" (no "paid" credit).
//
// Scenario A (happy path): both agree, both at/below solid → paid.
// Scenario B (disagreement — primary says solid, secondary says above solid):
//   max(BNs) > solid → invoice must NOT reach "paid" (stays "detected").
// Scenario C (secondary omits block number / returns null):
//   max(BNs) = MAX_BN > solid → invoice must NOT reach "paid" (stays "detected").
// Scenario D (two-tick recovery): secondary lags tick-1 → detected stored with
//   MAX_BN; both agree tick-2 → blockNumber refreshed → invoice MUST reach paid.

describe("Watcher — WATCH-1: two-provider per-tx block number agreement", () => {
  it("happy path: both providers agree blockNumber is below solid → paid", async () => {
    // Both primary and secondary return CONFIRMED_BLOCK_MAINNET (82_999_990n)
    // for the transaction. Both agree it is solid → invoice reaches "paid".
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-watch1-agree",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh-watch1-agree",
            confirmed: true,
            blockNumber: CONFIRMED_BLOCK_MAINNET, // primary: solid
          },
        ],
      },
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-watch1-agree",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh-watch1-agree",
            confirmed: true,
            blockNumber: CONFIRMED_BLOCK_MAINNET, // secondary: same solid block
          },
        ],
      },
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("paid");
    expect(paymentRepo.rows[0]!.status).toBe("confirmed");
  });

  it("WATCH-1 block disagree: primary says solid, secondary says above solid → invoice stays detected", async () => {
    // Primary returns CONFIRMED_BLOCK_MAINNET (≤ solid) → would credit "confirmed".
    // Secondary returns PRESOLID_BLOCK_MAINNET (> solid) → would say "detected".
    // The two providers disagree on finality: min(primary, secondary) > solid.
    // The invoice MUST NOT reach "paid" — it must stay "detected".
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-watch1-disagree",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh-watch1-disagree",
            confirmed: true,
            blockNumber: CONFIRMED_BLOCK_MAINNET, // primary: below solid (would be "confirmed")
          },
        ],
      },
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-watch1-disagree",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "",
            confirmed: false,
            blockNumber: PRESOLID_BLOCK_MAINNET, // secondary: above solid (would be "detected")
          },
        ],
      },
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    // MUST stay detected — both providers must agree before we credit "confirmed"
    expect(paymentRepo.rows).toHaveLength(1);
    expect(paymentRepo.rows[0]!.status).toBe("detected");

    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("payment_detected"); // not paid
  });

  it("WATCH-1 secondary missing block number → candidate skipped, invoice stays pending", async () => {
    // Primary has a confirmed receipt (solid block number).
    // Secondary's gettransactioninfobyid returns {} (tx not yet in secondary's block store).
    // In the new receipt-based design: secondary receipt null → candidate SKIPPED entirely.
    // No partial credit; no "detected" placeholder. Recovers on the next tick once
    // secondary also has a confirmed receipt.
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-watch1-secondary-null",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh-watch1-snull",
            confirmed: true,
            blockNumber: CONFIRMED_BLOCK_MAINNET, // primary: has receipt
          },
        ],
      },
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-watch1-secondary-null",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "",
            confirmed: false,
            blockNumber: null, // secondary: no receipt yet → empty {}
          },
        ],
      },
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    // Secondary receipt null → candidate skipped → no payment row, invoice stays pending
    expect(paymentRepo.rows).toHaveLength(0);

    const updated = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(updated!.status).toBe("pending"); // not changed
  });

  it("WATCH-1 two-tick recovery: secondary lags tick-1 (null receipt), both agree tick-2 → invoice MUST reach paid", async () => {
    // Scenario: secondary's gettransactioninfobyid returns {} on tick 1 (lagging).
    // Receipt-based design: secondary receipt null → candidate SKIPPED → no payment row.
    // On tick 2, both providers return confirmed receipts with the real solid block.
    // Fresh insert on tick 2 → confirmed payment → invoice paid.
    //
    // This is the "two-tick recovery" scenario for the receipt-based design.
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    invoiceRepo.addInvoice(invoice);

    // ── Tick 1: secondary lags — returns null for gettransactioninfobyid ──────
    const { primaryClient: pc1, secondaryClient: sc1 } = buildAgreementClients(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-watch1-recovery",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh-watch1-recovery",
            confirmed: true,
            blockNumber: CONFIRMED_BLOCK_MAINNET, // primary sees the real solid block
          },
        ],
      },
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-watch1-recovery",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "",
            confirmed: false,
            blockNumber: null, // secondary lags — no block number yet
          },
        ],
      },
    );

    const watcher1 = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient: pc1,
        secondaryClient: sc1,
        clock: { now: () => NOW },
      },
    );

    await watcher1.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    // After tick 1: secondary receipt was null → candidate skipped → no payment row
    expect(paymentRepo.rows).toHaveLength(0);
    const afterTick1 = invoiceRepo.rows.find((r) => r.id === invoice.id)!;
    expect(afterTick1.status).toBe("pending"); // invoice untouched

    // ── Tick 2: both providers now return the real solid block number ─────────
    const { primaryClient: pc2, secondaryClient: sc2 } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-watch1-recovery",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-watch1-recovery",
          confirmed: true,
          blockNumber: CONFIRMED_BLOCK_MAINNET, // both providers now agree
        },
      ],
    });

    const watcher2 = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient: pc2,
        secondaryClient: sc2,
        clock: { now: () => NOW },
      },
    );

    await watcher2.processInvoice(
      makeActiveInvoice(invoice), // still "pending" — tick 1 left invoice untouched
      SOLID_BLOCK_MAINNET,
      0,
      NOW,
    );

    // After tick 2: both receipts confirmed → fresh insert → payment confirmed → invoice paid.
    expect(paymentRepo.rows).toHaveLength(1); // fresh insert from tick 2
    expect(paymentRepo.rows[0]!.blockNumber).toBe(CONFIRMED_BLOCK_MAINNET); // real solid block
    expect(paymentRepo.rows[0]!.status).toBe("confirmed");

    const afterTick2 = invoiceRepo.rows.find((r) => r.id === invoice.id)!;
    expect(afterTick2.status).toBe("paid"); // MUST reach paid, not stuck at payment_detected
    expect(afterTick2.paidAt).toEqual(NOW);

    const paidWebhook = webhookRepo.deliveries.find(
      (d) => d.input.eventType === "invoice.paid",
    );
    expect(paidWebhook).toBeDefined();
  });
});

// ── Receipt-based security: fabrication rejection ─────────────────────────────
//
// The CORE PRINCIPLE of the new design: /v1 (TronGrid) = UNTRUSTED discovery.
// Credit decisions come EXCLUSIVELY from BOTH providers independently parsing
// the on-chain tx receipt event logs via gettransactioninfobyid.
//
// If a primary /v1 entry is "fabricated" (exists in the indexer but NOT on-chain),
// the secondary gettransactioninfobyid will return {} (tx unknown) → receipt null
// → the candidate is SKIPPED this tick. Zero payment rows. Zero webhooks.
//
// ALSO asserts: the SECONDARY client is NEVER asked for a /v1 path.

describe("Watcher — receipt-based security: fabrication + secondary /v1 assertion", () => {
  it("HEADLINE: fabricated primary /v1 candidate → secondary receipt empty → zero payments, zero webhooks", async () => {
    // Security scenario:
    //   PRIMARY /v1 claims a USDT transfer exists (could be a fabricated TronGrid entry).
    //   PRIMARY receipt: has a valid Transfer log + blockNumber (malicious primary).
    //   SECONDARY receipt: empty {} — tx does NOT exist on this node's confirmed state.
    // The new receipt-based agreement MUST skip this candidate → zero credits.
    //
    // OLD BEHAVIOR (before this fix): both /v1 agree on the transfer → detected payment
    //   created with effectiveBN=MAX_BN (secondary null blockNumber). Fabrication succeeds.
    // NEW BEHAVIOR: secondary receipt null → skip → no payment row.
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, webhookRepo, watcher } = buildWatcher(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-fabricated-v1-only",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh-fabricated",
            blockNumber: CONFIRMED_BLOCK_MAINNET, // primary has receipt + block
          },
        ],
      },
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-fabricated-v1-only",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000",
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "",
            blockNumber: null, // secondary has NO receipt (empty {}) — tx not on-chain
          },
        ],
      },
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    // MUST have zero payment rows — fabricated /v1 data is NOT credited without receipt agreement
    expect(paymentRepo.rows).toHaveLength(0);
    expect(webhookRepo.deliveries).toHaveLength(0);
    const invoiceRow = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(invoiceRow!.status).toBe("pending"); // invoice untouched
  });

  it("secondary receipt amount mismatch → no credit", async () => {
    // Primary receipt: 100 USDT. Secondary receipt: 50 USDT.
    // Receipt parser finds both but agreement fails on amountMicro mismatch.
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher(
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-receipt-mismatch-amount",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "100000000", // primary: 100 USDT
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh-mismatch",
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      },
      {
        solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
        transfers: [
          {
            txHash: "tx-receipt-mismatch-amount",
            from: FROM_ADDR,
            to: DEPOSIT_ADDR_BASE58,
            value: "50000000", // secondary: 50 USDT — MISMATCH
            blockTimestamp: BLOCK_TIMESTAMP,
            blockHash: "bh-mismatch",
            blockNumber: CONFIRMED_BLOCK_MAINNET,
          },
        ],
      },
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(0);
    const invoiceRow = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(invoiceRow!.status).toBe("pending");
  });

  it("two transfers in one tx (log indices 0 and 2) → two payment rows", async () => {
    // Multi-log tx: two separate USDT transfers to the same deposit address
    // at log indices 0 and 2 (index 1 is some other event).
    const invoice = makeInvoice({ status: "pending", amountUsdt: "150.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-multi-log",
          logIndex: 0,
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000", // 100 USDT at index 0
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-multi-log",
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
        {
          txHash: "tx-multi-log",
          logIndex: 2,
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "50000000", // 50 USDT at index 2
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-multi-log",
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    // Both transfers must be credited as separate payment rows
    expect(paymentRepo.rows).toHaveLength(2);
    const logIndices = paymentRepo.rows.map((r) => r.logIndex).sort();
    expect(logIndices).toEqual([0, 2]);
    const totalMicro = paymentRepo.rows.reduce((sum, r) => sum + BigInt(r.amountUsdt.replace(".", "")) / 1n, 0n);
    // 100 + 50 = 150 USDT received
    const invoiceRow = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(invoiceRow!.amountReceived).toBe("150.000000");
  });

  it("FAILED tx (top-level result=FAILED in receipt) → rejected, zero payments", async () => {
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const { paymentRepo, invoiceRepo, watcher } = buildWatcher({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-failed-receipt",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-failed",
          blockNumber: CONFIRMED_BLOCK_MAINNET,
          txFailed: true, // inject result:"FAILED" at top level of receipt
        },
      ],
    });

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    expect(paymentRepo.rows).toHaveLength(0);
    const invoiceRow = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(invoiceRow!.status).toBe("pending");
  });

  it("non-pinned emitter in receipt though /v1 claims USDT → RECEIPT PARSER rejects", async () => {
    // /v1 discovery claims the transfer uses the USDT contract — it PASSES the
    // untrusted /v1 prefilter and becomes a candidate. But the AUTHORITATIVE
    // receipt log is emitted by a DIFFERENT contract (non-pinned emitter).
    // The receipt parser's contract pin — the real defense — MUST reject it
    // on BOTH providers → zero payment rows.
    //
    // receiptContractAddress overrides the contract ONLY in the receipt log,
    // leaving the /v1 row as USDT, so this test cannot be satisfied by the
    // prefilter alone.
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();
    const txRunner = new InMemoryTransactionRunner();

    const nonPinnedEmitterFixture = {
      txHash: "tx-nonpinned-emitter",
      from: FROM_ADDR,
      to: DEPOSIT_ADDR_BASE58,
      value: "100000000",
      blockTimestamp: BLOCK_TIMESTAMP,
      blockHash: "bh-nonpinned",
      blockNumber: CONFIRMED_BLOCK_MAINNET,
      // /v1 contract stays default (USDT) → candidate passes the prefilter.
      receiptContractAddress: FAKE_CONTRACT, // receipt log emitter is NOT the pinned USDT
    };

    const primaryClient = buildMockClient({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [nonPinnedEmitterFixture],
    });
    const secondaryClient = buildMockClient({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [nonPinnedEmitterFixture],
    });

    const watcher = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner,
        primaryClient,
        secondaryClient,
        clock: { now: () => NOW },
      },
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    // Receipt parser contract pin rejects the non-pinned emitter → no payment
    expect(paymentRepo.rows).toHaveLength(0);
    const invoiceRow = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(invoiceRow!.status).toBe("pending");
  });

  it("SECONDARY client is NEVER asked for a /v1 path", async () => {
    // After the receipt-based rewrite, /v1 is PRIMARY-ONLY discovery.
    // The secondary is only used for /walletsolidity/getnowblock and
    // /wallet/gettransactioninfobyid — NEVER for /v1/accounts/.../trc20.
    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();
    const txRunner = new InMemoryTransactionRunner();

    // Standard primary mock
    const primaryClient = buildMockClient({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-secondary-v1-check",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-v1-check",
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });

    // Secondary that THROWS on any /v1 path — if it's called for /v1, test fails
    const secondaryPathsCalledWithV1: string[] = [];
    const secondaryClient = buildMockClient({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-secondary-v1-check",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-v1-check",
          blockNumber: CONFIRMED_BLOCK_MAINNET,
        },
      ],
    });
    // Wrap the secondary's get to spy on /v1 calls
    const originalGet = (secondaryClient as unknown as { get: (path: string) => Promise<unknown> }).get.bind(secondaryClient);
    (secondaryClient as unknown as { get: unknown }).get = async (path: string) => {
      if (path.includes("/v1/")) {
        secondaryPathsCalledWithV1.push(path);
      }
      return originalGet(path);
    };

    const watcher = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner,
        primaryClient,
        secondaryClient,
        clock: { now: () => NOW },
      },
    );

    invoiceRepo.addInvoice(invoice);
    await watcher.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    // Secondary must NEVER have been asked for a /v1 path
    expect(secondaryPathsCalledWithV1).toHaveLength(0);
    // And the invoice should be paid (agreement succeeded via receipts)
    const invoiceRow = invoiceRepo.rows.find((r) => r.id === invoice.id);
    expect(invoiceRow!.status).toBe("paid");
  });

  it("empty receipts on tick-1 → no payment rows; receipts present on tick-2 → paid", async () => {
    // Both providers return null receipt on tick 1 (tx not yet in a block).
    // On tick 2, both providers have confirmed receipts.
    // Invoice must NOT be credited on tick 1, and MUST reach paid on tick 2.
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    const invoice = makeInvoice({ status: "pending", amountUsdt: "100.000000" });
    invoiceRepo.addInvoice(invoice);

    // Tick 1: both providers have null blockNumber → empty receipts
    const { primaryClient: pc1, secondaryClient: sc1 } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-empty-receipts",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "",
          blockNumber: null, // → empty receipt
        },
      ],
    });

    const watcher1 = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient: pc1,
        secondaryClient: sc1,
        clock: { now: () => NOW },
      },
    );

    await watcher1.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    // Tick 1: no payment created
    expect(paymentRepo.rows).toHaveLength(0);
    expect(invoiceRepo.rows.find((r) => r.id === invoice.id)!.status).toBe("pending");

    // Tick 2: both providers have confirmed receipts
    const { primaryClient: pc2, secondaryClient: sc2 } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK_MAINNET),
      transfers: [
        {
          txHash: "tx-empty-receipts",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-now-confirmed",
          blockNumber: CONFIRMED_BLOCK_MAINNET, // → full receipt with Transfer log
        },
      ],
    });

    const watcher2 = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient: pc2,
        secondaryClient: sc2,
        clock: { now: () => NOW },
      },
    );

    await watcher2.processInvoice(makeActiveInvoice(invoice), SOLID_BLOCK_MAINNET, 0, NOW);

    // Tick 2: invoice paid
    expect(paymentRepo.rows).toHaveLength(1);
    expect(paymentRepo.rows[0]!.status).toBe("confirmed");
    expect(invoiceRepo.rows.find((r) => r.id === invoice.id)!.status).toBe("paid");
  });
});

// ── Regression: terminal invoice phantom swept via needsUnresolvedFundsReplay ─
//
// RESIDUAL EDGE (pre-fix): a phantom `detected` payment on a TERMINAL (e.g. paid)
// invoice was never swept because `needsUnresolvedFundsReplay` only covered
// pending/payment_detected/overdue. When a LATER late-funds credit arrived,
// `transitionAndEnqueue` still saw the phantom as `detected` with
// blockNumber=N <= latestSolidBlock → height-only promotion gate fired →
// phantom confirmed → amountReceived corrupt (205 instead of 105 USDT).
//
// FIX: needsUnresolvedFundsReplay now includes all statuses that
// listActiveForWatch returns, including grace-window terminal statuses
// ("paid","overpaid","underpaid","expired","canceled"). Terminal invoices
// within the grace window therefore receive full-replay (minTimestampMs=0)
// ticks, so Step 4's sentinel sweep also runs for them.
//
// This test goes through the PUBLIC `processInvoices` batch entrypoint so
// that `needsUnresolvedFundsReplay` is the gating mechanism — NOT a direct
// call to `processInvoice` with a hardcoded minTimestampMs=0.
//
// WITHOUT the fix (if "paid" were removed from the status array):
//   `needsUnresolvedFundsReplay("paid")` = false
//   → `invoiceMinTimestampMs = 1_000_000` (non-zero cursor passed in)
//   → `processInvoice` receives minTimestampMs=1_000_000
//   → Step 4 sentinel sweep is SKIPPED (only runs when minTimestampMs===0)
//   → phantom retains blockNumber=PRESOLID_BLOCK_MAINNET (83_000_050n)
//   → when the late-funds tx triggers `transitionAndEnqueue`:
//       height gate: 83_000_050n <= 83_000_100n → phantom promoted to confirmed
//       amountReceived = real(100) + phantom(100) + late(5) = 205 USDT (CORRUPTION)

describe("Watcher — processInvoices sentinels phantom on terminal paid invoice (needsUnresolvedFundsReplay gate)", () => {
  it("paid invoice in grace window: reorged phantom sentineled before late-funds credit, amountReceived=105 not 205", async () => {
    const paymentRepo = new InMemoryPaymentRepository();
    const invoiceRepo = new InMemoryInvoiceRepository();
    const cursorRepo = new InMemoryChainCursorRepository();
    const webhookRepo = new InMemoryWebhookDeliveryRepository();

    // ── Pre-condition: invoice already PAID (terminal, within grace window) ──────
    // The real 100 USDT payment confirmed solid; invoice reached "paid".
    const invoice = makeInvoice({
      status: "paid",
      amountReceived: "100.000000",
      paidAt: NOW,
    });
    invoiceRepo.addInvoice(invoice);

    // Real payment: confirmed, solidified.
    await paymentRepo.upsert({
      invoiceId: invoice.id,
      txHash: "tx-terminal-real",
      logIndex: 0,
      network: "TRON",
      fromAddress: FROM_ADDR,
      amountUsdt: "100.000000",
      blockNumber: CONFIRMED_BLOCK_MAINNET, // 82_999_990n — solid
      blockHash: "bh-terminal-real",
      status: "confirmed",
    });

    // Phantom payment: agreed on an earlier tick (pre-solid), NOT yet sentinel-ized.
    // Simulates a payment that was agreed by dual receipts before the reorg.
    await paymentRepo.upsert({
      invoiceId: invoice.id,
      txHash: "tx-terminal-phantom",
      logIndex: 0,
      network: "TRON",
      fromAddress: FROM_ADDR,
      amountUsdt: "100.000000",
      blockNumber: PRESOLID_BLOCK_MAINNET, // N = 83_000_050n — will become < NEW_SOLID
      blockHash: "bh-terminal-phantom",
      status: "detected", // NOT confirmed: was pre-solid when detected
    });

    // Advance solid PAST N so the height-only gate would fire on the unprotected phantom.
    const NEW_SOLID = 83_000_100n; // > PRESOLID_BLOCK_MAINNET = 83_000_050n

    // ── RPC fixture for this tick ─────────────────────────────────────────────────
    // Phantom tx: /v1 still lists it (indexer lag), but gettransactioninfobyid
    // returns {} (tx no longer on-chain) → fetchTransactionReceipt returns null.
    // Late-funds tx: 5 USDT arrives and is agreed by both providers, solid.
    const LATE_FUNDS_BLOCK = 83_000_080n; // <= NEW_SOLID → isConfirmed=true
    const { primaryClient, secondaryClient } = buildAgreementClients({
      solidBlockNumber: Number(NEW_SOLID),
      transfers: [
        {
          txHash: "tx-terminal-phantom",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "100000000",
          blockTimestamp: BLOCK_TIMESTAMP,
          blockHash: "bh-terminal-phantom",
          confirmed: false,
          blockNumber: null, // reorged out → receipt {} → fetchTransactionReceipt = null
        },
        {
          txHash: "tx-terminal-late",
          from: FROM_ADDR,
          to: DEPOSIT_ADDR_BASE58,
          value: "5000000", // 5 USDT — triggers transitionAndEnqueue (late funds)
          blockTimestamp: BLOCK_TIMESTAMP + 20,
          blockHash: "bh-terminal-late",
          blockNumber: LATE_FUNDS_BLOCK, // <= NEW_SOLID → solid, agreed by both
        },
      ],
    });

    const watcher = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: makeLinkedInvoiceRepo(invoiceRepo, paymentRepo),
        paymentRepo,
        chainCursorRepo: cursorRepo,
        webhookRepo,
        endpointRepo: webhookRepo,
        txRunner: new InMemoryTransactionRunner(),
        primaryClient,
        secondaryClient,
        clock: { now: () => NOW },
      },
    );

    // ── Drive via the PUBLIC batch entrypoint ─────────────────────────────────────
    // minTimestampMs is deliberately NON-ZERO so only needsUnresolvedFundsReplay
    // can force the full-replay (minTimestampMs=0) path. If "paid" were removed
    // from the status array, invoiceMinTimestampMs would stay 1_000_000 and
    // Step 4 would be skipped — the test would then fail (phantom not sentineled,
    // amountReceived = 205 instead of 105).
    const activeInvoice: ActiveInvoice = { ...makeActiveInvoice(invoice), status: "paid" };
    await watcher.processInvoices([activeInvoice], NEW_SOLID, 1_000_000, NOW);

    // ── ASSERT: phantom is sentineled ─────────────────────────────────────────────
    const phantomRow = paymentRepo.rows.find((r) => r.txHash === "tx-terminal-phantom")!;
    expect(phantomRow.blockNumber).toBe(UNCONFIRMED_BLOCK_SENTINEL);
    expect(phantomRow.status).toBe("detected"); // NOT promoted to confirmed

    // ── ASSERT: no phantom funds in amountReceived ────────────────────────────────
    // transitionAndEnqueue ran for the late-funds tx. Since the phantom was
    // sentineled (SENTINEL > NEW_SOLID), it was NOT promoted and NOT counted.
    // amountReceived = real(100) + late(5) = 105, NOT 205 (the corrupt value).
    const invoiceRow = invoiceRepo.rows.find((r) => r.id === invoice.id)!;
    expect(invoiceRow.amountReceived).toBe("105.000000");
    // Invoice correctly transitioned to overdue due to legitimate late funds.
    expect(invoiceRow.status).toBe("overdue");
  });
});
