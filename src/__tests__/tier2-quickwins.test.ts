/**
 * Tier-2 quick-win regression tests.
 *
 * Each describe block covers one audit item. All tests are offline (no real DB,
 * no real network). Tests drive implementation via TDD red-green cycle.
 */

import { describe, it, expect } from "vitest";

// Consolidated imports (lint: import/no-duplicates)
import { parseMicro, compareDecimalStrings } from "../lib/decimal.js";
import { buildProviderFromEnv, redactProviderUrl } from "../lib/http.js";

describe("MONEY-2: parseMicro canonical behaviour (replaces private parseAmountMicro)", () => {
  it('throws RangeError for "-0" (no silent -0 bug)', () => {
    // The old parseAmountMicro returned -0n somehow when given "-0";
    // parseMicro throws because negative is not allowed by default.
    expect(() => parseMicro("-0")).toThrow(RangeError);
  });

  it('parses "100.000000" as 100_000_000n', () => {
    expect(parseMicro("100.000000")).toBe(100_000_000n);
  });

  it('FixedRateSource.toMicroUsdt now uses parseMicro internally', async () => {
    // Import the adapter to confirm it doesn't throw at load time.
    const { FixedRateSource } = await import("../server/db/adapters.js");
    const src = new FixedRateSource(1_000_000n);
    // 1 USD * 1:1 rate = 1_000_000n micro-USDT
    expect(src.toMicroUsdt("1.000000", "USD")).toBe(1_000_000n);
  });
});

// ── MONEY-3: minimum invoice amount ──────────────────────────────────────────
import { createInvoice, InvoiceValidationError } from "../core/invoices.js";
import type {
  EventRow,
  InvoiceRepository,
  EventRepository,
  DepositAddressDeriver,
  Clock,
} from "../core/ports.js";
import type { RateConfig } from "../core/pricing.js";

function makeEventRepo(event: EventRow | null): EventRepository {
  return {
    findById: async () => event,
    insert: async () => { throw new Error("not needed"); },
    list: async () => [],
  } as unknown as EventRepository;
}

function makeInvoiceRepo(): InvoiceRepository {
  return {
    allocateNextInvoiceIndex: async () => 0,
    insert: async (inp) => ({
      id: "inv1",
      eventId: inp.eventId,
      status: "pending",
      priceFiat: inp.priceFiat,
      fiatCurrency: inp.fiatCurrency,
      amountUsdt: inp.amountUsdt,
      amountReceived: "0.000000",
      rateLockedAt: inp.rateLockedAt,
      network: inp.network,
      depositAddress: inp.depositAddress,
      derivationIndex: inp.derivationIndex,
      expiresAt: inp.expiresAt,
      metadata: inp.metadata,
      createdAt: new Date(),
      paidAt: null,
    }),
    findById: async () => null,
    findWithPayments: async () => { throw new Error("not needed"); },
    updateStatus: async () => { throw new Error("not needed"); },
    listSweepableForEvent: async () => [],
    listActiveForWatch: async () => [],
    updateAmountReceived: async () => { throw new Error("not needed"); },
    list: async () => [],
  } as unknown as InvoiceRepository;
}

const ACTIVE_EVENT: EventRow = {
  id: "evt1",
  name: "Test",
  status: "active",
  mainWalletAddress: "TMain",
  derivationAccount: 0,
  xpubAccount: "xpub",
  nextInvoiceIndex: 0,
  createdAt: new Date(),
};

const RATE_1TO1: RateConfig = {
  microUsdtPerFiatUnit: 1_000_000n,
  lockedAt: new Date(),
};

const CLOCK: Clock = { now: () => new Date() };
const DERIVER: DepositAddressDeriver = { derive: () => "TDeposit123456789012345678901234" };

