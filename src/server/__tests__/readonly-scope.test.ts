/**
 * ITEM 1 — MCP-1: readonly API key scope tests.
 *
 * Verifies:
 *   - readonly key CAN call agent-facing GET endpoints
 *   - readonly key is 403 on all write/admin endpoints
 *   - existing admin/merchant behaviour is unchanged
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps } from "./helpers/mocks.js";

// Convenience: inject an auth header.
function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

// ── Shared setup ──────────────────────────────────────────────────────────────

function buildAppWithReadonlyKey(): {
  app: ReturnType<typeof buildApp>;
  readonlyKey: string;
  adminKey: string;
  merchantKey: string;
} {
  const deps = buildTestDeps();
  const readonlyRaw = "readonlykey_test_1234567890abcdef";
  (deps.apiKeyRepo as import("./helpers/mocks.js").MockApiKeyRepository).seedKey({
    rawKey: readonlyRaw,
    scope: "readonly",
    label: "test-readonly",
  });
  const app = buildApp(deps);
  return {
    app,
    readonlyKey: readonlyRaw,
    adminKey: deps.adminKey,
    merchantKey: deps.merchantKey,
  };
}

// ── READ endpoints: readonly key MUST be accepted ────────────────────────────

describe("readonly key — read endpoints (200/empty)", () => {
  it("GET /v1/events — accepted", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({ method: "GET", url: "/v1/events", headers: bearer(readonlyKey) });
    expect(res.statusCode).toBe(200);
  });

  it("GET /v1/events/:id (not found 404) — accepted (not 403)", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({ method: "GET", url: "/v1/events/nonexistent", headers: bearer(readonlyKey) });
    // 404 = auth passed, resource not found — not a 403 scope rejection
    expect(res.statusCode).toBe(404);
  });

  it("GET /v1/invoices — accepted", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({ method: "GET", url: "/v1/invoices", headers: bearer(readonlyKey) });
    expect(res.statusCode).toBe(200);
  });

  it("GET /v1/invoices/:id (not found) — accepted (not 403)", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({ method: "GET", url: "/v1/invoices/nonexistent", headers: bearer(readonlyKey) });
    expect(res.statusCode).toBe(404);
  });

  it("GET /v1/webhooks — accepted", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({ method: "GET", url: "/v1/webhooks", headers: bearer(readonlyKey) });
    expect(res.statusCode).toBe(200);
  });

  it("GET /v1/api-keys — accepted", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({ method: "GET", url: "/v1/api-keys", headers: bearer(readonlyKey) });
    expect(res.statusCode).toBe(200);
  });

  it("GET /v1/sweeps/:id (not found) — accepted (not 403)", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({ method: "GET", url: "/v1/sweeps/nonexistent", headers: bearer(readonlyKey) });
    expect(res.statusCode).toBe(404);
  });
});

// ── WRITE endpoints: readonly key MUST be rejected (403) ─────────────────────

describe("readonly key — write/admin endpoints (403)", () => {
  it("POST /v1/api-keys — 403", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { ...bearer(readonlyKey), "content-type": "application/json" },
      body: JSON.stringify({ label: "evil-key", scope: "admin" }),
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("DELETE /v1/api-keys/:id — 403", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/api-keys/some-id",
      headers: bearer(readonlyKey),
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /v1/events — 403", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { ...bearer(readonlyKey), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Hack",
        mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
        derivationAccount: 99,
        xpubAccount: "xpub_hack",
      }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /v1/webhooks — 403", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { ...bearer(readonlyKey), "content-type": "application/json" },
      body: JSON.stringify({ url: "https://evil.example.com/hook" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("DELETE /v1/webhooks/:id — 403", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/webhooks/some-id",
      headers: bearer(readonlyKey),
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /v1/invoices — 403", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(readonlyKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ev1", priceFiat: "10.00", fiatCurrency: "USD" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /v1/invoices/:id/cancel — 403", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices/some-id/cancel",
      headers: bearer(readonlyKey),
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /v1/sweeps/prepare — accepted for readonly agents", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/prepare",
      headers: { ...bearer(readonlyKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: "ev1" }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /v1/sweeps/:id/broadcast-result — 403", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/some-id/broadcast-result",
      headers: { ...bearer(readonlyKey), "content-type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── Existing scope behaviour unchanged ───────────────────────────────────────

describe("existing scope behaviour unchanged with readonly added", () => {
  it("admin key still accepted on admin-only routes", async () => {
    const { app, adminKey } = buildAppWithReadonlyKey();
    const res = await app.inject({ method: "GET", url: "/v1/events", headers: bearer(adminKey) });
    expect(res.statusCode).toBe(200);
  });

  it("merchant key still rejected on admin-only routes (403)", async () => {
    // POST /v1/events is merchant+ since multi-merchant tenancy, and
    // POST /v1/sweeps/prepare is readonly+ since the agent-friendliness
    // relaxation (executing still requires the operator CLI + passphrase +
    // pin). Exercise a route that is still admin-only: broadcast-result.
    const { app, merchantKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sweeps/sweep_1/broadcast-result",
      headers: { ...bearer(merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("merchant key still accepted on invoice create", async () => {
    const { app, merchantKey, adminKey } = buildAppWithReadonlyKey();
    // Create event first (needs admin)
    const evRes = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { ...bearer(adminKey), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Merch Test Event",
        mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
        derivationAccount: 0,
        xpubAccount: "xpub_placeholder_merch",
      }),
    });
    expect(evRes.statusCode).toBe(201);
    const evBody = JSON.parse(evRes.body) as { data: { id: string } };

    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { ...bearer(merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ eventId: evBody.data.id, priceFiat: "10.00", fiatCurrency: "USD" }),
    });
    expect(res.statusCode).toBe(201);
  });

  it("admin can mint a readonly key", async () => {
    const { app, adminKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      headers: { ...bearer(adminKey), "content-type": "application/json" },
      body: JSON.stringify({ label: "mcp-agent", scope: "readonly" }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { data: { scope: string } };
    expect(body.data.scope).toBe("readonly");
  });
});
