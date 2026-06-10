/**
 * Multi-merchant tenant isolation (BOLA fix) tests.
 *
 * Tenancy rules under test:
 *   - merchant/readonly keys are confined to their merchantId tenant;
 *     invoices and sweep intents inherit tenancy through their event.
 *   - A key with merchantId = null is a LEGACY single-tenant key: it sees
 *     only resources whose merchantId is also null (the "default tenant").
 *   - admin keys see and manage everything (merchantId ignored).
 *   - Cross-tenant by-id access returns 404 (no existence leak).
 *
 * All tests are offline: in-memory repos via buildTestDeps(), no DATABASE_URL.
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps, MockEventRepository, MockInvoiceRepository, MockApiKeyRepository, MockSweepIntentRepository } from "./helpers/mocks.js";
import type { InvoiceRow } from "../../core/ports.js";

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

const KEY_A = "merchant_a_key_1234567890abcdef00";
const KEY_B = "merchant_b_key_1234567890abcdef00";
const KEY_LEGACY = "legacy_merchant_key_1234567890ab";
const KEY_READONLY_A = "readonly_a_key_1234567890abcdef0";

/**
 * Build an app with:
 *   - merchant keys A ("merchant-a"), B ("merchant-b"), legacy (null tenant)
 *   - readonly key bound to "merchant-a"
 *   - events + pending invoices for tenant A, tenant B, and the null tenant
 */
function buildTenantApp() {
  const deps = buildTestDeps();
  const apiKeyRepo = deps.apiKeyRepo as MockApiKeyRepository;
  const eventRepo = deps.eventRepo as MockEventRepository;
  const invoiceRepo = deps.invoiceRepo as MockInvoiceRepository;

  apiKeyRepo.seedKey({ rawKey: KEY_A, scope: "merchant", label: "merchant-a-key", merchantId: "merchant-a" });
  apiKeyRepo.seedKey({ rawKey: KEY_B, scope: "merchant", label: "merchant-b-key", merchantId: "merchant-b" });
  apiKeyRepo.seedKey({ rawKey: KEY_LEGACY, scope: "merchant", label: "legacy-key" });
  apiKeyRepo.seedKey({ rawKey: KEY_READONLY_A, scope: "readonly", label: "readonly-a-key", merchantId: "merchant-a" });

  const eventA = eventRepo.seed({ id: "evt_a", merchantId: "merchant-a", derivationAccount: 1 });
  const eventB = eventRepo.seed({ id: "evt_b", merchantId: "merchant-b", derivationAccount: 2 });
  const eventLegacy = eventRepo.seed({ id: "evt_legacy", merchantId: null, derivationAccount: 3 });

  const invA = invoiceRepo.seed({ id: "inv_a", eventId: eventA.id, depositAddress: "TAddrAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
  const invB = invoiceRepo.seed({ id: "inv_b", eventId: eventB.id, depositAddress: "TAddrBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" });
  const invLegacy = invoiceRepo.seed({ id: "inv_legacy", eventId: eventLegacy.id, depositAddress: "TAddrLLLLLLLLLLLLLLLLLLLLLLLLLLLLL" });

  const app = buildApp(deps);
  return { app, deps, eventA, eventB, eventLegacy, invA, invB, invLegacy };
}

// ── (a) Merchant key A cannot list/get/cancel merchant B's invoices ──────────

describe("tenant isolation — merchant key A vs merchant B resources", () => {
  it("GET /v1/invoices with key A lists only tenant A invoices", async () => {
    const { app, invA } = buildTenantApp();
    const res = await app.inject({ method: "GET", url: "/v1/invoices", headers: bearer(KEY_A) });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: InvoiceRow[] };
    expect(body.data.map((i) => i.id)).toEqual([invA.id]);
  });

  it("GET /v1/invoices/:id of tenant B with key A returns 404", async () => {
    const { app, invB } = buildTenantApp();
    const res = await app.inject({ method: "GET", url: `/v1/invoices/${invB.id}`, headers: bearer(KEY_A) });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("POST /v1/invoices/:id/cancel of tenant B with key A returns 404 and does NOT cancel", async () => {
    const { app, deps, invB } = buildTenantApp();
    const res = await app.inject({
      method: "POST",
      url: `/v1/invoices/${invB.id}/cancel`,
      headers: bearer(KEY_A),
    });
    expect(res.statusCode).toBe(404);
    // The invoice must remain pending — the cross-tenant write was blocked.
    const stored = (deps.invoiceRepo as MockInvoiceRepository).store.get(invB.id);
    expect(stored?.status).toBe("pending");
  });

  it("POST /v1/invoices for tenant B's event with key A returns 404 EVENT_NOT_FOUND", async () => {
    const { app, eventB } = buildTenantApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(KEY_A), "content-type": "application/json" },
      body: JSON.stringify({ eventId: eventB.id, priceFiat: "100.00", fiatCurrency: "USD" }),
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("EVENT_NOT_FOUND");
  });

  it("GET /v1/events with key A lists only tenant A events", async () => {
    const { app, eventA } = buildTenantApp();
    const res = await app.inject({ method: "GET", url: "/v1/events", headers: bearer(KEY_A) });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.map((e) => e.id)).toEqual([eventA.id]);
  });

  it("GET /v1/events/:id of tenant B with key A returns 404", async () => {
    const { app, eventB } = buildTenantApp();
    const res = await app.inject({ method: "GET", url: `/v1/events/${eventB.id}`, headers: bearer(KEY_B) });
    expect(res.statusCode).toBe(200); // sanity: owner sees it
    const cross = await app.inject({ method: "GET", url: `/v1/events/${eventB.id}`, headers: bearer(KEY_A) });
    expect(cross.statusCode).toBe(404);
  });

  it("readonly key bound to tenant A is confined the same way", async () => {
    const { app, invA, invB } = buildTenantApp();
    const list = await app.inject({ method: "GET", url: "/v1/invoices", headers: bearer(KEY_READONLY_A) });
    expect(list.statusCode).toBe(200);
    const body = JSON.parse(list.body) as { data: InvoiceRow[] };
    expect(body.data.map((i) => i.id)).toEqual([invA.id]);

    const cross = await app.inject({ method: "GET", url: `/v1/invoices/${invB.id}`, headers: bearer(KEY_READONLY_A) });
    expect(cross.statusCode).toBe(404);
  });
});

// ── (b) Legacy null-merchantId key sees only null-tenant resources ───────────

describe("tenant isolation — legacy key (merchantId = null)", () => {
  it("GET /v1/invoices lists only null-tenant invoices", async () => {
    const { app, invLegacy } = buildTenantApp();
    const res = await app.inject({ method: "GET", url: "/v1/invoices", headers: bearer(KEY_LEGACY) });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: InvoiceRow[] };
    expect(body.data.map((i) => i.id)).toEqual([invLegacy.id]);
  });

  it("GET /v1/invoices/:id of a tenant-owned invoice returns 404", async () => {
    const { app, invA } = buildTenantApp();
    const res = await app.inject({ method: "GET", url: `/v1/invoices/${invA.id}`, headers: bearer(KEY_LEGACY) });
    expect(res.statusCode).toBe(404);
  });

  it("GET /v1/invoices/:id of a null-tenant invoice succeeds", async () => {
    const { app, invLegacy } = buildTenantApp();
    const res = await app.inject({ method: "GET", url: `/v1/invoices/${invLegacy.id}`, headers: bearer(KEY_LEGACY) });
    expect(res.statusCode).toBe(200);
  });

  it("GET /v1/events lists only null-tenant events", async () => {
    const { app, eventLegacy } = buildTenantApp();
    const res = await app.inject({ method: "GET", url: "/v1/events", headers: bearer(KEY_LEGACY) });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Array<{ id: string }> };
    expect(body.data.map((e) => e.id)).toEqual([eventLegacy.id]);
  });
});

