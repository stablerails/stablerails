/**
 * End-to-end integration test: full invoice pipeline (offline, in-memory).
 *
 * Wires the REAL modules together:
 *   createInvoice (core) → TronWatcher.processInvoice (workers, mocked RPC)
 *   → invoice transitions pending → payment_detected → paid
 *   → WebhookDelivery row enqueued with a REAL endpoint.id (FK-safe)
 *   → drainPending delivers via mocked fetch
 *   → HMAC-signed payload verified by receiver
 *
 * Also covers the late-funds path:
 *   terminal invoice + new funds → overdue + invoice.late_funds webhook
 *
 * FK-enforcement tests:
 *   - enqueue with unregistered endpointId → throws (FK violation)
 *   - real endpoint registered via endpointRepo → enqueue succeeds
 *
 * All repos are in-memory. No DB, no network.
 * Block numbers are MAINNET-SCALE (solid ≈ 83_000_000n) per M-1 fix.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createInvoice } from "../../src/core/invoices.js";
import { TronWatcher } from "../../src/workers/watcher.js";
import { drainPending } from "../../src/workers/webhookDelivery.js";
import { InMemoryWebhookDeliveryRepo } from "../../src/workers/db/inMemoryWebhookDeliveryRepo.js";
import { verify as verifyHmac } from "../../src/lib/hmac.js";
import {
  InMemoryInvoiceRepository,
  InMemoryPaymentRepository,
  InMemoryChainCursorRepository,
  makeLinkedInvoiceRepo,
  InMemoryTransactionRunner,
} from "../../src/workers/__tests__/mocks.js";
import { buildAgreementClients } from "../../src/workers/__tests__/rpcFixtures.js";
import type { EventRow } from "../../src/core/ports.js";
import type { WebhookEndpointRow } from "../../src/workers/db/WebhookDeliveryRepository.js";
import { pauseArea, resumeArea, resetAll } from "../../src/server/killswitch.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Mainnet-scale solid block (real Tron mainnet ~June 2025). */
const SOLID_BLOCK = 83_000_000n;
/** Block for a confirmed transfer — 10 blocks below solid. */
const CONFIRMED_BLOCK = 82_999_990n;

const DEPOSIT_ADDR = "TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy";
const FROM_ADDR    = "THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC";
const XPUB_ACCOUNT = "xpubtest_mock_account";
const WEBHOOK_SECRET = "test-e2e-webhook-secret-abc123";
const NOW = new Date("2025-06-01T12:00:00Z");

/** Real WebhookEndpoint id used across happy-path tests. */
const REAL_ENDPOINT_ID = "ep-real-cuid-001";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(): EventRow {
  return {
    id: "evt-e2e-001",
    name: "E2E Test Event",
    status: "active",
    mainWalletAddress: DEPOSIT_ADDR,
    derivationAccount: 0,
    xpubAccount: XPUB_ACCOUNT,
    nextInvoiceIndex: 0,
    createdAt: NOW,
  };
}

/** Build a real endpoint record registered against evt-e2e-001. */
function makeRealEndpoint(id: string = REAL_ENDPOINT_ID): WebhookEndpointRow {
  return {
    id,
    eventId: "evt-e2e-001",
    url: "https://merchant.example.com/webhook",
    secret: WEBHOOK_SECRET,
    active: true,
    createdAt: NOW,
  };
}

/** Captured POST calls: { body, headers }. */
interface CapturedRequest {
  body: string;
  headers: Record<string, string>;
}

/** Build a mocked fetch that captures requests and returns 200. */
function buildCapturingFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) {
        headers[k] = v;
      }
    }
    captured.push({ body: init?.body as string ?? "", headers });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
}

// ── In-memory event repo (simple, no Prisma) ──────────────────────────────────

class InMemoryEventRepo {
  private events = new Map<string, EventRow>();

