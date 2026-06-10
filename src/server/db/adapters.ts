/**
 * Prisma adapters implementing the core port interfaces.
 *
 * PrismaEventRepository      → EventRepository
 * PrismaInvoiceRepository    → InvoiceRepository (allocateNextInvoiceIndex uses
 *                              SELECT...FOR UPDATE in a SERIALIZABLE transaction)
 * PrismaSweepIntentRepository → SweepIntentRepository
 * TronDepositAddressDeriver  → DepositAddressDeriver
 * SystemClock                → Clock
 * FixedRateSource            → RateSource
 *
 * NOTE: These require a real DATABASE_URL. Tests use the in-memory mocks instead.
 */

import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import type {
  EventRepository,
  EventRow,
  CreateEventInput,
  Clock,
  DepositAddressDeriver,
  RateSource,
} from "../../core/ports.js";
import type {
  SweepIntentRepository,
  SweepIntentRow,
  SweepIntentItem,
  SweepIntentStatus,
} from "../routes/sweeps.js";
import { deriveAddress } from "../../chain/tron/deriveAddress.js";
import { parseMicro } from "../../lib/decimal.js";
import type {
  InvoiceIdempotencyRecord,
  InvoiceIdempotencyReservation,
  InvoiceIdempotencyRepository,
} from "../routes/invoices.js";

// Re-export the unified PrismaInvoiceRepository so server/index.ts keeps its import.
export { PrismaInvoiceRepository } from "../../db/InvoiceRepositoryPrisma.js";

// ── Helper: Prisma Event → EventRow ─────────────────────────────────────────

function toEventRow(e: {
  id: string;
  name: string;
  status: string;
  mainWalletAddress: string;
  derivationAccount: number;
  xpubAccount: string;
  nextInvoiceIndex: number;
  merchantId?: string | null;
  createdAt: Date;
}): EventRow {
  return {
    id: e.id,
    name: e.name,
    status: e.status as "active" | "archived",
    mainWalletAddress: e.mainWalletAddress,
    derivationAccount: e.derivationAccount,
    xpubAccount: e.xpubAccount,
    nextInvoiceIndex: e.nextInvoiceIndex,
    merchantId: e.merchantId ?? null,
    createdAt: e.createdAt,
  };
}

// ── Helper: Prisma Invoice → InvoiceRow ───────────────────────────────────────

// ── PrismaEventRepository ─────────────────────────────────────────────────────

export class PrismaEventRepository implements EventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async insert(input: CreateEventInput): Promise<EventRow> {
    const row = await this.prisma.event.create({
      data: {
        name: input.name,
        mainWalletAddress: input.mainWalletAddress,
        derivationAccount: input.derivationAccount,
        xpubAccount: input.xpubAccount,
        merchantId: input.merchantId ?? null,
      },
    });
    return toEventRow(row);
  }

  async findById(id: string): Promise<EventRow | null> {
    const row = await this.prisma.event.findUnique({ where: { id } });
    return row ? toEventRow(row) : null;
  }

  /**
   * List events with optional tenant filter (multi-merchant isolation):
   *   - filter omitted / merchantId undefined → all events (admin)
   *   - merchantId null   → legacy default tenant only
   *   - merchantId string → that tenant only
   */
  async list(filter?: { merchantId?: string | null }): Promise<EventRow[]> {
    const rows = await this.prisma.event.findMany({
      where:
        filter !== undefined && filter.merchantId !== undefined
          ? { merchantId: filter.merchantId }
          : {},
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toEventRow);
  }
}

// ── TronDepositAddressDeriver ─────────────────────────────────────────────────

export class TronDepositAddressDeriver implements DepositAddressDeriver {
  derive(xpubAccount: string, index: number): string {
    return deriveAddress(xpubAccount, index);
  }
}

// ── SystemClock ───────────────────────────────────────────────────────────────

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

// ── FixedRateSource ───────────────────────────────────────────────────────────

/**
 * Fixed USDT rate source for MVP.
 * Default: 1 USDT = 1 USD with a configurable de-peg buffer.
 */
