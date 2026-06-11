/**
 * In-memory mock implementations of all core port interfaces.
 *
 * Injected by route tests — no real DB, chain, or external services needed.
 * Everything resolves immediately (pure in-memory Maps).
 */

import { createHash, randomBytes } from "crypto";
import type { SweepIntentRepository, SweepIntentRow, SweepIntentItem, SweepIntentStatus } from "../../routes/sweeps.js";
import type {
  EventRepository,
  EventRow,
  CreateEventInput,
  InvoiceRepository,
  InvoiceRow,
  InvoiceSummary,
  CreateInvoiceInput,
  PaymentRow,
  Clock,
  DepositAddressDeriver,
  AddressValidator,
  Network,
  ActiveInvoiceProjection,
  InvoiceStatus,
} from "../../../core/ports.js";
import { parseMicro, formatMicro } from "../../../lib/decimal.js";
import type {
  ApiKeyRepository,
  ApiKeyRecord,
  ApiKeyScope,
  OperatorRepository,
  OperatorRecord,
  LoginTokenRepository,
  LoginTokenRecord,
} from "../../auth.js";
import type { WebhookRepository, WebhookEndpointRecord } from "../../routes/webhooksAdmin.js";
import { RateLimiter } from "../../../lib/rate-limit.js";
import type { AppDeps } from "../../app.js";
import { InMemoryKillSwitchRepository } from "../../killswitch-repo.js";
import type { MerchantRepository } from "../../merchants.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(): string {
  return randomBytes(8).toString("hex");
}

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ── MockEventRepository ───────────────────────────────────────────────────────

export class MockEventRepository implements EventRepository {
  readonly store = new Map<string, EventRow>();

  async insert(input: CreateEventInput): Promise<EventRow> {
    const row: EventRow = {
      id: uid(),
      name: input.name,
      status: "active",
      mainWalletAddress: input.mainWalletAddress,
      derivationAccount: input.derivationAccount,
      xpubAccount: input.xpubAccount,
      nextInvoiceIndex: 0,
      merchantId: input.merchantId ?? null,
      createdAt: new Date(),
    };
    this.store.set(row.id, row);
    return row;
  }

  async findById(id: string): Promise<EventRow | null> {
    return this.store.get(id) ?? null;
  }

  /** Optional tenant filter mirrors PrismaEventRepository.list semantics. */
  async list(filter?: { merchantId?: string | null }): Promise<EventRow[]> {
    let rows = Array.from(this.store.values());
    if (filter !== undefined && filter.merchantId !== undefined) {
      rows = rows.filter((r) => (r.merchantId ?? null) === filter.merchantId);
    }
    return rows;
  }

  seed(partial: Partial<EventRow> & Pick<EventRow, "id">): EventRow {
    const row: EventRow = {
      name: "Test Event",
      status: "active",
      mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
      derivationAccount: 0,
      xpubAccount: "xpub_mock",
      nextInvoiceIndex: 0,
      merchantId: null,
      createdAt: new Date(),
      ...partial,
    };
    this.store.set(row.id, row);
    return row;
  }
}

// ── MockInvoiceRepository ─────────────────────────────────────────────────────

export class MockInvoiceRepository implements InvoiceRepository {
  readonly store = new Map<string, InvoiceRow>();
  private paymentStore = new Map<string, PaymentRow[]>();
  private indexCounters = new Map<string, number>();

  /**
   * Optional event repo for tenant filtering in list() — mirrors the Prisma
   * Invoice → Event join. When absent, all events are treated as null-tenant.
   */
  constructor(private readonly eventRepo?: MockEventRepository) {}

  /** Resolve the tenant of an invoice via its event (null when unknown). */
  private eventMerchantId(eventId: string): string | null {
    return this.eventRepo?.store.get(eventId)?.merchantId ?? null;
  }

  async allocateNextInvoiceIndex(eventId: string): Promise<number> {
    const current = this.indexCounters.get(eventId) ?? 0;
    this.indexCounters.set(eventId, current + 1);
    return current;
  }