  seed(event: EventRow): void { this.events.set(event.id, event); }
  async findById(id: string): Promise<EventRow | null> {
    return this.events.get(id) ?? null;
  }
  async insert(input: Omit<EventRow, "id" | "createdAt" | "nextInvoiceIndex">): Promise<EventRow> {
    const id = `evt-${Math.random().toString(36).slice(2, 10)}`;
    const row: EventRow = { ...input, id, nextInvoiceIndex: 0, createdAt: new Date() };
    this.events.set(id, row);
    return row;
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("E2E pipeline: createInvoice → watcher → paid → webhook delivered", () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let cursorRepo: InMemoryChainCursorRepository;
  let webhookRepo: InMemoryWebhookDeliveryRepo;
  let eventRepo: InMemoryEventRepo;
  let txRunner: InMemoryTransactionRunner;
  let watcher: TronWatcher;
  let event: EventRow;

  beforeEach(() => {
    resetAll(); // clear any kill-switch flags from previous tests

    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    cursorRepo  = new InMemoryChainCursorRepository();
    webhookRepo = new InMemoryWebhookDeliveryRepo();
    eventRepo   = new InMemoryEventRepo();
    txRunner    = new InMemoryTransactionRunner();

    event = makeEvent();
    eventRepo.seed(event);

    // Register the real endpoint BEFORE any watcher processing.
    // endpointRepo.listForEvent("evt-e2e-001") will return this endpoint
    // and the watcher will enqueue ONE delivery against its real id.
    webhookRepo.seedEndpoint(makeRealEndpoint());

    const linkedInvoiceRepo = makeLinkedInvoiceRepo(invoiceRepo, paymentRepo);

    const { primaryClient, secondaryClient } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK),
      transfers: [], // injected per-test
    });

    watcher = new TronWatcher(
      { network: "TRON", pollIntervalMs: 99_999 },
      {
        invoiceRepo: linkedInvoiceRepo,
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
  });

  // ── 1. Full happy-path: pending → payment_detected → paid → webhook delivered ─

  it("full pipeline: pending → paid → webhook POSTed with correct HMAC", async () => {
    // ── Step 1: Create invoice via real createInvoice (core) ────────────────
    const invoice = await createInvoice(
      {
        eventId: event.id,
        priceFiat: "100.00",
        fiatCurrency: "USD",
        ttlMinutes: 30,
      },
      {
        invoiceRepo,
        eventRepo: eventRepo as unknown as import("../../src/core/ports.js").EventRepository,
        deriver: { derive: (_xpub: string, _idx: number) => DEPOSIT_ADDR },
        clock: { now: () => NOW },
        rate: { microUsdtPerFiatUnit: 1_000_000n, lockedAt: NOW },
      },
    );

    expect(invoice.status).toBe("pending");
    expect(invoice.depositAddress).toBe(DEPOSIT_ADDR);
    expect(invoice.amountUsdt).toBe("100.000000");

    // ── Step 2: Build mock RPC clients with a solid transfer (confirmed block) ─
    const { primaryClient, secondaryClient } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK),
      transfers: [
        {
          txHash: "txhash_e2e_paid_001",
          logIndex: 0,
          from: FROM_ADDR,
          to: DEPOSIT_ADDR,
          value: "100000000", // 100 USDT in micro (6 decimals)
          blockTimestamp: 1_748_800_000,
          blockHash: "blockhash_e2e_001",
          blockNumber: CONFIRMED_BLOCK, // <= SOLID_BLOCK → confirmed
        },
      ],
    });

    // Rebuild watcher with real transfer fixtures
    const linkedInvoiceRepo = makeLinkedInvoiceRepo(invoiceRepo, paymentRepo);
    watcher = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: linkedInvoiceRepo,
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

    // ── Step 3: Run one poll cycle (directly call processInvoice) ────────────
    await watcher.processInvoice(
      {
        id: invoice.id,
        depositAddress: invoice.depositAddress,
        amountUsdt: invoice.amountUsdt,
        network: "TRON",
        expiresAt: invoice.expiresAt,
        status: "pending",
      },
      SOLID_BLOCK,
      0, // minTimestampMs
      NOW,
    );

