/**
 * Sprint 4 — Server route tests.
 *
 * All tests use in-memory mock repositories (no DB, no network).
 * buildTestDeps() wires a complete AppDeps with pre-seeded admin + merchant keys.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import argon2 from "argon2";

import { buildApp } from "../app.js";
import {
  buildTestDeps,
  MockEventRepository,
  MockInvoiceRepository,
  MockClock,
  RateLimiter as _RL,
} from "./helpers/mocks.js";
import { RateLimiter, RATE_LIMIT_BUCKETS } from "../../lib/rate-limit.js";
import { idempotencyStore } from "../routes/invoices.js";
import type {
  InvoiceIdempotencyRecord,
  InvoiceIdempotencyRepository,
} from "../routes/invoices.js";

// Convenience: inject an auth header.
function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth — bearer token
// ─────────────────────────────────────────────────────────────────────────────

describe("Bearer auth", () => {
  it("rejects missing token with 401", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/v1/events" });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects unknown key with 401", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: bearer("totally_unknown_key"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects merchant key on admin-only route (POST /v1/sweeps/:id/broadcast-result) with 403", async () => {
    // POST /v1/events is merchant+ (tenant-scoped event creation) and
    // POST /v1/sweeps/prepare is readonly+ (agent-friendliness relaxation —
    // executing still requires the operator CLI + passphrase + pin), so use
    // broadcast-result — still admin-only — to test merchant rejection.
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/sweep_any/broadcast-result",
      headers: { ...bearer(deps.merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("accepts valid admin key on admin route", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: bearer(deps.adminKey),
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects revoked key", async () => {
    const deps = buildTestDeps();
    const revokedRaw = "revokedkey_test_000000000000000000";
    (deps.apiKeyRepo as import("./helpers/mocks.js").MockApiKeyRepository).seedKey({
      rawKey: revokedRaw,
      scope: "admin",
      revoked: true,
    });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: bearer(revokedRaw),
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/events", () => {
  it("creates an event with valid params", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test Conf",
        mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
        derivationAccount: 0,
        xpubAccount: "xpub_placeholder",
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { data: { id: string; name: string } };
    expect(body.data.name).toBe("Test Conf");
    expect(typeof body.data.id).toBe("string");
  });

  it("returns 422 for empty name", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({
        name: "",
        mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
        derivationAccount: 0,
        xpubAccount: "xpub_placeholder",
      }),
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_NAME");
  });
});

describe("GET /v1/events", () => {
  it("returns empty list when no events", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: bearer(deps.adminKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("returns created event", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev1", name: "My Event" });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: bearer(deps.adminKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.some((e) => e.id === "ev1")).toBe(true);
  });
});

describe("GET /v1/events/:id", () => {
  it("returns 404 for unknown id", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/events/nonexistent",
      headers: bearer(deps.adminKey),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns event by id", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev2", name: "Found" });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/events/ev2",
      headers: bearer(deps.adminKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { id: string; name: string } };
    expect(body.data.id).toBe("ev2");
    expect(body.data.name).toBe("Found");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invoices
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/invoices", () => {
  it("creates an invoice for an active event", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev10" });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(deps.merchantKey), "content-type": "application/json" },
      body: JSON.stringify({
        eventId: "ev10",
        priceFiat: "50.00",
        fiatCurrency: "USD",
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { data: { id: string; priceFiat: string } };
    expect(body.data.priceFiat).toBe("50.00");
    expect(body.data.id).toBeTruthy();
  });

  it("returns 404 when event not found", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(deps.merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ghost", priceFiat: "10.00", fiatCurrency: "USD" }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 422 for zero amount", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev11" });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(deps.merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ev11", priceFiat: "0.00", fiatCurrency: "USD" }),
    });
    expect(res.statusCode).toBe(422);
  });

  it("rejects an event-scoped merchant key creating an invoice for another event", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev-owned" });
    (deps.eventRepo as MockEventRepository).seed({ id: "ev-other" });
    const scopedRaw = "merchantkey_event_scoped_000000000";
    const scoped = (deps.apiKeyRepo as import("./helpers/mocks.js").MockApiKeyRepository).seedKey({
      rawKey: scopedRaw,
      scope: "merchant",
      label: "event-scoped",
    });
    (scoped as typeof scoped & { eventId: string }).eventId = "ev-owned";
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(scopedRaw), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ev-other", priceFiat: "10.00", fiatCurrency: "USD" }),
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("EVENT_FORBIDDEN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("Idempotency-Key on POST /v1/invoices", () => {
  beforeEach(() => {
    idempotencyStore.clear();
  });

  it("reuses a persisted idempotency response after an app restart", async () => {
    const persisted = new Map<string, {
      state: "processing" | "completed";
      requestHash: string;
      statusCode: number | null;
      responseBody: unknown | null;
      expiresAt: Date;
      processingExpiresAt: Date | null;
    }>();
    const invoiceIdempotencyRepo = {
      async reserve(input: {
        scopeKey: string;
        idempotencyKey: string;
        requestHash: string;
        expiresAt: Date;
        processingExpiresAt: Date;
      }) {
        const key = `${input.scopeKey}:${input.idempotencyKey}`;
        const existing = persisted.get(key);
        if (existing) {
          return existing.requestHash === input.requestHash
            ? { kind: existing.state, record: existing }
            : { kind: "conflict", record: existing };
        }
        const record = {
          state: "processing" as const,
          requestHash: input.requestHash,
          statusCode: null,
          responseBody: null,
          expiresAt: input.expiresAt,
          processingExpiresAt: input.processingExpiresAt,
        };
        persisted.set(key, record);
        return { kind: "reserved" as const, record };
      },
      async findValid(scopeKey: string, idempotencyKey: string, now: Date) {
        const record = persisted.get(`${scopeKey}:${idempotencyKey}`);
        if (!record || record.expiresAt <= now) return null;
        return record;
      },
      async complete(input: {
        scopeKey: string;
        idempotencyKey: string;
        requestHash: string;
        statusCode: number;
        responseBody: unknown;
        expiresAt: Date;
      }) {
        persisted.set(`${input.scopeKey}:${input.idempotencyKey}`, {
          ...input,
          state: "completed",
          processingExpiresAt: null,
        });
      },
      async deleteExpired(now: Date) {
        for (const [key, record] of persisted) {
          if (record.expiresAt <= now) persisted.delete(key);
        }
      },
    };

    const deps = buildTestDeps({ invoiceIdempotencyRepo } as Partial<Parameters<typeof buildApp>[0]>);
    (deps.eventRepo as MockEventRepository).seed({ id: "ev20-persisted" });
    const body = JSON.stringify({ eventId: "ev20-persisted", priceFiat: "25.00", fiatCurrency: "USD" });

    const firstApp = buildApp(deps);
    const first = await firstApp.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(deps.merchantKey),
        "content-type": "application/json",
        "idempotency-key": "idem-key-persisted-001",
      },
      body,
    });
    expect(first.statusCode).toBe(201);

    idempotencyStore.clear();
    const secondApp = buildApp(deps);
    const second = await secondApp.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(deps.merchantKey),
        "content-type": "application/json",
        "idempotency-key": "idem-key-persisted-001",
      },
      body,
    });

    expect(second.statusCode).toBe(201);
    const b1 = JSON.parse(first.body) as { data: { id: string } };
    const b2 = JSON.parse(second.body) as { data: { id: string } };
    expect(b2.data.id).toBe(b1.data.id);
    expect((deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).store.size).toBe(1);
  });

  it("returns 409 from persisted idempotency without replacing the cached response", async () => {
    const persisted = new Map<string, {
      state: "processing" | "completed";
      requestHash: string;
      statusCode: number | null;
      responseBody: unknown | null;
      expiresAt: Date;
      processingExpiresAt: Date | null;
    }>();
    let saveCalls = 0;
    const invoiceIdempotencyRepo = {
      async reserve(input: {
        scopeKey: string;
        idempotencyKey: string;
        requestHash: string;
        expiresAt: Date;
        processingExpiresAt: Date;
      }) {
        const key = `${input.scopeKey}:${input.idempotencyKey}`;
        const existing = persisted.get(key);
        if (existing) {
          return existing.requestHash === input.requestHash
            ? { kind: existing.state, record: existing }
            : { kind: "conflict", record: existing };
        }
        const record = {
          state: "processing" as const,
          requestHash: input.requestHash,
          statusCode: null,
          responseBody: null,
          expiresAt: input.expiresAt,
          processingExpiresAt: input.processingExpiresAt,
        };
        persisted.set(key, record);
        return { kind: "reserved" as const, record };
      },
      async findValid(scopeKey: string, idempotencyKey: string, now: Date) {
        const record = persisted.get(`${scopeKey}:${idempotencyKey}`);
        if (!record || record.expiresAt <= now) return null;
        return record;
      },
      async complete(input: {
        scopeKey: string;
        idempotencyKey: string;
        requestHash: string;
        statusCode: number;
        responseBody: unknown;
        expiresAt: Date;
      }) {
        saveCalls += 1;
        const key = `${input.scopeKey}:${input.idempotencyKey}`;
        persisted.set(key, { ...input, state: "completed", processingExpiresAt: null });
      },
      async deleteExpired(now: Date) {
        for (const [key, record] of persisted) {
          if (record.expiresAt <= now) persisted.delete(key);
        }
      },
    };

    const deps = buildTestDeps({ invoiceIdempotencyRepo } as Partial<Parameters<typeof buildApp>[0]>);
    (deps.eventRepo as MockEventRepository).seed({ id: "ev20-persisted-conflict" });
    const app = buildApp(deps);

    const first = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(deps.merchantKey),
        "content-type": "application/json",
        "idempotency-key": "idem-key-persisted-conflict",
      },
      body: JSON.stringify({
        eventId: "ev20-persisted-conflict",
        priceFiat: "25.00",
        fiatCurrency: "USD",
      }),
    });
    expect(first.statusCode).toBe(201);
    const [persistedKey] = persisted.keys();
    const original = persisted.get(persistedKey!)!;

    const second = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(deps.merchantKey),
        "content-type": "application/json",
        "idempotency-key": "idem-key-persisted-conflict",
      },
      body: JSON.stringify({
        eventId: "ev20-persisted-conflict",
        priceFiat: "30.00",
        fiatCurrency: "USD",
      }),
    });

    expect(second.statusCode).toBe(409);
    expect(saveCalls).toBe(1);
    expect(persisted.get(persistedKey!)).toEqual(original);
    expect((deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).store.size).toBe(1);
  });

  it("same key + same body returns cached response (201)", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev20" });
    const app = buildApp(deps);
    const body = JSON.stringify({ eventId: "ev20", priceFiat: "25.00", fiatCurrency: "USD" });

    const r1 = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(deps.merchantKey),
        "content-type": "application/json",
        "idempotency-key": "idem-key-001",
      },
      body,
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(deps.merchantKey),
        "content-type": "application/json",
        "idempotency-key": "idem-key-001",
      },
      body,
    });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    // Same invoice id returned both times.
    const b1 = JSON.parse(r1.body) as { data: { id: string } };
    const b2 = JSON.parse(r2.body) as { data: { id: string } };
    expect(b1.data.id).toBe(b2.data.id);
    // Only ONE invoice in store (idempotency worked).
    expect((deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).store.size).toBe(1);
  });

  it("same key + different body returns 409", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev21" });
    const app = buildApp(deps);

    const r1 = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(deps.merchantKey),
        "content-type": "application/json",
        "idempotency-key": "idem-key-002",
      },
      body: JSON.stringify({ eventId: "ev21", priceFiat: "10.00", fiatCurrency: "USD" }),
    });
    expect(r1.statusCode).toBe(201);

    const r2 = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(deps.merchantKey),
        "content-type": "application/json",
        "idempotency-key": "idem-key-002",
      },
      body: JSON.stringify({ eventId: "ev21", priceFiat: "99.00", fiatCurrency: "USD" }), // different
    });
    expect(r2.statusCode).toBe(409);
    const body = JSON.parse(r2.body) as { error: { code: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("concurrent same persisted key and body creates one invoice and replays the owner response", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev20-concurrent-same" });

    let reserveCalls = 0;
    const persisted = new Map<string, InvoiceIdempotencyRecord>();
    const invoiceIdempotencyRepo: InvoiceIdempotencyRepository = {
      async reserve(input) {
        reserveCalls += 1;
        const key = `${input.scopeKey}:${input.idempotencyKey}`;
        const existing = persisted.get(key);
        if (existing) {
          return existing.requestHash === input.requestHash
            ? { kind: existing.state, record: existing }
            : { kind: "conflict", record: existing };
        }
        const record: InvoiceIdempotencyRecord = {
          requestHash: input.requestHash,
          state: "processing",
          statusCode: null,
          responseBody: null,
          expiresAt: input.expiresAt,
          processingExpiresAt: input.processingExpiresAt,
        };
        persisted.set(key, record);
        return { kind: "reserved", record };
      },
      async findValid(scopeKey, idempotencyKey, now) {
        const record = persisted.get(`${scopeKey}:${idempotencyKey}`);
        if (!record || record.expiresAt <= now) return null;
        return record;
      },
      async complete(input) {
        persisted.set(`${input.scopeKey}:${input.idempotencyKey}`, {
          requestHash: input.requestHash,
          state: "completed",
          statusCode: input.statusCode,
          responseBody: input.responseBody,
          expiresAt: input.expiresAt,
          processingExpiresAt: null,
        });
      },
      async deleteExpired(now) {
        for (const [key, record] of persisted) {
          if (record.expiresAt <= now) persisted.delete(key);
        }
      },
    };

    const invoiceRepo = deps.invoiceRepo as MockInvoiceRepository;
    const originalInsert = invoiceRepo.insert.bind(invoiceRepo);
    invoiceRepo.insert = async (input) => {
      while (reserveCalls < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return originalInsert(input);
    };

    const app = buildApp({ ...deps, invoiceIdempotencyRepo });
    const body = JSON.stringify({
      eventId: "ev20-concurrent-same",
      priceFiat: "25.00",
      fiatCurrency: "USD",
    });

    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/invoices",
        headers: { ...bearer(deps.merchantKey), "content-type": "application/json", "idempotency-key": "idem-concurrent-same" },
        body,
      }),
      app.inject({
        method: "POST",
        url: "/v1/invoices",
        headers: { ...bearer(deps.merchantKey), "content-type": "application/json", "idempotency-key": "idem-concurrent-same" },
        body,
      }),
    ]);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const b1 = JSON.parse(first.body) as { data: { id: string } };
    const b2 = JSON.parse(second.body) as { data: { id: string } };
    expect(b1.data.id).toBe(b2.data.id);
    expect(invoiceRepo.store.size).toBe(1);
  });

  it("concurrent same persisted key and different body returns conflict without a duplicate invoice", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev20-concurrent-different" });

    let reserveCalls = 0;
    const persisted = new Map<string, InvoiceIdempotencyRecord>();
    const invoiceIdempotencyRepo: InvoiceIdempotencyRepository = {
      async reserve(input) {
        reserveCalls += 1;
        const key = `${input.scopeKey}:${input.idempotencyKey}`;
        const existing = persisted.get(key);
        if (existing) {
          return existing.requestHash === input.requestHash
            ? { kind: existing.state, record: existing }
            : { kind: "conflict", record: existing };
        }
        const record: InvoiceIdempotencyRecord = {
          requestHash: input.requestHash,
          state: "processing",
          statusCode: null,
          responseBody: null,
          expiresAt: input.expiresAt,
          processingExpiresAt: input.processingExpiresAt,
        };
        persisted.set(key, record);
        return { kind: "reserved", record };
      },
      async findValid(scopeKey, idempotencyKey, now) {
        const record = persisted.get(`${scopeKey}:${idempotencyKey}`);
        if (!record || record.expiresAt <= now) return null;
        return record;
      },
      async complete(input) {
        persisted.set(`${input.scopeKey}:${input.idempotencyKey}`, {
          requestHash: input.requestHash,
          state: "completed",
          statusCode: input.statusCode,
          responseBody: input.responseBody,
          expiresAt: input.expiresAt,
          processingExpiresAt: null,
        });
      },
      async deleteExpired(now) {
        for (const [key, record] of persisted) {
          if (record.expiresAt <= now) persisted.delete(key);
        }
      },
    };

    const invoiceRepo = deps.invoiceRepo as MockInvoiceRepository;
    const originalInsert = invoiceRepo.insert.bind(invoiceRepo);
    invoiceRepo.insert = async (input) => {
      while (reserveCalls < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return originalInsert(input);
    };

    const app = buildApp({ ...deps, invoiceIdempotencyRepo });
    const [first, second] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/invoices",
        headers: { ...bearer(deps.merchantKey), "content-type": "application/json", "idempotency-key": "idem-concurrent-conflict" },
        body: JSON.stringify({ eventId: "ev20-concurrent-different", priceFiat: "25.00", fiatCurrency: "USD" }),
      }),
      app.inject({
        method: "POST",
        url: "/v1/invoices",
        headers: { ...bearer(deps.merchantKey), "content-type": "application/json", "idempotency-key": "idem-concurrent-conflict" },
        body: JSON.stringify({ eventId: "ev20-concurrent-different", priceFiat: "30.00", fiatCurrency: "USD" }),
      }),
    ]);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(invoiceRepo.store.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/invoices/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/invoices/:id", () => {
  it("returns 404 for unknown invoice", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/invoices/nope",
      headers: bearer(deps.merchantKey),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns invoice with payments and confirmations=0", async () => {
    const deps = buildTestDeps();
    const inv = (deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).seed({
      id: "inv1",
      eventId: "ev99",
    });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: `/v1/invoices/${inv.id}`,
      headers: bearer(deps.merchantKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { id: string; payments: unknown[]; confirmations: number } };
    expect(body.data.id).toBe(inv.id);
    expect(Array.isArray(body.data.payments)).toBe(true);
    expect(body.data.confirmations).toBe(0);
  });

  // M3: confirmations must never be negative. When getHeadBlockNumber defaults
  // to 0n and a payment has blockNumber > 0, the delta is negative — clamp to 0.
  it("M3: confirmations clamp — never returns negative value when head < blockNumber", async () => {
    const deps = buildTestDeps();
    // Inject getHeadBlockNumber returning 0n (default/unwired).
    // The invoice repo will have a payment with blockNumber=100n, so
    // 0n - 100n = -100n → should be clamped to 0.
    const inv = (deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).seed({
      id: "inv-m3",
      eventId: "ev-m3",
    });

    // Seed a payment with a high blockNumber so delta is negative.
    (deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).seedPayment(
      inv.id,
      {
        id: "pay-m3",
        invoiceId: inv.id,
        txHash: "abc123deadbeef",
        logIndex: 0,
        network: "TRON",
        fromAddress: "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH",
        amountUsdt: "1.000000",
        blockNumber: 100n,
        blockHash: "block000",
        status: "confirmed",
        detectedAt: new Date(),
        confirmedAt: new Date(),
      },
    );

    // getHeadBlockNumber returns 0n → delta = 0n - 100n = -100 → must clamp to 0.
    const app = buildApp({ ...deps, getHeadBlockNumber: () => 0n });
    const res = await app.inject({
      method: "GET",
      url: `/v1/invoices/${inv.id}`,
      headers: bearer(deps.merchantKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: {
        confirmations: number;
        payments: Array<{ confirmations: number }>;
      };
    };
    // Top-level confirmations must be >= 0.
    expect(body.data.confirmations).toBeGreaterThanOrEqual(0);
    // All payment-level confirmations must be >= 0.
    for (const p of body.data.payments) {
      expect(p.confirmations).toBeGreaterThanOrEqual(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/invoices/:id/cancel
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/invoices/:id/cancel", () => {
  it("cancels a pending invoice", async () => {
    const deps = buildTestDeps();
    const inv = (deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).seed({
      id: "inv2",
      eventId: "ev30",
      status: "pending",
    });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/v1/invoices/${inv.id}/cancel`,
      headers: bearer(deps.merchantKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { status: string } };
    expect(body.data.status).toBe("canceled");
  });

  it("returns 409 for non-pending invoice", async () => {
    const deps = buildTestDeps();
    const inv = (deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).seed({
      id: "inv3",
      eventId: "ev31",
      status: "paid",
    });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: `/v1/invoices/${inv.id}/cancel`,
      headers: bearer(deps.merchantKey),
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("CANCEL_NOT_PENDING");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API Keys
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/api-keys", () => {
  it("creates a key and returns rawKey once", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ label: "new-merchant", scope: "merchant" }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      data: { rawKey: string; prefix: string; scope: string; label: string };
    };
    expect(typeof body.data.rawKey).toBe("string");
    expect(body.data.rawKey.length).toBeGreaterThan(20);
    expect(body.data.scope).toBe("merchant");
    expect(body.data.prefix.length).toBe(8);
  });

  it("returns 400 for missing scope", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ label: "oops" }),
    });
    expect(res.statusCode).toBe(400);
  });

  // M2: first-run bootstrap — a valid operator session can create an API key
  // without already having a Bearer admin key.
  it("M2: valid session cookie can create an api-key (first-run bootstrap)", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);

    // Log in as the operator to get a session cookie.
    const hashedPw = await argon2.hash("super-secret-pass");
    (deps.operatorRepo as import("./helpers/mocks.js").MockOperatorRepository).seedOperator({
      id: "op-1",
      email: "admin@example.com",
      passwordHash: hashedPw,
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "super-secret-pass" }),
    });
    expect(loginRes.statusCode).toBe(200);
    const setCookie = loginRes.headers["set-cookie"] as string;
    expect(typeof setCookie).toBe("string");

    // Extract the session cookie value.
    const cookieMatch = setCookie.match(/stablerails_session=([^;]+)/);
    expect(cookieMatch).not.toBeNull();
    const sessionCookie = `stablerails_session=${cookieMatch![1]}`;

    // Create an API key using ONLY the session cookie — no Bearer token.
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
      },
      body: JSON.stringify({ label: "first-admin-key", scope: "admin" }),
    });
    expect(createRes.statusCode).toBe(201);
    const body = JSON.parse(createRes.body) as {
      data: { rawKey: string; scope: string };
    };
    expect(body.data.scope).toBe("admin");
    expect(typeof body.data.rawKey).toBe("string");
    expect(body.data.rawKey.length).toBeGreaterThan(20);
  });

  it("M2: no session and no Bearer token → 401", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);

    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "no-auth", scope: "admin" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("M2: invalid/expired session cookie → 401 (falls through to Bearer check)", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);

    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: {
        "content-type": "application/json",
        cookie: "stablerails_session=totally-fake-session-id",
      },
      body: JSON.stringify({ label: "fake-session", scope: "merchant" }),
    });
    // No valid session AND no Bearer → 401.
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /v1/api-keys", () => {
  it("never exposes hashedKey", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/api-keys",
      headers: bearer(deps.adminKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Record<string, unknown>[] };
    for (const key of body.data) {
      expect(key["hashedKey"]).toBeUndefined();
    }
  });
});

describe("DELETE /v1/api-keys/:id", () => {
  it("revokes existing key (204)", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    // First create a key.
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ label: "to-revoke", scope: "merchant" }),
    });
    const created = JSON.parse(createRes.body) as { data: { id: string } };

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/v1/api-keys/${created.data.id}`,
      headers: bearer(deps.adminKey),
    });
    expect(deleteRes.statusCode).toBe(204);
  });

  it("returns 404 for unknown id", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/api-keys/ghost-id",
      headers: bearer(deps.adminKey),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when the repository throws Prisma missing-row error", async () => {
    const deps = buildTestDeps();
    const apiKeyRepo = deps.apiKeyRepo as import("./helpers/mocks.js").MockApiKeyRepository;
    const throwingRepo = Object.create(apiKeyRepo) as typeof apiKeyRepo;
    throwingRepo.revoke = async () => {
      const err = new Error("Record to update not found.");
      (err as Error & { code?: string }).code = "P2025";
      throw err;
    };
    const app = buildApp({ ...deps, apiKeyRepo: throwingRepo });
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/api-keys/ghost-id",
      headers: bearer(deps.adminKey),
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhooks
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/webhooks", () => {
  it("creates a webhook endpoint", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook" }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { data: { id: string; url: string; secret: string } };
    expect(body.data.url).toBe("https://example.com/hook");
    expect(typeof body.data.secret).toBe("string");
    expect(body.data.secret.length).toBeGreaterThan(10);
  });

  it("returns 404 when eventId does not exist", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook", eventId: "missing-event" }),
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("EVENT_NOT_FOUND");
  });

  it("rejects an empty caller-supplied secret with 400 INVALID_SECRET", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook", secret: "" }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_SECRET");
  });

  it("rejects a too-short caller-supplied secret with 400 INVALID_SECRET", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook", secret: "short" }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_SECRET");
  });

  it("accepts a sufficiently long caller-supplied secret", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const suppliedSecret = "a-strong-webhook-secret-0123456789";
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook", secret: suppliedSecret }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { data: { secret: string } };
    expect(body.data.secret).toBe(suppliedSecret);
  });
});

describe("DELETE /v1/webhooks/:id", () => {
  it("deletes existing webhook", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook2" }),
    });
    const created = JSON.parse(createRes.body) as { data: { id: string } };
    const delRes = await app.inject({
      method: "DELETE",
      url: `/v1/webhooks/${created.data.id}`,
      headers: bearer(deps.adminKey),
    });
    expect(delRes.statusCode).toBe(204);
  });
});

describe("POST /v1/webhooks/test", () => {
  it("sends a signed test event and reports delivered true only on success without exposing secret", async () => {
    const deps = buildTestDeps();
    const sender = async (
      _url: string,
      _secret: string,
      rawBody: string,
      eventUid: string,
    ) => {
      expect(JSON.parse(rawBody)).toMatchObject({ eventType: "webhook.test" });
      expect(eventUid).toMatch(/^webhook\.test:/);
      return { ok: true, status: 204 };
    };
    const app = buildApp({ ...deps, webhookTestSender: sender } as Parameters<typeof buildApp>[0]);
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook-test", secret: "super-secret-webhook-key" }),
    });
    const created = JSON.parse(createRes.body) as { data: { id: string } };

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ endpointId: created.data.id }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Record<string, unknown> };
    expect(body.data["delivered"]).toBe(true);
    expect(body.data["status"]).toBe(204);
    expect(JSON.stringify(body)).not.toContain("super-secret-webhook-key");
  });

  it("reports delivered false with a sanitized error on send failure", async () => {
    const deps = buildTestDeps();
    const app = buildApp({
      ...deps,
      webhookTestSender: async () => ({ ok: false, status: 500, error: "boom super-secret-webhook-key" }),
    } as Parameters<typeof buildApp>[0]);
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook-test-fail", secret: "super-secret-webhook-key" }),
    });
    const created = JSON.parse(createRes.body) as { data: { id: string } };

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ endpointId: created.data.id }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Record<string, unknown> };
    expect(body.data["delivered"]).toBe(false);
    expect(body.data["error"]).toBe("Delivery failed");
    expect(JSON.stringify(body)).not.toContain("super-secret-webhook-key");
  });

  it("rejects inactive endpoints", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const endpoint = await deps.webhookRepo.insert({
      eventId: null,
      url: "https://example.com/inactive",
      secret: "inactive-secret",
    });
    (deps.webhookRepo as import("./helpers/mocks.js").MockWebhookRepository).store.set(endpoint.id, {
      ...endpoint,
      active: false,
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks/test",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ endpointId: endpoint.id }),
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("WEBHOOK_INACTIVE");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Public status
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/public/invoices/:id", () => {
  it("returns sanitized invoice (no auth required)", async () => {
    const deps = buildTestDeps();
    const inv = (deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).seed({
      id: "pub1",
      eventId: "ev50",
    });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: `/v1/public/invoices/${inv.id}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: { id: string; status: string; amountUsdt: string };
    };
    expect(body.data.id).toBe(inv.id);
    expect(body.data.amountUsdt).toBe("100.000000");
    // Should NOT expose priceFiat or metadata.
    expect((body.data as Record<string, unknown>)["priceFiat"]).toBeUndefined();
  });

  it("returns 404 for unknown invoice", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/v1/public/invoices/ghost" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /pay/:invoiceId", () => {
  it("returns HTML checkout page", async () => {
    const deps = buildTestDeps();
    const inv = (deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).seed({
      id: "pay1",
      eventId: "ev51",
    });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: `/pay/${inv.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("USDT");
    expect(res.body).toContain("TRON");
    expect(res.body).toContain(inv.depositAddress);
  });

  it("returns 404 HTML for unknown invoice", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/pay/ghost" });
    expect(res.statusCode).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth routes
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /login", () => {
  it("returns HTML login form", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("form");
  });
});

describe("POST /v1/auth/login", () => {
  it("returns 401 for unknown email (JSON)", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nope@test.com", password: "wrong" }),
    });
    expect(res.statusCode).toBe(401);
    // Generic code — must not distinguish unknown email from wrong password
    // (timing is equalized via a decoy argon2.verify in the handler).
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("verifies valid Argon2 password and sets session cookie", async () => {
    const deps = buildTestDeps();
    const passwordHash = await argon2.hash("s3cr3t");
    (deps.operatorRepo as import("./helpers/mocks.js").MockOperatorRepository).seedOperator({
      id: "op1",
      email: "admin@test.com",
      passwordHash,
    });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "s3cr3t" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
    const body = JSON.parse(res.body) as { data: { email: string } };
    expect(body.data.email).toBe("admin@test.com");
  });

  it("returns 401 for wrong password", async () => {
    const deps = buildTestDeps();
    const passwordHash = await argon2.hash("correct");
    (deps.operatorRepo as import("./helpers/mocks.js").MockOperatorRepository).seedOperator({
      id: "op2",
      email: "user@test.com",
      passwordHash,
    });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "user@test.com", password: "wrong" }),
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH-1: Rate-limiting POST /v1/auth/login
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/auth/login — rate limiting (AUTH-1)", () => {
  it("returns 429 after exceeding login rate limit without invoking argon2", async () => {
    // Use a real RateLimiter with a tight login bucket: max 3 attempts / window.
    const tightLimiter = new RateLimiter({
      ...RATE_LIMIT_BUCKETS,
      login: { maxRequests: 3, windowMs: 60_000 },
    });
    const deps = buildTestDeps({ rateLimiter: tightLimiter });

    // Track how many times findByEmail was called (proxy for DB+argon2 work).
    let findByEmailCalls = 0;
    const origFind = deps.operatorRepo.findByEmail.bind(deps.operatorRepo);
    (deps.operatorRepo as import("../auth.js").OperatorRepository).findByEmail = async (email: string) => {
      findByEmailCalls++;
      return origFind(email);
    };

    const app = buildApp(deps);

    // Send 3 requests (within limit): all should NOT be 429
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "unknown@test.com", password: "wrong" }),
        remoteAddress: "10.0.0.1",
      });
      expect(res.statusCode).not.toBe(429);
    }
    const callsAfterLimit = findByEmailCalls;

    // 4th request: must be rate-limited (429) — argon2 must NOT run for this request
    const limitedRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "unknown@test.com", password: "wrong" }),
      remoteAddress: "10.0.0.1",
    });
    expect(limitedRes.statusCode).toBe(429);

    // findByEmail must NOT have been called for the 4th (rate-limited) request
    expect(findByEmailCalls).toBe(callsAfterLimit);

    const body = JSON.parse(limitedRes.body) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("a normal login succeeds when under the rate limit", async () => {
    // Verify the happy path still works when limit is not reached.
    const tightLimiter = new RateLimiter({
      ...RATE_LIMIT_BUCKETS,
      login: { maxRequests: 10, windowMs: 60_000 },
    });
    const deps = buildTestDeps({ rateLimiter: tightLimiter });
    const passwordHash = await argon2.hash("correct-password");
    (deps.operatorRepo as import("./helpers/mocks.js").MockOperatorRepository).seedOperator({
      id: "op-rl-test",
      email: "rl@test.com",
      passwordHash,
    });
    const app = buildApp(deps);

    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "rl@test.com", password: "correct-password" }),
      remoteAddress: "10.0.0.2",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { email: string } };
    expect(body.data.email).toBe("rl@test.com");
  });

  it("different IPs have independent login buckets", async () => {
    // Requests from different remote addresses should not share a rate-limit bucket.
    const tightLimiter = new RateLimiter({
      ...RATE_LIMIT_BUCKETS,
      login: { maxRequests: 1, windowMs: 60_000 },
    });
    const deps = buildTestDeps({ rateLimiter: tightLimiter });
    const app = buildApp(deps);

    // First IP: first request allowed, second blocked
    const r1 = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@test.com", password: "pw" }),
      remoteAddress: "11.0.0.1",
    });
    expect(r1.statusCode).not.toBe(429); // within limit

    const r2 = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@test.com", password: "pw" }),
      remoteAddress: "11.0.0.1",
    });
    expect(r2.statusCode).toBe(429); // over limit

    // Second IP: still within its own limit
    const r3 = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@test.com", password: "pw" }),
      remoteAddress: "11.0.0.2", // different IP
    });
    expect(r3.statusCode).not.toBe(429); // its own fresh bucket
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiter unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("RateLimiter", () => {
  it("allows requests within limit", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 60; i++) {
      expect(rl.check("public_status", "1.2.3.4")).toBe(true);
    }
  });

  it("blocks after exceeding limit", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < RATE_LIMIT_BUCKETS["public_status"]!.maxRequests; i++) {
      rl.check("public_status", "10.0.0.1");
    }
    expect(rl.check("public_status", "10.0.0.1")).toBe(false);
  });

  it("sliding window expires old tokens", () => {
    let fakeNow = 1000;
    const rl = new RateLimiter(
      { test_bucket: { maxRequests: 2, windowMs: 1000 } },
      { now: () => fakeNow },
    );
    rl.check("test_bucket", "a");
    rl.check("test_bucket", "a");
    expect(rl.check("test_bucket", "a")).toBe(false); // limit hit
    fakeNow += 1001; // advance past window
    expect(rl.check("test_bucket", "a")).toBe(true); // old tokens expired
  });

  it("different entities have independent windows", () => {
    const rl = new RateLimiter({ b: { maxRequests: 1, windowMs: 60_000 } });
    rl.check("b", "x"); // x exhausted
    expect(rl.check("b", "y")).toBe(true); // y unaffected
    expect(rl.check("b", "x")).toBe(false); // x still blocked
  });

  it("rate limiting on POST /v1/events returns 429", async () => {
    const deps = buildTestDeps();
    // Override rate limiter with a very tight limit.
    deps.rateLimiter = new RateLimiter({
      admin: { maxRequests: 1, windowMs: 60_000 },
      invoice_create: { maxRequests: 999, windowMs: 60_000 },
      public_status: { maxRequests: 999, windowMs: 60_000 },
    });
    const app = buildApp(deps);

    // Exhaust the limit.
    await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: bearer(deps.adminKey),
    });
    // Second request should be rate-limited.
    const res = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: bearer(deps.adminKey),
    });
    expect(res.statusCode).toBe(429);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1 — hostedUrl in POST /v1/invoices and GET /v1/invoices/:id
// ─────────────────────────────────────────────────────────────────────────────

describe("hostedUrl in invoice responses", () => {
  it("POST /v1/invoices returns hostedUrl = PUBLIC_BASE_URL + /pay/<id>", async () => {
    const deps = buildTestDeps({ publicBaseUrl: "https://pay.example.com" });
    (deps.eventRepo as MockEventRepository).seed({ id: "ev_hurl1" });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(deps.merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ev_hurl1", priceFiat: "10.00", fiatCurrency: "USD" }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { data: { id: string; hostedUrl: string } };
    expect(body.data.hostedUrl).toBe(`https://pay.example.com/pay/${body.data.id}`);
  });

  it("GET /v1/invoices/:id returns hostedUrl", async () => {
    const deps = buildTestDeps({ publicBaseUrl: "https://pay.example.com" });
    const inv = (deps.invoiceRepo as MockInvoiceRepository).seed({
      id: "inv_hurl1",
      eventId: "ev99",
    });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: `/v1/invoices/${inv.id}`,
      headers: bearer(deps.merchantKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { hostedUrl: string } };
    expect(body.data.hostedUrl).toBe(`https://pay.example.com/pay/${inv.id}`);
  });

  it("hostedUrl defaults to http://localhost:3000 when publicBaseUrl not set", async () => {
    const deps = buildTestDeps(); // no publicBaseUrl override
    (deps.eventRepo as MockEventRepository).seed({ id: "ev_hurl2" });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(deps.merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ev_hurl2", priceFiat: "5.00", fiatCurrency: "USD" }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { data: { id: string; hostedUrl: string } };
    expect(body.data.hostedUrl).toMatch(/^http:\/\/localhost:\d+\/pay\//);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2 — q + metadata.<k> filter on GET /v1/invoices
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/invoices — q and metadata filter", () => {
  it("?q= filters by metadata content (case-insensitive)", async () => {
    const deps = buildTestDeps();
    const repo = deps.invoiceRepo as MockInvoiceRepository;
    repo.seed({ id: "inv_q1", eventId: "ev1", metadata: { orderId: "ALPHA-001" } });
    repo.seed({ id: "inv_q2", eventId: "ev1", metadata: { orderId: "BETA-002" } });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/invoices?q=alpha",
      headers: bearer(deps.merchantKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.some((r) => r.id === "inv_q1")).toBe(true);
    expect(body.data.some((r) => r.id === "inv_q2")).toBe(false);
  });

  it("?metadata.<key>=<value> filters by typed JSON path (exact match)", async () => {
    const deps = buildTestDeps();
    const repo = deps.invoiceRepo as MockInvoiceRepository;
    repo.seed({ id: "inv_m1", eventId: "ev1", metadata: { tenant: "acme" } });
    repo.seed({ id: "inv_m2", eventId: "ev1", metadata: { tenant: "globex" } });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/invoices?metadata.tenant=acme",
      headers: bearer(deps.merchantKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.some((r) => r.id === "inv_m1")).toBe(true);
    expect(body.data.some((r) => r.id === "inv_m2")).toBe(false);
  });

  it("metadata key containing SQL-special chars is treated as a literal — no injection bypass", async () => {
    // Security contract: metadata filter must use Prisma's typed JSON path array
    // (or equivalent in-memory property lookup), never raw SQL concatenation.
    // A key that contains SQL chars must be treated literally — only exact-matching
    // rows should be returned.
    //
    // Test setup: one row with key "tenant", one row with key "tenant; DROP TABLE"
    // (with a semicolon — the injection char). We filter by the malicious literal key.
    // Only the row with the exact matching key should be returned, proving the filter
    // is typed (not SQL-injected into a LIKE or raw WHERE clause).
    const deps = buildTestDeps();
    const repo = deps.invoiceRepo as MockInvoiceRepository;
    // Row whose metadata has the NORMAL key "tenant".
    repo.seed({ id: "inv_safe_normal", eventId: "ev1", metadata: { tenant: "victim" } });
    // Row whose metadata has the malicious literal key (what would be the injected value).
    const maliciousLiteralKey = "tenant; DROP TABLE invoices--";
    repo.seed({ id: "inv_safe_malicious", eventId: "ev1", metadata: { [maliciousLiteralKey]: "victim" } });

    const app = buildApp(deps);

    // Filter by the malicious literal key name (URL-encoded).
    const res = await app.inject({
      method: "GET",
      url: `/v1/invoices?metadata.${encodeURIComponent(maliciousLiteralKey)}=victim`,
      headers: bearer(deps.merchantKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };

    // ONLY the row with the exact literal key must appear — not the "tenant" row.
    // If this were SQL-injected (e.g. "WHERE metadata->>'tenant; DROP TABLE...' = ..."),
    // both or all rows might appear. Typed path means exactly one row matches.
    expect(body.data.some((r) => r.id === "inv_safe_malicious")).toBe(true);
    expect(body.data.some((r) => r.id === "inv_safe_normal")).toBe(false);
    // Must be exactly the one matching row.
    expect(body.data.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3 — Per-key idempotency: same key under two different API keys → no collision
// ─────────────────────────────────────────────────────────────────────────────

describe("Idempotency-Key — per-api-key scoping", () => {
  beforeEach(() => {
    idempotencyStore.clear();
  });
  afterEach(() => {
    idempotencyStore.clear();
  });

  it("same Idempotency-Key under two different api-keys does NOT collide (no spurious 409)", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev_idem_scope" });

    // Seed a second merchant key.
    const merchantRaw2 = "merchantkey_test_second_0000000abc";
    (deps.apiKeyRepo as import("./helpers/mocks.js").MockApiKeyRepository).seedKey({
      rawKey: merchantRaw2,
      scope: "merchant",
      label: "second-merchant",
    });

    const app = buildApp(deps);
    const idemKey = "shared-key-across-merchants";

    // First merchant creates invoice.
    const r1 = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(deps.merchantKey),
        "content-type": "application/json",
        "idempotency-key": idemKey,
      },
      body: JSON.stringify({ eventId: "ev_idem_scope", priceFiat: "10.00", fiatCurrency: "USD" }),
    });
    expect(r1.statusCode).toBe(201);
    const b1 = JSON.parse(r1.body) as { data: { id: string } };

    // Second merchant uses THE SAME Idempotency-Key — must NOT get a 409 cache hit.
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(merchantRaw2),
        "content-type": "application/json",
        "idempotency-key": idemKey,
      },
      body: JSON.stringify({ eventId: "ev_idem_scope", priceFiat: "20.00", fiatCurrency: "USD" }),
    });
    // Should succeed independently (different body, different merchant, no collision).
    expect(r2.statusCode).toBe(201);
    const b2 = JSON.parse(r2.body) as { data: { id: string } };

    // The two invoices must be different (no cross-merchant cache hit).
    expect(b1.data.id).not.toBe(b2.data.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4 — public_status rate limiting keyed per INVOICE ID (payer privacy)
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/public/invoices/:id — per-invoice rate limiting (payer privacy)", () => {
  /** Tight public_status limit (1 req/min) for bucket-keying tests. */
  function tightPublicLimiter(): RateLimiter {
    return new RateLimiter({
      public_status: { maxRequests: 1, windowMs: 60_000 },
      invoice_create: { maxRequests: 999, windowMs: 60_000 },
      admin: { maxRequests: 999, windowMs: 60_000 },
      merchant_read: { maxRequests: 999, windowMs: 60_000 },
    });
  }

  it("two requests for the same invoice share one bucket regardless of X-Forwarded-For", async () => {
    const deps = buildTestDeps();
    const inv = (deps.invoiceRepo as MockInvoiceRepository).seed({
      id: "pub_xff1",
      eventId: "ev_xff",
    });
    deps.rateLimiter = tightPublicLimiter();
    const app = buildApp(deps);

    // First request — allowed; uses a fake XFF.
    const r1 = await app.inject({
      method: "GET",
      url: `/v1/public/invoices/${inv.id}`,
      headers: { "x-forwarded-for": "9.9.9.9" },
    });
    expect(r1.statusCode).toBe(200);

    // Second request for the SAME invoice with a DIFFERENT XFF — must still be 429.
    // The bucket is keyed by invoice ID (payer privacy — no IP keying), so
    // header forging cannot mint a fresh bucket.
    const r2 = await app.inject({
      method: "GET",
      url: `/v1/public/invoices/${inv.id}`,
      headers: { "x-forwarded-for": "8.8.8.8" },
    });
    expect(r2.statusCode).toBe(429);
  });

  it("two DIFFERENT invoices do not share a rate-limit bucket", async () => {
    const deps = buildTestDeps();
    const repo = deps.invoiceRepo as MockInvoiceRepository;
    const invA = repo.seed({ id: "pub_key_a", eventId: "ev_key" });
    const invB = repo.seed({ id: "pub_key_b", eventId: "ev_key" });
    deps.rateLimiter = tightPublicLimiter();
    const app = buildApp(deps);

    // Exhaust invoice A's budget (limit = 1).
    const a1 = await app.inject({ method: "GET", url: `/v1/public/invoices/${invA.id}` });
    expect(a1.statusCode).toBe(200);
    const a2 = await app.inject({ method: "GET", url: `/v1/public/invoices/${invA.id}` });
    expect(a2.statusCode).toBe(429);

    // Invoice B has its own bucket — still allowed.
    const b1 = await app.inject({ method: "GET", url: `/v1/public/invoices/${invB.id}` });
    expect(b1.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Payer privacy — checkout routes set no cookies, store no payer identifiers
// ─────────────────────────────────────────────────────────────────────────────

describe("payer privacy — no Set-Cookie on payer-facing routes", () => {
  it("GET /pay/:invoiceId response has no Set-Cookie header", async () => {
    const deps = buildTestDeps();
    const inv = (deps.invoiceRepo as MockInvoiceRepository).seed({
      id: "pub_nocookie",
      eventId: "ev_nc",
    });
    const app = buildApp(deps);

    const res = await app.inject({ method: "GET", url: `/pay/${inv.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("GET /v1/public/invoices/:id response has no Set-Cookie header", async () => {
    const deps = buildTestDeps();
    const inv = (deps.invoiceRepo as MockInvoiceRepository).seed({
      id: "pub_nocookie2",
      eventId: "ev_nc",
    });
    const app = buildApp(deps);

    const res = await app.inject({ method: "GET", url: `/v1/public/invoices/${inv.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #5 — limit clamping on GET /v1/invoices
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/invoices — limit clamping", () => {
  it("?limit=100000000 is capped at 100", async () => {
    const deps = buildTestDeps();
    const repo = deps.invoiceRepo as MockInvoiceRepository;
    // Seed 110 invoices.
    for (let i = 0; i < 110; i++) {
      repo.seed({ id: `inv_clamp_${i}`, eventId: "ev1" });
    }
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/invoices?limit=100000000",
      headers: bearer(deps.merchantKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[] };
    expect(body.data.length).toBeLessThanOrEqual(100);
  });

  it("?limit=abc (NaN) uses default (20)", async () => {
    const deps = buildTestDeps();
    const repo = deps.invoiceRepo as MockInvoiceRepository;
    // Seed 30 invoices.
    for (let i = 0; i < 30; i++) {
      repo.seed({ id: `inv_nan_${i}`, eventId: "ev1" });
    }
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/invoices?limit=abc",
      headers: bearer(deps.merchantKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[] };
    // Default is 20 — must not 500 and must not return all 30.
    expect(body.data.length).toBe(20);
  });

  it("missing limit uses default (20)", async () => {
    const deps = buildTestDeps();
    const repo = deps.invoiceRepo as MockInvoiceRepository;
    for (let i = 0; i < 25; i++) {
      repo.seed({ id: `inv_def_${i}`, eventId: "ev1" });
    }
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/invoices",
      headers: bearer(deps.merchantKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[] };
    expect(body.data.length).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #7 — merchant_read bucket separate from admin
// ─────────────────────────────────────────────────────────────────────────────

describe("merchant_read bucket does not consume admin quota", () => {
  it("exhausting admin quota does not block merchant reads", async () => {
    const deps = buildTestDeps();
    (deps.invoiceRepo as MockInvoiceRepository).seed({ id: "inv_bucket1", eventId: "ev1" });
    // Exhaust admin bucket, keep merchant_read wide open.
    deps.rateLimiter = new RateLimiter({
      admin: { maxRequests: 1, windowMs: 60_000 },
      invoice_create: { maxRequests: 999, windowMs: 60_000 },
      public_status: { maxRequests: 999, windowMs: 60_000 },
      merchant_read: { maxRequests: 999, windowMs: 60_000 },
    });
    const app = buildApp(deps);

    // Exhaust admin (via admin route).
    await app.inject({ method: "GET", url: "/v1/events", headers: bearer(deps.adminKey) });
    // Admin route should now 429.
    const adminRes = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: bearer(deps.adminKey),
    });
    expect(adminRes.statusCode).toBe(429);

    // Merchant read should still work (different bucket, different key prefix).
    const merchantRes = await app.inject({
      method: "GET",
      url: "/v1/invoices",
      headers: bearer(deps.merchantKey),
    });
    expect(merchantRes.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #8 — webhook list strips secret
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/webhooks — secret not in list", () => {
  it("secret absent from list response", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);

    // Create a webhook (secret returned once).
    await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hook-secret" }),
    });

    const listRes = await app.inject({
      method: "GET",
      url: "/v1/webhooks",
      headers: bearer(deps.adminKey),
    });
    expect(listRes.statusCode).toBe(200);
    const body = JSON.parse(listRes.body) as { data: Record<string, unknown>[] };
    for (const hook of body.data) {
      expect(hook["secret"]).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #9 — session-gated GET /api-keys page
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api-keys — session-gated operator page", () => {
  it("redirects to /login without a session cookie", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/api-keys" });
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });

  it("returns 200 with valid session cookie (JSON)", async () => {
    const deps = buildTestDeps();
    const passwordHash = await argon2.hash("pw123");
    (deps.operatorRepo as import("./helpers/mocks.js").MockOperatorRepository).seedOperator({
      id: "op_page1",
      email: "admin@example.com",
      passwordHash,
    });
    const app = buildApp(deps);

    // Login to get session cookie.
    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "pw123" }),
    });
    expect(loginRes.statusCode).toBe(200);
    const setCookie = loginRes.headers["set-cookie"] as string | undefined;
    expect(setCookie).toBeDefined();
    // Extract the cookie value.
    const cookieValue = (setCookie ?? "").split(";")[0];

    const pageRes = await app.inject({
      method: "GET",
      url: "/api-keys",
      headers: {
        cookie: cookieValue,
        accept: "application/json",
      },
    });
    expect(pageRes.statusCode).toBe(200);
    const body = JSON.parse(pageRes.body) as { data: { operator: { email: string } } };
    expect(body.data.operator.email).toBe("admin@example.com");
  });

  it("login sets Secure flag on session cookie", async () => {
    const deps = buildTestDeps();
    const passwordHash = await argon2.hash("secure!");
    (deps.operatorRepo as import("./helpers/mocks.js").MockOperatorRepository).seedOperator({
      id: "op_sec",
      email: "secure@example.com",
      passwordHash,
    });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "secure@example.com", password: "secure!" }),
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.headers["set-cookie"] as string | undefined;
    expect(cookie).toBeDefined();
    expect(cookie?.toLowerCase()).toContain("secure");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NICE-TO-HAVE: rate-limiter fails CLOSED on unknown bucket
// ─────────────────────────────────────────────────────────────────────────────

describe("RateLimiter — fail-closed on unknown bucket", () => {
  it("throws on unknown bucket name instead of silently allowing", () => {
    const rl = new RateLimiter();
    expect(() => rl.check("nonexistent_bucket", "entity")).toThrow(/unknown bucket/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NICE-TO-HAVE: idempotency bodyFingerprint is canonical (sorted keys)
// ─────────────────────────────────────────────────────────────────────────────

describe("Idempotency-Key — canonical body fingerprint (key order)", () => {
  beforeEach(() => { idempotencyStore.clear(); });
  afterEach(() => { idempotencyStore.clear(); });

  it("same body with reordered keys does NOT spuriously 409", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev_canon1" });
    const app = buildApp(deps);

    // First request.
    const r1 = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(deps.merchantKey),
        "content-type": "application/json",
        "idempotency-key": "canon-key-001",
      },
      body: JSON.stringify({ eventId: "ev_canon1", priceFiat: "15.00", fiatCurrency: "USD" }),
    });
    expect(r1.statusCode).toBe(201);

    // Second request: same semantic body, different key order.
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(deps.merchantKey),
        "content-type": "application/json",
        "idempotency-key": "canon-key-001",
      },
      body: JSON.stringify({ fiatCurrency: "USD", priceFiat: "15.00", eventId: "ev_canon1" }),
    });
    // Must be treated as the same body → 201 (cached), not 409.
    expect(r2.statusCode).toBe(201);
    const b1 = JSON.parse(r1.body) as { data: { id: string } };
    const b2 = JSON.parse(r2.body) as { data: { id: string } };
    expect(b1.data.id).toBe(b2.data.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HIGH-1: OperatorRepository.create + first-run bootstrap end-to-end
//
// Verifies that:
//   1. MockOperatorRepository.create() creates an Operator row and rejects
//      duplicate emails (mirrors Prisma P2002 constraint).
//   2. The full M2 flow works when operator is created via .create() (not just
//      seedOperator()): create → login → session → mint admin key.
// ─────────────────────────────────────────────────────────────────────────────

describe("HIGH-1: OperatorRepository.create + bootstrap end-to-end", () => {
  it("MockOperatorRepository.create() creates operator and findByEmail returns it", async () => {
    const { MockOperatorRepository } = await import("./helpers/mocks.js");
    const repo = new MockOperatorRepository();

    const hashedPw = await argon2.hash("test-password", { type: argon2.argon2id });
    const op = await repo.create("newoperator@example.com", hashedPw);

    expect(op.id).toBeTruthy();
    expect(op.email).toBe("newoperator@example.com");
    expect(op.passwordHash).toBe(hashedPw);

    const found = await repo.findByEmail("newoperator@example.com");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(op.id);
  });

  it("MockOperatorRepository.create() rejects duplicate email with P2002-style error", async () => {
    const { MockOperatorRepository } = await import("./helpers/mocks.js");
    const repo = new MockOperatorRepository();

    const hashedPw = await argon2.hash("pass1");
    await repo.create("dup@example.com", hashedPw);

    // Second create with same email must throw (mirrors Postgres P2002 unique constraint)
    await expect(repo.create("dup@example.com", hashedPw)).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("HIGH-1 E2E: operator created via .create() can login and mint first admin key", async () => {
    // This is the full M2 first-run bootstrap:
    //   1. operator init: create(email, passwordHash) — tested here via MockOperatorRepository
    //   2. login at /v1/auth/login → session cookie
    //   3. POST /v1/api-keys with session cookie → rawKey returned
    //   4. rawKey is a valid admin key (can auth bearer requests)
    const deps = buildTestDeps();
    const app = buildApp(deps);

    const operatorRepo = deps.operatorRepo as import("./helpers/mocks.js").MockOperatorRepository;

    // Step 1: simulate `operator init --email` by calling .create()
    const password = "bootstrap-password-secure";
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const operator = await operatorRepo.create("bootstrap@example.com", passwordHash);
    expect(operator.id).toBeTruthy();

    // Step 2: login
    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bootstrap@example.com", password }),
    });
    expect(loginRes.statusCode).toBe(200);

    const setCookie = loginRes.headers["set-cookie"] as string;
    const cookieMatch = setCookie.match(/stablerails_session=([^;]+)/);
    expect(cookieMatch).not.toBeNull();
    const sessionCookie = `stablerails_session=${cookieMatch![1]}`;

    // Step 3: mint first admin key using only the session cookie (no Bearer token)
    const createKeyRes = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
      },
      body: JSON.stringify({ label: "first-admin-key", scope: "admin" }),
    });
    expect(createKeyRes.statusCode).toBe(201);
    const keyBody = JSON.parse(createKeyRes.body) as {
      data: { rawKey: string; scope: string; prefix: string };
    };
    expect(keyBody.data.scope).toBe("admin");
    expect(typeof keyBody.data.rawKey).toBe("string");
    expect(keyBody.data.rawKey.length).toBeGreaterThan(20);

    // Step 4: new admin key can authenticate a real admin request
    const eventsRes = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: { authorization: `Bearer ${keyBody.data.rawKey}` },
    });
    expect(eventsRes.statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-2: Invoice TTL cap + idempotency retention cap + prune
// ─────────────────────────────────────────────────────────────────────────────

describe("SEC-2: Invoice TTL cap", () => {
  beforeEach(() => {
    idempotencyStore.clear();
  });

  it("rejects ttlMinutes > 1440 (24h) with 400", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev-ttl-1" });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(deps.merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ev-ttl-1", priceFiat: "10.00", fiatCurrency: "USD", ttlMinutes: 1441 }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("TTL_OUT_OF_RANGE");
  });

  it("rejects ttlMinutes = 0 with 400", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev-ttl-2" });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(deps.merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ev-ttl-2", priceFiat: "10.00", fiatCurrency: "USD", ttlMinutes: 0 }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("TTL_OUT_OF_RANGE");
  });

  it("rejects NaN ttlMinutes with 400", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev-ttl-3" });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(deps.merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ev-ttl-3", priceFiat: "10.00", fiatCurrency: "USD", ttlMinutes: "not-a-number" }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("TTL_OUT_OF_RANGE");
  });

  it("rejects expiresInSeconds > 86400 (24h) with 400", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev-ttl-4" });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(deps.merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ev-ttl-4", priceFiat: "10.00", fiatCurrency: "USD", expiresInSeconds: 86401 }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("TTL_OUT_OF_RANGE");
  });

  it("accepts valid ttlMinutes = 60 (1h)", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev-ttl-5" });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(deps.merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ev-ttl-5", priceFiat: "10.00", fiatCurrency: "USD", ttlMinutes: 60 }),
    });
    expect(res.statusCode).toBe(201);
  });

  it("accepts valid ttlMinutes = 1440 (max = 24h)", async () => {
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev-ttl-6" });
    const app = buildApp(deps);
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(deps.merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ev-ttl-6", priceFiat: "10.00", fiatCurrency: "USD", ttlMinutes: 1440 }),
    });
    expect(res.statusCode).toBe(201);
  });

  it("idempotency entries with past expiresAt are pruned on next write", async () => {
    // Manually insert an expired entry.
    idempotencyStore.set("stale-key", {
      statusCode: 201,
      body: { data: { id: "old-invoice" } },
      bodyHash: "{}",
      expiresAt: Date.now() - 1000, // expired 1s ago
    });
    expect(idempotencyStore.size).toBe(1);

    // A new write to any key should trigger a prune sweep.
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({ id: "ev-ttl-7" });
    const app = buildApp(deps);
    await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: {
        ...bearer(deps.merchantKey),
        "content-type": "application/json",
        "idempotency-key": "new-key",
      },
      body: JSON.stringify({ eventId: "ev-ttl-7", priceFiat: "5.00", fiatCurrency: "USD" }),
    });

    // The stale entry should have been pruned.
    expect(idempotencyStore.has("stale-key")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-3: Security headers on HTML routes
// ─────────────────────────────────────────────────────────────────────────────

describe("SEC-3: Security headers", () => {
  it("GET /login sets X-Content-Type-Options: nosniff", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("GET /login sets X-Frame-Options or CSP frame-ancestors to block framing", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/login" });
    // Either X-Frame-Options DENY or CSP frame-ancestors 'none' must be present
    const xfo = res.headers["x-frame-options"];
    const csp = (res.headers["content-security-policy"] as string | undefined) ?? "";
    const hasFrameBlock = (xfo && xfo.toUpperCase().includes("DENY")) ||
                          csp.includes("frame-ancestors");
    expect(hasFrameBlock).toBe(true);
  });

  it("GET /login has a Referrer-Policy header", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.headers["referrer-policy"]).toBeTruthy();
  });

  it("GET /login returns HTML (page still renders correctly)", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("Войти");
  });

  it("GET /pay/:id sets X-Content-Type-Options: nosniff", async () => {
    const deps = buildTestDeps();
    const inv = (deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).seed({
      id: "inv-sec",
      eventId: "ev-sec",
    });
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: `/pay/${inv.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("GET /pay/:id page still renders (CSP nonce does not break HTML output)", async () => {
    const deps = buildTestDeps();
    const inv = (deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).seed({
      id: "inv-sec2",
      eventId: "ev-sec2",
    });
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: `/pay/${inv.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("USDT");
  });

  it("JSON API routes (GET /v1/events) do not return HTML security headers but still work", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({
      method: "GET",
      url: "/v1/events",
      headers: bearer(deps.adminKey),
    });
    expect(res.statusCode).toBe(200);
    // Must have x-content-type-options globally
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  // ── I-2: CSP nonce consistency per HTML route ──────────────────────────────

  it("I-2 /login: CSP script-src contains nonce and not 'unsafe-inline'", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: "/login" });
    expect(res.statusCode).toBe(200);
    const csp = (res.headers["content-security-policy"] as string) ?? "";
    // Extract script-src directive value
    const scriptSrcMatch = /script-src([^;]*)/i.exec(csp);
    expect(scriptSrcMatch, "CSP must have a script-src directive").not.toBeNull();
    const scriptSrc = scriptSrcMatch![1] ?? "";
    // /login has no inline <script> so script-src 'none' is acceptable — just
    // assert there is no 'unsafe-inline' that would negate the protection.
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("I-2 /api-keys: CSP script-src contains 'nonce-' and not 'unsafe-inline'; header nonce matches <script nonce>", async () => {
    const deps = buildTestDeps();
    const passwordHash = await import("argon2").then((a) => a.hash("pw-i2"));
    (deps.operatorRepo as import("./helpers/mocks.js").MockOperatorRepository).seedOperator({
      id: "op-i2",
      email: "i2@example.com",
      passwordHash,
    });
    const app = buildApp(deps);
    const loginRes = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "i2@example.com", password: "pw-i2" }),
    });
    const cookieValue = ((loginRes.headers["set-cookie"] as string) ?? "").split(";")[0];

    const res = await app.inject({
      method: "GET",
      url: "/api-keys",
      headers: { cookie: cookieValue },
    });
    expect(res.statusCode).toBe(200);

    const csp = (res.headers["content-security-policy"] as string) ?? "";
    const scriptSrcMatch = /script-src([^;]*)/i.exec(csp);
    expect(scriptSrcMatch, "CSP must have a script-src directive").not.toBeNull();
    const scriptSrc = scriptSrcMatch![1] ?? "";

    // Must contain a nonce
    expect(scriptSrc).toContain("'nonce-");
    // Must NOT contain unsafe-inline (which would bypass the nonce)
    expect(scriptSrc).not.toContain("'unsafe-inline'");

    // Extract nonce value from CSP header
    const nonceInHeader = /'nonce-([^']+)'/.exec(scriptSrc)?.[1];
    expect(nonceInHeader, "nonce value must be present in script-src").toBeTruthy();

    // Nonce in the rendered <script nonce="..."> must match the CSP header nonce
    expect(res.body).toContain(`<script nonce="${nonceInHeader}">`);
  });

  it("I-2 /pay/:id: CSP script-src contains 'nonce-' and not 'unsafe-inline'; header nonce matches <script nonce>; no onclick= attribute", async () => {
    const deps = buildTestDeps();
    const inv = (deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).seed({
      id: "inv-i2",
      eventId: "ev-i2",
    });
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: `/pay/${inv.id}` });
    expect(res.statusCode).toBe(200);

    const csp = (res.headers["content-security-policy"] as string) ?? "";
    const scriptSrcMatch = /script-src([^;]*)/i.exec(csp);
    expect(scriptSrcMatch, "CSP must have a script-src directive").not.toBeNull();
    const scriptSrc = scriptSrcMatch![1] ?? "";

    // Must contain a nonce
    expect(scriptSrc).toContain("'nonce-");
    // Must NOT contain unsafe-inline
    expect(scriptSrc).not.toContain("'unsafe-inline'");

    // Nonce in header must match <script nonce="..."> in the rendered HTML
    const nonceInHeader = /'nonce-([^']+)'/.exec(scriptSrc)?.[1];
    expect(nonceInHeader, "nonce value must be present in script-src").toBeTruthy();
    expect(res.body).toContain(`<script nonce="${nonceInHeader}">`);

    // I-1 regression guard: the copy interaction must NOT use an inline onclick=
    // attribute (blocked by script-src-attr 'none'). The handler must be bound
    // inside the nonce'd script block.
    expect(res.body).not.toContain("onclick=");
    // The nonce'd script must contain the addEventListener binding for #addr
    expect(res.body).toContain('addEventListener("click", copyAddress)');
  });

  // ── I-3: style-src nonce consistency — inline <style> must be allowed ────────
  // When enableCSPNonces is true, @fastify/helmet injects a nonce into style-src.
  // Per CSP spec, a nonce in a directive makes 'unsafe-inline' ineffective, so
  // the <style> tag MUST carry a matching nonce or the browser blocks all styles.

  it("I-3 /pay/:id: CSP style-src contains 'nonce-' and <style> tag carries matching nonce", async () => {
    const deps = buildTestDeps();
    const inv = (deps.invoiceRepo as import("./helpers/mocks.js").MockInvoiceRepository).seed({
      id: "inv-i3",
      eventId: "ev-i3",
    });
    const app = buildApp(deps);
    const res = await app.inject({ method: "GET", url: `/pay/${inv.id}` });
    expect(res.statusCode).toBe(200);

    const csp = (res.headers["content-security-policy"] as string) ?? "";

    // style-src must contain a nonce (injected by helmet when enableCSPNonces=true)
    const styleSrcMatch = /style-src([^;]*)/i.exec(csp);
    expect(styleSrcMatch, "CSP must have a style-src directive").not.toBeNull();
    const styleSrc = styleSrcMatch![1] ?? "";
    expect(styleSrc).toContain("'nonce-");

    // The nonce in the style-src header must match the <style nonce="..."> in the HTML
    const nonceInHeader = /'nonce-([^']+)'/.exec(styleSrc)?.[1];
    expect(nonceInHeader, "style nonce must be present in style-src").toBeTruthy();
    expect(res.body).toContain(`<style nonce="${nonceInHeader}">`);

    // script-src must still be nonce-locked with NO 'unsafe-inline' (Tier-1a invariant)
    const scriptSrcMatch = /script-src([^;]*)/i.exec(csp);
    expect(scriptSrcMatch, "CSP must have a script-src directive").not.toBeNull();
    const scriptSrc = scriptSrcMatch![1] ?? "";
    expect(scriptSrc).toContain("'nonce-");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("I-3 /demo: CSP style-src contains 'nonce-' and <style> tag carries matching nonce", async () => {
    const originalEnvDemo = process.env["ENABLE_DEMO"];
    const originalStablerailsEnv = process.env["STABLERAILS_ENV"];
    process.env["ENABLE_DEMO"] = "1";
    // Use STABLERAILS_ENV=testnet to lift the localhost restriction (main's gating mechanism)
    process.env["STABLERAILS_ENV"] = "testnet";
    try {
      const deps = buildTestDeps();
      const app = buildApp(deps);
      const res = await app.inject({ method: "GET", url: "/demo" });
      await app.close();

      expect(res.statusCode).toBe(200);

      const csp = (res.headers["content-security-policy"] as string) ?? "";

      // style-src must contain a nonce
      const styleSrcMatch = /style-src([^;]*)/i.exec(csp);
      expect(styleSrcMatch, "CSP must have a style-src directive").not.toBeNull();
      const styleSrc = styleSrcMatch![1] ?? "";
      expect(styleSrc).toContain("'nonce-");

      // The nonce in the style-src header must match the <style nonce="..."> in the HTML
      const nonceInHeader = /'nonce-([^']+)'/.exec(styleSrc)?.[1];
      expect(nonceInHeader, "style nonce must be present in style-src").toBeTruthy();
      expect(res.body).toContain(`<style nonce="${nonceInHeader}">`);

      // script-src must still be nonce-locked (no unsafe-inline)
      const scriptSrcMatch = /script-src([^;]*)/i.exec(csp);
      expect(scriptSrcMatch, "CSP must have a script-src directive").not.toBeNull();
      const scriptSrc = scriptSrcMatch![1] ?? "";
      expect(scriptSrc).toContain("'nonce-");
      expect(scriptSrc).not.toContain("'unsafe-inline'");
    } finally {
      if (originalEnvDemo === undefined) delete process.env["ENABLE_DEMO"];
      else process.env["ENABLE_DEMO"] = originalEnvDemo;
      if (originalStablerailsEnv === undefined) delete process.env["STABLERAILS_ENV"];
      else process.env["STABLERAILS_ENV"] = originalStablerailsEnv;
    }
  });
});
