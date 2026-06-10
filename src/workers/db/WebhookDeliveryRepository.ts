/**
 * Unified WebhookDelivery + WebhookEndpoint repository.
 *
 * Merges the two previously-split adapters (S5 enqueue+maxVersionForInvoice and
 * S6 claimPending/markDelivered/markFailed/markDead) into ONE production class.
 *
 * Single version authority: `maxVersionForInvoice(invoiceId, tx)+1` computed
 * by the watcher INSIDE the credit transaction is the only version assigner.
 * The dead `incrementVersion`/`assignVersion` helpers from the S6 split are
 * intentionally NOT ported here.
 *
 * Gated behind DATABASE_URL.
 */

import type { PrismaClient } from "@prisma/client";
import { randomBytes } from "crypto";
import type { WebhookEventType } from "../../core/lifecycle.js";
import { getPrismaClient } from "./prismaClient.js";

// ── Enqueue input (used by watcher) ───────────────────────────────────────────

export interface EnqueueWebhookInput {
  /** Real WebhookEndpoint.id (cuid) — NEVER a fabricated string. */
  endpointId: string;
  /** Event type name, e.g. "invoice.paid". */
  eventType: WebhookEventType;
  /** Related invoice ID (optional). */
  invoiceId?: string;
  /** Event payload to send. */
  payload: Record<string, unknown>;
  /**
   * Unique event identifier for idempotency.
   * Format: `{eventType}:{invoiceId}:{version}` or similar.
   */
  eventUid: string;
  /** Monotonic version counter per invoice. */
  version: number;
  /** When to attempt first delivery. */
  nextAttemptAt: Date;
}

// ── Endpoint row (returned by listForEvent) ───────────────────────────────────

export interface WebhookEndpointRow {
  id: string;
  eventId: string | null;
  url: string;
  secret: string;
  active: boolean;
  createdAt: Date;
}

// ── WebhookEndpointRepository port ────────────────────────────────────────────

/**
 * Port for resolving active WebhookEndpoints for a given event.
 * Implemented by PrismaWebhookDeliveryRepository (prod) and
 * UnifiedInMemoryWebhookRepo (tests).
 */
export interface WebhookEndpointRepository {
  /**
   * List all ACTIVE endpoints that should receive deliveries for the given
   * eventId. Includes both:
   *   - endpoints scoped to this eventId (eventId = provided value)
   *   - global endpoints (eventId IS NULL) that receive all events
   *
   * Returns an empty array if no endpoints are registered (caller must NOT
   * fabricate an endpointId — enqueue nothing when this returns []).
   */
  listForEvent(eventId: string): Promise<WebhookEndpointRow[]>;
}

// ── WebhookDeliveryRepository port (watcher-facing) ──────────────────────────

export interface WebhookDeliveryRepository {
  /**
   * Idempotent enqueue on eventUid.
   *
   * @param tx  Optional Prisma transaction client. When supplied the insert
   *            runs inside the caller's transaction; otherwise auto-commits.
   */
  enqueue(input: EnqueueWebhookInput, tx?: unknown): Promise<{ id: string; created: boolean }>;
  /**
   * Return the highest version number already stored for `invoiceId`.
   * Returns 0 if no webhooks exist yet for this invoice.
   * MUST run inside the same DB transaction as the enqueue (pass `tx` for Prisma).
   * @deprecated Use maxVersionForInvoiceEndpoint for per-endpoint versioning.
   */
  maxVersionForInvoice(invoiceId: string, tx?: unknown): Promise<number>;
  /**
   * Return the highest version number already stored for the (invoiceId, endpointId) pair.
   * Returns 0 if no webhooks exist yet for this (invoice, endpoint) combination.
   * MUST run inside the same DB transaction as the enqueue (pass `tx` for Prisma).
   */
  maxVersionForInvoiceEndpoint(invoiceId: string, endpointId: string, tx?: unknown): Promise<number>;
}

// ── Delivery worker types (claimPending / markDelivered etc.) ─────────────────

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed" | "dead";

export interface WebhookDeliveryRow {
  id: string;
  endpointId: string;
  eventType: string;
  invoiceId: string | null;
  payload: unknown;
  eventUid: string;
  version: number;
  attempts: number;
  status: WebhookDeliveryStatus;
  nextAttemptAt: Date;
  lastError: string | null;
  claimToken: string | null;
  claimedAt: Date | null;
  claimExpiresAt: Date | null;
  createdAt: Date;
  deliveredAt: Date | null;
  endpoint?: WebhookEndpointRow;
}