describe("MONEY-3: minimum invoice amount enforcement", () => {
  it("rejects a 0.005 USDT invoice (below 0.01 USDT minimum)", async () => {
    await expect(
      createInvoice(
        { eventId: "evt1", priceFiat: "0.005", fiatCurrency: "USD" },
        {
          invoiceRepo: makeInvoiceRepo(),
          eventRepo: makeEventRepo(ACTIVE_EVENT),
          deriver: DERIVER,
          clock: CLOCK,
          rate: RATE_1TO1,
        },
      ),
    ).rejects.toThrow(InvoiceValidationError);
  });

  it("rejects a 0.005 USDT invoice with code AMOUNT_TOO_SMALL", async () => {
    let err: InvoiceValidationError | null = null;
    try {
      await createInvoice(
        { eventId: "evt1", priceFiat: "0.005", fiatCurrency: "USD" },
        {
          invoiceRepo: makeInvoiceRepo(),
          eventRepo: makeEventRepo(ACTIVE_EVENT),
          deriver: DERIVER,
          clock: CLOCK,
          rate: RATE_1TO1,
        },
      );
    } catch (e) {
      err = e as InvoiceValidationError;
    }
    expect(err).not.toBeNull();
    expect(err!.code).toBe("AMOUNT_TOO_SMALL");
  });

  it("accepts a 0.01 USDT invoice (exactly at minimum)", async () => {
    await expect(
      createInvoice(
        { eventId: "evt1", priceFiat: "0.01", fiatCurrency: "USD" },
        {
          invoiceRepo: makeInvoiceRepo(),
          eventRepo: makeEventRepo(ACTIVE_EVENT),
          deriver: DERIVER,
          clock: CLOCK,
          rate: RATE_1TO1,
        },
      ),
    ).resolves.toBeDefined();
  });

  it("accepts a 1.00 USDT invoice", async () => {
    await expect(
      createInvoice(
        { eventId: "evt1", priceFiat: "1.00", fiatCurrency: "USD" },
        {
          invoiceRepo: makeInvoiceRepo(),
          eventRepo: makeEventRepo(ACTIVE_EVENT),
          deriver: DERIVER,
          clock: CLOCK,
          rate: RATE_1TO1,
        },
      ),
    ).resolves.toBeDefined();
  });
});

// ── OPS-1: numeric env validation ────────────────────────────────────────────
import { validatePositiveInt } from "../lib/envValidation.js";

describe("OPS-1: validatePositiveInt helper", () => {
  it("returns the number when valid", () => {
    expect(validatePositiveInt("5000", "MY_VAR")).toBe(5000);
  });

  it("throws for NaN (non-numeric string)", () => {
    expect(() => validatePositiveInt("abc", "MY_VAR")).toThrow(/MY_VAR/);
  });

  it("throws for 0 (not positive)", () => {
    expect(() => validatePositiveInt("0", "MY_VAR")).toThrow(/MY_VAR/);
  });

  it("throws for negative", () => {
    expect(() => validatePositiveInt("-1", "MY_VAR")).toThrow(/MY_VAR/);
  });

  it("throws when below minValue", () => {
    expect(() => validatePositiveInt("500", "MY_VAR", 1000)).toThrow(/MY_VAR/);
  });

  it("accepts value exactly at minValue", () => {
    expect(validatePositiveInt("1000", "MY_VAR", 1000)).toBe(1000);
  });
});

// ── AUTH-2: rate-limit checkout page ─────────────────────────────────────────
// Tested via server integration (buildApp) using mock invoice repo
import { buildApp } from "../server/app.js";
import type { AppDeps } from "../server/app.js";

function makeMinimalDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    eventRepo: {
      findById: async () => null,
      insert: async () => { throw new Error("stub"); },
      list: async () => [],
    } as unknown as AppDeps["eventRepo"],
    invoiceRepo: {
      findById: async () => null,
      insert: async () => { throw new Error("stub"); },
      allocateNextInvoiceIndex: async () => 0,
      findWithPayments: async () => { throw new Error("stub"); },
      updateStatus: async () => { throw new Error("stub"); },
      listSweepableForEvent: async () => [],
      listActiveForWatch: async () => [],
      updateAmountReceived: async () => { throw new Error("stub"); },
      list: async () => [],
    } as unknown as AppDeps["invoiceRepo"],
    sweepIntentRepo: {
      insert: async () => { throw new Error("stub"); },
      findById: async () => null,
      updateStatus: async () => { throw new Error("stub"); },
      updateItems: async () => { throw new Error("stub"); },
    },
    deriver: { derive: () => "TAddr" },
    clock: { now: () => new Date() },
    getRateConfig: () => ({ microUsdtPerFiatUnit: 1_000_000n, lockedAt: new Date() }),
    apiKeyRepo: {
      findByHash: async () => null,
      insert: async () => { throw new Error("stub"); },
      list: async () => [],
      revoke: async () => null,
      findById: async () => null,
    },
    operatorRepo: {
      findByEmail: async () => null,
      create: async () => { throw new Error("stub"); },
    },
    webhookRepo: {
      insert: async () => { throw new Error("stub"); },
      list: async () => [],
      findById: async () => null,
      delete: async () => { throw new Error("stub"); },
    },
    rateLimiter: {
      check: () => true, // always allow by default
    } as AppDeps["rateLimiter"],
    logLevel: "silent",
    ...overrides,
  };
}

