/**
 * Environment variable validation helpers.
 *
 * Provides clear startup errors for misconfigured numeric env vars so that
 * invalid configuration (NaN, non-positive, below minimum threshold) never
 * silently degrades to a tight-loop or unexpected behaviour at runtime.
 */

/**
 * Parse and validate a string value as a positive integer.
 *
 * @param raw       Raw string value (from process.env or similar).
 * @param name      Environment variable name — used in error messages.
 * @param minValue  Optional minimum acceptable value (inclusive, default: 1).
 * @returns         The parsed integer.
 * @throws          Error with a descriptive message if the value is invalid.
 */
export function validatePositiveInt(
  raw: string,
  name: string,
  minValue = 1,
): number {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < minValue) {
    throw new Error(
      `Invalid ${name}: expected a positive integer >= ${minValue}, got "${raw}"`,
    );
  }
  return n;
}

/**
 * Resolve the USDT rate from the USDT_RATE_MICRO environment variable.
 *
 * - Returns 1_000_000n (exact 1:1) when raw is undefined or empty.
 * - Returns BigInt(raw) when raw is a valid positive integer string.
 * - Throws at startup when raw is set but is not a valid positive integer
 *   (fail-fast prevents silent misconfiguration).
 *
 * @param raw  Value of process.env["USDT_RATE_MICRO"] (or undefined).
 * @returns    microUsdtPerFiatUnit as bigint.
 */
export function resolveRateMicro(raw: string | undefined): bigint {
  const DEFAULT = 1_000_000n;
  if (raw === undefined || raw === "") {
    return DEFAULT;
  }
  try {
    const n = BigInt(raw.trim());
    if (n <= 0n) {
      throw new Error(`USDT_RATE_MICRO must be a positive integer, got "${raw}"`);
    }
    return n;
  } catch (err) {
    // Re-wrap with a clear message if BigInt() threw on a non-integer string.
    if (err instanceof Error && err.message.startsWith("USDT_RATE_MICRO")) {
      throw err;
    }
    throw new Error(
      `Invalid USDT_RATE_MICRO: expected a positive integer, got "${raw}"`,
    );
  }
}

/**
 * Validate an OPTIONAL 32-byte hex key environment variable.
 *
 * Used for STABLERAILS_DATA_KEY, which (when set) enables webhook-secret
 * encryption at rest (see src/lib/secretBox.ts). Unset/empty means the
 * feature is disabled — that is a valid configuration.
 *
 * @param raw   Raw env value (process.env.X); undefined or "" means "not set".
 * @param name  Environment variable name — used in error messages.
 * @returns     Normalized lowercase 64-char hex string, or null when unset.
 * @throws      Error if the value is set but is not exactly 64 hex characters.
 *              The raw value is never included in the message (it is a key).
 */
export function validateOptionalHexKey32(
  raw: string | undefined,
  name: string,
): string | null {
  if (raw === undefined || raw === "") return null;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      `Invalid ${name}: expected 64 hex characters (32-byte key), got ${raw.length} characters`,
    );
  }
  return raw.toLowerCase();
}