export class FixedRateSource implements RateSource {
  /** microUsdtPerFiatUnit: default 1_010_000n (1% de-peg buffer). */
  constructor(
    private readonly microUsdtPerFiatUnit: bigint = 1_010_000n,
  ) {}

  toMicroUsdt(fiatAmount: string, _currency: string): bigint {
    // Route through the canonical parseMicro — single source of truth for
    // decimal parsing. microUsdt = parseMicro(fiatAmount) * microUsdtPerFiatUnit / SCALE
    const scale = 1_000_000n;
    const fiatMicro = parseMicro(fiatAmount);
    return (fiatMicro * this.microUsdtPerFiatUnit) / scale;
  }
}

// ── PrismaInvoiceIdempotencyRepository ───────────────────────────────────────

export class PrismaInvoiceIdempotencyRepository implements InvoiceIdempotencyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private toRecord(row: {
    requestHash: string;
    state: string;
    statusCode: number | null;
    responseBody: unknown | null;
    expiresAt: Date;
    processingExpiresAt: Date | null;
  }): InvoiceIdempotencyRecord {
    return {
      requestHash: row.requestHash,
      state: row.state as "processing" | "completed",
      statusCode: row.statusCode,
      responseBody: row.responseBody,
      expiresAt: row.expiresAt,
      processingExpiresAt: row.processingExpiresAt,
    };
  }

  async reserve(input: {
    apiKeyId: string | null;
    scopeKey: string;
    idempotencyKey: string;
    requestHash: string;
    expiresAt: Date;
    processingExpiresAt: Date;
  }): Promise<InvoiceIdempotencyReservation> {
    const id = `idem_${randomBytes(16).toString("hex")}`;
    const now = new Date();
    const rows = await this.prisma.$queryRaw<Array<{
      requestHash: string;
      state: string;
      statusCode: number | null;
      responseBody: unknown | null;
      expiresAt: Date;
      processingExpiresAt: Date | null;
    }>>`
      INSERT INTO "InvoiceIdempotency" (
        "id",
        "apiKeyId",
        "scopeKey",
        "idempotencyKey",
        "requestHash",
        "state",
        "statusCode",
        "responseBody",
        "expiresAt",
        "processingExpiresAt",
        "updatedAt"
      ) VALUES (
        ${id},
        ${input.apiKeyId},
        ${input.scopeKey},
        ${input.idempotencyKey},
        ${input.requestHash},
        'processing',
        NULL,
        NULL,
        ${input.expiresAt},
        ${input.processingExpiresAt},
        ${now}
      )
      ON CONFLICT ("scopeKey", "idempotencyKey")
      DO UPDATE SET
        "apiKeyId" = EXCLUDED."apiKeyId",
        "requestHash" = EXCLUDED."requestHash",
        "state" = 'processing',
        "statusCode" = NULL,
        "responseBody" = NULL,
        "expiresAt" = EXCLUDED."expiresAt",
        "processingExpiresAt" = EXCLUDED."processingExpiresAt",
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE "InvoiceIdempotency"."expiresAt" <= ${now}
         OR (
           "InvoiceIdempotency"."state" = 'processing'
           AND "InvoiceIdempotency"."processingExpiresAt" <= ${now}
         )
      RETURNING "requestHash", "state", "statusCode", "responseBody", "expiresAt", "processingExpiresAt"
    `;

    const changed = rows[0];
    if (changed) {
      return { kind: "reserved", record: this.toRecord(changed) };
    }

    const existing = await this.findValid(input.scopeKey, input.idempotencyKey, now);
    if (!existing) {
      return this.reserve(input);
    }
    if (existing.requestHash !== input.requestHash) {
      return { kind: "conflict", record: existing };
    }
    if (existing.state === "completed") {
      return { kind: "completed", record: existing };
    }
    return { kind: "processing", record: existing };
  }

  async findValid(
    scopeKey: string,
    idempotencyKey: string,
    now: Date,
  ): Promise<InvoiceIdempotencyRecord | null> {
    const rows = await this.prisma.$queryRaw<Array<{
      state: string;
      requestHash: string;
      statusCode: number | null;
      responseBody: unknown | null;
      expiresAt: Date;
      processingExpiresAt: Date | null;
    }>>`
      SELECT "requestHash", "state", "statusCode", "responseBody", "expiresAt", "processingExpiresAt"
      FROM "InvoiceIdempotency"
      WHERE "scopeKey" = ${scopeKey}
        AND "idempotencyKey" = ${idempotencyKey}
        AND "expiresAt" > ${now}
      LIMIT 1
    `;
    const row = rows[0];
    return row ? this.toRecord(row) : null;
  }

  async complete(input: {
    apiKeyId: string | null;
    scopeKey: string;
    idempotencyKey: string;
    requestHash: string;
    statusCode: number;
    responseBody: unknown;
    expiresAt: Date;
  }): Promise<void> {
    const responseBody = JSON.stringify(input.responseBody);
    const id = `idem_${randomBytes(16).toString("hex")}`;
    const updatedAt = new Date();
    await this.prisma.$executeRaw`
      INSERT INTO "InvoiceIdempotency" (
        "id",
        "apiKeyId",
        "scopeKey",
        "idempotencyKey",
        "requestHash",
        "state",
        "statusCode",
        "responseBody",
        "expiresAt",
        "processingExpiresAt",
        "updatedAt"
      ) VALUES (
        ${id},
        ${input.apiKeyId},
        ${input.scopeKey},
        ${input.idempotencyKey},
        ${input.requestHash},
        'completed',
        ${input.statusCode},
        ${responseBody}::jsonb,
        ${input.expiresAt},
        NULL,
        ${updatedAt}
      )
      ON CONFLICT ("scopeKey", "idempotencyKey")
      DO UPDATE SET
        "apiKeyId" = EXCLUDED."apiKeyId",
        "requestHash" = EXCLUDED."requestHash",
        "state" = 'completed',
        "statusCode" = EXCLUDED."statusCode",
        "responseBody" = EXCLUDED."responseBody",
        "expiresAt" = EXCLUDED."expiresAt",
        "processingExpiresAt" = NULL,
        "updatedAt" = EXCLUDED."updatedAt"
    `;
  }

  async deleteExpired(now: Date): Promise<void> {
    await this.prisma.$executeRaw`
      DELETE FROM "InvoiceIdempotency"
      WHERE "expiresAt" <= ${now}
    `;
  }
}

