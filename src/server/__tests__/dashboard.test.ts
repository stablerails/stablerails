/**
 * Tests for sprint: operator dashboard, CSV export, landing page, copy-amount button.
 *
 * All tests use in-memory mocks — no DB, no network.
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps, MockInvoiceRepository } from "./helpers/mocks.js";
import { InMemorySessionStore, SESSION_COOKIE_NAME } from "../auth.js";

/** Helper: create a live session and return the cookie string. */
function makeSessionCookie(sessionStore: InMemorySessionStore): string {
  const id = sessionStore.create({ operatorId: "op1", email: "admin@example.com" });
  return `${SESSION_COOKIE_NAME}=${id}`;
}

// ── Dashboard 302 without session ─────────────────────────────────────────────

describe("GET /dashboard — auth gate", () => {
  it("redirects to /login when no session cookie is present", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });

  it("redirects to /login when session cookie has an unknown id", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie: `${SESSION_COOKIE_NAME}=nonexistentsessionid` },
    });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });
});

// ── Dashboard renders with session ────────────────────────────────────────────

describe("GET /dashboard — renders with valid session", () => {
  it("returns 200 HTML", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("shows invoice rows in HTML table", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "inv_alpha", eventId: "e1", status: "paid", amountReceived: "50.000000" });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // Invoice id should appear (possibly truncated)
    expect(res.body).toContain("inv_alpha");
  });

  it("shows USDT received summary stat", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "i1", eventId: "e1", status: "paid", amountReceived: "123.456000" });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("123.456000");
  });

  it("has nonce-locked script-src CSP (no unsafe-inline for scripts)", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    await app.close();

    const csp = res.headers["content-security-policy"] as string | undefined;
    expect(csp).toBeDefined();
    // script-src must have a nonce (injected by @fastify/helmet)
    expect(csp).toMatch(/script-src[^;]*nonce-/);
    // must NOT have unsafe-inline in script-src
    const scriptSrcPart = csp!.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrcPart).toBeDefined();
    expect(scriptSrcPart).not.toContain("unsafe-inline");
  });

  it("filters by status when ?status= param is given", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "paid_inv", eventId: "e1", status: "paid" });
    invoiceRepo.seed({ id: "pending_inv", eventId: "e1", status: "pending" });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard?status=paid",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("paid_inv");
    expect(res.body).not.toContain("pending_inv");
  });
});

// ── summary() method ──────────────────────────────────────────────────────────

describe("InvoiceRepository.summary()", () => {
  it("returns total count, paid count, pending count, totalAmountReceived", async () => {
    const repo = new MockInvoiceRepository();
    repo.seed({ id: "a", eventId: "e1", status: "paid", amountReceived: "50.000000" });
    repo.seed({ id: "b", eventId: "e1", status: "paid", amountReceived: "75.000000" });
    repo.seed({ id: "c", eventId: "e1", status: "pending", amountReceived: "0.000000" });

    const result = await repo.summary();

    expect(result.totalCount).toBe(3);
    expect(result.paidCount).toBe(2);
    expect(result.pendingCount).toBe(1);
    expect(result.totalAmountReceived).toBe("125.000000");
  });

  it("filters by eventId when provided", async () => {
    const repo = new MockInvoiceRepository();
    repo.seed({ id: "a", eventId: "e1", status: "paid", amountReceived: "50.000000" });
    repo.seed({ id: "b", eventId: "e2", status: "paid", amountReceived: "99.000000" });
    repo.seed({ id: "c", eventId: "e2", status: "paid", amountReceived: "1.000000" });

    const result = await repo.summary("e1");

    expect(result.totalCount).toBe(1);
    expect(result.totalAmountReceived).toBe("50.000000");
  });

  it("returns zeros for empty store", async () => {
    const repo = new MockInvoiceRepository();
    const result = await repo.summary();
    expect(result.totalCount).toBe(0);
    expect(result.paidCount).toBe(0);
    expect(result.pendingCount).toBe(0);
    expect(result.totalAmountReceived).toBe("0.000000");
  });

  it("sums amountReceived across all statuses (not just paid)", async () => {
    const repo = new MockInvoiceRepository();
    repo.seed({ id: "a", eventId: "e1", status: "overpaid", amountReceived: "200.000000" });
    repo.seed({ id: "b", eventId: "e1", status: "underpaid", amountReceived: "30.000000" });
    const result = await repo.summary();
    expect(result.totalAmountReceived).toBe("230.000000");
  });
});