    // ── Step 4: Assert invoice reached "paid" ─────────────────────────────────
    const updated = await invoiceRepo.findById(invoice.id);
    expect(updated?.status).toBe("paid");
    expect(updated?.paidAt).not.toBeNull();
    expect(updated?.amountReceived).toBe("100.000000");

    // ── Step 5: Assert payment row exists and is "confirmed" ──────────────────
    expect(paymentRepo.rows).toHaveLength(1);
    expect(paymentRepo.rows[0]!.status).toBe("confirmed");
    expect(paymentRepo.rows[0]!.txHash).toBe("txhash_e2e_paid_001");
    expect(paymentRepo.rows[0]!.blockNumber).toBe(CONFIRMED_BLOCK);

    // ── Step 6: Assert WebhookDelivery row was enqueued with REAL endpoint.id ─
    const deliveries = webhookRepo.getAllDeliveries();
    expect(deliveries.length).toBeGreaterThanOrEqual(1);

    const paidDelivery = deliveries.find((d) => d.eventType === "invoice.paid");
    expect(paidDelivery).toBeDefined();
    expect(paidDelivery!.invoiceId).toBe(invoice.id);
    // CRITICAL: endpointId must be the real registered id, NOT a fabricated string
    expect(paidDelivery!.endpointId).toBe(REAL_ENDPOINT_ID);
    expect(paidDelivery!.version).toBe(1); // first delivery → version 1
    expect(paidDelivery!.eventUid).toMatch(/^invoice\.paid:/);

    // ── Step 7: Drain pending → webhook POSTed with correct HMAC ─────────────
    const captured: CapturedRequest[] = [];
    const mockFetch = buildCapturingFetch(captured);

    await drainPending(webhookRepo, {
      batchSize: 10,
      timeoutMs: 5_000,
      resolve: async () => ["93.184.216.34"], // safe DNS
      fetchFn: mockFetch,
      now: () => NOW,
    });

    // Delivery should have been sent
    expect(captured).toHaveLength(1);
    const req = captured[0]!;

    // Verify HMAC signature (tolerance: use nowSeconds from sign header)
    const sigHeader = req.headers["X-Stablerails-Signature"] ?? req.headers["x-stablerails-signature"];
    expect(sigHeader).toBeDefined();

    // verifyHmac parses t= from header and checks MAC — pass a large tolerance
    // so the wall-clock diff between sign time and verify time doesn't matter.
    expect(() =>
      verifyHmac(req.body, sigHeader!, WEBHOOK_SECRET, 86_400),
    ).not.toThrow();

    // Verify payload structure
    const payload = JSON.parse(req.body) as {
      eventUid: string;
      eventType: string;
      version: number;
      invoiceId: string;
      status: string;
    };
    expect(payload.eventType).toBe("invoice.paid");
    expect(payload.invoiceId).toBe(invoice.id);
    expect(payload.status).toBe("paid");
    expect(payload.version).toBe(1);
    expect(payload.eventUid).toMatch(/^invoice\.paid:/);

