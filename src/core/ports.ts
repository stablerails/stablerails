/**
 * Core domain port interfaces (spec §2.1).
 *
 * ALL external I/O is expressed as these interfaces so core logic remains pure
 * and testable without Prisma, the chain, or any other concrete adapter.
 * Concrete adapters are wired in Sprint 4 (server) and Sprint 5 (watcher).
 */

// ── Domain types used across ports ───────────────────────────────────────────

export type Network = "TRON";

export type InvoiceStatus =
  | "pending"
  | "payment_detected"
  | "paid"
  | "underpaid"
  | "overpaid"
  | "expired"
  | "canceled"
  | "overdue";

export type PaymentStatus = "detected" | "confirmed" | "orphaned";

/** Minimal Event shape the core needs — no Prisma import required. */
export interface EventRow {
  id: string;
  name: string;
  status: "active" | "archived";
  mainWalletAddress: string;
  derivationAccount: number;
  xpubAccount: string;
  nextInvoiceIndex: number;
  /**
   * Multi-merchant tenancy: owner tenant of this event.
   * null/undefined = legacy "default tenant". Invoices inherit tenancy
   * through their event. Optional for backward compatibility with
   * pre-tenancy fixtures.
   */
  merchantId?: string | null;
  createdAt: Date;
}

/** Minimal Invoice shape the core needs. */
export interface InvoiceRow {
  id: string;
  eventId: string;
  status: InvoiceStatus;
  priceFiat: string; // decimal string, e.g. "100.00"
  fiatCurrency: string; // ISO 4217
  amountUsdt: string; // micro-USDT decimal string, e.g. "100.000000"
  amountReceived: string;
  rateLockedAt: Date;
  network: Network;
  depositAddress: string;
  derivationIndex: number;
  expiresAt: Date;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  paidAt: Date | null;
}

/** Minimal Payment shape the core needs. */
export interface PaymentRow {
  id: string;
  invoiceId: string;
  txHash: string;
  logIndex: number;
  network: Network;
  fromAddress: string;
  amountUsdt: string; // micro-USDT decimal string
  blockNumber: bigint;
  blockHash: string;
  status: PaymentStatus;
  detectedAt: Date;
  confirmedAt: Date | null;
}

// ── Port: Clock ───────────────────────────────────────────────────────────────

/** Injected clock so core is time-testable. */
export interface Clock {
  now(): Date;
}

// ── Port: AddressValidator ────────────────────────────────────────────────────

/** Pure check that an address is valid for a given network. */
export interface AddressValidator {
  isValid(address: string, network: Network): boolean;
}

// ── Port: DepositAddressDeriver ───────────────────────────────────────────────

/**
 * Derive the deposit address for a given xpubAccount + derivation index.
 * The concrete adapter in Sprint 4 will delegate to src/chain/tron/deriveAddress.
 */
export interface DepositAddressDeriver {
  derive(xpubAccount: string, index: number): string;
}

// ── Port: RateSource ──────────────────────────────────────────────────────────

/**
 * Convert fiat amount (decimal string) to micro-USDT (bigint).
 * The source may be a fixed rate (MVP) or a live oracle (future).
 */
export interface RateSource {
  /**
   * @param fiatAmount  Fiat amount as a decimal string (e.g. "100.00")
   * @param currency    ISO 4217 fiat currency code (e.g. "USD", "RUB")
   * @returns micro-USDT (bigint, 6 decimals)
   */
  toMicroUsdt(fiatAmount: string, currency: string): bigint;
}

// ── Port: EventRepository ─────────────────────────────────────────────────────

export interface CreateEventInput {
  name: string;
  mainWalletAddress: string;
  derivationAccount: number;
  xpubAccount: string;
  /** Owner tenant. null/omitted = legacy default tenant. */
  merchantId?: string | null;
}

export interface EventRepository {
  /** Insert a new event row. Returns the persisted row. */
  insert(input: CreateEventInput): Promise<EventRow>;
  /** Load event by id. Returns null if not found. */
  findById(id: string): Promise<EventRow | null>;
}

// ── Domain type: InvoiceSummary ───────────────────────────────────────────────