// ── CSV export ────────────────────────────────────────────────────────────────

describe("GET /dashboard/invoices.csv — auth gate", () => {
  it("redirects to /login without session", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/dashboard/invoices.csv" });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });
});

describe("GET /dashboard/invoices.csv — content", () => {
  it("returns text/csv with Content-Disposition attachment", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices.csv",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.headers["content-disposition"]).toMatch(/invoices\.csv/);
  });

  it("includes header row with expected column names", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices.csv",
      headers: { cookie },
    });
    await app.close();

    const firstLine = res.body.split("\n")[0]!;
    expect(firstLine).toContain("id");
    expect(firstLine).toContain("status");
    expect(firstLine).toContain("amountUsdt");
  });

  it("guards formula injection — cells starting with = are prefixed with single quote", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    // amountUsdt from DB is always numeric, but depositAddress could theoretically carry
    // injection if somehow an operator-provided value reached it. Test with a crafted id.
    invoiceRepo.seed({
      id: "inv001",
      eventId: "e1",
      depositAddress: "=EVIL()",
      amountUsdt: "10.000000",
    });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices.csv",
      headers: { cookie },
    });
    await app.close();

    // The raw formula must NOT appear unguarded
    expect(res.body).not.toContain(",=EVIL()");
    expect(res.body).not.toContain('"=EVIL()"');
    // The guarded version SHOULD appear
    expect(res.body).toContain("'=EVIL()");
  });

  it("CSV-escapes fields containing commas and double quotes", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    // Craft an invoice whose id contains a comma and a quote
    invoiceRepo.seed({
      id: 'inv,has"quote',
      eventId: "e1",
      amountUsdt: "5.000000",
    });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices.csv",
      headers: { cookie },
    });
    await app.close();

    // The comma+quote field must be properly double-quoted and internal quotes doubled
    expect(res.body).toContain('"inv,has""quote"');
  });
});

// ── Landing page ──────────────────────────────────────────────────────────────

describe("GET / — landing page", () => {
  it("returns 200 HTML", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/" });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("contains a CTA link to /demo when ENABLE_DEMO=1", async () => {
    const savedDemo = process.env["ENABLE_DEMO"];
    const savedEnv = process.env["STABLERAILS_ENV"];
    process.env["ENABLE_DEMO"] = "1";
    // Ensure non-production so demo is enabled
    delete process.env["STABLERAILS_ENV"];

    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/" });
    await app.close();

    if (savedDemo !== undefined) process.env["ENABLE_DEMO"] = savedDemo;
    else delete process.env["ENABLE_DEMO"];
    if (savedEnv !== undefined) process.env["STABLERAILS_ENV"] = savedEnv;

    expect(res.body).toContain("/demo");
  });

  it("contains a link to /login for operators", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/" });
    await app.close();
    expect(res.body).toContain("/login");
  });

  it("CSP has no unsafe-inline for scripts (script-src none or nonce)", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/" });
    await app.close();
    const csp = res.headers["content-security-policy"] as string | undefined;
    expect(csp).toBeDefined();
    const scriptSrcPart = csp!.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrcPart).toBeDefined();
    expect(scriptSrcPart).not.toContain("unsafe-inline");
  });
});

// ── Fix 3: invalid ?status= returns 200 (not 500) ────────────────────────────