    // Delivery row should now be "delivered"
    const deliveryRow = webhookRepo.getAllDeliveries().find(
      (d) => d.eventType === "invoice.paid",
    );
    expect(deliveryRow?.status).toBe("delivered");
  });

  // ── 2. Transition through payment_detected first (0-conf) then paid ───────────

  it("pre-solid transfer → payment_detected first; subsequent solid → paid", async () => {
    const PRE_SOLID_BLOCK = SOLID_BLOCK + 50n; // above solid → detected

    const invoice = await createInvoice(
      { eventId: event.id, priceFiat: "50.00", fiatCurrency: "USD", ttlMinutes: 30 },
      {
        invoiceRepo,
        eventRepo: eventRepo as unknown as import("../../src/core/ports.js").EventRepository,
        deriver: { derive: () => DEPOSIT_ADDR },
        clock: { now: () => NOW },
        rate: { microUsdtPerFiatUnit: 1_000_000n, lockedAt: NOW },
      },
    );

    const linkedInvoiceRepo = makeLinkedInvoiceRepo(invoiceRepo, paymentRepo);

    // Round 1: pre-solid block → payment_detected
    const { primaryClient: pc1, secondaryClient: sc1 } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK),
      transfers: [{
        txHash: "txhash_presolid_001",
        logIndex: 0,
        from: FROM_ADDR,
        to: DEPOSIT_ADDR,
        value: "50000000", // 50 USDT
        blockTimestamp: 1_748_800_000,
        blockHash: "bh_presolid",
        blockNumber: PRE_SOLID_BLOCK, // > SOLID_BLOCK → detected
      }],
    });

    const w1 = new TronWatcher(
      { network: "TRON" },
      { invoiceRepo: linkedInvoiceRepo, paymentRepo, chainCursorRepo: cursorRepo,
        webhookRepo, endpointRepo: webhookRepo,
        txRunner, primaryClient: pc1, secondaryClient: sc1, clock: { now: () => NOW } },
    );

    await w1.processInvoice(
      { id: invoice.id, depositAddress: DEPOSIT_ADDR, amountUsdt: "50.000000",
        network: "TRON", expiresAt: invoice.expiresAt, status: "pending" },
      SOLID_BLOCK, 0, NOW,
    );

    const afterDetect = await invoiceRepo.findById(invoice.id);
    expect(afterDetect?.status).toBe("payment_detected");
    expect(paymentRepo.rows[0]?.status).toBe("detected");

    // WebhookDelivery for payment_detected — must use real endpoint id
    const detectedDeliveries = webhookRepo.getAllDeliveries().filter(
      (d) => d.eventType === "invoice.payment_detected",
    );
    expect(detectedDeliveries).toHaveLength(1);
    expect(detectedDeliveries[0]!.version).toBe(1);
    expect(detectedDeliveries[0]!.endpointId).toBe(REAL_ENDPOINT_ID);

    // Round 2: same txHash, new solid block height confirms it
    const NEW_SOLID = PRE_SOLID_BLOCK + 100n; // now the tx is below solid
    const { primaryClient: pc2, secondaryClient: sc2 } = buildAgreementClients({
      solidBlockNumber: Number(NEW_SOLID),
      transfers: [{
        txHash: "txhash_presolid_001", // same hash — replay
        logIndex: 0,
        from: FROM_ADDR,
        to: DEPOSIT_ADDR,
        value: "50000000",
        blockTimestamp: 1_748_800_000,
        blockHash: "bh_presolid",
        blockNumber: PRE_SOLID_BLOCK, // now <= NEW_SOLID → confirmed
      }],
    });

    const w2 = new TronWatcher(
      { network: "TRON" },
      { invoiceRepo: linkedInvoiceRepo, paymentRepo, chainCursorRepo: cursorRepo,
        webhookRepo, endpointRepo: webhookRepo,
        txRunner, primaryClient: pc2, secondaryClient: sc2, clock: { now: () => NOW } },
    );

    await w2.processInvoice(
      { id: invoice.id, depositAddress: DEPOSIT_ADDR, amountUsdt: "50.000000",
        network: "TRON", expiresAt: invoice.expiresAt, status: "payment_detected" },
      NEW_SOLID, 0, NOW,
    );

    const afterPaid = await invoiceRepo.findById(invoice.id);
    expect(afterPaid?.status).toBe("paid");

    // Second webhook: invoice.paid, version=2
    const allDeliveries = webhookRepo.getAllDeliveries();
    const paidDelivery = allDeliveries.find((d) => d.eventType === "invoice.paid");
    expect(paidDelivery).toBeDefined();
    expect(paidDelivery!.version).toBe(2); // monotonic: 1=detected, 2=paid
    expect(paidDelivery!.endpointId).toBe(REAL_ENDPOINT_ID);
  });

  // ── 3. Late-funds path: terminal invoice + new payment → overdue ──────────────

  it("late funds path: paid invoice + new transfer → overdue + invoice.late_funds webhook", async () => {
    const invoice = await createInvoice(
      { eventId: event.id, priceFiat: "100.00", fiatCurrency: "USD", ttlMinutes: 30 },
      {
        invoiceRepo,
        eventRepo: eventRepo as unknown as import("../../src/core/ports.js").EventRepository,
        deriver: { derive: () => DEPOSIT_ADDR },
        clock: { now: () => NOW },
        rate: { microUsdtPerFiatUnit: 1_000_000n, lockedAt: NOW },
      },
    );

    const linkedInvoiceRepo = makeLinkedInvoiceRepo(invoiceRepo, paymentRepo);

    // Round 1: Pay the invoice fully
    const { primaryClient: pc1, secondaryClient: sc1 } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK),
      transfers: [{
        txHash: "txhash_initial_pay",
        logIndex: 0,
        from: FROM_ADDR,
        to: DEPOSIT_ADDR,
        value: "100000000", // 100 USDT — exact amount
        blockTimestamp: 1_748_800_000,
        blockHash: "bh_pay",
        blockNumber: CONFIRMED_BLOCK,
      }],
    });

    const w1 = new TronWatcher(
      { network: "TRON" },
      { invoiceRepo: linkedInvoiceRepo, paymentRepo, chainCursorRepo: cursorRepo,
        webhookRepo, endpointRepo: webhookRepo,
        txRunner, primaryClient: pc1, secondaryClient: sc1, clock: { now: () => NOW } },
    );

    await w1.processInvoice(
      { id: invoice.id, depositAddress: DEPOSIT_ADDR, amountUsdt: "100.000000",
        network: "TRON", expiresAt: invoice.expiresAt, status: "pending" },
      SOLID_BLOCK, 0, NOW,
    );

    const paidInvoice = await invoiceRepo.findById(invoice.id);
    expect(paidInvoice?.status).toBe("paid");

    // Round 2: Send more funds to a "paid" invoice → late_funds / overdue
    const LATE_BLOCK = SOLID_BLOCK - 1000n;
    const { primaryClient: pc2, secondaryClient: sc2 } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK),
      transfers: [{
        txHash: "txhash_late_funds",
        logIndex: 0,
        from: FROM_ADDR,
        to: DEPOSIT_ADDR,
        value: "10000000", // 10 extra USDT
        blockTimestamp: 1_748_900_000,
        blockHash: "bh_late",
        blockNumber: LATE_BLOCK,
      }],
    });

    const w2 = new TronWatcher(
      { network: "TRON" },
      { invoiceRepo: linkedInvoiceRepo, paymentRepo, chainCursorRepo: cursorRepo,
        webhookRepo, endpointRepo: webhookRepo,
        txRunner, primaryClient: pc2, secondaryClient: sc2, clock: { now: () => NOW } },
    );

    await w2.processInvoice(
      { id: invoice.id, depositAddress: DEPOSIT_ADDR, amountUsdt: "100.000000",
        network: "TRON", expiresAt: invoice.expiresAt, status: "paid" },
      SOLID_BLOCK, 0, NOW,
    );

    // Invoice persisted row must transition to overdue (never silently lost).
    const afterLate = await invoiceRepo.findById(invoice.id);
    expect(afterLate?.status).toBe("overdue");

    // Invoice should have a late_funds webhook
    const allDeliveries = webhookRepo.getAllDeliveries();
    const lateFundsDelivery = allDeliveries.find((d) => d.eventType === "invoice.late_funds");
    expect(lateFundsDelivery).toBeDefined();
  });

  // ── 4. No endpoints registered → no delivery rows enqueued (safe) ─────────────

  it("no endpoints registered for event → enqueue nothing (no fabricated ids)", async () => {
    // Use a fresh repo with NO endpoint registered
    const emptyWebhookRepo = new InMemoryWebhookDeliveryRepo();
    const linkedInvoiceRepo = makeLinkedInvoiceRepo(invoiceRepo, paymentRepo);

    const invoice = await createInvoice(
      { eventId: event.id, priceFiat: "10.00", fiatCurrency: "USD", ttlMinutes: 30 },
      {
        invoiceRepo,
        eventRepo: eventRepo as unknown as import("../../src/core/ports.js").EventRepository,
        deriver: { derive: () => DEPOSIT_ADDR },
        clock: { now: () => NOW },
        rate: { microUsdtPerFiatUnit: 1_000_000n, lockedAt: NOW },
      },
    );

    const { primaryClient, secondaryClient } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK),
      transfers: [{
        txHash: "txhash_noendpoint",
        logIndex: 0,
        from: FROM_ADDR,
        to: DEPOSIT_ADDR,
        value: "10000000",
        blockTimestamp: 1_748_800_000,
        blockHash: "bh_noep",
        blockNumber: CONFIRMED_BLOCK,
      }],
    });

    const w = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: linkedInvoiceRepo, paymentRepo, chainCursorRepo: cursorRepo,
        webhookRepo: emptyWebhookRepo, endpointRepo: emptyWebhookRepo,
        txRunner, primaryClient, secondaryClient, clock: { now: () => NOW },
      },
    );

    await w.processInvoice(
      { id: invoice.id, depositAddress: DEPOSIT_ADDR, amountUsdt: "10.000000",
        network: "TRON", expiresAt: invoice.expiresAt, status: "pending" },
      SOLID_BLOCK, 0, NOW,
    );

    // Invoice should still reach paid
    const updated = await invoiceRepo.findById(invoice.id);
    expect(updated?.status).toBe("paid");

    // But NO delivery rows should have been enqueued (zero endpoints)
    expect(emptyWebhookRepo.getAllDeliveries()).toHaveLength(0);
  });

  // ── 5. FK enforcement: enqueue with unregistered endpointId throws ─────────────

  it("FK enforcement: enqueue with unregistered endpointId throws", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    // Do NOT seed any endpoint

    await expect(
      repo.enqueue({
        endpointId: "fabricated-non-existent-id",
        eventType: "invoice.paid",
        invoiceId: "inv-test-001",
        payload: { event: "invoice.paid" },
        eventUid: "invoice.paid:inv-test-001:fake-ep:1",
        version: 1,
        nextAttemptAt: NOW,
      }),
    ).rejects.toThrow(/FK violation/i);
  });

  // ── 6. FK enforcement: enqueue with registered endpointId succeeds ─────────────

  it("FK enforcement: enqueue with real registered endpointId succeeds", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(makeRealEndpoint("ep-real-001"));

    const result = await repo.enqueue({
      endpointId: "ep-real-001",
      eventType: "invoice.paid",
      invoiceId: "inv-test-002",
      payload: { event: "invoice.paid" },
      eventUid: "invoice.paid:inv-test-002:ep-real-001:1",
      version: 1,
      nextAttemptAt: NOW,
    });

    expect(result.created).toBe(true);
    expect(repo.getAllDeliveries()).toHaveLength(1);
    expect(repo.getAllDeliveries()[0]!.endpointId).toBe("ep-real-001");
  });
});