// ── (c) Admin sees everything ─────────────────────────────────────────────────

describe("tenant isolation — admin sees everything", () => {
  it("GET /v1/invoices lists all tenants' invoices", async () => {
    const { app, deps, invA, invB, invLegacy } = buildTenantApp();
    const res = await app.inject({ method: "GET", url: "/v1/invoices", headers: bearer(deps.adminKey) });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: InvoiceRow[] };
    expect(body.data.map((i) => i.id).sort()).toEqual([invA.id, invB.id, invLegacy.id].sort());
  });

  it("GET /v1/invoices/:id works across tenants", async () => {
    const { app, deps, invB } = buildTenantApp();
    const res = await app.inject({ method: "GET", url: `/v1/invoices/${invB.id}`, headers: bearer(deps.adminKey) });
    expect(res.statusCode).toBe(200);
  });

  it("GET /v1/events lists all tenants' events", async () => {
    const { app, deps } = buildTenantApp();
    const res = await app.inject({ method: "GET", url: "/v1/events", headers: bearer(deps.adminKey) });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[] };
    expect(body.data).toHaveLength(3);
  });
});

// ── (d) Events created via a merchant key inherit its merchantId ─────────────

describe("tenant isolation — event creation inherits key tenant", () => {
  it("merchant key A creates an event carrying merchantId = merchant-a", async () => {
    const { app } = buildTenantApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { ...bearer(KEY_A), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Merchant A Event",
        mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
        derivationAccount: 42,
        xpubAccount: "xpub_merchant_a",
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { data: { id: string; merchantId: string | null } };
    expect(body.data.merchantId).toBe("merchant-a");

    // Merchant B must not see the new event.
    const listB = await app.inject({ method: "GET", url: "/v1/events", headers: bearer(KEY_B) });
    const bodyB = JSON.parse(listB.body) as { data: Array<{ id: string }> };
    expect(bodyB.data.map((e) => e.id)).not.toContain(body.data.id);
  });

  it("merchant key cannot create an event for another tenant (403)", async () => {
    const { app } = buildTenantApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { ...bearer(KEY_A), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Cross-tenant Attempt",
        mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
        derivationAccount: 43,
        xpubAccount: "xpub_x",
        merchantId: "merchant-b",
      }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin may pass an explicit merchantId to create an event for a tenant", async () => {
    const { app, deps } = buildTenantApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Provisioned For C",
        mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
        derivationAccount: 44,
        xpubAccount: "xpub_c",
        merchantId: "merchant-c",
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { data: { merchantId: string | null } };
    expect(body.data.merchantId).toBe("merchant-c");
  });

  it("admin rejects a malformed merchantId with 400 INVALID_MERCHANT_ID", async () => {
    const { app, deps } = buildTenantApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Bad Tenant",
        mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
        derivationAccount: 45,
        xpubAccount: "xpub_bad",
        merchantId: "has spaces!",
      }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_MERCHANT_ID");
  });
});