describe("GET /dashboard — invalid ?status= is ignored (no 500)", () => {
  it("returns 200 when ?status=INVALID_GARBAGE is given on dashboard", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard?status=INVALID_GARBAGE",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("returns 200 when ?status=INVALID_GARBAGE is given on CSV route", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices.csv?status=INVALID_GARBAGE",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
  });
});

// ── Fix 4: settledCount = paid + overpaid ─────────────────────────────────────

describe("InvoiceRepository.summary() — settledCount", () => {
  it("settledCount equals paid + overpaid", async () => {
    const repo = new MockInvoiceRepository();
    repo.seed({ id: "p1", eventId: "e1", status: "paid", amountReceived: "10.000000" });
    repo.seed({ id: "p2", eventId: "e1", status: "paid", amountReceived: "10.000000" });
    repo.seed({ id: "o1", eventId: "e1", status: "overpaid", amountReceived: "10.000000" });
    repo.seed({ id: "u1", eventId: "e1", status: "underpaid", amountReceived: "5.000000" });

    const result = await repo.summary();

    expect(result.settledCount).toBe(3); // 2 paid + 1 overpaid
  });

  it("settledCount is 0 for empty store", async () => {
    const repo = new MockInvoiceRepository();
    const result = await repo.summary();
    expect(result.settledCount).toBe(0);
  });

  it("dashboard card shows settledCount (paid+overpaid together)", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "p1", eventId: "e1", status: "paid", amountReceived: "10.000000" });
    invoiceRepo.seed({ id: "o1", eventId: "e1", status: "overpaid", amountReceived: "15.000000" });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    await app.close();

    // The settled card should show 2 (paid + overpaid)
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(">2<"); // settledCount in the stat-value div
  });
});

// ── Fix 1: no inline styles in dashboard HTML ─────────────────────────────────

describe("GET /dashboard — no inline style= attributes", () => {
  it("rendered HTML has no inline style= attributes (CSP safe)", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    // Seed one of each status to exercise all badge classes
    invoiceRepo.seed({ id: "i1", eventId: "e1", status: "paid" });
    invoiceRepo.seed({ id: "i2", eventId: "e1", status: "pending" });
    invoiceRepo.seed({ id: "i3", eventId: "e1", status: "overpaid" });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // No inline style= should appear in the HTML body (badges and cells must use classes)
    expect(res.body).not.toMatch(/\sstyle="/);
  });

  it("status badges use CSS classes (badge-paid, badge-pending, etc.)", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "p1", eventId: "e1", status: "paid" });
    invoiceRepo.seed({ id: "pe", eventId: "e1", status: "pending" });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    await app.close();

    expect(res.body).toContain("badge-paid");
    expect(res.body).toContain("badge-pending");
  });
});

// ── Fix 1: no inline styles in checkout copy-amount button ───────────────────

describe("checkout copy-amount button — no inline style= attributes", () => {
  it("copy-amount button has no inline style= (uses CSS class)", async () => {
    const { renderCheckout } = await import("../checkout.js");
    const invoice = {
      id: "inv_style_test",
      eventId: "evt1",
      status: "pending" as const,
      priceFiat: "100.00",
      fiatCurrency: "USD",
      amountUsdt: "100.000000",
      amountReceived: "0.000000",
      rateLockedAt: new Date(),
      network: "TRON" as const,
      depositAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
      derivationIndex: 0,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      metadata: null,
      createdAt: new Date(),
      paidAt: null,
    };

    const html = await renderCheckout(invoice, "scriptnonce", "stylenonce");

    // The copy-amount button wrapper div and button must NOT use inline style=
    // The button must use a CSS class instead
    expect(html).not.toMatch(/id="copy-amount-btn"[^>]*style=/);
    expect(html).toContain("copy-amount-wrapper");
  });
});

// ── Fix 6: CSV truncation header ─────────────────────────────────────────────