// ── Kill-switch integration ───────────────────────────────────────────────────

describe("Kill-switch integration", () => {
  let invoiceRepo: InMemoryInvoiceRepository;
  let paymentRepo: InMemoryPaymentRepository;
  let cursorRepo: InMemoryChainCursorRepository;
  let webhookRepo: InMemoryWebhookDeliveryRepo;
  let txRunner: InMemoryTransactionRunner;
  let watcher: TronWatcher;
  let event: EventRow;

  beforeEach(() => {
    resetAll();

    invoiceRepo = new InMemoryInvoiceRepository();
    paymentRepo = new InMemoryPaymentRepository();
    cursorRepo  = new InMemoryChainCursorRepository();
    webhookRepo = new InMemoryWebhookDeliveryRepo();
    txRunner    = new InMemoryTransactionRunner();

    event = makeEvent();

    // Register real endpoint
    webhookRepo.seedEndpoint(makeRealEndpoint());

    const linkedInvoiceRepo = makeLinkedInvoiceRepo(invoiceRepo, paymentRepo);

    // Pre-seed an invoice
    invoiceRepo.addInvoice({
      id: "inv-ks-001",
      eventId: event.id,
      status: "pending",
      priceFiat: "50.00",
      fiatCurrency: "USD",
      amountUsdt: "50.000000",
      amountReceived: "0.000000",
      rateLockedAt: NOW,
      network: "TRON",
      depositAddress: DEPOSIT_ADDR,
      derivationIndex: 0,
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
      metadata: null,
      createdAt: NOW,
      paidAt: null,
    });

    const { primaryClient, secondaryClient } = buildAgreementClients({
      solidBlockNumber: Number(SOLID_BLOCK),
      transfers: [{
        txHash: "txhash_ks_001",
        logIndex: 0,
        from: FROM_ADDR,
        to: DEPOSIT_ADDR,
        value: "50000000",
        blockTimestamp: 1_748_800_000,
        blockHash: "bh_ks",
        blockNumber: CONFIRMED_BLOCK,
      }],
    });

    watcher = new TronWatcher(
      { network: "TRON" },
      {
        invoiceRepo: linkedInvoiceRepo,
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
  });

  it("watcher kill-switch: pollOnce is skipped when watcher is paused", async () => {
    pauseArea("watcher");

    // pollOnce should return without doing anything
    await watcher.pollOnce();

    // No payments credited, invoice still pending
    expect(paymentRepo.rows).toHaveLength(0);
    const inv = await invoiceRepo.findById("inv-ks-001");
    expect(inv?.status).toBe("pending");
  });

  it("watcher kill-switch: pollOnce resumes after resumeArea", async () => {
    pauseArea("watcher");
    await watcher.pollOnce();
    expect(paymentRepo.rows).toHaveLength(0);

    resumeArea("watcher");
    // Now pollOnce should actually execute
    await watcher.pollOnce();

    // Payment should have been credited now
    expect(paymentRepo.rows).toHaveLength(1);
    const inv = await invoiceRepo.findById("inv-ks-001");
    expect(inv?.status).toBe("paid");
  });

  it("webhook kill-switch: drainPending returns empty when webhooks are paused", async () => {
    // Seed a pending delivery with a real endpoint
    webhookRepo.seedDelivery({
      id: "del-ks-001",
      endpointId: REAL_ENDPOINT_ID,
      eventType: "invoice.paid",
      invoiceId: "inv-ks-001",
      payload: { status: "paid" },
      eventUid: "invoice.paid:inv-ks-001:ep-real-cuid-001:1",
      version: 1,
      attempts: 0,
      status: "pending",
      nextAttemptAt: new Date(0), // immediately due
      lastError: null,
      createdAt: NOW,
      deliveredAt: null,
    });

    pauseArea("webhooks");

    const result = await drainPending(webhookRepo, {
      fetchFn: buildCapturingFetch([]),
      now: () => NOW,
    });

    expect(result.processed).toBe(0);
    expect(result.delivered).toBe(0);

    // Delivery row still pending (not consumed)
    const row = await webhookRepo.findByEventUid("invoice.paid:inv-ks-001:ep-real-cuid-001:1");
    expect(row?.status).toBe("pending");
  });

  it("webhook kill-switch: drain resumes after resumeArea", async () => {
    const captured: CapturedRequest[] = [];
    webhookRepo.seedDelivery({
      id: "del-ks-002",
      endpointId: REAL_ENDPOINT_ID,
      eventType: "invoice.paid",
      invoiceId: "inv-ks-001",
      payload: { status: "paid" },
      eventUid: "invoice.paid:inv-ks-001:ep-real-cuid-001:2",
      version: 1,
      attempts: 0,
      status: "pending",
      nextAttemptAt: new Date(0),
      lastError: null,
      createdAt: NOW,
      deliveredAt: null,
    });

    pauseArea("webhooks");
    await drainPending(webhookRepo, { fetchFn: buildCapturingFetch(captured), now: () => NOW });
    expect(captured).toHaveLength(0); // paused

    resumeArea("webhooks");
    await drainPending(webhookRepo, {
      fetchFn: buildCapturingFetch(captured),
      resolve: async () => ["93.184.216.34"],
      now: () => NOW,
    });
    expect(captured).toHaveLength(1); // now delivered
  });
});
