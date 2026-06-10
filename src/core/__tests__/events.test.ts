import { describe, it, expect, vi } from "vitest";
import { createEvent, validateCreateEventParams, EventValidationError } from "../events.js";
import type { AddressValidator, EventRepository, EventRow, CreateEventInput } from "../ports.js";

// ── Mock ports ────────────────────────────────────────────────────────────────

function makeAddressValidator(valid = true): AddressValidator {
  return {
    isValid: vi.fn().mockReturnValue(valid),
  };
}

function makeEventRepo(overrides: Partial<EventRepository> = {}): EventRepository {
  const defaultRow: EventRow = {
    id: "evt_001",
    name: "Test Event",
    status: "active",
    mainWalletAddress: "TValidBase58Address123456789",
    derivationAccount: 0,
    xpubAccount: "xpub...",
    nextInvoiceIndex: 0,
    createdAt: new Date(),
  };
  return {
    insert: vi.fn().mockResolvedValue(defaultRow),
    findById: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const VALID_PARAMS = {
  name: "Berlin Blockchain Conf",
  mainWalletAddress: "TValidBase58Address123456789",
  derivationAccount: 0,
  xpubAccount: "xpubSomeValidKey",
};

// ── validateCreateEventParams ─────────────────────────────────────────────────

describe("validateCreateEventParams", () => {
  it("passes with valid params", () => {
    expect(() =>
      validateCreateEventParams(VALID_PARAMS, makeAddressValidator(true)),
    ).not.toThrow();
  });

  it("throws INVALID_NAME on empty name", () => {
    expect(() =>
      validateCreateEventParams({ ...VALID_PARAMS, name: "   " }, makeAddressValidator()),
    ).toThrow(EventValidationError);
  });

  it("throws INVALID_ADDRESS on empty address", () => {
    expect(() =>
      validateCreateEventParams(
        { ...VALID_PARAMS, mainWalletAddress: "" },
        makeAddressValidator(),
      ),
    ).toThrow(EventValidationError);
  });

  it("throws INVALID_TRON_ADDRESS when validator rejects", () => {
    expect(() =>
      validateCreateEventParams(VALID_PARAMS, makeAddressValidator(false)),
    ).toThrow(EventValidationError);
  });

  it("throws INVALID_DERIVATION_ACCOUNT on negative account", () => {
    expect(() =>
      validateCreateEventParams(
        { ...VALID_PARAMS, derivationAccount: -1 },
        makeAddressValidator(),
      ),
    ).toThrow(EventValidationError);
  });

  it("throws INVALID_DERIVATION_ACCOUNT on non-integer account", () => {
    expect(() =>
      validateCreateEventParams(
        { ...VALID_PARAMS, derivationAccount: 1.5 },
        makeAddressValidator(),
      ),
    ).toThrow(EventValidationError);
  });

  it("throws INVALID_XPUB on empty xpub", () => {
    expect(() =>
      validateCreateEventParams(
        { ...VALID_PARAMS, xpubAccount: "" },
        makeAddressValidator(),
      ),
    ).toThrow(EventValidationError);
  });

  it("allows derivationAccount = 0 (first account)", () => {
    expect(() =>
      validateCreateEventParams({ ...VALID_PARAMS, derivationAccount: 0 }, makeAddressValidator()),
    ).not.toThrow();
  });
});

// ── createEvent ───────────────────────────────────────────────────────────────

describe("createEvent", () => {
  it("calls repo.insert with trimmed inputs", async () => {
    const validator = makeAddressValidator(true);
    const repo = makeEventRepo();
    const ports = { eventRepo: repo, addressValidator: validator };

    await createEvent(
      { ...VALID_PARAMS, name: "  Trimmed Name  " },
      ports,
    );

    expect(repo.insert).toHaveBeenCalledOnce();
    const inserted = (repo.insert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as CreateEventInput;
    expect(inserted.name).toBe("Trimmed Name");
  });

  it("returns the persisted EventRow", async () => {
    const validator = makeAddressValidator(true);
    const repo = makeEventRepo();
    const result = await createEvent(VALID_PARAMS, { eventRepo: repo, addressValidator: validator });
    expect(result.id).toBe("evt_001");
  });

  it("propagates validation errors before hitting repo", async () => {
    const validator = makeAddressValidator(false); // rejects address
    const repo = makeEventRepo();
    await expect(
      createEvent(VALID_PARAMS, { eventRepo: repo, addressValidator: validator }),
    ).rejects.toThrow(EventValidationError);
    expect(repo.insert).not.toHaveBeenCalled();
  });
});