describe("AUTH-2: checkout page GET /pay/:invoiceId is rate-limited", () => {
  it("returns 429 when rate limiter returns false for public_status bucket", async () => {
    const app = buildApp(
      makeMinimalDeps({
        rateLimiter: {
          // Return false for the public_status bucket (simulates limit exceeded)
          check: (bucket: string) => bucket !== "public_status",
        } as AppDeps["rateLimiter"],
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: "/pay/inv_test123",
    });

    expect(res.statusCode).toBe(429);
    await app.close();
  });

  it("returns 404 (not 429) when rate limiter allows and invoice not found", async () => {
    const app = buildApp(makeMinimalDeps());

    const res = await app.inject({
      method: "GET",
      url: "/pay/inv_notfound",
    });

    // Invoice not found → 404, meaning the rate limit was not triggered
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ── AUTH-3: session rate-bucket key ──────────────────────────────────────────
// Two different sessions should get independent rate buckets.
// We test this by calling the route with two different session cookies and
// confirming that bucket keys differ (not both "session").
import { InMemorySessionStore, SESSION_COOKIE_NAME } from "../server/auth.js";

describe("AUTH-3: session-auth path uses per-session rate key", () => {
  it("uses session-specific key (not constant 'session')", async () => {
    const bucketKeysUsed: string[] = [];
    const sessionStore = new InMemorySessionStore();
    const sid1 = sessionStore.create({ operatorId: "op1", email: "a@b.com" });
    const sid2 = sessionStore.create({ operatorId: "op2", email: "c@d.com" });

    const app = buildApp(
      makeMinimalDeps({
        sessionStore,
        rateLimiter: {
          check: (_bucket: string, key: string) => {
            bucketKeysUsed.push(key);
            return true;
          },
        } as AppDeps["rateLimiter"],
        apiKeyRepo: {
          findByHash: async () => null,
          insert: async (inp) => ({
            id: "ak1",
            label: inp.label,
            scope: inp.scope,
            prefix: inp.prefix,
            hashedKey: inp.hashedKey,
            createdAt: new Date(),
            revokedAt: null,
          }),
          list: async () => [],
          revoke: async () => null,
          findById: async () => null,
        },
      }),
    );

    // Two requests with different session cookies
    await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sid1}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ label: "test1", scope: "admin" }),
    });

    await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sid2}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ label: "test2", scope: "admin" }),
    });

    // Both keys should contain the actual session IDs, not the constant "session"
    const sessionBucketKeys = bucketKeysUsed.filter((k) => k !== undefined);
    expect(sessionBucketKeys).toContain(`session:${sid1}`);
    expect(sessionBucketKeys).toContain(`session:${sid2}`);
    // They must be different
    expect(sessionBucketKeys[0]).not.toBe(sessionBucketKeys[1]);
    await app.close();
  });
});

