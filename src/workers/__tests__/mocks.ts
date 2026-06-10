/**
 * In-memory mock repositories for watcher tests.
 *
 * Implements the core port interfaces without any DB dependency.
 * Used in ALL offline tests — never import Prisma in this file.
 */

import { UNCONFIRMED_BLOCK_SENTINEL } from "../../core/ports.js";
import type {
  InvoiceRepository,
  InvoiceSummary,
  PaymentRepository,
  InvoiceRow,
  PaymentRow,
  InvoiceStatus,
  PaymentStatus,
  RecordPaymentInput,
  CreateInvoiceInput,
  Network,
  ActiveInvoiceProjection,
} from "../../core/ports.js";
import { parseMicro, formatMicro } from "../../lib/decimal.js";
import type { ChainCursorRepository, ChainCursorRow } from "../db/ChainCursorRepository.js";
import type {
  WebhookDeliveryRepository,
  WebhookEndpointRepository,
  WebhookEndpointRow,
  EnqueueWebhookInput,
} from "../db/WebhookDeliveryRepository.js";
import type { TransactionRunner } from "../watcher.js";

// ── In-memory Payment Repository ──────────────────────────────────────────────

export class InMemoryPaymentRepository implements PaymentRepository {
  readonly rows: PaymentRow[] = [];
  private idCounter = 0;

  async upsert(input: RecordPaymentInput, _tx?: unknown): Promise<{ row: PaymentRow; created: boolean }> {
    const existing = this.rows.find(
      (r) =>
        r.network === input.network &&
        r.txHash === input.txHash &&
        r.logIndex === input.logIndex,
    );
    if (existing) {
      // Refresh blockNumber while the payment is still pre-credit (detected).
      // Rationale: on tick 1 a transient secondary lag may store MAX_BN as the
      // block number. On tick 2, both providers agree on the real block; the
      // upsert must update blockNumber so the M-4 replay gate
      // (paymentRow.blockNumber <= latestSolidBlock) can fire → invoice reaches paid.
      //
      // blockHash is intentionally NOT updated here: checkReorg (called after upsert)
      // compares the original stored blockHash against the newly-received one to
      // detect chain reorganisations. Updating blockHash in the upsert would mask
      // that comparison and prevent legitimate reorg detection.
      //
      // Never-revert invariant: confirmed rows are immutable (already credited).
      if (existing.status === "detected") {
        existing.blockNumber = input.blockNumber;
      }
      // Orphan revival: the same (network, txHash, logIndex) re-observed by BOTH
      // providers (the watcher only calls upsert on the agreement path) with a
      // confirmed placement — the tx was re-mined after a pre-solid reorg.
      // Revive to "detected" with the fresh block coordinates so the normal
      // detected→confirmed solid gate can credit it. Status is forced to
      // "detected" regardless of input.status (never jump straight to
      // confirmed/paid); amountUsdt stays immutable.
      if (
        existing.status === "orphaned" &&
        input.blockNumber < UNCONFIRMED_BLOCK_SENTINEL &&
        input.blockHash.length > 0
      ) {
        existing.status = "detected";
        existing.blockNumber = input.blockNumber;
        existing.blockHash = input.blockHash;
      }
      return { row: existing, created: false };
    }

    const row: PaymentRow = {
      id: `pay-${++this.idCounter}`,
      invoiceId: input.invoiceId,
      txHash: input.txHash,
      logIndex: input.logIndex,
      network: input.network,
      fromAddress: input.fromAddress,
      amountUsdt: input.amountUsdt,
      blockNumber: input.blockNumber,
      blockHash: input.blockHash,
      status: input.status,
      detectedAt: new Date(),
      confirmedAt: null,
    };
    this.rows.push(row);
    return { row, created: true };
  }

  async updateStatus(
    id: string,
    status: PaymentStatus,
    confirmedAt?: Date,
    _tx?: unknown,
  ): Promise<PaymentRow> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`Payment not found: ${id}`);
    row.status = status;
    if (confirmedAt) row.confirmedAt = confirmedAt;
    return row;
  }

  async markUnconfirmed(id: string, _tx?: unknown): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    // Guard mirrors the Prisma impl: only reset while still "detected".
    if (!row || row.status !== "detected") return;
    row.blockNumber = UNCONFIRMED_BLOCK_SENTINEL;
  }
}