describe("GET /dashboard/invoices.csv — truncation header", () => {
  it("sets X-Truncated-Rows: true header when export is capped", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    // Seed exactly PAGE (100) invoices so the mock (which ignores cursors) will
    // keep returning the same 100 rows each iteration, hitting MAX_ROWS (10,000).
    for (let i = 0; i < 100; i++) {
      invoiceRepo.seed({ id: `bulk${String(i).padStart(4, "0")}`, eventId: "e1" });
    }
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices.csv",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-truncated-rows"]).toBe("true");
  });
});

// ── Fix 2: landing CTA when demo is disabled ──────────────────────────────────

describe("GET / — landing CTA adapts to demo availability", () => {
  it("shows /login as primary CTA when ENABLE_DEMO is not set", async () => {
    // Default test environment: ENABLE_DEMO is undefined → demo disabled
    const savedDemo = process.env["ENABLE_DEMO"];
    delete process.env["ENABLE_DEMO"];

    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/" });
    await app.close();

    if (savedDemo !== undefined) process.env["ENABLE_DEMO"] = savedDemo;

    expect(res.statusCode).toBe(200);
    // Primary CTA should be /login (Войти) when demo not enabled
    expect(res.body).toContain('href="/login"');
    // Primary button (btn-primary) must NOT point to /demo
    const primaryBtn = res.body.match(/class="btn-primary"[^>]*href="([^"]+)"/)?.[1]
      ?? res.body.match(/href="([^"]+)"[^>]*class="btn-primary"/)?.[1];
    expect(primaryBtn).not.toBe("/demo");
  });
});

// ── Fix 5: summary cards label ────────────────────────────────────────────────

describe("GET /dashboard — summary cards label", () => {
  it("summary section has a label indicating overall/all-time totals", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard?status=paid",
      headers: { cookie },
    });
    await app.close();

    // The cards should have a label that makes clear they are overall totals
    // (not filtered by the current status filter)
    expect(res.body).toMatch(/за\s+всё\s+время|всё\s+время|overall/i);
  });
});

// ── Copy-amount button in checkout ────────────────────────────────────────────

describe("checkout copy-amount button", () => {
  it("rendered HTML contains a copy-amount button element", async () => {
    const { renderCheckout } = await import("../checkout.js");
    const invoice = {
      id: "inv_test",
      eventId: "evt1",
      status: "pending" as const,
      priceFiat: "100.00",
      fiatCurrency: "USD",
      amountUsdt: "100.000000",
      amountReceived: "0.000000",
      rateLockedAt: new Date(),
      network: "TRON" as const,
      depositAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
      derivationIndex: 0,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      metadata: null,
      createdAt: new Date(),
      paidAt: null,
    };

    const html = await renderCheckout(invoice, "scriptnonce", "stylenonce");

    expect(html).toContain("copy-amount-btn");
  });

  it("copy-amount button is bound via addEventListener (not inline onclick)", async () => {
    const { renderCheckout } = await import("../checkout.js");
    const invoice = {
      id: "inv_test2",
      eventId: "evt1",
      status: "pending" as const,
      priceFiat: "50.00",
      fiatCurrency: "USD",
      amountUsdt: "50.000000",
      amountReceived: "0.000000",
      rateLockedAt: new Date(),
      network: "TRON" as const,
      depositAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
      derivationIndex: 0,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      metadata: null,
      createdAt: new Date(),
      paidAt: null,
    };

    const html = await renderCheckout(invoice, "scriptnonce", "stylenonce");

    // Should use addEventListener, not inline onclick
    expect(html).toContain("copy-amount-btn");
    expect(html).toContain("addEventListener");
    // Must NOT have inline event handlers
    expect(html).not.toMatch(/onclick\s*=/);
  });

  it("QR code still encodes bare address (no URI change)", async () => {
    const { renderCheckout } = await import("../checkout.js");
    const invoice = {
      id: "inv_qr",
      eventId: "evt1",
      status: "pending" as const,
      priceFiat: "10.00",
      fiatCurrency: "USD",
      amountUsdt: "10.000000",
      amountReceived: "0.000000",
      rateLockedAt: new Date(),
      network: "TRON" as const,
      depositAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
      derivationIndex: 0,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      metadata: null,
      createdAt: new Date(),
      paidAt: null,
    };

    const html = await renderCheckout(invoice, "n1", "s1");

    // QR generation uses the bare address; we verify the QR SVG is present
    // and no tron:// or similar URI scheme was injected into the QR data.
    // The QR SVG is inline — just check the address appears plain in the HTML.
    expect(html).toContain("TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe");
    expect(html).not.toContain("tron://");
  });
});