export interface ClaimPendingInput {
  now?: Date;
  batchSize?: number;
  leaseMs?: number;
}

export interface MarkDeliveredInput {
  id: string;
  deliveredAt?: Date;
  claimToken?: string | null;
}

export interface MarkFailedInput {
  id: string;
  lastError: string;
  nextAttemptAt: Date;
  claimToken?: string | null;
}

export interface RecordAttemptInput {
  id: string;
  nextAttemptAt: Date;
  lastError?: string | null;
  status: WebhookDeliveryStatus;
}

// ── DeliveryWorkerRepository port (drainPending-facing) ──────────────────────

export interface DeliveryWorkerRepository {
  claimPending(input: ClaimPendingInput): Promise<WebhookDeliveryRow[]>;
  findByEventUid(eventUid: string): Promise<WebhookDeliveryRow | null>;
  /** Record a manual replay attempt (status reset to pending). */
  recordAttempt(input: RecordAttemptInput): Promise<WebhookDeliveryRow>;
  markDelivered(input: MarkDeliveredInput): Promise<WebhookDeliveryRow>;
  markFailed(input: MarkFailedInput): Promise<WebhookDeliveryRow>;
  markDead(id: string, lastError: string, claimToken?: string | null): Promise<WebhookDeliveryRow>;
  getEndpointById(endpointId: string): Promise<WebhookEndpointRow | null>;
}

// ── Unified Prisma implementation ─────────────────────────────────────────────

/**
 * Single Prisma implementation that satisfies all three ports:
 *   - WebhookDeliveryRepository (watcher: enqueue + maxVersionForInvoice)
 *   - WebhookEndpointRepository (watcher fan-out: listForEvent)
 *   - DeliveryWorkerRepository (drainPending: claimPending + mark*)
 */