// ── In-memory Invoice Repository ─────────────────────────────────────────────

export class InMemoryInvoiceRepository implements InvoiceRepository {
  readonly rows: InvoiceRow[] = [];
  private indexCounters: Map<string, number> = new Map();
  private idCounter = 0;

  addInvoice(row: InvoiceRow): void {
    this.rows.push(row);
  }

  async allocateNextInvoiceIndex(eventId: string): Promise<number> {
    const current = this.indexCounters.get(eventId) ?? 0;
    this.indexCounters.set(eventId, current + 1);
    return current;
  }

  async insert(input: CreateInvoiceInput): Promise<InvoiceRow> {
    const row: InvoiceRow = {
      id: `inv-${++this.idCounter}`,
      eventId: input.eventId,
      status: "pending",
      priceFiat: input.priceFiat,
      fiatCurrency: input.fiatCurrency,
      amountUsdt: input.amountUsdt,
      amountReceived: "0.000000",
      rateLockedAt: input.rateLockedAt,
      network: input.network,
      depositAddress: input.depositAddress,
      derivationIndex: input.derivationIndex,
      expiresAt: input.expiresAt,
      metadata: input.metadata,
      createdAt: new Date(),
      paidAt: null,
    };
    this.rows.push(row);
    return row;
  }

  async findById(id: string): Promise<InvoiceRow | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async findWithPayments(
    invoiceId: string,
    paymentRepoOrTx?: InMemoryPaymentRepository | unknown,
  ): Promise<{ invoice: InvoiceRow; payments: PaymentRow[] } | null> {
    const invoice = this.rows.find((r) => r.id === invoiceId);
    if (!invoice) return null;

    // Accept either a companion InMemoryPaymentRepository or an ignored tx token
    const paymentRepo =
      paymentRepoOrTx instanceof InMemoryPaymentRepository
        ? paymentRepoOrTx
        : undefined;
    const payments =
      paymentRepo?.rows.filter((p) => p.invoiceId === invoiceId) ?? [];
    return { invoice, payments };
  }

  async updateStatus(
    invoiceId: string,
    status: InvoiceStatus,
    extra?: { amountReceived?: string; paidAt?: Date },
    _tx?: unknown,
  ): Promise<InvoiceRow> {
    const row = this.rows.find((r) => r.id === invoiceId);
    if (!row) throw new Error(`Invoice not found: ${invoiceId}`);
    row.status = status;
    if (extra?.amountReceived !== undefined) row.amountReceived = extra.amountReceived;
    if (extra?.paidAt !== undefined) row.paidAt = extra.paidAt;
    return row;
  }

  async listActiveForWatch(network: Network, _graceDays?: number): Promise<ActiveInvoiceProjection[]> {
    const activeStatuses: InvoiceStatus[] = ["pending", "payment_detected", "overdue"];
    const graceStatuses: InvoiceStatus[] = ["paid", "overpaid", "underpaid", "expired", "canceled"];
    const graceDays = _graceDays ?? 30;
    const graceWindowStart = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

    return this.rows
      .filter((r) => {
        if (r.network !== network) return false;
        if (activeStatuses.includes(r.status)) return true;
        if (graceStatuses.includes(r.status)) {
          const closeTime = r.paidAt ?? r.expiresAt ?? r.createdAt;
          return closeTime >= graceWindowStart;
        }
        return false;
      })
      .map((r) => ({
        id: r.id,
        depositAddress: r.depositAddress,
        amountUsdt: r.amountUsdt,
        network: r.network,
        expiresAt: r.expiresAt,
        status: r.status,
      }));
  }

  async listSweepableForEvent(eventId: string): Promise<
    Array<{ depositAddress: string; derivationIndex: number; amountReceived: string; status: InvoiceStatus }>
  > {
    const sweepableStatuses: InvoiceStatus[] = ["paid", "overpaid", "underpaid", "overdue"];
    return this.rows
      .filter(
        (r) =>
          r.eventId === eventId &&
          sweepableStatuses.includes(r.status) &&
          r.amountReceived !== "0.000000",
      )
      .map((r) => ({
        depositAddress: r.depositAddress,
        derivationIndex: r.derivationIndex,
        amountReceived: r.amountReceived,
        status: r.status,
      }));
  }