// ── (e) Minting tenant-bound keys ─────────────────────────────────────────────

describe("tenant isolation — minting keys with merchantId", () => {
  it("admin mints a merchant key with merchantId; listing returns it", async () => {
    const { app, deps } = buildTenantApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ label: "tenant-d-key", scope: "merchant", merchantId: "merchant-d" }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { data: { id: string; merchantId: string | null; rawKey: string } };
    expect(body.data.merchantId).toBe("merchant-d");

    const list = await app.inject({ method: "GET", url: "/v1/api-keys", headers: bearer(deps.adminKey) });
    expect(list.statusCode).toBe(200);
    const listBody = JSON.parse(list.body) as { data: Array<{ id: string; merchantId: string | null }> };
    const minted = listBody.data.find((k) => k.id === body.data.id);
    expect(minted?.merchantId).toBe("merchant-d");
  });

  it("minting an admin key with merchantId is rejected with 400", async () => {
    const { app, deps } = buildTenantApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ label: "bad-admin", scope: "admin", merchantId: "merchant-x" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("minting with a malformed merchantId is rejected with 400", async () => {
    const { app, deps } = buildTenantApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ label: "bad-id", scope: "merchant", merchantId: "x".repeat(65) }),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── Sweep status scoping (inherits tenancy via the intent's event) ───────────

describe("tenant isolation — sweep prepare (readonly+ but tenant-scoped)", () => {
  it("merchant key B cannot prepare a sweep for tenant A's event (404, same as not-found)", async () => {
    const { app } = buildTenantApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: { ...bearer(KEY_B), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "evt_a" }),
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("readonly key bound to tenant A may prepare for tenant A's own event (passes the tenancy gate)", async () => {
    const { app } = buildTenantApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: { ...bearer(KEY_READONLY_A), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "evt_a" }),
    });
    // No sweepable (fund-holding) invoices were seeded — 422 proves the request
    // got PAST auth + tenancy and into business logic (not 403/404).
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("NO_PAID_INVOICES");
  });

  it("readonly key bound to tenant A cannot prepare for tenant B's event (404)", async () => {
    const { app } = buildTenantApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: { ...bearer(KEY_READONLY_A), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "evt_b" }),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("tenant isolation — sweep status reads", () => {
  it("merchant key B cannot read a sweep intent of tenant A's event (404); A and admin can", async () => {
    const { app, deps, eventA } = buildTenantApp();
    const sweepRepo = deps.sweepIntentRepo as MockSweepIntentRepository;
    const intent = await sweepRepo.insert({
      eventId: eventA.id,
      destination: eventA.mainWalletAddress,
      status: "prepared",
      items: [],
    });

    const crossRes = await app.inject({ method: "GET", url: `/v1/sweeps/${intent.id}`, headers: bearer(KEY_B) });
    expect(crossRes.statusCode).toBe(404);

    const ownRes = await app.inject({ method: "GET", url: `/v1/sweeps/${intent.id}`, headers: bearer(KEY_A) });
    expect(ownRes.statusCode).toBe(200);

    const adminRes = await app.inject({ method: "GET", url: `/v1/sweeps/${intent.id}`, headers: bearer(deps.adminKey) });
    expect(adminRes.statusCode).toBe(200);
  });
});
