/**
 * Integer micro-USDT arithmetic — 6 decimal places.
 *
 * All amounts are represented as bigint (micro-USDT, i.e. 1 USDT = 1_000_000n).
 * External I/O uses decimal strings like "1.500000".
 * NEVER use floating-point for money.
 */

export const USDT_DECIMALS = 6;
export const USDT_SCALE = 10n ** BigInt(USDT_DECIMALS); // 1_000_000n

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse a decimal string (e.g. "1.5" or "1000000") into micro-USDT bigint.
 * Throws on invalid input, NaN, or negative values not explicitly allowed.
 */
export function parseMicro(value: string, allowNegative = false): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new TypeError(`Invalid decimal string: "${value}"`);
  }

  const isNeg = trimmed.startsWith("-");
  const abs = isNeg ? trimmed.slice(1) : trimmed;

  const [intPart = "0", fracPart = ""] = abs.split(".");

  // Pad or truncate fractional part to exactly USDT_DECIMALS digits
  // We truncate (floor toward zero) — callers wanting rounding must handle it.
  const fracPadded = fracPart.padEnd(USDT_DECIMALS, "0").slice(0, USDT_DECIMALS);

  const micro = BigInt(intPart) * USDT_SCALE + BigInt(fracPadded);

  if (isNeg) {
    if (!allowNegative) {
      throw new RangeError(`Negative USDT amount not allowed: "${value}"`);
    }
    return -micro;
  }
  return micro;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format micro-USDT bigint into canonical decimal string with 6 decimal places.
 * e.g. 1_500_000n → "1.500000"
 */
export function formatMicro(micro: bigint): string {
  const isNeg = micro < 0n;
  const abs = isNeg ? -micro : micro;

  const intPart = abs / USDT_SCALE;
  const fracPart = abs % USDT_SCALE;

  const fracStr = fracPart.toString().padStart(USDT_DECIMALS, "0");
  const result = `${intPart.toString()}.${fracStr}`;
  return isNeg ? `-${result}` : result;
}

// ── Arithmetic ────────────────────────────────────────────────────────────────

/** Add two micro amounts (both bigint). */
export function addMicro(a: bigint, b: bigint): bigint {
  return a + b;
}

/** Subtract b from a (both bigint). Returns signed result. */
export function subMicro(a: bigint, b: bigint): bigint {
  return a - b;
}

// ── Comparison ────────────────────────────────────────────────────────────────

/** Compare two micro amounts. Returns -1 | 0 | 1 */
export function compareMicro(a: bigint, b: bigint): -1 | 0 | 1 {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function microGt(a: bigint, b: bigint): boolean {
  return a > b;
}

export function microGte(a: bigint, b: bigint): boolean {
  return a >= b;
}

export function microLt(a: bigint, b: bigint): boolean {
  return a < b;
}

export function microEq(a: bigint, b: bigint): boolean {
  return a === b;
}

// ── String-level helpers (for Prisma String fields) ─────────────────────────

/**
 * Add two decimal-string amounts and return a decimal string.
 * Safe bridge for DB string fields.
 */
export function addDecimalStrings(a: string, b: string): string {
  return formatMicro(parseMicro(a) + parseMicro(b));
}

/**
 * Compare two decimal-string amounts.
 */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  return compareMicro(parseMicro(a), parseMicro(b));
}
