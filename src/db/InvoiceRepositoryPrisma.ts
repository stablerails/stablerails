/**
 * Unified Prisma adapter for InvoiceRepository port.
 *
 * This is the SINGLE canonical implementation — both the HTTP server
 * (src/server/index.ts) and the watcher worker (src/workers/index.ts) import
 * from here. The old duplicates in src/server/db/adapters.ts (PrismaInvoiceRepository)
 * and src/workers/db/InvoiceRepositoryPrisma.ts (InvoiceRepositoryPrisma) are
 * removed and replaced by this class.
 *
 * Key capabilities over the old impls:
 *   - tx? params on findWithPayments / updateStatus (worker requirement)
 *   - list() method (server requirement)
 *   - listSweepableForEvent() for H2 sweep fix
 *   - Grace-window listActiveForWatch() for C2 late-funds fix:
 *       always-active: pending, payment_detected, overdue
 *       grace-window:  paid/overpaid/underpaid/expired/canceled within LATE_FUNDS_GRACE_DAYS
 */

import type { PrismaClient } from "@prisma/client";
import type {
  InvoiceRepository,
  InvoiceRow,
  InvoiceSummary,
  InvoiceStatus,
  PaymentRow,
  PaymentStatus,
  CreateInvoiceInput,
  Network,
  ActiveInvoiceProjection,
} from "../core/ports.js";
import { compareDecimalStrings, parseMicro, formatMicro } from "../lib/decimal.js";
import { getPrismaClient } from "./prismaClient.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Number of days after a terminal invoice's close time (paidAt / expiresAt /
 * createdAt, whichever is latest) during which the deposit address is still
 * included in the watcher poll set for late-funds detection.
 *
 * Can be overridden via the LATE_FUNDS_GRACE_DAYS environment variable.
 */
export const LATE_FUNDS_GRACE_DAYS =
  parseInt(process.env["LATE_FUNDS_GRACE_DAYS"] ?? "30", 10) || 30;

// ── Helpers ───────────────────────────────────────────────────────────────────

function toDomainInvoice(row: {
  id: string;
  eventId: string;
  status: string;
  priceFiat: string;
  fiatCurrency: string;
  amountUsdt: string;
  amountReceived: string;
  rateLockedAt: Date;
  network: string;
  depositAddress: string;
  derivationIndex: number;
  expiresAt: Date;
  metadata: unknown;
  createdAt: Date;
  paidAt: Date | null;
}): InvoiceRow {
  return {
    id: row.id,
    eventId: row.eventId,
    status: row.status as InvoiceStatus,
    priceFiat: row.priceFiat,
    fiatCurrency: row.fiatCurrency,
    amountUsdt: row.amountUsdt,
    amountReceived: row.amountReceived,
    rateLockedAt: row.rateLockedAt,
    network: row.network as InvoiceRow["network"],
    depositAddress: row.depositAddress,
    derivationIndex: row.derivationIndex,
    expiresAt: row.expiresAt,
    metadata: row.metadata as Record<string, unknown> | null,
    createdAt: row.createdAt,
    paidAt: row.paidAt,
  };
}

function toDomainPayment(p: {
  id: string;
  invoiceId: string;
  txHash: string;
  logIndex: number;
  network: string;
  fromAddress: string;
  amountUsdt: string;
  blockNumber: bigint;
  blockHash: string;
  status: string;
  detectedAt: Date;
  confirmedAt: Date | null;
}): PaymentRow {
  return {
    id: p.id,
    invoiceId: p.invoiceId,
    txHash: p.txHash,
    logIndex: p.logIndex,
    network: p.network as PaymentRow["network"],
    fromAddress: p.fromAddress,
    amountUsdt: p.amountUsdt,
    blockNumber: p.blockNumber,
    blockHash: p.blockHash,
    status: p.status as PaymentStatus,
    detectedAt: p.detectedAt,
    confirmedAt: p.confirmedAt,
  };
}

// ── PrismaInvoiceRepository ───────────────────────────────────────────────────

/**
 * Unified Prisma implementation of InvoiceRepository.
 *
 * Inject via: `new PrismaInvoiceRepository(db)` or `new PrismaInvoiceRepository()`
 * (lazy-singleton via getPrismaClient() when db is omitted).
 */
export class PrismaInvoiceRepository implements InvoiceRepository {
  private readonly db: PrismaClient;

  constructor(db?: PrismaClient) {
    this.db = db ?? getPrismaClient();
  }

  async allocateNextInvoiceIndex(eventId: string): Promise<number> {
    return this.db.$transaction(
      async (tx) => {
        // Row-level lock via SELECT...FOR UPDATE to prevent race conditions.
        const rows = await tx.$queryRaw<Array<{ nextInvoiceIndex: number }>>`
          SELECT "nextInvoiceIndex" FROM "Event"
          WHERE id = ${eventId}
          FOR UPDATE
        `;
        const row = rows[0];
        if (!row) throw new Error(`Event "${eventId}" not found`);
        const current = row.nextInvoiceIndex;
        await tx.event.update({
          where: { id: eventId },
          data: { nextInvoiceIndex: current + 1 },
        });
        return current;
      },
      { isolationLevel: "Serializable" },
    );
  }

