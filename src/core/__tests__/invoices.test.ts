import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createInvoice,
  cancelInvoiceById,
  InvoiceValidationError,
  DEFAULT_INVOICE_TTL_MINUTES,
} from "../invoices.js";
import type {
  EventRow,
  InvoiceRow,
  InvoiceRepository,
  EventRepository,
  DepositAddressDeriver,
  Clock,
  CreateInvoiceInput,
} from "../ports.js";
import type { RateConfig } from "../pricing.js";
import { LifecycleError } from "../lifecycle.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date("2025-06-01T12:00:00Z");
const RATE: RateConfig = {
  microUsdtPerFiatUnit: 1_000_000n,
  lockedAt: FIXED_NOW,
};

function makeClock(d = FIXED_NOW): Clock {
  return { now: vi.fn().mockReturnValue(d) };
}

function makeDeriver(address = "TDerivedDepositAddr"): DepositAddressDeriver {
  return { derive: vi.fn().mockReturnValue(address) };
}

function makeActiveEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "evt_001",
    name: "Test Event",
    status: "active",
    mainWalletAddress: "TMainWallet",
    derivationAccount: 0,
    xpubAccount: "xpub...",
    nextInvoiceIndex: 0,
    createdAt: FIXED_NOW,
    ...overrides,
  };
}

function makeInvoiceRow(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv_001",
    eventId: "evt_001",
    status: "pending",
    priceFiat: "100.000000",
    fiatCurrency: "USD",
    amountUsdt: "100.000000",
    amountReceived: "0.000000",
    rateLockedAt: FIXED_NOW,
    network: "TRON",
    depositAddress: "TDerivedDepositAddr",
    derivationIndex: 0,
    expiresAt: new Date(FIXED_NOW.getTime() + 30 * 60 * 1000),
    metadata: null,
    createdAt: FIXED_NOW,
    paidAt: null,
    ...overrides,
  };
}

function makeInvoiceRepo(
  overrides: Partial<InvoiceRepository> = {},
  row: InvoiceRow = makeInvoiceRow(),
): InvoiceRepository {
  return {
    allocateNextInvoiceIndex: vi.fn().mockResolvedValue(0),
    insert: vi.fn().mockResolvedValue(row),
    findById: vi.fn().mockResolvedValue(row),
    findWithPayments: vi.fn().mockResolvedValue({ invoice: row, payments: [] }),
    updateStatus: vi.fn().mockResolvedValue({ ...row, status: "canceled" }),
    ...overrides,
  };
}

function makeEventRepo(event: EventRow | null = makeActiveEvent()): EventRepository {
  return {
    insert: vi.fn().mockResolvedValue(event ?? makeActiveEvent()),
    findById: vi.fn().mockResolvedValue(event),
  };
}

// ── createInvoice ─────────────────────────────────────────────────────────────

