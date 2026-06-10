/**
 * Invoice domain: create and cancel invoices.
 *
 * Persistence is via the injected InvoiceRepository + EventRepository ports.
 * Address derivation is via the injected DepositAddressDeriver port.
 * Rate pricing is via the injected RateSource port.
 * Clock is injected for testability.
 *
 * No Prisma, no chain imports.
 */

import type {
  InvoiceRow,
  EventRow,
  InvoiceRepository,
  EventRepository,
  DepositAddressDeriver,
  Clock,
  CreateInvoiceInput,
} from "./ports.js";
import type { RateConfig, ToleranceConfig } from "./pricing.js";
import { computePricing, DEFAULT_TOLERANCE } from "./pricing.js";
import { cancelInvoice, LifecycleError } from "./lifecycle.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Minimum priced amount in micro-USDT (0.01 USDT = 10_000 micro).
 *
 * Rationale: the ±1% tolerance floor can credit a partial payment as fully paid.
 * For sub-cent invoices the absolute tolerance floor (1 micro) dominates,
 * creating a path where nearly-zero payments are accepted as settled.
 * Enforcing a minimum at creation prevents this class of mis-crediting.
 */
export const MIN_INVOICE_AMOUNT_MICRO = 10_000n; // 0.01 USDT

// ── Configuration ─────────────────────────────────────────────────────────────

/** Default invoice TTL in minutes. */
export const DEFAULT_INVOICE_TTL_MINUTES = 30;

// ── Input ─────────────────────────────────────────────────────────────────────

export interface CreateInvoiceParams {
  eventId: string;
  /** Fiat amount as decimal string, e.g. "100.00". */
  priceFiat: string;
  /** ISO 4217 fiat currency code, e.g. "USD". */
  fiatCurrency: string;
  /** Optional metadata blob. */
  metadata?: Record<string, unknown> | null;
  /** TTL in minutes. Defaults to DEFAULT_INVOICE_TTL_MINUTES (30). */
  ttlMinutes?: number;
  /** Tolerance configuration. Defaults to ±1%. */
  tolerance?: ToleranceConfig;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class InvoiceValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InvoiceValidationError";
  }
}

// ── Ports bundle ─────────────────────────────────────────────────────────────

export interface CreateInvoicePorts {
  invoiceRepo: InvoiceRepository;
  eventRepo: EventRepository;
  deriver: DepositAddressDeriver;
  clock: Clock;
  /** Rate configuration (locked at call time by the server). */
  rate: RateConfig;
}

// ── Create invoice ────────────────────────────────────────────────────────────

/**
 * Create a new invoice for an event.
 *
 * Steps:
 * 1. Load the event (validate it exists and is active).
 * 2. Compute pricing (fiat → micro-USDT + tolerance band).
 * 3. Allocate the next derivation index via port (monotonic, never-reused).
 * 4. Derive the deposit address via port.
 * 5. Persist the invoice.
 *
 * @param params  Invoice creation input.
 * @param ports   Injected dependencies.
 */
export async function createInvoice(
  params: CreateInvoiceParams,
  ports: CreateInvoicePorts,
): Promise<InvoiceRow> {
  const {
    eventId,
    priceFiat,
    fiatCurrency,
    metadata = null,
    ttlMinutes = DEFAULT_INVOICE_TTL_MINUTES,
    tolerance = DEFAULT_TOLERANCE,
  } = params;

  // 1. Validate basic inputs.
  if (!eventId || eventId.trim() === "") {
    throw new InvoiceValidationError("INVALID_EVENT_ID", "eventId must not be empty");
  }
  if (!priceFiat || priceFiat.trim() === "") {
    throw new InvoiceValidationError("INVALID_PRICE", "priceFiat must not be empty");
  }
  if (!fiatCurrency || fiatCurrency.trim() === "") {
    throw new InvoiceValidationError(
      "INVALID_CURRENCY",
      "fiatCurrency must not be empty",
    );
  }
  if (!Number.isInteger(ttlMinutes) || ttlMinutes <= 0) {
    throw new InvoiceValidationError(
      "INVALID_TTL",
      `ttlMinutes must be a positive integer, got ${ttlMinutes}`,
    );
  }

  // 2. Load and validate the event.
  const event: EventRow | null = await ports.eventRepo.findById(eventId);
  if (!event) {
    throw new InvoiceValidationError(
      "EVENT_NOT_FOUND",
      `Event "${eventId}" not found`,
    );
  }
  if (event.status !== "active") {
    throw new InvoiceValidationError(
      "EVENT_ARCHIVED",
      `Event "${eventId}" is archived and cannot accept new invoices`,
    );
  }

  // 3. Compute pricing (locks the rate).
  const pricing = computePricing(priceFiat, fiatCurrency, ports.rate, tolerance);

  // 3a. Enforce minimum invoice amount.
  // Must happen AFTER pricing so we compare the actual USDT amount, not the
  // raw fiat string (rate conversion may reduce a fiat amount below minimum).
  if (pricing.amountMicro < MIN_INVOICE_AMOUNT_MICRO) {
    throw new InvoiceValidationError(
      "AMOUNT_TOO_SMALL",
      `Invoice amount too small: ${pricing.amountUsdtString} USDT (minimum ${MIN_INVOICE_AMOUNT_MICRO / 1_000_000n}.${(MIN_INVOICE_AMOUNT_MICRO % 1_000_000n).toString().padStart(6, "0")} USDT)`,
    );
  }

  // 4. Allocate the next derivation index.
  //    The adapter MUST hold a serializable lock; core just calls and trusts the result.
  const derivationIndex = await ports.invoiceRepo.allocateNextInvoiceIndex(eventId);

  // 5. Derive the deposit address.
  let depositAddress: string;
  try {
    depositAddress = ports.deriver.derive(event.xpubAccount, derivationIndex);
  } catch (err) {
    throw new InvoiceValidationError(
      "DERIVATION_FAILED",
      `Failed to derive deposit address for index ${derivationIndex}: ${(err as Error).message}`,
    );
  }

  // 6. Compute expiry.
  const now = ports.clock.now();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  // 7. Build and persist.
  // Note: rateLockedAt comes from the injected rate config (ports.rate.lockedAt).
  // Sprint 4 should pass a clock.now()-aligned value when constructing RateConfig.
  const input: CreateInvoiceInput = {
    eventId,
    priceFiat,
    fiatCurrency: fiatCurrency.toUpperCase(),
    amountUsdt: pricing.amountUsdtString,
    rateLockedAt: ports.rate.lockedAt,
    network: "TRON",
    depositAddress,
    derivationIndex,
    expiresAt,
    metadata: metadata ?? null,
  };

  return ports.invoiceRepo.insert(input);
}

// ── Cancel invoice ────────────────────────────────────────────────────────────

export interface CancelInvoicePorts {
  invoiceRepo: InvoiceRepository;
}

/**
 * Cancel an invoice. Only allowed while status === "pending".
 *
 * @throws {LifecycleError} if not in pending state.
 * @throws {InvoiceValidationError} if invoice not found.
 */
export async function cancelInvoiceById(
  invoiceId: string,
  ports: CancelInvoicePorts,
): Promise<InvoiceRow> {
  const found = await ports.invoiceRepo.findById(invoiceId);
  if (!found) {
    throw new InvoiceValidationError(
      "INVOICE_NOT_FOUND",
      `Invoice "${invoiceId}" not found`,
    );
  }

  // Will throw LifecycleError if not pending.
  cancelInvoice(found);

  return ports.invoiceRepo.updateStatus(found.id, "canceled");
}

export { LifecycleError };