// ── PrismaSweepIntentRepository ───────────────────────────────────────────────

/**
 * Prisma adapter for SweepIntent persistence.
 *
 * items is stored as JSON in the DB (Prisma Json field).
 * destination = event.mainWalletAddress at prepare time.
 */
export class PrismaSweepIntentRepository implements SweepIntentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private toRow(raw: {
    id: string;
    eventId: string;
    destination: string;
    status: string;
    items: unknown;
    createdAt: Date;
  }): SweepIntentRow {
    return {
      id: raw.id,
      eventId: raw.eventId,
      destination: raw.destination,
      status: raw.status as SweepIntentStatus,
      items: (raw.items as SweepIntentItem[]) ?? [],
      createdAt: raw.createdAt,
    };
  }

  async insert(intent: Omit<SweepIntentRow, "id" | "createdAt">): Promise<SweepIntentRow> {
    const row = await this.prisma.sweepIntent.create({
      data: {
        eventId: intent.eventId,
        destination: intent.destination,
        status: intent.status,
        items: intent.items as unknown as object,
      },
    });
    return this.toRow(row);
  }

  async findById(id: string): Promise<SweepIntentRow | null> {
    const row = await this.prisma.sweepIntent.findUnique({ where: { id } });
    return row ? this.toRow(row) : null;
  }

  async updateStatus(id: string, status: SweepIntentStatus): Promise<SweepIntentRow> {
    const row = await this.prisma.sweepIntent.update({
      where: { id },
      data: { status },
    });
    return this.toRow(row);
  }

  async updateItems(id: string, items: SweepIntentItem[]): Promise<SweepIntentRow> {
    const row = await this.prisma.sweepIntent.update({
      where: { id },
      data: { items: items as unknown as object },
    });
    return this.toRow(row);
  }
}