describe("createInvoice", () => {
  it("allocates index via port and derives address", async () => {
    const invoiceRepo = makeInvoiceRepo(
      { allocateNextInvoiceIndex: vi.fn().mockResolvedValue(5) },
    );
    const deriver = makeDeriver("TDerivedAddr5");
    const ports = {
      invoiceRepo,
      eventRepo: makeEventRepo(),
      deriver,
      clock: makeClock(),
      rate: RATE,
    };

    await createInvoice({ eventId: "evt_001", priceFiat: "100.000000", fiatCurrency: "USD" }, ports);

    expect(invoiceRepo.allocateNextInvoiceIndex).toHaveBeenCalledWith("evt_001");
    expect(deriver.derive).toHaveBeenCalledWith("xpub...", 5);
  });

  it("stores correct amountUsdt from pricing", async () => {
    const invoiceRepo = makeInvoiceRepo();
    const ports = {
      invoiceRepo,
      eventRepo: makeEventRepo(),
      deriver: makeDeriver(),
      clock: makeClock(),
      rate: RATE,
    };

    await createInvoice({ eventId: "evt_001", priceFiat: "100.000000", fiatCurrency: "USD" }, ports);

    const inserted = (invoiceRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CreateInvoiceInput;
    expect(inserted.amountUsdt).toBe("100.000000");
  });

  it("sets expiresAt = now + ttlMinutes", async () => {
    const invoiceRepo = makeInvoiceRepo();
    const clock = makeClock(FIXED_NOW);
    const ports = {
      invoiceRepo,
      eventRepo: makeEventRepo(),
      deriver: makeDeriver(),
      clock,
      rate: RATE,
    };

    await createInvoice(
      { eventId: "evt_001", priceFiat: "100.000000", fiatCurrency: "USD", ttlMinutes: 60 },
      ports,
    );

    const inserted = (invoiceRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CreateInvoiceInput;
    expect(inserted.expiresAt.getTime()).toBe(FIXED_NOW.getTime() + 60 * 60 * 1000);
  });

  it("uses DEFAULT_INVOICE_TTL_MINUTES when not specified", async () => {
    const invoiceRepo = makeInvoiceRepo();
    const clock = makeClock(FIXED_NOW);
    const ports = {
      invoiceRepo,
      eventRepo: makeEventRepo(),
      deriver: makeDeriver(),
      clock,
      rate: RATE,
    };

    await createInvoice(
      { eventId: "evt_001", priceFiat: "100.000000", fiatCurrency: "USD" },
      ports,
    );

    const inserted = (invoiceRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CreateInvoiceInput;
    expect(inserted.expiresAt.getTime()).toBe(
      FIXED_NOW.getTime() + DEFAULT_INVOICE_TTL_MINUTES * 60 * 1000,
    );
  });

  it("throws EVENT_NOT_FOUND when event doesn't exist", async () => {
    const ports = {
      invoiceRepo: makeInvoiceRepo(),
      eventRepo: makeEventRepo(null),
      deriver: makeDeriver(),
      clock: makeClock(),
      rate: RATE,
    };

    await expect(
      createInvoice(
        { eventId: "evt_missing", priceFiat: "100.000000", fiatCurrency: "USD" },
        ports,
      ),
    ).rejects.toThrow(InvoiceValidationError);
  });

  it("throws EVENT_ARCHIVED when event is archived", async () => {
    const archivedEvent = makeActiveEvent({ status: "archived" });
    const ports = {
      invoiceRepo: makeInvoiceRepo(),
      eventRepo: makeEventRepo(archivedEvent),
      deriver: makeDeriver(),
      clock: makeClock(),
      rate: RATE,
    };

    await expect(
      createInvoice(
        { eventId: "evt_001", priceFiat: "100.000000", fiatCurrency: "USD" },
        ports,
      ),
    ).rejects.toThrow(InvoiceValidationError);
  });

  it("throws INVALID_EVENT_ID on empty eventId", async () => {
    const ports = {
      invoiceRepo: makeInvoiceRepo(),
      eventRepo: makeEventRepo(),
      deriver: makeDeriver(),
      clock: makeClock(),
      rate: RATE,
    };

    await expect(
      createInvoice({ eventId: "", priceFiat: "100.000000", fiatCurrency: "USD" }, ports),
    ).rejects.toThrow(InvoiceValidationError);
  });

  it("allocates monotonically increasing indices across sequential calls", async () => {
    let counter = 0;
    const allocate = vi.fn().mockImplementation(() => Promise.resolve(counter++));
    const insertedIndices: number[] = [];
    const insert = vi.fn().mockImplementation((input: CreateInvoiceInput) => {
      insertedIndices.push(input.derivationIndex);
      return Promise.resolve(makeInvoiceRow({ derivationIndex: input.derivationIndex }));
    });
    const invoiceRepo = makeInvoiceRepo({ allocateNextInvoiceIndex: allocate, insert });
    const ports = {
      invoiceRepo,
      eventRepo: makeEventRepo(),
      deriver: makeDeriver(),
      clock: makeClock(),
      rate: RATE,
    };

    await createInvoice({ eventId: "evt_001", priceFiat: "10.000000", fiatCurrency: "USD" }, ports);
    await createInvoice({ eventId: "evt_001", priceFiat: "20.000000", fiatCurrency: "USD" }, ports);
    await createInvoice({ eventId: "evt_001", priceFiat: "30.000000", fiatCurrency: "USD" }, ports);

    // Monotonic: 0, 1, 2
    expect(insertedIndices).toEqual([0, 1, 2]);
    expect(allocate).toHaveBeenCalledTimes(3);
  });

  it("passes metadata through", async () => {
    const invoiceRepo = makeInvoiceRepo();
    const ports = {
      invoiceRepo,
      eventRepo: makeEventRepo(),
      deriver: makeDeriver(),
      clock: makeClock(),
      rate: RATE,
    };
    const meta = { orderId: "ord_123", customer: "Alice" };

    await createInvoice(
      { eventId: "evt_001", priceFiat: "50.000000", fiatCurrency: "USD", metadata: meta },
      ports,
    );

    const inserted = (invoiceRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CreateInvoiceInput;
    expect(inserted.metadata).toEqual(meta);
  });
});

// ── cancelInvoiceById ─────────────────────────────────────────────────────────

describe("cancelInvoiceById", () => {
  it("cancels a pending invoice", async () => {
    const pendingInvoice = makeInvoiceRow({ status: "pending" });
    const invoiceRepo = makeInvoiceRepo({}, pendingInvoice);
    const result = await cancelInvoiceById("inv_001", { invoiceRepo });
    expect(invoiceRepo.updateStatus).toHaveBeenCalledWith("inv_001", "canceled");
  });

  it("throws INVOICE_NOT_FOUND when invoice doesn't exist", async () => {
    const invoiceRepo = makeInvoiceRepo({ findById: vi.fn().mockResolvedValue(null) });
    await expect(cancelInvoiceById("inv_missing", { invoiceRepo })).rejects.toThrow(
      InvoiceValidationError,
    );
  });

  it("throws LifecycleError when trying to cancel a paid invoice", async () => {
    const paidInvoice = makeInvoiceRow({ status: "paid" });
    const invoiceRepo = makeInvoiceRepo({ findById: vi.fn().mockResolvedValue(paidInvoice) });
    await expect(cancelInvoiceById("inv_001", { invoiceRepo })).rejects.toThrow(LifecycleError);
    expect(invoiceRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("throws LifecycleError when trying to cancel an expired invoice", async () => {
    const expiredInvoice = makeInvoiceRow({ status: "expired" });
    const invoiceRepo = makeInvoiceRepo({ findById: vi.fn().mockResolvedValue(expiredInvoice) });
    await expect(cancelInvoiceById("inv_001", { invoiceRepo })).rejects.toThrow(LifecycleError);
  });
});