export class PrismaWebhookDeliveryRepository
  implements WebhookDeliveryRepository, WebhookEndpointRepository, DeliveryWorkerRepository
{
  private readonly db: PrismaClient;

  constructor(db?: PrismaClient) {
    this.db = db ?? getPrismaClient();
  }

  // ── WebhookDeliveryRepository ─────────────────────────────────────────────

  async enqueue(
    input: EnqueueWebhookInput,
    tx?: unknown,
  ): Promise<{ id: string; created: boolean }> {
    const client = (tx as PrismaClient | undefined) ?? this.db;

    // Idempotent: skip if eventUid already exists
    const existing = await client.webhookDelivery.findUnique({
      where: { eventUid: input.eventUid },
      select: { id: true },
    });

    if (existing) {
      return { id: existing.id, created: false };
    }

    const row = await client.webhookDelivery.create({
      data: {
        endpointId: input.endpointId,
        eventType: input.eventType,
        invoiceId: input.invoiceId ?? null,
        payload: input.payload as Parameters<typeof this.db.webhookDelivery.create>[0]["data"]["payload"],
        eventUid: input.eventUid,
        version: input.version,
        nextAttemptAt: input.nextAttemptAt,
        status: "pending",
        attempts: 0,
      },
      select: { id: true },
    });

    return { id: row.id, created: true };
  }

  async maxVersionForInvoice(invoiceId: string, tx?: unknown): Promise<number> {
    const client = (tx as PrismaClient | undefined) ?? this.db;
    const result = await client.webhookDelivery.aggregate({
      where: { invoiceId },
      _max: { version: true },
    });
    return result._max.version ?? 0;
  }

  async maxVersionForInvoiceEndpoint(invoiceId: string, endpointId: string, tx?: unknown): Promise<number> {
    const client = (tx as PrismaClient | undefined) ?? this.db;
    const result = await client.webhookDelivery.aggregate({
      where: { invoiceId, endpointId },
      _max: { version: true },
    });
    return result._max.version ?? 0;
  }

  // ── WebhookEndpointRepository ─────────────────────────────────────────────

  async listForEvent(eventId: string): Promise<WebhookEndpointRow[]> {
    const rows = await this.db.webhookEndpoint.findMany({
      where: {
        active: true,
        OR: [
          { eventId },
          { eventId: null },
        ],
      },
    });
    return rows as WebhookEndpointRow[];
  }

  // ── DeliveryWorkerRepository ──────────────────────────────────────────────

  async claimPending(input: ClaimPendingInput): Promise<WebhookDeliveryRow[]> {
    const now = input.now ?? new Date();
    const limit = input.batchSize ?? 50;
    const claimToken = `claim_${randomBytes(16).toString("hex")}`;
    const claimExpiresAt = new Date(now.getTime() + (input.leaseMs ?? 60_000));
    const claimed = await this.db.$queryRaw<Array<{ id: string }>>`
      WITH candidates AS (
        SELECT "id"
        FROM "WebhookDelivery"
        WHERE "status" = 'pending'
          AND "nextAttemptAt" <= ${now}
          AND ("claimExpiresAt" IS NULL OR "claimExpiresAt" <= ${now})
        ORDER BY "nextAttemptAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "WebhookDelivery" d
      SET
        "claimToken" = ${claimToken},
        "claimedAt" = ${now},
        "claimExpiresAt" = ${claimExpiresAt}
      FROM candidates
      WHERE d."id" = candidates."id"
      RETURNING d."id"
    `;
    const ids = claimed.map((row) => row.id);
    if (ids.length === 0) return [];
    const rows = await this.db.webhookDelivery.findMany({
      where: { id: { in: ids } },
      include: { endpoint: true },
    });
    return rows as unknown as WebhookDeliveryRow[];
  }

  async findByEventUid(eventUid: string): Promise<WebhookDeliveryRow | null> {
    const row = await this.db.webhookDelivery.findUnique({
      where: { eventUid },
      include: { endpoint: true },
    });
    return row as unknown as WebhookDeliveryRow | null;
  }

  async recordAttempt(input: RecordAttemptInput): Promise<WebhookDeliveryRow> {
    const row = await this.db.webhookDelivery.update({
      where: { id: input.id },
      data: {
        attempts: { increment: 1 },
        nextAttemptAt: input.nextAttemptAt,
        lastError: input.lastError ?? null,
        status: input.status,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    return row as unknown as WebhookDeliveryRow;
  }

  async markDelivered(input: MarkDeliveredInput): Promise<WebhookDeliveryRow> {
    const result = await this.db.webhookDelivery.updateMany({
      where: { id: input.id, ...(input.claimToken ? { claimToken: input.claimToken } : {}) },
      data: {
        status: "delivered" as WebhookDeliveryStatus,
        deliveredAt: input.deliveredAt ?? new Date(),
        attempts: { increment: 1 },
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    if (result.count === 0) throw new Error(`Stale claim token for delivery: ${input.id}`);
    const row = await this.db.webhookDelivery.findUniqueOrThrow({ where: { id: input.id } });
    return row as unknown as WebhookDeliveryRow;
  }

  async markFailed(input: MarkFailedInput): Promise<WebhookDeliveryRow> {
    const result = await this.db.webhookDelivery.updateMany({
      where: { id: input.id, ...(input.claimToken ? { claimToken: input.claimToken } : {}) },
      data: {
        status: "failed" as WebhookDeliveryStatus,
        lastError: input.lastError,
        nextAttemptAt: input.nextAttemptAt,
        attempts: { increment: 1 },
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    if (result.count === 0) throw new Error(`Stale claim token for delivery: ${input.id}`);
    const row = await this.db.webhookDelivery.findUniqueOrThrow({ where: { id: input.id } });
    return row as unknown as WebhookDeliveryRow;
  }

  async markDead(id: string, lastError: string, claimToken?: string | null): Promise<WebhookDeliveryRow> {
    const result = await this.db.webhookDelivery.updateMany({
      where: { id, ...(claimToken ? { claimToken } : {}) },
      data: {
        status: "dead" as WebhookDeliveryStatus,
        lastError,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
      },
    });
    if (result.count === 0) throw new Error(`Stale claim token for delivery: ${id}`);
    const row = await this.db.webhookDelivery.findUniqueOrThrow({ where: { id } });
    return row as unknown as WebhookDeliveryRow;
  }

  async getEndpointById(endpointId: string): Promise<WebhookEndpointRow | null> {
    const row = await this.db.webhookEndpoint.findUnique({
      where: { id: endpointId },
    });
    return row as WebhookEndpointRow | null;
  }
}
