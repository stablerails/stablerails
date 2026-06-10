/**
 * Tests for the operator "create payment link" page.
 *
 * GET  /dashboard/create-link  — session-gated form (event selector + amount)
 * POST /dashboard/create-link  — creates invoice via createInvoice(), renders link
 *
 * All tests use in-memory mocks — no DB, no network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps, MockInvoiceRepository, MockEventRepository } from "./helpers/mocks.js";
import { InMemorySessionStore, SESSION_COOKIE_NAME } from "../auth.js";
import { pauseArea, resetAll } from "../killswitch.js";

/** Create a live session and return the cookie string. */
function makeSessionCookie(sessionStore: InMemorySessionStore): string {
  const id = sessionStore.create({ operatorId: "op1", email: "admin@example.com" });
  return `${SESSION_COOKIE_NAME}=${id}`;
}

// ── GET /dashboard/create-link — auth gate ────────────────────────────────────

describe("GET /dashboard/create-link — auth gate", () => {
  it("redirects to /login when no session cookie is present", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/dashboard/create-link" });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });

  it("redirects to /login when session cookie has an unknown id", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/create-link",
      headers: { cookie: `${SESSION_COOKIE_NAME}=unknownsessionid` },
    });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });
});

// ── GET /dashboard/create-link — renders with session ────────────────────────

