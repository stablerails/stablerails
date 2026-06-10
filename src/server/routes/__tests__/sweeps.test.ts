/**
 * Sweep routes tests — Sprint 7.
 *
 * Tests:
 *   1. POST /v1/sweeps/prepare builds unsigned txs via buildTransfer (keyless).
 *   2. POST /v1/sweeps/:id/broadcast-result records txHashes.
 *   3. GET  /v1/sweeps/:id returns the intent.
 *   4. sweeps.ts does NOT import src/signer (ESLint isolation check).
 *
 * All tests use in-memory mocks — no DB, no Tron network.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { buildApp } from "../../app.js";
import {
  buildTestDeps,
  MockApiKeyRepository,
  MockEventRepository,
  MockInvoiceRepository,
  MockSweepIntentRepository,
} from "../../../server/__tests__/helpers/mocks.js";
import type { AppDeps } from "../../app.js";

// ── Extended AppDeps with typed sweepIntentRepo ───────────────────────────────

type ExtendedDeps = AppDeps & {
  adminKey: string;
  merchantKey: string;
  sweepIntentRepo: MockSweepIntentRepository;
};

function buildExtendedDeps(): ExtendedDeps {
  const base = buildTestDeps();

  // Seed an event.
  (base.eventRepo as MockEventRepository).seed({
    id: "ev_test_1",
    name: "Test Event",
    mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
    derivationAccount: 0,
    xpubAccount: "xpub_mock",
    nextInvoiceIndex: 2,
    status: "active",
    createdAt: new Date(),
  });

  // Seed two paid invoices.
  const now = new Date();
  (base.invoiceRepo as MockInvoiceRepository).seed({
    id: "inv_paid_1",
    eventId: "ev_test_1",
    status: "paid",
    priceFiat: "100.00",
    fiatCurrency: "USD",
    amountUsdt: "100.000000",
    amountReceived: "100.000000",
    rateLockedAt: now,
    network: "TRON",
    depositAddress: "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH",
    derivationIndex: 0,
    expiresAt: now,
    metadata: null,
    createdAt: now,
    paidAt: now,
  });
  (base.invoiceRepo as MockInvoiceRepository).seed({
    id: "inv_paid_2",
    eventId: "ev_test_1",
    status: "paid",
    priceFiat: "50.00",
    fiatCurrency: "USD",
    amountUsdt: "50.000000",
    amountReceived: "50.000000",
    rateLockedAt: now,
    network: "TRON",
    depositAddress: "TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK",
    derivationIndex: 1,
    expiresAt: now,
    metadata: null,
    createdAt: now,
    paidAt: now,
  });

  // sweepIntentRepo is already provided by buildTestDeps; cast for typed access.
  return base as ExtendedDeps;
}

function buildAppWithSweeps(deps: ExtendedDeps): ReturnType<typeof buildApp> {
  // buildApp now mounts /v1/sweeps/* via registerSweepRoutes automatically.
  return buildApp({ ...deps, logLevel: "silent" });
}

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /v1/sweeps/prepare", () => {
  let deps: ExtendedDeps;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    deps = buildExtendedDeps();
    app = buildAppWithSweeps(deps);
  });

  it("accepts merchant auth for prepare", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(deps.merchantKey),
      body: { eventId: "ev_test_1" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects an event-scoped readonly key preparing another event", async () => {
    const scopedReadonly = "readonly_sweep_event_scoped_1234567890";
    (deps.apiKeyRepo as MockApiKeyRepository).seedKey({
      rawKey: scopedReadonly,
      scope: "readonly",
      eventId: "ev_other",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(scopedReadonly),
      body: { eventId: "ev_test_1" },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("EVENT_FORBIDDEN");
  });

  it("rejects an event-scoped merchant key preparing another event", async () => {
    const scopedMerchant = "merchant_sweep_event_scoped_123456789";
    (deps.apiKeyRepo as MockApiKeyRepository).seedKey({
      rawKey: scopedMerchant,
      scope: "merchant",
      eventId: "ev_other",
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(scopedMerchant),
      body: { eventId: "ev_test_1" },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("EVENT_FORBIDDEN");
  });

  it("returns 400 if eventId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(deps.adminKey),
      body: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("returns 404 if event not found", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(deps.adminKey),
      body: { eventId: "ev_nonexistent" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("builds unsigned txs for paid invoices (keyless)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(deps.adminKey),
      body: { eventId: "ev_test_1" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      data: {
        id: string;
        eventId: string;
        status: string;
        items: Array<{
          address: string;
          account: number;
          index: number;
          amountMicroStr: string;
          txHash: null;
          unsignedTx: {
            fromAddressBase58: string;
            toAddressBase58: string;
            amountMicro: string;
            callData: string;
          };
        }>;
      };
    };

    const data = body.data;
    expect(data.eventId).toBe("ev_test_1");
    expect(data.status).toBe("prepared");
    expect(data.items).toHaveLength(2);

    // All items must have unsigned txs with no signer involvement.
    for (const item of data.items) {
      expect(item.txHash).toBeNull();
      // unsignedTx.toAddressBase58 must be the event's mainWalletAddress.
      expect(item.unsignedTx.toAddressBase58).toBe("TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe");
      // callData must start with TRC-20 transfer method selector.
      expect(item.unsignedTx.callData).toMatch(/^a9059cbb/);
      // Amount in micro-USDT must be positive.
      expect(BigInt(item.unsignedTx.amountMicro)).toBeGreaterThan(0n);
    }

    // Verify specific amounts: 100 USDT = 100_000_000 micro
    const addr1Item = data.items.find((i) => i.address === "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH");
    expect(addr1Item).toBeDefined();
    expect(addr1Item!.amountMicroStr).toBe("100000000");

    const addr2Item = data.items.find((i) => i.address === "TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK");
    expect(addr2Item).toBeDefined();
    expect(addr2Item!.amountMicroStr).toBe("50000000");
  });

  it("returns 422 when no paid invoices exist", async () => {
    // Create event with no paid invoices.
    (deps.eventRepo as MockEventRepository).seed({
      id: "ev_empty",
      name: "Empty Event",
      mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
      derivationAccount: 0,
      xpubAccount: "xpub_mock",
      nextInvoiceIndex: 0,
      status: "active",
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(deps.adminKey),
      body: { eventId: "ev_empty" },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("NO_PAID_INVOICES");
  });

  it("persists the intent in the repository", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(deps.adminKey),
      body: { eventId: "ev_test_1" },
    });

    expect(deps.sweepIntentRepo.store.size).toBe(1);
    const [intent] = Array.from(deps.sweepIntentRepo.store.values());
    expect(intent!.status).toBe("prepared");
    expect(intent!.items).toHaveLength(2);
  });
});

describe("GET /v1/sweeps/:id", () => {
  it("returns 404 for unknown intent", async () => {
    const deps = buildExtendedDeps();
    const app = buildAppWithSweeps(deps);

    const res = await app.inject({
      method: "GET",
      url: "/v1/sweeps/unknown_id",
      headers: bearer(deps.adminKey),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns the intent after prepare", async () => {
    const deps = buildExtendedDeps();
    const app = buildAppWithSweeps(deps);

    const prepRes = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(deps.adminKey),
      body: { eventId: "ev_test_1" },
    });
    const { data: intent } = JSON.parse(prepRes.body) as { data: { id: string; status: string } };

    const getRes = await app.inject({
      method: "GET",
      url: `/v1/sweeps/${intent.id}`,
      headers: bearer(deps.adminKey),
    });
    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body) as { data: { id: string; status: string } };
    expect(body.data.id).toBe(intent.id);
    expect(body.data.status).toBe("prepared");
  });
});

describe("POST /v1/sweeps/:id/broadcast-result", () => {
  it("records txHashes and transitions to partially_broadcast", async () => {
    const deps = buildExtendedDeps();
    const app = buildAppWithSweeps(deps);

    // Prepare first.
    const prepRes = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(deps.adminKey),
      body: { eventId: "ev_test_1" },
    });
    const { data: intent } = JSON.parse(prepRes.body) as {
      data: { id: string; items: Array<{ address: string }> };
    };

    // Record broadcast result for one address.
    const res = await app.inject({
      method: "POST",
      url: `/v1/sweeps/${intent.id}/broadcast-result`,
      headers: bearer(deps.adminKey),
      body: {
        items: [
          { address: intent.items[0]!.address, txHash: "a".repeat(64) },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: { status: string; items: Array<{ address: string; txHash: string | null }> };
    };
    expect(body.data.status).toBe("partially_broadcast"); // only 1 of 2 done
    const broadcasted = body.data.items.find((i) => i.address === intent.items[0]!.address);
    expect(broadcasted?.txHash).toBe("a".repeat(64));
  });

  it("transitions to done when all items have txHashes", async () => {
    const deps = buildExtendedDeps();
    const app = buildAppWithSweeps(deps);

    const prepRes = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(deps.adminKey),
      body: { eventId: "ev_test_1" },
    });
    const { data: intent } = JSON.parse(prepRes.body) as {
      data: { id: string; items: Array<{ address: string }> };
    };

    const res = await app.inject({
      method: "POST",
      url: `/v1/sweeps/${intent.id}/broadcast-result`,
      headers: bearer(deps.adminKey),
      body: {
        items: intent.items.map((item, i) => ({
          address: item.address,
          txHash: `${i}`.repeat(64).slice(0, 64),
        })),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { status: string } };
    expect(body.data.status).toBe("broadcast");
  });

  it("returns 409 if intent is already done", async () => {
    const deps = buildExtendedDeps();
    const app = buildAppWithSweeps(deps);

    const prepRes = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(deps.adminKey),
      body: { eventId: "ev_test_1" },
    });
    const { data: intent } = JSON.parse(prepRes.body) as {
      data: { id: string; items: Array<{ address: string }> };
    };

    // Mark done.
    await app.inject({
      method: "POST",
      url: `/v1/sweeps/${intent.id}/broadcast-result`,
      headers: bearer(deps.adminKey),
      body: { items: intent.items.map((i, n) => ({ address: i.address, txHash: `${n}`.repeat(64).slice(0, 64) })) },
    });

    // Try again — should 409.
    const res2 = await app.inject({
      method: "POST",
      url: `/v1/sweeps/${intent.id}/broadcast-result`,
      headers: bearer(deps.adminKey),
      body: { items: [{ address: intent.items[0]!.address, txHash: "f".repeat(64) }] },
    });
    expect(res2.statusCode).toBe(409);
    const body = JSON.parse(res2.body) as { error: { code: string } };
    expect(body.error.code).toBe("ALREADY_DONE");
  });

  it("rejects invalid broadcast-result hashes", async () => {
    const deps = buildExtendedDeps();
    const app = buildAppWithSweeps(deps);
    const prepRes = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(deps.adminKey),
      body: { eventId: "ev_test_1" },
    });
    const { data: intent } = JSON.parse(prepRes.body) as {
      data: { id: string; items: Array<{ address: string }> };
    };

    const res = await app.inject({
      method: "POST",
      url: `/v1/sweeps/${intent.id}/broadcast-result`,
      headers: bearer(deps.adminKey),
      body: { items: [{ address: intent.items[0]!.address, txHash: "not-a-txid" }] },
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects unknown and duplicate broadcast-result addresses", async () => {
    const deps = buildExtendedDeps();
    const app = buildAppWithSweeps(deps);
    const prepRes = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: bearer(deps.adminKey),
      body: { eventId: "ev_test_1" },
    });
    const { data: intent } = JSON.parse(prepRes.body) as {
      data: { id: string; items: Array<{ address: string }> };
    };

    const unknown = await app.inject({
      method: "POST",
      url: `/v1/sweeps/${intent.id}/broadcast-result`,
      headers: bearer(deps.adminKey),
      body: { items: [{ address: "TUnknownAddressForIntentXXXXX", txHash: "b".repeat(64) }] },
    });
    expect(unknown.statusCode).toBe(400);

    const duplicate = await app.inject({
      method: "POST",
      url: `/v1/sweeps/${intent.id}/broadcast-result`,
      headers: bearer(deps.adminKey),
      body: {
        items: [
          { address: intent.items[0]!.address, txHash: "c".repeat(64) },
          { address: intent.items[0]!.address, txHash: "d".repeat(64) },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(400);
  });
});

// ── H2: sweep amountReceived, include overpaid/overdue ───────────────────────

describe("POST /v1/sweeps/prepare — H2: sweeps amountReceived for all fund-holding statuses", () => {
  it("sweeps amountReceived (not amountUsdt) for an overpaid invoice — full actual balance is swept", async () => {
    // H2 fix verification: overpaid invoice has amountUsdt=100 (billed) but
    // amountReceived=120 (actual on-chain). The sweep must use amountReceived=120
    // so the overpay excess is not stranded.
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({
      id: "ev_h2_overpaid",
      name: "H2 Overpaid Event",
      mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
      derivationAccount: 0,
      xpubAccount: "xpub_mock",
      nextInvoiceIndex: 1,
      status: "active",
      createdAt: new Date(),
    });

    const now = new Date();
    (deps.invoiceRepo as MockInvoiceRepository).seed({
      id: "inv_h2_overpaid",
      eventId: "ev_h2_overpaid",
      status: "overpaid",
      priceFiat: "100.00",
      fiatCurrency: "USD",
      amountUsdt: "100.000000",   // billed amount
      amountReceived: "120.000000", // ACTUAL on-chain (overpaid by 20)
      rateLockedAt: now,
      network: "TRON",
      depositAddress: "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH",
      derivationIndex: 0,
      expiresAt: now,
      metadata: null,
      createdAt: now,
      paidAt: now,
    });

    const app = buildApp({ ...deps, logLevel: "silent" });
    const adminKey = (deps as ReturnType<typeof buildTestDeps>).adminKey;

    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: { authorization: `Bearer ${adminKey}` },
      body: { eventId: "ev_h2_overpaid" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      data: { items: Array<{ address: string; amountMicroStr: string }> };
    };

    // Must include the overpaid invoice
    expect(body.data.items).toHaveLength(1);
    const item = body.data.items[0]!;
    expect(item.address).toBe("TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH");
    // amountMicroStr must be 120 USDT (amountReceived), NOT 100 USDT (amountUsdt)
    expect(item.amountMicroStr).toBe("120000000"); // 120_000_000 micro
  });

  it("sweeps overdue invoice (amountReceived) and a paid invoice in the same event", async () => {
    // H2 fix: overdue invoices (holding real USDT) must be included in sweep,
    // alongside standard paid invoices.
    const deps = buildTestDeps();
    (deps.eventRepo as MockEventRepository).seed({
      id: "ev_h2_mixed",
      name: "H2 Mixed Statuses",
      mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
      derivationAccount: 0,
      xpubAccount: "xpub_mock",
      nextInvoiceIndex: 2,
      status: "active",
      createdAt: new Date(),
    });

    const now = new Date();
    // paid invoice
    (deps.invoiceRepo as MockInvoiceRepository).seed({
      id: "inv_h2_paid",
      eventId: "ev_h2_mixed",
      status: "paid",
      priceFiat: "50.00",
      fiatCurrency: "USD",
      amountUsdt: "50.000000",
      amountReceived: "50.000000",
      rateLockedAt: now,
      network: "TRON",
      depositAddress: "TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK",
      derivationIndex: 0,
      expiresAt: now,
      metadata: null,
      createdAt: now,
      paidAt: now,
    });
    // overdue invoice (late funds received after expiry)
    (deps.invoiceRepo as MockInvoiceRepository).seed({
      id: "inv_h2_overdue",
      eventId: "ev_h2_mixed",
      status: "overdue",
      priceFiat: "75.00",
      fiatCurrency: "USD",
      amountUsdt: "75.000000",
      amountReceived: "30.000000", // partial late funds
      rateLockedAt: now,
      network: "TRON",
      depositAddress: "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH",
      derivationIndex: 1,
      expiresAt: now,
      metadata: null,
      createdAt: now,
      paidAt: null,
    });

    const app = buildApp({ ...deps, logLevel: "silent" });
    const adminKey = (deps as ReturnType<typeof buildTestDeps>).adminKey;

    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: { authorization: `Bearer ${adminKey}` },
      body: { eventId: "ev_h2_mixed" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as {
      data: { items: Array<{ address: string; amountMicroStr: string }> };
    };

    // Both invoices must appear in the sweep
    expect(body.data.items).toHaveLength(2);

    const paidItem = body.data.items.find((i) => i.address === "TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK");
    expect(paidItem).toBeDefined();
    expect(paidItem!.amountMicroStr).toBe("50000000"); // 50 USDT

    const overdueItem = body.data.items.find((i) => i.address === "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH");
    expect(overdueItem).toBeDefined();
    expect(overdueItem!.amountMicroStr).toBe("30000000"); // 30 USDT (amountReceived)
  });
});

// ── Isolation guard: sweeps.ts must NOT import src/signer ────────────────────

describe("Server isolation: sweeps.ts does NOT import src/signer", () => {
  it("sweeps.ts source does not contain 'from ...signer' import", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { join } = await import("node:path");

    const dir = fileURLToPath(new URL("..", import.meta.url));
    const sweepsPath = join(dir, "sweeps.ts");
    const source = readFileSync(sweepsPath, "utf-8");

    // No static import from src/signer in sweeps.ts.
    expect(source).not.toMatch(/from\s+["'][^"']*signer[^"']*["']/);
    expect(source).not.toMatch(/require\s*\(\s*["'][^"']*signer[^"']*["']\s*\)/);
  });
});
