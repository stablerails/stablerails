/**
 * CSP headers on static inline-HTML error responses (defense-in-depth).
 *
 * The global helmet registration disables CSP (JSON API routes), and HTML
 * routes set their own nonce-based CSP via route config. Static error pages
 * (429/404 on /pay, 400/503/502 on /demo/order) are served inline without the
 * nonce machinery — they must carry a strict static CSP of their own:
 *
 *   /pay error pages   → "default-src 'none'"                              (no styles at all)
 *   /demo error pages  → "default-src 'none'; style-src 'unsafe-inline'"   (inline style="" only)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps, MockInvoiceRepository } from "./helpers/mocks.js";
import { RateLimiter } from "../../lib/rate-limit.js";

const PAY_ERROR_CSP = "default-src 'none'";
const DEMO_ERROR_CSP = "default-src 'none'; style-src 'unsafe-inline'";

describe("GET /pay/:invoiceId — static HTML error pages carry a strict CSP", () => {
  it("404 (invoice not found) HTML response has Content-Security-Policy: default-src 'none'", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);

    const res = await app.inject({ method: "GET", url: "/pay/does-not-exist" });

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toBe(PAY_ERROR_CSP);
  });

  it("429 (rate-limited) HTML response has Content-Security-Policy: default-src 'none'", async () => {
    // Rate limiter with a zero-budget public_status bucket → first request is 429.
    const rateLimiter = new RateLimiter({
      public_status: { maxRequests: 0, windowMs: 60_000 },
    });
    const deps = buildTestDeps({ rateLimiter });
    const app = buildApp(deps);

    const res = await app.inject({ method: "GET", url: "/pay/any-id" });

    expect(res.statusCode).toBe(429);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toBe(PAY_ERROR_CSP);
  });

  it("200 checkout page keeps its nonce-based CSP (route config not clobbered)", async () => {
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "inv-csp-1", eventId: "evt-csp-1" });
    const deps = buildTestDeps({ invoiceRepo });
    const app = buildApp(deps);

    const res = await app.inject({ method: "GET", url: "/pay/inv-csp-1" });

    expect(res.statusCode).toBe(200);
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("script-src");
    expect(csp).toContain("nonce-");
  });
});

describe("POST /demo/order — static HTML error pages carry a strict CSP", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["ENABLE_DEMO", "DEMO_MERCHANT_KEY", "DEMO_EVENT_ID"] as const;

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env["ENABLE_DEMO"] = "1";
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("400 (invalid amount) HTML response has the static error CSP", async () => {
    process.env["DEMO_MERCHANT_KEY"] = "demo-key";
    process.env["DEMO_EVENT_ID"] = "demo-event";
    const app = buildApp(buildTestDeps());

    const res = await app.inject({
      method: "POST",
      url: "/demo/order",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "product=Test&amount=not-a-number",
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toBe(DEMO_ERROR_CSP);
  });

  it("503 (demo not configured) HTML response has the static error CSP", async () => {
    delete process.env["DEMO_MERCHANT_KEY"];
    delete process.env["DEMO_EVENT_ID"];
    const app = buildApp(buildTestDeps());

    const res = await app.inject({
      method: "POST",
      url: "/demo/order",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "product=Test&amount=1.00",
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toBe(DEMO_ERROR_CSP);
  });
});