describe("GET /dashboard/create-link — renders with valid session", () => {
  it("returns 200 HTML", async () => {
    const sessionStore = new InMemorySessionStore();
    const app = buildApp(buildTestDeps({ sessionStore }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/create-link",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("includes a form with method POST and action /dashboard/create-link", async () => {
    const sessionStore = new InMemorySessionStore();
    const app = buildApp(buildTestDeps({ sessionStore }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/create-link",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('method="POST"');
    expect(res.body).toContain('action="/dashboard/create-link"');
  });

  it("lists events from eventRepo as select options", async () => {
    const sessionStore = new InMemorySessionStore();
    const eventRepo = new MockEventRepository();
    eventRepo.seed({ id: "evt-alpha", name: "Alpha Event" });
    eventRepo.seed({ id: "evt-beta", name: "Beta Event" });
    const app = buildApp(buildTestDeps({ sessionStore, eventRepo }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/create-link",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("evt-alpha");
    expect(res.body).toContain("Alpha Event");
    expect(res.body).toContain("evt-beta");
    expect(res.body).toContain("Beta Event");
  });

  it("has a fiat amount input field", async () => {
    const sessionStore = new InMemorySessionStore();
    const app = buildApp(buildTestDeps({ sessionStore }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/create-link",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // Must have an amount input (type number or text named "amount")
    expect(res.body).toMatch(/name="amount"/);
  });

  it("has an optional description/product input field", async () => {
    const sessionStore = new InMemorySessionStore();
    const app = buildApp(buildTestDeps({ sessionStore }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/create-link",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/name="description"/);
  });

  it("has a nonce-locked script-src CSP (no unsafe-inline for scripts)", async () => {
    const sessionStore = new InMemorySessionStore();
    const app = buildApp(buildTestDeps({ sessionStore }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/create-link",
      headers: { cookie },
    });
    await app.close();

    const csp = res.headers["content-security-policy"] as string | undefined;
    expect(csp).toBeDefined();
    expect(csp).toMatch(/script-src[^;]*nonce-/);
    const scriptSrcPart = csp!.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrcPart).toBeDefined();
    expect(scriptSrcPart).not.toContain("unsafe-inline");
  });

  it("has no inline style= attributes (CSP safe)", async () => {
    const sessionStore = new InMemorySessionStore();
    const app = buildApp(buildTestDeps({ sessionStore }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/create-link",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/\sstyle="/);
  });

  it("has a back link to /dashboard", async () => {
    const sessionStore = new InMemorySessionStore();
    const app = buildApp(buildTestDeps({ sessionStore }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/create-link",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/dashboard"');
  });
});

// ── POST /dashboard/create-link — auth gate ───────────────────────────────────

describe("POST /dashboard/create-link — auth gate", () => {
  it("redirects to /login when no session cookie is present", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "eventId=evt1&amount=10.00&description=Test",
    });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });
});

// ── POST /dashboard/create-link — invoice creation ───────────────────────────

describe("POST /dashboard/create-link — invoice creation", () => {
  it("creates an invoice and returns 200 with the shareable pay link", async () => {
    const sessionStore = new InMemorySessionStore();
    const eventRepo = new MockEventRepository();
    eventRepo.seed({ id: "evt-x", name: "Test Event" });
    const invoiceRepo = new MockInvoiceRepository();
    const app = buildApp(buildTestDeps({
      sessionStore,
      eventRepo,
      invoiceRepo,
      publicBaseUrl: "https://pay.example.com",
    }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "eventId=evt-x&amount=25.00&description=Test+Product",
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    // Must show the pay link
    expect(res.body).toContain("https://pay.example.com/pay/");
  });

  it("shows a copy button in the success page", async () => {
    const sessionStore = new InMemorySessionStore();
    const eventRepo = new MockEventRepository();
    eventRepo.seed({ id: "evt-copy", name: "Copy Event" });
    const app = buildApp(buildTestDeps({ sessionStore, eventRepo }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "eventId=evt-copy&amount=10.00",
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // Must have a copy button
    expect(res.body).toContain("copy");
  });

  it("success page has no inline style= attributes (CSP safe)", async () => {
    const sessionStore = new InMemorySessionStore();
    const eventRepo = new MockEventRepository();
    eventRepo.seed({ id: "evt-nostyle", name: "NoStyle Event" });
    const app = buildApp(buildTestDeps({ sessionStore, eventRepo }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "eventId=evt-nostyle&amount=5.00",
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/\sstyle="/);
  });

  it("success page has nonce-locked CSP", async () => {
    const sessionStore = new InMemorySessionStore();
    const eventRepo = new MockEventRepository();
    eventRepo.seed({ id: "evt-csp", name: "CSP Event" });
    const app = buildApp(buildTestDeps({ sessionStore, eventRepo }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "eventId=evt-csp&amount=5.00",
    });
    await app.close();

    const csp = res.headers["content-security-policy"] as string | undefined;
    expect(csp).toBeDefined();
    expect(csp).toMatch(/script-src[^;]*nonce-/);
    const scriptSrcPart = csp!.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrcPart).not.toContain("unsafe-inline");
  });

  it("stores the invoice in invoiceRepo (invoice count increases)", async () => {
    const sessionStore = new InMemorySessionStore();
    const eventRepo = new MockEventRepository();
    eventRepo.seed({ id: "evt-count", name: "Count Event" });
    const invoiceRepo = new MockInvoiceRepository();
    const app = buildApp(buildTestDeps({ sessionStore, eventRepo, invoiceRepo }));
    const cookie = makeSessionCookie(sessionStore);

    expect(invoiceRepo.store.size).toBe(0);

    await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "eventId=evt-count&amount=10.00",
    });
    await app.close();

    expect(invoiceRepo.store.size).toBe(1);
  });

  it("sets invoice metadata.product from description field", async () => {
    const sessionStore = new InMemorySessionStore();
    const eventRepo = new MockEventRepository();
    eventRepo.seed({ id: "evt-meta", name: "Meta Event" });
    const invoiceRepo = new MockInvoiceRepository();
    const app = buildApp(buildTestDeps({ sessionStore, eventRepo, invoiceRepo }));
    const cookie = makeSessionCookie(sessionStore);

    await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "eventId=evt-meta&amount=10.00&description=My+Product",
    });
    await app.close();

    const invoices = Array.from(invoiceRepo.store.values());
    expect(invoices).toHaveLength(1);
    expect((invoices[0]!.metadata as Record<string, unknown>)?.["product"]).toBe("My Product");
  });
});

// ── POST /dashboard/create-link — validation errors ──────────────────────────

describe("POST /dashboard/create-link — validation errors", () => {
  it("returns 400 HTML when amount is missing", async () => {
    const sessionStore = new InMemorySessionStore();
    const eventRepo = new MockEventRepository();
    eventRepo.seed({ id: "evt-val", name: "Val Event" });
    const app = buildApp(buildTestDeps({ sessionStore, eventRepo }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "eventId=evt-val&amount=",
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("returns 400 HTML when amount is not a positive number", async () => {
    const sessionStore = new InMemorySessionStore();
    const eventRepo = new MockEventRepository();
    eventRepo.seed({ id: "evt-neg", name: "Neg Event" });
    const app = buildApp(buildTestDeps({ sessionStore, eventRepo }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "eventId=evt-neg&amount=-5.00",
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("returns error HTML when eventId is missing", async () => {
    const sessionStore = new InMemorySessionStore();
    const app = buildApp(buildTestDeps({ sessionStore }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "amount=10.00",
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("returns 422 HTML when eventId does not exist", async () => {
    const sessionStore = new InMemorySessionStore();
    const app = buildApp(buildTestDeps({ sessionStore }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "eventId=nonexistent-event&amount=10.00",
    });
    await app.close();

    // EVENT_NOT_FOUND from createInvoice maps to 422 (or 404 — our handler should
    // display a user-friendly error page, not a raw JSON 404)
    expect([400, 404, 422]).toContain(res.statusCode);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("returns 400 HTML when amount is below minimum (0.01)", async () => {
    const sessionStore = new InMemorySessionStore();
    const eventRepo = new MockEventRepository();
    eventRepo.seed({ id: "evt-min", name: "Min Event" });
    const app = buildApp(buildTestDeps({ sessionStore, eventRepo }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      // With 1:1 rate, 0.001 USD → 0.001 USDT which is below MIN_INVOICE_AMOUNT_MICRO (0.01)
      body: "eventId=evt-min&amount=0.001",
    });
    await app.close();

    expect([400, 422]).toContain(res.statusCode);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });
});

// ── Dashboard links to create-link page ──────────────────────────────────────

describe("GET /dashboard — links to create-link page", () => {
  it("contains a link to /dashboard/create-link", async () => {
    const sessionStore = new InMemorySessionStore();
    const app = buildApp(buildTestDeps({ sessionStore }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("/dashboard/create-link");
  });
});

// ── POST /dashboard/create-link — kill-switch ─────────────────────────────────

describe("POST /dashboard/create-link — kill-switch", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  it("returns 503 HTML when the invoices kill-switch is engaged", async () => {
    pauseArea("invoices");

    const sessionStore = new InMemorySessionStore();
    const eventRepo = new MockEventRepository();
    eventRepo.seed({ id: "evt-ks", name: "KS Event" });
    const app = buildApp(buildTestDeps({ sessionStore, eventRepo }));
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/dashboard/create-link",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "eventId=evt-ks&amount=10.00",
    });
    await app.close();

    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });
});