  async insert(input: CreateInvoiceInput): Promise<InvoiceRow> {
    const row = await this.db.invoice.create({
      data: {
        eventId: input.eventId,
        priceFiat: input.priceFiat,
        fiatCurrency: input.fiatCurrency,
        amountUsdt: input.amountUsdt,
        rateLockedAt: input.rateLockedAt,
        network: input.network,
        depositAddress: input.depositAddress,
        derivationIndex: input.derivationIndex,
        expiresAt: input.expiresAt,
        metadata: input.metadata !== null ? (input.metadata as object) : undefined,
      },
    });
    return toDomainInvoice(row);
  }

  async findById(id: string): Promise<InvoiceRow | null> {
    const row = await this.db.invoice.findUnique({ where: { id } });
    return row ? toDomainInvoice(row) : null;
  }

  async findWithPayments(
    invoiceId: string,
    tx?: unknown,
  ): Promise<{ invoice: InvoiceRow; payments: PaymentRow[] } | null> {
    const client = (tx as PrismaClient | undefined) ?? this.db;
    const row = await client.invoice.findUnique({
      where: { id: invoiceId },
      include: { payments: true },
    });
    if (!row) return null;
    return {
      invoice: toDomainInvoice(row),
      payments: row.payments.map(toDomainPayment),
    };
  }

  async updateStatus(
    invoiceId: string,
    status: InvoiceStatus,
    extra?: { amountReceived?: string; paidAt?: Date },
    tx?: unknown,
  ): Promise<InvoiceRow> {
    const client = (tx as PrismaClient | undefined) ?? this.db;
    const row = await client.invoice.update({
      where: { id: invoiceId },
      data: {
        status,
        ...(extra?.amountReceived !== undefined && { amountReceived: extra.amountReceived }),
        ...(extra?.paidAt !== undefined && { paidAt: extra.paidAt }),
      },
    });
    return toDomainInvoice(row);
  }

  /**
   * C2 fix: include terminal invoices within the grace window.
   *
   * Always-active: pending, payment_detected, overdue
   * Grace-window:  paid, overpaid, underpaid, expired, canceled
   *   whose max(paidAt, expiresAt, createdAt) >= now - graceDays
   *
   * This ensures late funds arriving after a terminal transition are still
   * detected and recorded rather than silently lost.
   */
  async listActiveForWatch(
    network: Network,
    graceDays: number = LATE_FUNDS_GRACE_DAYS,
  ): Promise<ActiveInvoiceProjection[]> {
    const graceWindowStart = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

    // Terminal statuses that may still receive late funds during the grace window.
    const graceStatuses = ["paid", "overpaid", "underpaid", "expired", "canceled"] as const;

    const rows = await this.db.invoice.findMany({
      where: {
        network,
        OR: [
          // Always-active: non-terminal statuses.
          { status: { in: ["pending", "payment_detected", "overdue"] } },
          // Grace-window: terminal invoices closed within the last graceDays.
          {
            status: { in: [...graceStatuses] },
            OR: [
              { paidAt: { gte: graceWindowStart } },
              { expiresAt: { gte: graceWindowStart } },
              { createdAt: { gte: graceWindowStart } },
            ],
          },
        ],
      },
      select: {
        id: true,
        depositAddress: true,
        amountUsdt: true,
        network: true,
        expiresAt: true,
        status: true,
      },
    });

    return rows.map((r) => ({
      id: r.id,
      depositAddress: r.depositAddress,
      amountUsdt: r.amountUsdt,
      network: r.network as Network,
      expiresAt: r.expiresAt,
      status: r.status as InvoiceStatus,
    }));
  }

  /**
   * H2 fix: return fund-holding invoices for sweep.
   *
   * Includes all statuses that hold real USDT on the deposit address:
   *   paid, overpaid, underpaid, overdue
   *
   * Returns amountReceived (actual on-chain funds) rather than amountUsdt
   * (billed amount), so overpaid excess is always swept.
   */
  async listSweepableForEvent(eventId: string): Promise<
    Array<{
      depositAddress: string;
      derivationIndex: number;
      amountReceived: string;
      status: InvoiceStatus;
    }>
  > {
    // DB-3: Fetch all candidate rows and apply a value-based filter in application
    // code via compareDecimalStrings. This is safe because the set is bounded by
    // the status filter (paid/overpaid/underpaid/overdue); a literal-string NOT
    // filter would silently miss rows whose amountReceived was written as "0" (old
    // default) vs "0.000000" (new canonical default) despite both meaning zero.
    const rows = await this.db.invoice.findMany({
      where: {
        eventId,
        status: { in: ["paid", "overpaid", "underpaid", "overdue"] },
      },
      select: {
        depositAddress: true,
        derivationIndex: true,
        amountReceived: true,
        status: true,
      },
    });

    return rows
      .filter((r) => compareDecimalStrings(r.amountReceived, "0") > 0)
      .map((r) => ({
        depositAddress: r.depositAddress,
        derivationIndex: r.derivationIndex,
        amountReceived: r.amountReceived,
        status: r.status as InvoiceStatus,
      }));
  }