  async insert(input: CreateInvoiceInput): Promise<InvoiceRow> {
    const row: InvoiceRow = {
      id: uid(),
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
    this.store.set(row.id, row);
    return row;
  }

  async findById(id: string): Promise<InvoiceRow | null> {
    return this.store.get(id) ?? null;
  }

  async findWithPayments(
    invoiceId: string,
  ): Promise<{ invoice: InvoiceRow; payments: PaymentRow[] } | null> {
    const invoice = this.store.get(invoiceId);
    if (!invoice) return null;
    const payments = this.paymentStore.get(invoiceId) ?? [];
    return { invoice, payments };
  }

  async updateStatus(
    invoiceId: string,
    status: InvoiceRow["status"],
    extra?: { amountReceived?: string; paidAt?: Date },
  ): Promise<InvoiceRow> {
    const existing = this.store.get(invoiceId);
    if (!existing) throw new Error(`Invoice "${invoiceId}" not found`);
    const updated: InvoiceRow = {
      ...existing,
      status,
      ...(extra?.amountReceived !== undefined && { amountReceived: extra.amountReceived }),
      ...(extra?.paidAt !== undefined && { paidAt: extra.paidAt }),
    };
    this.store.set(invoiceId, updated);
    return updated;
  }

  async list(opts: {
    eventId?: string;
    status?: import("../../../core/ports.js").InvoiceStatus;
    q?: string;
    metadata?: Record<string, string>;
    cursor?: string;
    limit?: number;
    merchantId?: string | null;
  }): Promise<InvoiceRow[]> {
    let rows = Array.from(this.store.values());
    // Tenant filter (multi-merchant isolation): undefined = no filtering,
    // null = legacy default tenant, string = that tenant only.
    if (opts.merchantId !== undefined) {
      rows = rows.filter((r) => this.eventMerchantId(r.eventId) === opts.merchantId);
    }
    if (opts.eventId) rows = rows.filter((r) => r.eventId === opts.eventId);
    if (opts.status) rows = rows.filter((r) => r.status === opts.status);

    // q: case-insensitive contains over JSON-stringified metadata (best-effort).
    if (opts.q) {
      const needle = opts.q.toLowerCase();
      rows = rows.filter((r) => {
        const hay = r.metadata ? JSON.stringify(r.metadata).toLowerCase() : "";
        return hay.includes(needle);
      });
    }

    // metadata.<key>=<value>: typed JSON path match — uses strict equality
    // per Prisma's typed path filter; never string-concatenates key into SQL.
    if (opts.metadata) {
      for (const [key, value] of Object.entries(opts.metadata)) {
        rows = rows.filter((r) => {
          if (!r.metadata) return false;
          return String((r.metadata as Record<string, unknown>)[key]) === value;
        });
      }
    }

    return rows.slice(0, opts.limit ?? 20);
  }

  async listActiveForWatch(network: Network, _graceDays?: number): Promise<ActiveInvoiceProjection[]> {
    const activeStatuses = new Set<InvoiceStatus>(["pending", "payment_detected", "overdue"]);
    // Grace-window statuses included for in-memory mock (simplified: always include terminal)
    const graceStatuses = new Set<InvoiceStatus>(["paid", "overpaid", "underpaid", "expired", "canceled"]);
    const graceDays = _graceDays ?? 30;
    const graceWindowStart = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

    return Array.from(this.store.values())
      .filter((r) => {
        if (r.network !== network) return false;
        if (activeStatuses.has(r.status)) return true;
        if (graceStatuses.has(r.status)) {
          // Include if closed within grace window
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
    const sweepableStatuses = new Set<InvoiceStatus>(["paid", "overpaid", "underpaid", "overdue"]);
    return Array.from(this.store.values())
      .filter(
        (r) =>
          r.eventId === eventId &&
          sweepableStatuses.has(r.status) &&
          r.amountReceived !== "0.000000",
      )
      .map((r) => ({
        depositAddress: r.depositAddress,
        derivationIndex: r.derivationIndex,
        amountReceived: r.amountReceived,
        status: r.status,
      }));
  }

  async summary(eventId?: string): Promise<InvoiceSummary> {
    let rows = Array.from(this.store.values());
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
      // settledCount: confirmed funds — paid + overpaid.
      settledCount: (byStatus["paid"] ?? 0) + (byStatus["overpaid"] ?? 0),
      pendingCount: byStatus["pending"] ?? 0,
      totalAmountReceived: formatMicro(totalMicro),
      byStatus,
    };
  }

  seed(partial: Partial<InvoiceRow> & Pick<InvoiceRow, "id" | "eventId">): InvoiceRow {
    const row: InvoiceRow = {
      status: "pending",
      priceFiat: "100.00",
      fiatCurrency: "USD",
      amountUsdt: "100.000000",
      amountReceived: "0.000000",
      rateLockedAt: new Date(),
      network: "TRON",
      depositAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
      derivationIndex: 0,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      metadata: null,
      createdAt: new Date(),
      paidAt: null,
      ...partial,
    };
    this.store.set(row.id, row);
    return row;
  }

  /** Seed a payment row directly into the payment store (for testing confirmations). */
  seedPayment(invoiceId: string, payment: PaymentRow): void {
    const existing = this.paymentStore.get(invoiceId) ?? [];
    this.paymentStore.set(invoiceId, [...existing, payment]);
  }
}

// ── MockApiKeyRepository ──────────────────────────────────────────────────────

export class MockApiKeyRepository implements ApiKeyRepository {
  readonly store = new Map<string, ApiKeyRecord>();
  private byHash = new Map<string, string>(); // hashedKey → id

  async findByHash(hashedKey: string): Promise<ApiKeyRecord | null> {
    const id = this.byHash.get(hashedKey);
    if (!id) return null;
    return this.store.get(id) ?? null;
  }

  async insert(input: {
    label: string;
    hashedKey: string;
    prefix: string;
    scope: ApiKeyScope;
    eventId?: string | null;
    merchantId?: string | null;
  }): Promise<ApiKeyRecord> {
    const id = uid();
    const record: ApiKeyRecord = {
      id,
      label: input.label,
      hashedKey: input.hashedKey,
      prefix: input.prefix,
      scope: input.scope,
      eventId: input.eventId ?? null,
      merchantId: input.merchantId ?? null,
      createdAt: new Date(),
      revokedAt: null,
    };
    this.store.set(id, record);
    this.byHash.set(input.hashedKey, id);
    return record;
  }

  async list(): Promise<ApiKeyRecord[]> {
    return Array.from(this.store.values());
  }

  async revoke(id: string): Promise<ApiKeyRecord | null> {
    const record = this.store.get(id);
    if (!record) return null;
    const updated = { ...record, revokedAt: new Date() };
    this.store.set(id, updated);
    return updated;
  }

  async findById(id: string): Promise<ApiKeyRecord | null> {
    return this.store.get(id) ?? null;
  }

  seedKey(opts: {
    rawKey: string;
    scope: ApiKeyScope;
    label?: string;
    revoked?: boolean;
    eventId?: string | null;
    merchantId?: string | null;
  }): ApiKeyRecord {
    const hashed = sha256hex(opts.rawKey);
    const prefix = opts.rawKey.slice(0, 8);
    const id = uid();
    const record: ApiKeyRecord = {
      id,
      label: opts.label ?? "test-key",
      hashedKey: hashed,
      prefix,
      scope: opts.scope,
      eventId: opts.eventId ?? null,
      merchantId: opts.merchantId ?? null,
      createdAt: new Date(),
      revokedAt: opts.revoked ? new Date() : null,
    };
    this.store.set(id, record);
    this.byHash.set(hashed, id);
    return record;
  }
}

// ── MockOperatorRepository ────────────────────────────────────────────────────

export class MockOperatorRepository implements OperatorRepository {
  readonly store = new Map<string, OperatorRecord>();

  async findByEmail(email: string): Promise<OperatorRecord | null> {
    for (const op of this.store.values()) {
      if (op.email === email) return op;
    }
    return null;
  }

  async findById(id: string): Promise<OperatorRecord | null> {
    return this.store.get(id) ?? null;
  }

  async create(email: string, passwordHash: string): Promise<OperatorRecord> {
    // Reject duplicate emails (mirrors Postgres @unique constraint).
    for (const op of this.store.values()) {
      if (op.email === email) {
        const err = new Error(`Unique constraint violation: Operator email "${email}" already exists`);
        (err as Error & { code?: string }).code = "P2002";
        throw err;
      }
    }
    const record: OperatorRecord = { id: uid(), email, passwordHash };
    this.store.set(record.id, record);
    return record;
  }

  seedOperator(op: OperatorRecord): void {
    this.store.set(op.id, op);
  }
}

// ── MockLoginTokenRepository ──────────────────────────────────────────────────

export class MockLoginTokenRepository implements LoginTokenRepository {
  /** tokenHash → record */
  readonly store = new Map<string, LoginTokenRecord>();

  async create(input: {
    tokenHash: string;
    operatorId: string;
    expiresAt: Date;
  }): Promise<LoginTokenRecord> {
    const record: LoginTokenRecord = {
      id: uid(),
      tokenHash: input.tokenHash,
      operatorId: input.operatorId,
      expiresAt: input.expiresAt,
      usedAt: null,
      createdAt: new Date(),
    };
    this.store.set(record.tokenHash, record);
    return record;
  }

  /** Mirrors the Prisma guarded updateMany: unused AND unexpired, atomically marked used. */
  async consume(tokenHash: string, now: Date): Promise<LoginTokenRecord | null> {
    const record = this.store.get(tokenHash);
    if (!record) return null;
    if (record.usedAt !== null) return null;
    if (record.expiresAt.getTime() <= now.getTime()) return null;
    const updated = { ...record, usedAt: now };
    this.store.set(tokenHash, updated);
    return updated;
  }

  /** Seed a token from its RAW value (hashed here, like the CLI does). */
  seedToken(opts: {
    rawToken: string;
    operatorId: string;
    expiresAt?: Date;
    usedAt?: Date | null;
  }): LoginTokenRecord {
    const record: LoginTokenRecord = {
      id: uid(),
      tokenHash: sha256hex(opts.rawToken),
      operatorId: opts.operatorId,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
      usedAt: opts.usedAt ?? null,
      createdAt: new Date(),
    };
    this.store.set(record.tokenHash, record);
    return record;
  }
}

// ── MockWebhookRepository ─────────────────────────────────────────────────────

export class MockWebhookRepository implements WebhookRepository {
  readonly store = new Map<string, WebhookEndpointRecord>();

  async insert(input: {
    eventId: string | null;
    url: string;
    secret: string;
  }): Promise<WebhookEndpointRecord> {
    const record: WebhookEndpointRecord = {
      id: uid(),
      eventId: input.eventId,
      url: input.url,
      secret: input.secret,
      active: true,
      createdAt: new Date(),
    };
    this.store.set(record.id, record);
    return record;
  }

  async list(): Promise<WebhookEndpointRecord[]> {
    return Array.from(this.store.values());
  }

  async findById(id: string): Promise<WebhookEndpointRecord | null> {
    return this.store.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  seedEndpoint(
    partial: Partial<Omit<WebhookEndpointRecord, "id" | "createdAt">> &
      Pick<WebhookEndpointRecord, "url">,
  ): WebhookEndpointRecord {
    const record: WebhookEndpointRecord = {
      id: uid(),
      eventId: partial.eventId ?? null,
      url: partial.url,
      secret: partial.secret ?? "test-secret",
      active: partial.active ?? true,
      createdAt: new Date(),
    };
    this.store.set(record.id, record);
    return record;
  }
}

// ── MockDeriver ───────────────────────────────────────────────────────────────

export class MockDeriver implements DepositAddressDeriver {
  derive(_xpubAccount: string, index: number): string {
    return `TTestAddress${String(index).padStart(10, "0")}XXXXX`;
  }
}

// ── MockClock ─────────────────────────────────────────────────────────────────

export class MockClock implements Clock {
  private _now: Date;

  constructor(now: Date = new Date("2025-01-01T00:00:00Z")) {
    this._now = now;
  }

  now(): Date {
    return this._now;
  }

  set(d: Date): void {
    this._now = d;
  }

  advance(ms: number): void {
    this._now = new Date(this._now.getTime() + ms);
  }
}

// ── MockAddressValidator ──────────────────────────────────────────────────────

export class MockAddressValidator implements AddressValidator {
  isValid(address: string, _network: Network): boolean {
    return typeof address === "string" && address.startsWith("T") && address.length >= 10;
  }
}

// ── Unbounded rate limiter (effectively no-op) ────────────────────────────────

export class UnboundedRateLimiter extends RateLimiter {
  constructor() {
    super({
      public_status: { maxRequests: 999_999, windowMs: 60_000 },
      invoice_create: { maxRequests: 999_999, windowMs: 60_000 },
      admin: { maxRequests: 999_999, windowMs: 60_000 },
      merchant_read: { maxRequests: 999_999, windowMs: 60_000 },
      // login: unbounded for tests that don't test rate-limiting behaviour.
      // Tests that need a real limit construct their own RateLimiter with a
      // tight login bucket and pass it via buildTestDeps({ rateLimiter: ... }).
      login: { maxRequests: 999_999, windowMs: 60_000 },
      // dashboard: unbounded for tests
      dashboard: { maxRequests: 999_999, windowMs: 60_000 },
      // signup: unbounded for tests that don't test rate-limiting behaviour.
      signup: { maxRequests: 999_999, windowMs: 60_000 },
    });
  }
}

// ── MockSweepIntentRepository ─────────────────────────────────────────────────

export class MockSweepIntentRepository implements SweepIntentRepository {
  readonly store = new Map<string, SweepIntentRow>();

  async insert(intent: Omit<SweepIntentRow, "id" | "createdAt">): Promise<SweepIntentRow> {
    const id = randomBytes(8).toString("hex");
    const row: SweepIntentRow = { id, ...intent, createdAt: new Date() };
    this.store.set(id, row);
    return row;
  }

  async findById(id: string): Promise<SweepIntentRow | null> {
    return this.store.get(id) ?? null;
  }

  async updateStatus(id: string, status: SweepIntentStatus): Promise<SweepIntentRow> {
    const row = this.store.get(id);
    if (!row) throw new Error(`SweepIntent "${id}" not found`);
    const updated = { ...row, status };
    this.store.set(id, updated);
    return updated;
  }

  async updateItems(id: string, items: SweepIntentItem[]): Promise<SweepIntentRow> {
    const row = this.store.get(id);
    if (!row) throw new Error(`SweepIntent "${id}" not found`);
    const updated = { ...row, items };
    this.store.set(id, updated);
    return updated;
  }
}

// ── buildTestDeps ─────────────────────────────────────────────────────────────

/**
 * Build a complete AppDeps bundle with in-memory mocks and pre-seeded keys.
 */
export function buildTestDeps(overrides?: Partial<AppDeps>): AppDeps & {
  adminKey: string;
  merchantKey: string;
  killSwitchRepo: InMemoryKillSwitchRepository;
  loginTokenRepo: MockLoginTokenRepository;
} {
  const eventRepo = new MockEventRepository();
  // Wire eventRepo into the invoice repo so list() can resolve invoice tenancy
  // through the event (mirrors the Prisma join).
  const invoiceRepo = new MockInvoiceRepository(eventRepo);
  const apiKeyRepo = new MockApiKeyRepository();
  const operatorRepo = new MockOperatorRepository();
  const loginTokenRepo = new MockLoginTokenRepository();
  const webhookRepo = new MockWebhookRepository();
  const sweepIntentRepo = new MockSweepIntentRepository();
  const deriver = new MockDeriver();
  const clock = new MockClock();
  const rateLimiter = new UnboundedRateLimiter();
  const addressValidator = new MockAddressValidator();
  const killSwitchRepo = new InMemoryKillSwitchRepository();

  const adminRaw = "adminkey_test_1234567890abcdef0000";
  const merchantRaw = "merchantkey_test_1234567890abcdef";

  apiKeyRepo.seedKey({ rawKey: adminRaw, scope: "admin", label: "test-admin" });
  apiKeyRepo.seedKey({ rawKey: merchantRaw, scope: "merchant", label: "test-merchant" });

  const getRateConfig = () => ({
    microUsdtPerFiatUnit: 1_000_000n,
    lockedAt: clock.now(),
  });

  const merged: AppDeps = {
    eventRepo,
    invoiceRepo,
    deriver,
    clock,
    getRateConfig,
    apiKeyRepo,
    operatorRepo,
    loginTokenRepo,
    webhookRepo,
    sweepIntentRepo,
    rateLimiter,
    addressValidator,
    killSwitchRepo,
    logLevel: "silent",
    ...overrides,
  };

  return {
    ...merged,
    // These two are always from the local vars — not overridable via AppDeps.
    adminKey: adminRaw,
    merchantKey: merchantRaw,
    // Expose the concrete InMemoryKillSwitchRepository so tests can call
    // .reset() / .setFlag() directly.  If the caller passed overrides.killSwitchRepo,
    // use that (cast to InMemoryKillSwitchRepository); otherwise use the local default.
    killSwitchRepo: (overrides?.killSwitchRepo as InMemoryKillSwitchRepository) ?? killSwitchRepo,
    // Same pattern: expose the concrete mock so tests can seed tokens directly.
    loginTokenRepo: (overrides?.loginTokenRepo as MockLoginTokenRepository) ?? loginTokenRepo,
  };
}