/**
 * Aggregated read-only summary over invoice rows.
 * Used by the operator dashboard — no money-logic, display-only arithmetic.
 */
export interface InvoiceSummary {
  /** Total invoice count across all statuses. */
  totalCount: number;
  /** Count of invoices with status="paid" only (granular). */
  paidCount: number;
  /**
   * Count of confirmed-funds invoices: status="paid" + status="overpaid".
   * Overpaid means funds arrived and were confirmed — customer simply sent too much.
   * Use this for the "Оплачено / settled" KPI card.
   */
  settledCount: number;
  /** Count of invoices with status="pending". */
  pendingCount: number;
  /**
   * Sum of amountReceived across all rows, as a decimal micro-USDT string
   * (e.g. "125.000000"). Uses parseMicro/formatMicro — no float arithmetic.
   */
  totalAmountReceived: string;
  /** Per-status invoice counts. */
  byStatus: Partial<Record<InvoiceStatus, number>>;
}

// ── Port: InvoiceRepository ───────────────────────────────────────────────────

export interface CreateInvoiceInput {
  eventId: string;
  priceFiat: string;
  fiatCurrency: string;
  amountUsdt: string;
  rateLockedAt: Date;
  network: Network;
  depositAddress: string;
  derivationIndex: number;
  expiresAt: Date;
  metadata: Record<string, unknown> | null;
}

/** Minimal projection returned by listActiveForWatch — only what the watcher needs. */
export interface ActiveInvoiceProjection {
  id: string;
  depositAddress: string;
  amountUsdt: string;
  network: Network;
  expiresAt: Date;
  status: InvoiceStatus;
}

export interface InvoiceRepository {
  /**
   * Atomically allocate the next derivation index for an event and return it.
   * The concrete adapter MUST hold a row-level lock / serializable transaction
   * to ensure monotonic, never-reused indices. Core just calls this port and
   * treats the returned index as authoritative.
   */
  allocateNextInvoiceIndex(eventId: string): Promise<number>;

  /** Insert a new invoice row. Returns the persisted row. */
  insert(input: CreateInvoiceInput): Promise<InvoiceRow>;

  /** Load invoice by id. Returns null if not found. */
  findById(id: string): Promise<InvoiceRow | null>;

  /**
   * Load invoice with all its payments in one call.
   * Returns null if the invoice is not found.
   *
   * @param tx  Optional Prisma transaction client.
   */
  findWithPayments(invoiceId: string, tx?: unknown): Promise<{ invoice: InvoiceRow; payments: PaymentRow[] } | null>;

  /**
   * Persist a status transition.
   * Core dictates what the new status should be; adapter applies it.
   *
   * @param tx  Optional Prisma transaction client.
   */
  updateStatus(
    invoiceId: string,
    status: InvoiceStatus,
    extra?: { amountReceived?: string; paidAt?: Date },
    tx?: unknown,
  ): Promise<InvoiceRow>;

  /**
   * Return all invoices that the watcher should actively poll.
   *
   * Always-active statuses: pending, payment_detected, overdue.
   *
   * Grace-window statuses (C2 fix): terminal invoices (paid, overpaid, underpaid,
   * expired, canceled) whose paidAt/expiresAt/createdAt is within the last
   * LATE_FUNDS_GRACE_DAYS days are also returned so late payments are never
   * silently lost. Once the grace window expires the address drops out of the
   * poll set — the fund has been missed regardless.
   *
   * Concrete adapters query by network for the relevant deposit addresses.
   */
  listActiveForWatch(network: Network, graceDays?: number): Promise<ActiveInvoiceProjection[]>;

  /**
   * Return all fund-holding invoices for an event that should be swept.
   *
   * Sweepable statuses: paid, overpaid, underpaid, overdue.
   * Returns only invoices with amountReceived > 0 (actual on-chain funds received).
   */
  listSweepableForEvent(eventId: string): Promise<
    Array<{
      depositAddress: string;
      derivationIndex: number;
      amountReceived: string;
      status: InvoiceStatus;
    }>
  >;

