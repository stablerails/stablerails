/**
 * Tests for src/lib/hmac.ts
 *
 * All offline — no network, no Prisma.
 */

import { describe, it, expect } from "vitest";
import {
  sign,
  verify,
  parseSignatureHeader,
  HmacVerifyError,
  DEFAULT_TOLERANCE_SECONDS,
} from "../hmac.js";

const SECRET = "test-secret-key-abc123";
const BODY = '{"invoiceId":"inv_abc","status":"paid"}';
const TS = 1_700_000_000; // fixed timestamp

// ── sign ──────────────────────────────────────────────────────────────────────

describe("sign()", () => {
  it("produces a header matching t=<ts>,v1=<hex>", () => {
    const header = sign(BODY, SECRET, TS);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("embeds the provided timestamp", () => {
    const header = sign(BODY, SECRET, TS);
    expect(header.startsWith(`t=${TS},`)).toBe(true);
  });

  it("produces different MACs for different bodies", () => {
    const h1 = sign(BODY, SECRET, TS);
    const h2 = sign(BODY + "X", SECRET, TS);
    expect(h1).not.toBe(h2);
  });

  it("produces different MACs for different secrets", () => {
    const h1 = sign(BODY, SECRET, TS);
    const h2 = sign(BODY, "other-secret", TS);
    expect(h1).not.toBe(h2);
  });

  it("produces different MACs for different timestamps", () => {
    const h1 = sign(BODY, SECRET, TS);
    const h2 = sign(BODY, SECRET, TS + 1);
    expect(h1).not.toBe(h2);
  });

  it("accepts a Buffer body", () => {
    const bodyBuf = Buffer.from(BODY, "utf8");
    const h1 = sign(BODY, SECRET, TS);
    const h2 = sign(bodyBuf, SECRET, TS);
    expect(h1).toBe(h2);
  });

  it("uses current time when ts is not provided", () => {
    const before = Math.floor(Date.now() / 1000);
    const header = sign(BODY, SECRET);
    const after = Math.floor(Date.now() / 1000);
    const parsed = parseSignatureHeader(header);
    expect(parsed).not.toBeNull();
    expect(parsed!.ts).toBeGreaterThanOrEqual(before);
    expect(parsed!.ts).toBeLessThanOrEqual(after);
  });
});

// ── parseSignatureHeader ──────────────────────────────────────────────────────

describe("parseSignatureHeader()", () => {
  it("parses a valid header", () => {
    const header = `t=${TS},v1=abc123def456`;
    const parsed = parseSignatureHeader(header);
    expect(parsed).toEqual({ ts: TS, v1: "abc123def456" });
  });

  it("returns null for missing t=", () => {
    expect(parseSignatureHeader("v1=abc123")).toBeNull();
  });

  it("returns null for missing v1=", () => {
    expect(parseSignatureHeader(`t=${TS}`)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSignatureHeader("")).toBeNull();
  });
});

// ── verify ────────────────────────────────────────────────────────────────────

describe("verify()", () => {
  it("accepts a freshly-signed payload", () => {
    const header = sign(BODY, SECRET, TS);
    // nowSeconds matches ts → age = 0
    expect(() => verify(BODY, header, SECRET, DEFAULT_TOLERANCE_SECONDS, TS)).not.toThrow();
  });

  it("accepts a payload within tolerance", () => {
    const header = sign(BODY, SECRET, TS);
    const nowSlightlyLater = TS + 100; // 100s later, well within 300s tolerance
    expect(() =>
      verify(BODY, header, SECRET, DEFAULT_TOLERANCE_SECONDS, nowSlightlyLater),
    ).not.toThrow();
  });

  it("rejects a stale timestamp (age > tolerance)", () => {
    const header = sign(BODY, SECRET, TS);
    const nowTooLate = TS + DEFAULT_TOLERANCE_SECONDS + 1; // 301s later
    let caught: HmacVerifyError | null = null;
    try {
      verify(BODY, header, SECRET, DEFAULT_TOLERANCE_SECONDS, nowTooLate);
    } catch (e) {
      caught = e as HmacVerifyError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("STALE");
  });

  it("rejects a timestamp in the future (age > tolerance)", () => {
    const header = sign(BODY, SECRET, TS);
    const nowTooEarly = TS - DEFAULT_TOLERANCE_SECONDS - 1; // 301s before
    let caught: HmacVerifyError | null = null;
    try {
      verify(BODY, header, SECRET, DEFAULT_TOLERANCE_SECONDS, nowTooEarly);
    } catch (e) {
      caught = e as HmacVerifyError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("STALE");
  });

  it("rejects a tampered body", () => {
    const header = sign(BODY, SECRET, TS);
    let caught: HmacVerifyError | null = null;
    try {
      verify(BODY + " tampered", header, SECRET, DEFAULT_TOLERANCE_SECONDS, TS);
    } catch (e) {
      caught = e as HmacVerifyError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MISMATCH");
  });

  it("rejects a tampered v1 hex value", () => {
    const header = sign(BODY, SECRET, TS);
    // Flip one character in the MAC
    const tampered = header.replace(/v1=([0-9a-f]{64})/, (_, mac) => {
      const chars = mac.split("");
      chars[0] = chars[0] === "a" ? "b" : "a";
      return `v1=${chars.join("")}`;
    });
    let caught: HmacVerifyError | null = null;
    try {
      verify(BODY, tampered, SECRET, DEFAULT_TOLERANCE_SECONDS, TS);
    } catch (e) {
      caught = e as HmacVerifyError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MISMATCH");
  });

  it("rejects a missing header", () => {
    let caught: HmacVerifyError | null = null;
    try {
      verify(BODY, null, SECRET, DEFAULT_TOLERANCE_SECONDS, TS);
    } catch (e) {
      caught = e as HmacVerifyError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MISSING_HEADER");
  });

  it("rejects an undefined header", () => {
    let caught: HmacVerifyError | null = null;
    try {
      verify(BODY, undefined, SECRET, DEFAULT_TOLERANCE_SECONDS, TS);
    } catch (e) {
      caught = e as HmacVerifyError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MISSING_HEADER");
  });

  it("rejects a malformed header", () => {
    let caught: HmacVerifyError | null = null;
    try {
      verify(BODY, "not-a-valid-header", SECRET, DEFAULT_TOLERANCE_SECONDS, TS);
    } catch (e) {
      caught = e as HmacVerifyError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MALFORMED");
  });

  it("rejects a wrong secret", () => {
    const header = sign(BODY, SECRET, TS);
    let caught: HmacVerifyError | null = null;
    try {
      verify(BODY, header, "wrong-secret", DEFAULT_TOLERANCE_SECONDS, TS);
    } catch (e) {
      caught = e as HmacVerifyError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("MISMATCH");
  });

  it("accepts a Buffer body consistent with the string signature", () => {
    const header = sign(BODY, SECRET, TS);
    const bodyBuf = Buffer.from(BODY, "utf8");
    expect(() =>
      verify(bodyBuf, header, SECRET, DEFAULT_TOLERANCE_SECONDS, TS),
    ).not.toThrow();
  });

  it("HmacVerifyError carries the correct name", () => {
    const err = new HmacVerifyError("MISMATCH", "test");
    expect(err.name).toBe("HmacVerifyError");
    expect(err.code).toBe("MISMATCH");
  });
});