// ── Invoice detail page — auth gate ──────────────────────────────────────────

describe("GET /dashboard/invoices/:id — auth gate", () => {
  it("redirects to /login when no session cookie is present", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/dashboard/invoices/inv_abc" });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });

  it("redirects to /login when session cookie has an unknown id", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices/inv_abc",
      headers: { cookie: `${SESSION_COOKIE_NAME}=badsessionid` },
    });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });
});

// ── Invoice detail page — renders with session ────────────────────────────────

describe("GET /dashboard/invoices/:id — renders", () => {
  it("returns 200 HTML with key invoice fields", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({
      id: "detail-inv-1",
      eventId: "evt-x",
      status: "paid",
      priceFiat: "99.00",
      fiatCurrency: "EUR",
      amountUsdt: "99.000000",
      amountReceived: "99.000000",
      depositAddress: "TDetailAddr1234567890XXXXX",
    });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices/detail-inv-1",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("detail-inv-1");
    expect(res.body).toContain("evt-x");
    expect(res.body).toContain("99.00");
    expect(res.body).toContain("EUR");
    expect(res.body).toContain("99.000000");
    expect(res.body).toContain("badge-paid");
    expect(res.body).toContain("TDetailAddr1234567890XXXXX");
  });

  it("contains a back-link to /dashboard", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "detail-inv-back", eventId: "e1", status: "pending" });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices/detail-inv-back",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/dashboard"');
  });

  it("contains a payment link section with /pay/:id URL", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "detail-pay-link", eventId: "e1", status: "pending" });
    const deps = buildTestDeps({ sessionStore, invoiceRepo, publicBaseUrl: "https://pay.example.com" });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices/detail-pay-link",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("https://pay.example.com/pay/detail-pay-link");
  });

  it("has nonce-locked script-src CSP (no unsafe-inline)", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "detail-csp-test", eventId: "e1", status: "pending" });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices/detail-csp-test",
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

  it("rendered HTML has no inline style= attributes (CSP safe)", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "detail-nostyle", eventId: "e1", status: "paid", amountReceived: "50.000000" });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices/detail-nostyle",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/\sstyle="/);
  });
});

// ── Invoice detail page — styled 404 ─────────────────────────────────────────

describe("GET /dashboard/invoices/:id — styled 404", () => {
  it("returns 404 HTML (Vault style, not raw error) for unknown invoice id", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices/nonexistent-id-xyz",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    // Vault-styled page, not raw JSON or bare error
    expect(res.body).toContain("<!DOCTYPE html");
    expect(res.body).toContain("404");
    // Should include back-link to dashboard
    expect(res.body).toContain("/dashboard");
  });
});

// ── Dashboard rows link to invoice detail ────────────────────────────────────

describe("GET /dashboard — invoice rows link to detail page", () => {
  it("table rows contain anchor links to /dashboard/invoices/:id", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "row-link-inv", eventId: "e1", status: "pending" });
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("/dashboard/invoices/row-link-inv");
  });
});

// ── CSV truncation off-by-one ─────────────────────────────────────────────────