  /**
   * List invoices with optional filters.
   *
   * merchantId is the tenant filter (multi-merchant isolation):
   *   - undefined → no tenant filtering (admin callers)
   *   - null      → legacy default tenant: only invoices whose event has merchantId = null
   *   - string    → only invoices whose event has that merchantId
   */
  list(opts: {
    eventId?: string;
    status?: InvoiceStatus;
    q?: string;
    metadata?: Record<string, string>;
    cursor?: string;
    limit?: number;
    merchantId?: string | null;
  }): Promise<InvoiceRow[]>;

  /**
   * Aggregated read-only summary over all invoices (optionally filtered by eventId).
   * Additive — no money-movement, no state transitions.
   * Concrete DB adapters use COUNT/groupBy/aggregate; mock uses in-memory arithmetic.
   */
  summary(eventId?: string): Promise<InvoiceSummary>;
}

// ── Port: PaymentRepository ───────────────────────────────────────────────────

/**
 * Sentinel block number meaning "placement not yet confirmed by BOTH providers"
 * (WATCH-1). It exceeds any real Tron block height, so a payment carrying it can
 * never pass the finality gate (blockNumber <= latestSolidBlock) and stays
 * "detected" until both providers agree on a real block number.
 */
export const UNCONFIRMED_BLOCK_SENTINEL = BigInt(Number.MAX_SAFE_INTEGER);

export interface RecordPaymentInput {
  invoiceId: string;
  txHash: string;
  logIndex: number;
  network: Network;
  fromAddress: string;
  amountUsdt: string;
  blockNumber: bigint;
  blockHash: string;
  status: PaymentStatus;
}

export interface PaymentRepository {
  /**
   * Upsert on (network, txHash, logIndex).
   * - New row: insert and return { created: true }.
   * - Existing row in "detected" status: refresh blockNumber from input and
   *   return { created: false }. This allows a two-tick recovery when a
   *   transient secondary lag caused MAX_BN to be stored on tick 1; tick 2
   *   corrects blockNumber so the M-4 replay gate
   *   (blockNumber <= latestSolidBlock) can fire.
   *   blockHash is NOT updated here — checkReorg compares the original stored
   *   blockHash against the incoming value to detect chain reorganisations.
   * - Existing row in "orphaned" status AND input carries a confirmed placement
   *   (blockNumber < UNCONFIRMED_BLOCK_SENTINEL, non-empty blockHash): revive to
   *   "detected" with the fresh blockNumber/blockHash (tx re-mined after a
   *   pre-solid reorg). The status is forced to "detected" regardless of
   *   input.status — crediting still goes through the normal
   *   detected→confirmed solid gate, never straight to confirmed.
   *   amountUsdt remains immutable.
   * - Existing row in "confirmed" status: return unchanged { created: false }
   *   — never-revert invariant.
   *
   * @param tx  Optional Prisma transaction client. When supplied the operation
   *            runs inside the caller's transaction; otherwise auto-commits.
   */
  upsert(input: RecordPaymentInput, tx?: unknown): Promise<{ row: PaymentRow; created: boolean }>;

  /**
   * Mark a detected payment as confirmed (or orphaned).
   *
   * @param tx  Optional Prisma transaction client.
   */
  updateStatus(
    id: string,
    status: PaymentStatus,
    confirmedAt?: Date,
    tx?: unknown,
  ): Promise<PaymentRow>;

  /**
   * Reset a payment's stored blockNumber to UNCONFIRMED_BLOCK_SENTINEL — ONLY
   * while the payment is still "detected" (the status guard is re-checked
   * atomically by the implementation; no-op for any other status).
   *
   * Used by the watcher's full-replay reorg sweep: a "detected" payment whose
   * (txHash, logIndex) was NOT re-agreed via dual receipts on a full-replay
   * tick is no longer observable on-chain (reorged out), so its stale
   * blockNumber must never satisfy the height-only promotion gate
   * (blockNumber <= latestSolidBlock). If the tx is later re-mined, the
   * normal agreement path restores a real blockNumber via upsert's
   * "refresh blockNumber while detected" rule.
   *
   * @param tx  Optional Prisma transaction client.
   */
  markUnconfirmed(id: string, tx?: unknown): Promise<void>;
}