  async list(opts: {
    eventId?: string;
    status?: InvoiceStatus;
    q?: string;
    metadata?: Record<string, string>;
    cursor?: string;
    limit?: number;
  }): Promise<InvoiceRow[]> {
    let rows = this.rows.slice();
    if (opts.eventId) rows = rows.filter((r) => r.eventId === opts.eventId);
    if (opts.status) rows = rows.filter((r) => r.status === opts.status);
    return rows.slice(0, opts.limit ?? 20);
  }

  async summary(eventId?: string): Promise<InvoiceSummary> {
    let rows = this.rows.slice();
    if (eventId) rows = rows.filter((r) => r.eventId === eventId);

    const byStatus: Partial<Record<InvoiceStatus, number>> = {};
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    }

    let totalMicro = 0n;
    for (const r of rows) {
      totalMicro += parseMicro(r.amountReceived);
    }

    return {
      totalCount: rows.length,
      paidCount: byStatus["paid"] ?? 0,
      settledCount: (byStatus["paid"] ?? 0) + (byStatus["overpaid"] ?? 0),
      pendingCount: byStatus["pending"] ?? 0,
      totalAmountReceived: formatMicro(totalMicro),
      byStatus,
    };
  }
}

// ── findWithPayments that crosses both repos (used by watcher) ────────────────

/**
 * Creates a linked InvoiceRepository mock that automatically fetches payments
 * from the companion PaymentRepository.
 */
export function makeLinkedInvoiceRepo(
  invoiceRepo: InMemoryInvoiceRepository,
  paymentRepo: InMemoryPaymentRepository,
): InvoiceRepository {
  return {
    allocateNextInvoiceIndex: (eventId) => invoiceRepo.allocateNextInvoiceIndex(eventId),
    insert: (input) => invoiceRepo.insert(input),
    findById: (id) => invoiceRepo.findById(id),
    // Pass paymentRepo (not the tx token) so the in-memory impl can join payments.
    // The tx token is ignored by the in-memory impl; paymentRepo is the join key.
    findWithPayments: async (invoiceId, _tx) =>
      invoiceRepo.findWithPayments(invoiceId, paymentRepo),
    updateStatus: (invoiceId, status, extra, _tx) =>
      invoiceRepo.updateStatus(invoiceId, status, extra),
    listActiveForWatch: (network, graceDays) => invoiceRepo.listActiveForWatch(network, graceDays),
    listSweepableForEvent: (eventId) => invoiceRepo.listSweepableForEvent(eventId),
    list: (opts) => invoiceRepo.list(opts),
    summary: (eventId) => invoiceRepo.summary(eventId),
  };
}

// ── In-memory Chain Cursor Repository ────────────────────────────────────────

export class InMemoryChainCursorRepository implements ChainCursorRepository {
  private cursors: Map<Network, ChainCursorRow> = new Map();

  async findByNetwork(network: Network): Promise<ChainCursorRow | null> {
    return this.cursors.get(network) ?? null;
  }

  async upsert(
    network: Network,
    lastScannedBlock: bigint,
    lastSolidBlock: bigint,
  ): Promise<ChainCursorRow> {
    const row: ChainCursorRow = {
      network,
      lastScannedBlock,
      lastSolidBlock,
      updatedAt: new Date(),
    };
    this.cursors.set(network, row);
    return row;
  }
}

// ── In-memory Webhook Delivery Repository ────────────────────────────────────

export interface WebhookDeliveryRecord {
  id: string;
  input: EnqueueWebhookInput;
  createdAt: Date;
}

/**
 * Watcher-focused in-memory repo that satisfies both WebhookDeliveryRepository
 * and WebhookEndpointRepository ports so it can be passed as both `webhookRepo`
 * and `endpointRepo` in TronWatcher constructor.
 *
 * Designed for watcher unit tests where the inspection API (deliveries array,
 * d.input.*) must remain unchanged. Endpoints can be seeded via seedEndpoint();
 * if no endpoints are seeded, listForEvent returns a single default stub so
 * that enqueue does not require explicit endpoint setup in every test.
 */