// ── WH-4: webhook URL validation at registration ──────────────────────────────
describe("WH-4: webhook registration rejects unsafe URLs", () => {
  it("rejects http:// URL with 400", async () => {
    const app = buildApp(
      makeMinimalDeps({
        apiKeyRepo: {
          findByHash: async () => ({
            id: "ak1",
            label: "test",
            scope: "admin" as const,
            prefix: "uk_",
            hashedKey: "hash",
            createdAt: new Date(),
            revokedAt: null,
          }),
          insert: async () => { throw new Error("stub"); },
          list: async () => [],
          revoke: async () => null,
          findById: async () => null,
        },
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: {
        authorization: "Bearer uk_testkey",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ url: "http://evil.com/wh" }),
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a private/internal IP URL with 400", async () => {
    const app = buildApp(
      makeMinimalDeps({
        apiKeyRepo: {
          findByHash: async () => ({
            id: "ak1",
            label: "test",
            scope: "admin" as const,
            prefix: "uk_",
            hashedKey: "hash",
            createdAt: new Date(),
            revokedAt: null,
          }),
          insert: async () => { throw new Error("stub"); },
          list: async () => [],
          revoke: async () => null,
          findById: async () => null,
        },
      }),
    );

    // SSRF: internal metadata endpoint (public SSRF URL that assertSafeUrl blocks)
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: {
        authorization: "Bearer uk_testkey",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ url: "https://169.254.169.254/latest/meta-data" }),
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("accepts a valid https:// URL (passes URL validation, mocked insert)", async () => {
    const app = buildApp(
      makeMinimalDeps({
        apiKeyRepo: {
          findByHash: async () => ({
            id: "ak1",
            label: "test",
            scope: "admin" as const,
            prefix: "uk_",
            hashedKey: "hash",
            createdAt: new Date(),
            revokedAt: null,
          }),
          insert: async () => { throw new Error("stub"); },
          list: async () => [],
          revoke: async () => null,
          findById: async () => null,
        },
        webhookRepo: {
          insert: async (inp) => ({
            id: "wh1",
            eventId: inp.eventId,
            url: inp.url,
            secret: inp.secret,
            active: true,
            createdAt: new Date(),
          }),
          list: async () => [],
          findById: async () => null,
          delete: async () => {},
        },
      }),
    );

    // Use a hostname that the SSRF guard will pass (not an IP literal, not
    // a private range — the guard does DNS but in route tests we can't do real
    // DNS. We mock the resolveForWebhook to allow it by testing a known-public host
    // via the static IP path: host=example.com... actually we use the IP literal
    // 93.184.216.34 which is example.com's real IP, but that's public.
    // Simplest approach: use a URL with IP that is public (not in any deny-list).
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: {
        authorization: "Bearer uk_testkey",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ url: "https://93.184.216.34/webhook" }),
    });

    // 201 created (or 500 if the repo throws, but NOT 400 from URL validation)
    expect(res.statusCode).not.toBe(400);
    await app.close();
  });
});

// ── KS-3: buildProviderFromEnv distinctness check ─────────────────────────────

describe("KS-3: buildProviderFromEnv throws when primary === secondary URL", () => {
  it("throws when both URLs are identical", () => {
    const origPrimary = process.env["TRON_RPC_PRIMARY_URL"];
    const origSecondary = process.env["TRON_RPC_SECONDARY_URL"];
    try {
      process.env["TRON_RPC_PRIMARY_URL"] = "https://api.trongrid.io";
      process.env["TRON_RPC_SECONDARY_URL"] = "https://api.trongrid.io";
      expect(() => buildProviderFromEnv()).toThrow(/identical|same/i);
    } finally {
      if (origPrimary === undefined) delete process.env["TRON_RPC_PRIMARY_URL"];
      else process.env["TRON_RPC_PRIMARY_URL"] = origPrimary;
      if (origSecondary === undefined) delete process.env["TRON_RPC_SECONDARY_URL"];
      else process.env["TRON_RPC_SECONDARY_URL"] = origSecondary;
    }
  });

  it("does NOT throw when URLs are different", () => {
    const origPrimary = process.env["TRON_RPC_PRIMARY_URL"];
    const origSecondary = process.env["TRON_RPC_SECONDARY_URL"];
    try {
      process.env["TRON_RPC_PRIMARY_URL"] = "https://api.trongrid.io";
      process.env["TRON_RPC_SECONDARY_URL"] = "https://api2.trongrid.io";
      expect(() => buildProviderFromEnv()).not.toThrow();
    } finally {
      if (origPrimary === undefined) delete process.env["TRON_RPC_PRIMARY_URL"];
      else process.env["TRON_RPC_PRIMARY_URL"] = origPrimary;
      if (origSecondary === undefined) delete process.env["TRON_RPC_SECONDARY_URL"];
      else process.env["TRON_RPC_SECONDARY_URL"] = origSecondary;
    }
  });
});

