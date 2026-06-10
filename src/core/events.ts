/**
 * Event domain: validate + create an Event.
 *
 * Persistence is via the injected EventRepository port.
 * Address validation is via the injected AddressValidator port.
 * No Prisma, no chain imports.
 */

import type {
  EventRow,
  EventRepository,
  AddressValidator,
  CreateEventInput,
} from "./ports.js";

// ── Input ─────────────────────────────────────────────────────────────────────

export interface CreateEventParams {
  name: string;
  /** Valid Tron Base58 mainWallet address. */
  mainWalletAddress: string;
  /** BIP44 account index. Must be a non-negative integer. */
  derivationAccount: number;
  /** Extended public key (xpub) for this account. */
  xpubAccount: string;
  /**
   * Owner tenant (multi-merchant isolation). null/omitted = legacy default
   * tenant. Format validation happens at the route boundary; core just
   * persists it.
   */
  merchantId?: string | null;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class EventValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EventValidationError";
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

export function validateCreateEventParams(
  params: CreateEventParams,
  addressValidator: AddressValidator,
): void {
  const { name, mainWalletAddress, derivationAccount, xpubAccount } = params;

  if (!name || name.trim() === "") {
    throw new EventValidationError("INVALID_NAME", "Event name must not be empty");
  }

  if (!mainWalletAddress || mainWalletAddress.trim() === "") {
    throw new EventValidationError(
      "INVALID_ADDRESS",
      "mainWalletAddress must not be empty",
    );
  }

  if (!addressValidator.isValid(mainWalletAddress, "TRON")) {
    throw new EventValidationError(
      "INVALID_TRON_ADDRESS",
      `mainWalletAddress "${mainWalletAddress}" is not a valid Tron Base58 address`,
    );
  }

  if (!Number.isInteger(derivationAccount) || derivationAccount < 0) {
    throw new EventValidationError(
      "INVALID_DERIVATION_ACCOUNT",
      `derivationAccount must be a non-negative integer, got ${derivationAccount}`,
    );
  }

  if (!xpubAccount || xpubAccount.trim() === "") {
    throw new EventValidationError(
      "INVALID_XPUB",
      "xpubAccount must not be empty",
    );
  }
}

// ── Use-case ──────────────────────────────────────────────────────────────────

export interface CreateEventPorts {
  eventRepo: EventRepository;
  addressValidator: AddressValidator;
}

/**
 * Validate and create a new Event.
 *
 * @param params  Input from API/operator.
 * @param ports   Injected dependencies.
 * @returns       The persisted EventRow.
 * @throws        EventValidationError on invalid input.
 */
export async function createEvent(
  params: CreateEventParams,
  ports: CreateEventPorts,
): Promise<EventRow> {
  validateCreateEventParams(params, ports.addressValidator);

  const input: CreateEventInput = {
    name: params.name.trim(),
    mainWalletAddress: params.mainWalletAddress.trim(),
    derivationAccount: params.derivationAccount,
    xpubAccount: params.xpubAccount.trim(),
    merchantId: params.merchantId ?? null,
  };

  return ports.eventRepo.insert(input);
}