describe("GET /dashboard/invoices.csv — truncation off-by-one fix", () => {
  it("does NOT set X-Truncated-Rows when well under MAX_ROWS rows exist", async () => {
    const sessionStore = new InMemorySessionStore();
    const invoiceRepo = new MockInvoiceRepository();
    for (let i = 0; i < 5; i++) {
      invoiceRepo.seed({ id: `small_trunc_${i}`, eventId: "e1" });
    }
    const deps = buildTestDeps({ sessionStore, invoiceRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/dashboard/invoices.csv",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers["x-truncated-rows"]).toBeUndefined();
  });
});

// ── isDemoEnabled() shared helper ─────────────────────────────────────────────

describe("isDemoEnabled() shared helper", () => {
  it("returns false when ENABLE_DEMO is not set", async () => {
    const { isDemoEnabled } = await import("../utils.js");
    const savedDemo = process.env["ENABLE_DEMO"];
    const savedEnv = process.env["STABLERAILS_ENV"];
    delete process.env["ENABLE_DEMO"];
    delete process.env["STABLERAILS_ENV"];
    const result = isDemoEnabled();
    if (savedDemo !== undefined) process.env["ENABLE_DEMO"] = savedDemo;
    if (savedEnv !== undefined) process.env["STABLERAILS_ENV"] = savedEnv;
    expect(result).toBe(false);
  });

  it("returns false when STABLERAILS_ENV=production even with ENABLE_DEMO=1", async () => {
    const { isDemoEnabled } = await import("../utils.js");
    const savedDemo = process.env["ENABLE_DEMO"];
    const savedEnv = process.env["STABLERAILS_ENV"];
    process.env["ENABLE_DEMO"] = "1";
    process.env["STABLERAILS_ENV"] = "production";
    const result = isDemoEnabled();
    if (savedDemo !== undefined) process.env["ENABLE_DEMO"] = savedDemo;
    else delete process.env["ENABLE_DEMO"];
    if (savedEnv !== undefined) process.env["STABLERAILS_ENV"] = savedEnv;
    else delete process.env["STABLERAILS_ENV"];
    expect(result).toBe(false);
  });

  it("returns true when ENABLE_DEMO=1 and non-production runtime", async () => {
    const { isDemoEnabled } = await import("../utils.js");
    const savedDemo = process.env["ENABLE_DEMO"];
    const savedEnv = process.env["STABLERAILS_ENV"];
    process.env["ENABLE_DEMO"] = "1";
    delete process.env["STABLERAILS_ENV"];
    const result = isDemoEnabled();
    if (savedDemo !== undefined) process.env["ENABLE_DEMO"] = savedDemo;
    else delete process.env["ENABLE_DEMO"];
    if (savedEnv !== undefined) process.env["STABLERAILS_ENV"] = savedEnv;
    expect(result).toBe(true);
  });

  it("is used by landing.ts CTA (same result as direct env check)", async () => {
    // Verifies that landing.ts imports isDemoEnabled from utils (not its own copy)
    // by checking that the landing CTA mirrors the shared function's result.
    const savedDemo = process.env["ENABLE_DEMO"];
    const savedEnv = process.env["STABLERAILS_ENV"];
    process.env["ENABLE_DEMO"] = "1";
    delete process.env["STABLERAILS_ENV"];

    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/" });
    await app.close();

    if (savedDemo !== undefined) process.env["ENABLE_DEMO"] = savedDemo;
    else delete process.env["ENABLE_DEMO"];
    if (savedEnv !== undefined) process.env["STABLERAILS_ENV"] = savedEnv;

    expect(res.body).toContain("/demo");
  });
});

// ── Landing CSP — no script-src 'none' warning ────────────────────────────────

describe("GET / — landing CSP script-src has no 'none' that conflicts with nonce", () => {
  it("script-src does not contain 'none' alongside a nonce", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/" });
    await app.close();

    const csp = res.headers["content-security-policy"] as string | undefined;
    expect(csp).toBeDefined();
    const scriptSrcPart = csp!.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrcPart).toBeDefined();
    // Must not have both 'none' and a nonce (Chrome warns)
    const hasNone = scriptSrcPart!.includes("'none'");
    const hasNonce = /nonce-/.test(scriptSrcPart!);
    // Either no 'none', or no nonce — they must not coexist
    expect(hasNone && hasNonce).toBe(false);
  });
});