export class InMemoryWebhookDeliveryRepository
  implements WebhookDeliveryRepository, WebhookEndpointRepository
{
  readonly deliveries: WebhookDeliveryRecord[] = [];
  private idCounter = 0;
  private endpoints = new Map<string, WebhookEndpointRow>();

  /** Seed a real endpoint for fan-out tests. */
  seedEndpoint(ep: WebhookEndpointRow): void {
    this.endpoints.set(ep.id, ep);
  }

  async enqueue(input: EnqueueWebhookInput, _tx?: unknown): Promise<{ id: string; created: boolean }> {
    const existing = this.deliveries.find((d) => d.input.eventUid === input.eventUid);
    if (existing) return { id: existing.id, created: false };

    // Enforce @@unique([invoiceId, endpointId, version]) — mirrors Postgres constraint.
    const dupConstraint = this.deliveries.find(
      (d) =>
        d.input.invoiceId === input.invoiceId &&
        d.input.endpointId === input.endpointId &&
        d.input.version === input.version,
    );
    if (dupConstraint) {
      throw new Error(
        `P2002: Unique constraint violation on WebhookDelivery @@unique([invoiceId, endpointId, version]): ` +
          `invoiceId=${input.invoiceId} endpointId=${input.endpointId} version=${input.version}`,
      );
    }

    const id = `wh-${++this.idCounter}`;
    this.deliveries.push({ id, input, createdAt: new Date() });
    return { id, created: true };
  }

  /**
   * Returns the highest version number already stored for `invoiceId`.
   * Computes from the actual deliveries array — no shortcut field.
   * The optional `tx` param is ignored (in-memory; no real transaction context).
   */
  async maxVersionForInvoice(invoiceId: string, _tx?: unknown): Promise<number> {
    const forInvoice = this.deliveries.filter((d) => d.input.invoiceId === invoiceId);
    if (forInvoice.length === 0) return 0;
    return forInvoice.reduce((max, d) => Math.max(max, d.input.version), 0);
  }

  /**
   * Returns the highest version number already stored for (invoiceId, endpointId).
   * Mirrors @@unique([invoiceId, endpointId, version]) — each endpoint has its
   * own independent monotonic counter.
   */
  async maxVersionForInvoiceEndpoint(invoiceId: string, endpointId: string, _tx?: unknown): Promise<number> {
    const forPair = this.deliveries.filter(
      (d) => d.input.invoiceId === invoiceId && d.input.endpointId === endpointId,
    );
    if (forPair.length === 0) return 0;
    return forPair.reduce((max, d) => Math.max(max, d.input.version), 0);
  }

  /**
   * List active endpoints for a given eventId.
   * If real endpoints have been seeded via seedEndpoint(), return those.
   * Otherwise return a single default stub so watcher tests that don't care
   * about endpoint ids still see one endpoint to enqueue against.
   */
  async listForEvent(eventId: string): Promise<WebhookEndpointRow[]> {
    const seeded = [...this.endpoints.values()].filter(
      (ep) => ep.active && (ep.eventId === eventId || ep.eventId === null),
    );
    if (seeded.length > 0) return seeded;
    // Default stub: allows watcher tests to enqueue without explicit endpoint setup.
    return [
      {
        id: `stub-ep-${eventId}`,
        eventId,
        url: "https://stub.example.com/webhook",
        secret: "stub-secret",
        active: true,
        createdAt: new Date(),
      },
    ];
  }
}

// ── In-memory TransactionRunner ───────────────────────────────────────────────

/**
 * In-memory implementation of the TransactionRunner port.
 *
 * Simply calls fn(undefined) — no real DB transaction or lock needed in tests
 * because all in-memory repos are single-threaded and sequential.
 * Models the same invariant as the Prisma implementation: the entire fn body
 * completes before any other concurrent caller can observe partial state.
 */
export class InMemoryTransactionRunner implements TransactionRunner {
  async runInCredit<T>(_invoiceId: string, fn: (tx: unknown) => Promise<T>): Promise<T> {
    return fn(undefined);
  }
}
