/**
 * HMAC-SHA256 webhook signing (spec §8).
 *
 * Signature header format:
 *   X-Stablerails-Signature: t=<unixSeconds>,v1=<hexmac>
 *
 * Signed payload = "<t>.<rawBody>"
 *
 * All compares are constant-time to prevent timing attacks.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Stablerails-Signature";
export const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes

// ── Signing ───────────────────────────────────────────────────────────────────

/**
 * Compute the HMAC-SHA256 signature for a webhook delivery.
 *
 * @param rawBody  Raw (string or Buffer) request body — MUST be the original bytes.
 * @param secret   Endpoint secret (UTF-8 string).
 * @param ts       Unix timestamp in seconds. Defaults to Date.now()/1000.
 * @returns        Full signature header value, e.g. "t=1234567890,v1=abc123..."
 */
export function sign(
  rawBody: string | Buffer,
  secret: string,
  ts: number = Math.floor(Date.now() / 1000),
): string {
  const payload = `${ts}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const mac = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  return `t=${ts},v1=${mac}`;
}

// ── Verification ──────────────────────────────────────────────────────────────

export class HmacVerifyError extends Error {
  constructor(
    public readonly code: "MISSING_HEADER" | "MALFORMED" | "STALE" | "MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "HmacVerifyError";
  }
}

/**
 * Parse the `X-Stablerails-Signature` header.
 *
 * Returns { ts, v1 } or null if malformed.
 */
export function parseSignatureHeader(
  header: string,
): { ts: number; v1: string } | null {
  // Expected: "t=<digits>,v1=<hexstring>"
  const tMatch = /(?:^|,)t=(\d+)/.exec(header);
  const v1Match = /(?:^|,)v1=([0-9a-f]+)/.exec(header);
  if (!tMatch || !v1Match) return null;
  const ts = Number(tMatch[1]);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const v1 = v1Match[1];
  if (v1 === undefined) return null;
  return { ts, v1 };
}

/**
 * Verify a webhook request signature.
 *
 * Throws HmacVerifyError on any verification failure.
 *
 * @param rawBody           Raw request body (same bytes that were signed).
 * @param header            Value of the `X-Stablerails-Signature` header.
 * @param secret            Endpoint secret.
 * @param toleranceSeconds  Max acceptable age in seconds. Default: 300 (5 min).
 * @param nowSeconds        Current Unix time. Defaults to Date.now()/1000.
 */
export function verify(
  rawBody: string | Buffer,
  header: string | undefined | null,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): void {
  if (!header) {
    throw new HmacVerifyError("MISSING_HEADER", "Missing signature header");
  }

  const parsed = parseSignatureHeader(header);
  if (!parsed) {
    throw new HmacVerifyError(
      "MALFORMED",
      `Malformed signature header: ${header}`,
    );
  }

  const { ts, v1 } = parsed;

  // Stale timestamp check
  const age = Math.abs(nowSeconds - ts);
  if (age > toleranceSeconds) {
    throw new HmacVerifyError(
      "STALE",
      `Timestamp is ${age}s old (tolerance: ${toleranceSeconds}s)`,
    );
  }

  // Recompute the expected MAC
  const payload = `${ts}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest("hex");

  // Constant-time compare via timingSafeEqual.
  // HMAC-SHA256 always produces a 64-char hex string, so lengths are always equal
  // when the input is well-formed. We check length first only to satisfy
  // timingSafeEqual's precondition (it throws on unequal-length buffers); this
  // leaks no timing info for the 64-char path because both sides are always the
  // same length. Malformed (non-hex, wrong-length) signatures are rejected here.
  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(v1, "hex");

  if (
    expectedBuf.length !== receivedBuf.length ||
    !timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    throw new HmacVerifyError("MISMATCH", "Signature does not match");
  }
}