  /**
   * List invoices with optional filters (server-side pagination).
   *
   * merchantId is the tenant filter (multi-merchant isolation, BOLA fix):
   *   - undefined → no tenant filtering (admin callers)
   *   - null      → only invoices whose event has merchantId = null (legacy tenant)
   *   - string    → only invoices whose event has that merchantId
   */
  async list(opts: {
    eventId?: string;
    status?: InvoiceStatus;
    q?: string;
    metadata?: Record<string, string>;
    cursor?: string;
    limit?: number;
    merchantId?: string | null;
  }): Promise<InvoiceRow[]> {
    const limit = opts.limit ?? 20;

    let cursorId: string | undefined;
    if (opts.cursor) {
      try {
        const decoded = Buffer.from(opts.cursor, "base64url").toString("utf8");
        const parsed = JSON.parse(decoded) as { id?: string };
        cursorId = parsed.id;
      } catch {
        // invalid cursor → ignore
      }
    }

    const metadataAnds = opts.metadata
      ? Object.entries(opts.metadata).map(([key, value]) => ({
          metadata: { path: [key], equals: value },
        }))
      : [];

    const rows = await this.db.invoice.findMany({
      where: {
        // Tenant filter via the Invoice → Event join. `merchantId: null`
        // matches only null-tenant events (Prisma null equality).
        ...(opts.merchantId !== undefined ? { event: { merchantId: opts.merchantId } } : {}),
        ...(opts.eventId ? { eventId: opts.eventId } : {}),
        ...(opts.status ? { status: opts.status } : {}),
        ...(metadataAnds.length > 0 ? { AND: metadataAnds } : {}),
        ...(opts.q
          ? {
              metadata: {
                string_contains: opts.q,
              },
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    return rows.map(toDomainInvoice);
  }

  /**
   * Read-only aggregated summary over invoice rows.
   * Additive — no state transitions, no money movement.
   *
   * Uses Prisma count/groupBy + raw SQL SUM so it works correctly across all
   * rows regardless of pagination limits in list(). `amountReceived` is stored
   * as a String column in Postgres, so Prisma aggregate._sum cannot be used
   * (String fields are not aggregatable). Instead, raw SQL CAST to NUMERIC and
   * SUM is used. Result is parsed through parseMicro/formatMicro — no floats.
   */
  async summary(eventId?: string): Promise<InvoiceSummary> {
    const where = eventId ? { eventId } : {};

    // Run count and groupBy in parallel; raw SUM separately.
    const [totalCount, statusGroups] = await Promise.all([
      this.db.invoice.count({ where }),
      this.db.invoice.groupBy({
        by: ["status"],
        where,
        _count: { _all: true },
      }),
    ]);

    // Sum amountReceived via raw SQL — the column is a VARCHAR decimal string
    // (e.g. "100.000000"); CAST to NUMERIC lets Postgres sum it correctly.
    // NULLIF guards against an empty string ever reaching CAST (which would error).
    let totalAmountReceived: string;
    if (eventId) {
      const rows = await this.db.$queryRaw<[{ total: unknown }]>`
        SELECT COALESCE(SUM(CAST(NULLIF("amountReceived",'') AS NUMERIC)), 0) AS total
        FROM "Invoice"
        WHERE "eventId" = ${eventId}
      `;
      const raw = rows[0]?.total?.toString() ?? "0";
      totalAmountReceived = formatMicro(parseMicro(raw));
    } else {
      const rows = await this.db.$queryRaw<[{ total: unknown }]>`
        SELECT COALESCE(SUM(CAST(NULLIF("amountReceived",'') AS NUMERIC)), 0) AS total
        FROM "Invoice"
      `;
      const raw = rows[0]?.total?.toString() ?? "0";
      totalAmountReceived = formatMicro(parseMicro(raw));
    }

    const byStatus: Partial<Record<InvoiceStatus, number>> = {};
    for (const g of statusGroups) {
      byStatus[g.status as InvoiceStatus] = g._count._all;
    }

    return {
      totalCount,
      paidCount: byStatus["paid"] ?? 0,
      // settledCount: confirmed funds — paid + overpaid (overpaid = customer sent
      // more than required, but funds are confirmed on-chain).
      settledCount: (byStatus["paid"] ?? 0) + (byStatus["overpaid"] ?? 0),
      pendingCount: byStatus["pending"] ?? 0,
      totalAmountReceived,
      byStatus,
    };
  }
}