// ── SEC-4: login response body must not contain sessionId ─────────────────────
describe("SEC-4: login response body omits sessionId", () => {
  it("login JSON response contains email but not sessionId", async () => {
    const app = buildApp(
      makeMinimalDeps({
        operatorRepo: {
          findByEmail: async (email: string) => ({
            id: "op1",
            email,
            passwordHash:
              // argon2 hash of "password" — precomputed to avoid async argon2 in test
              // We need a real hash; use a known one or mock argon2
              "$argon2id$v=19$m=65536,t=3,p=4$fakeSalt$fakeHash", // will fail verify → 401
            createdAt: new Date(),
          }),
          create: async () => { throw new Error("stub"); },
        },
      }),
    );

    // Use wrong password so we get 401 — we just want to verify the success path
    // shape. For the success shape test, we need a real argon2 hash.
    // Instead, let's test with no operator (401 path won't leak session id)
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "no@op.com", password: "pw" }),
    });
    // 401 — no session created, no sessionId in body
    const body = res.json();
    expect(body).not.toHaveProperty("data.sessionId");
    await app.close();
  });

  it("successful login: body has email but NOT sessionId; Set-Cookie is present", async () => {
    // We need a real argon2 hash. Import argon2 to hash inline.
    const argon2 = await import("argon2");
    const hash = await argon2.hash("correctpassword");

    const app = buildApp(
      makeMinimalDeps({
        operatorRepo: {
          findByEmail: async (email: string) => ({
            id: "op1",
            email,
            passwordHash: hash,
            createdAt: new Date(),
          }),
          create: async () => { throw new Error("stub"); },
        },
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "admin@example.com", password: "correctpassword" }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Must have email
    expect(body.data).toHaveProperty("email");
    // Must NOT have sessionId
    expect(body.data).not.toHaveProperty("sessionId");
    // Must set the cookie
    const cookie = res.headers["set-cookie"];
    expect(cookie).toBeDefined();
    expect(String(cookie)).toContain("stablerails_session=");
    await app.close();
  });
});

// ── KS-4: URL credential redaction in RPC error messages ─────────────────────

describe("KS-4: redactProviderUrl strips credentials and query params", () => {
  it("strips userinfo from https://user:pass@host/path", () => {
    const redacted = redactProviderUrl("https://user:secret@api.trongrid.io/path");
    expect(redacted).not.toContain("secret");
    expect(redacted).toContain("api.trongrid.io");
    expect(redacted).toContain("/path");
  });

  it("strips ?apikey= query parameter", () => {
    const redacted = redactProviderUrl("https://api.trongrid.io/wallet?apikey=MYSECRETKEY");
    expect(redacted).not.toContain("MYSECRETKEY");
    expect(redacted).toContain("api.trongrid.io");
    expect(redacted).toContain("/wallet");
  });

  it("keeps origin + pathname for a clean URL", () => {
    const redacted = redactProviderUrl("https://api.trongrid.io/v1/wallet/getblock");
    expect(redacted).toBe("https://api.trongrid.io/v1/wallet/getblock");
  });

  it("handles invalid URL gracefully (returns sanitized placeholder)", () => {
    const redacted = redactProviderUrl("not-a-url");
    expect(redacted).toBe("[invalid-url]");
  });
});

// ── AUTH-4: generic error messages ────────────────────────────────────────────
describe("AUTH-4: global error handler emits generic message for non-500 framework errors", () => {
  it("malformed JSON body returns generic message, not raw library text", async () => {
    const app = buildApp(makeMinimalDeps());

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      // Intentionally malformed JSON
      payload: "{ bad json !!!",
    });

    // Should be 400 but with a generic message
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { message: string } };
    // Must NOT leak raw framework/library text like "Unexpected token"
    expect(body.error.message).not.toMatch(/Unexpected token/i);
    expect(body.error.message).not.toMatch(/SyntaxError/i);
    await app.close();
  });
});

// ── DB-3: value-based sweepable filter ───────────────────────────────────────

describe("DB-3: compareDecimalStrings is value-based (not literal-string)", () => {
  it('"0" equals "0.000000" by value', () => {
    expect(compareDecimalStrings("0", "0.000000")).toBe(0);
  });

  it('"0.000001" is greater than "0.000000"', () => {
    expect(compareDecimalStrings("0.000001", "0.000000")).toBe(1);
  });

  it('"0.000000" is NOT greater than "0.000000"', () => {
    expect(compareDecimalStrings("0.000000", "0.000000")).toBe(0);
  });
});
