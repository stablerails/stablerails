/**
 * In-memory repo for WebhookDelivery + WebhookEndpoint — for offline tests.
 *
 * Satisfies all three ports from WebhookDeliveryRepository.ts:
 *   - WebhookDeliveryRepository (watcher: enqueue + maxVersionForInvoice)
 *   - WebhookEndpointRepository (watcher fan-out: listForEvent)
 *   - DeliveryWorkerRepository  (drainPending: claimPending + mark*)
 *
 * FK enforcement: enqueue() throws if endpointId is not present in the endpoint
 * store, mirroring the FK constraint on WebhookDelivery.endpointId in Postgres.
 * This ensures tests catch fabricated endpoint ids at enqueue time.
 *
 * No Prisma, no network, no DATABASE_URL required.
 */

import type {
  WebhookDeliveryRow,
  WebhookEndpointRow,
  WebhookDeliveryStatus,
  ClaimPendingInput,
  RecordAttemptInput,
  MarkDeliveredInput,
  MarkFailedInput,
  DeliveryWorkerRepository,
  WebhookDeliveryRepository,
  WebhookEndpointRepository,
  EnqueueWebhookInput,
} from "./WebhookDeliveryRepository.js";

export class InMemoryWebhookDeliveryRepo
  implements WebhookDeliveryRepository, WebhookEndpointRepository, DeliveryWorkerRepository
{
  private deliveries = new Map<string, WebhookDeliveryRow>();
  private endpoints = new Map<string, WebhookEndpointRow>();

  // ── Seed helpers ────────────────────────────────────────────────────────────

  seedDelivery(
    row: Omit<WebhookDeliveryRow, "claimToken" | "claimedAt" | "claimExpiresAt"> &
      Partial<Pick<WebhookDeliveryRow, "claimToken" | "claimedAt" | "claimExpiresAt">>,
  ): void {
    this.deliveries.set(row.id, {
      ...row,
      claimToken: row.claimToken ?? null,
      claimedAt: row.claimedAt ?? null,
      claimExpiresAt: row.claimExpiresAt ?? null,
    });
  }

  seedEndpoint(row: WebhookEndpointRow): void {
    this.endpoints.set(row.id, { ...row });
  }

  getAllDeliveries(): WebhookDeliveryRow[] {
    return [...this.deliveries.values()];
  }

  // ── WebhookDeliveryRepository (watcher port) ────────────────────────────────

  /**
   * Idempotent enqueue on eventUid.
   *
   * FK-enforcing: throws if endpointId is not registered in the endpoint store.
   * This mirrors the Postgres FK on WebhookDelivery.endpointId so tests catch
   * fabricated ids (e.g. `invoice:${invoiceId}`) at enqueue time.
   */
  async enqueue(input: EnqueueWebhookInput, _tx?: unknown): Promise<{ id: string; created: boolean }> {
    // FK check: endpointId must exist in the endpoint store
    if (!this.endpoints.has(input.endpointId)) {
      throw new Error(
        `FK violation: endpointId "${input.endpointId}" is not registered. ` +
          `Register it via seedEndpoint() before enqueueing.`,
      );
    }

    const existing = this.getAllDeliveries().find((d) => d.eventUid === input.eventUid);
    if (existing) return { id: existing.id, created: false };

    const id = `wh-${Math.random().toString(36).slice(2, 10)}`;
    this.seedDelivery({
      id,
      endpointId: input.endpointId,
      eventType: input.eventType,
      invoiceId: input.invoiceId ?? null,
      payload: input.payload,
      eventUid: input.eventUid,
      version: input.version,
      attempts: 0,
      status: "pending",
      nextAttemptAt: input.nextAttemptAt,
      lastError: null,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      createdAt: new Date(),
      deliveredAt: null,
    });
    return { id, created: true };
  }

  async maxVersionForInvoice(invoiceId: string, _tx?: unknown): Promise<number> {
    const all = this.getAllDeliveries().filter((d) => d.invoiceId === invoiceId);
    if (all.length === 0) return 0;
    return all.reduce((max, d) => Math.max(max, d.version), 0);
  }

  async maxVersionForInvoiceEndpoint(invoiceId: string, endpointId: string, _tx?: unknown): Promise<number> {
    const all = this.getAllDeliveries().filter(
      (d) => d.invoiceId === invoiceId && d.endpointId === endpointId,
    );
    if (all.length === 0) return 0;
    return all.reduce((max, d) => Math.max(max, d.version), 0);
  }

  // ── WebhookEndpointRepository (watcher fan-out port) ────────────────────────

  async listForEvent(eventId: string): Promise<WebhookEndpointRow[]> {
    return [...this.endpoints.values()].filter(
      (ep) => ep.active && (ep.eventId === eventId || ep.eventId === null),
    );
  }

  // ── DeliveryWorkerRepository (drainPending port) ────────────────────────────

  async claimPending(input: ClaimPendingInput): Promise<WebhookDeliveryRow[]> {
    const now = input.now ?? new Date();
    const limit = input.batchSize ?? 50;
    const claimExpiresAt = new Date(now.getTime() + (input.leaseMs ?? 60_000));

    const rows = [...this.deliveries.values()]
      .filter(
        (d) =>
          d.status === "pending" &&
          d.nextAttemptAt <= now &&
          (d.claimExpiresAt === null || d.claimExpiresAt <= now),
      )
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);

    return rows.map((row) => {
      const updated: WebhookDeliveryRow = {
        ...row,
        claimToken: `claim_${Math.random().toString(36).slice(2, 14)}`,
        claimedAt: now,
        claimExpiresAt,
      };
      this.deliveries.set(row.id, updated);
      return this.withEndpoint(updated);
    });
  }

  async findByEventUid(eventUid: string): Promise<WebhookDeliveryRow | null> {
    const row = [...this.deliveries.values()].find((d) => d.eventUid === eventUid);
    return row ? this.withEndpoint(row) : null;
  }

  async recordAttempt(input: RecordAttemptInput): Promise<WebhookDeliveryRow> {
    const row = this.getOrThrow(input.id);
    const updated: WebhookDeliveryRow = {
      ...row,
      attempts: row.attempts + 1,
      nextAttemptAt: input.nextAttemptAt,
      lastError: input.lastError ?? null,
      status: input.status,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
    };
    this.deliveries.set(input.id, updated);
    return this.withEndpoint(updated);
  }

  async markDelivered(input: MarkDeliveredInput): Promise<WebhookDeliveryRow> {
    const row = this.getOrThrow(input.id);
    this.assertClaimToken(row, input.claimToken);
    const updated: WebhookDeliveryRow = {
      ...row,
      status: "delivered" as WebhookDeliveryStatus,
      deliveredAt: input.deliveredAt ?? new Date(),
      attempts: row.attempts + 1,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
    };
    this.deliveries.set(input.id, updated);
    return this.withEndpoint(updated);
  }

  async markFailed(input: MarkFailedInput): Promise<WebhookDeliveryRow> {
    const row = this.getOrThrow(input.id);
    this.assertClaimToken(row, input.claimToken);
    const updated: WebhookDeliveryRow = {
      ...row,
      status: "failed" as WebhookDeliveryStatus,
      lastError: input.lastError,
      nextAttemptAt: input.nextAttemptAt,
      attempts: row.attempts + 1,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
    };
    this.deliveries.set(input.id, updated);
    return this.withEndpoint(updated);
  }

  async markDead(id: string, lastError: string, claimToken?: string | null): Promise<WebhookDeliveryRow> {
    const row = this.getOrThrow(id);
    this.assertClaimToken(row, claimToken);
    const updated: WebhookDeliveryRow = {
      ...row,
      status: "dead" as WebhookDeliveryStatus,
      lastError,
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
    };
    this.deliveries.set(id, updated);
    return this.withEndpoint(updated);
  }

  async getEndpointById(endpointId: string): Promise<WebhookEndpointRow | null> {
    return this.endpoints.get(endpointId) ?? null;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private getOrThrow(id: string): WebhookDeliveryRow {
    const row = this.deliveries.get(id);
    if (!row) throw new Error(`Delivery not found: ${id}`);
    return row;
  }

  private withEndpoint(row: WebhookDeliveryRow): WebhookDeliveryRow {
    const ep = this.endpoints.get(row.endpointId);
    return ep ? { ...row, endpoint: ep } : row;
  }

  private assertClaimToken(row: WebhookDeliveryRow, claimToken?: string | null): void {
    if (claimToken && row.claimToken !== claimToken) {
      throw new Error(`Stale claim token for delivery: ${row.id}`);
    }
  }
}
