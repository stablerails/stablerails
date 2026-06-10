/**
 * GET /docs — public API documentation page.
 *
 * Asserts:
 *   1. Returns 200 with HTML content-type — no auth required.
 *   2. Contains the key endpoint sections (invoice create, public status, webhook admin).
 *   3. Documents the real HMAC signature header format (t=...,v1=...).
 *   4. Contains the webhook payload structure.
 *   5. No inline style= attributes — all CSS in a nonce'd <style> block.
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps } from "./helpers/mocks.js";

describe("GET /docs", () => {
  it("returns 200 HTML with no auth", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("contains the POST /v1/invoices endpoint section", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.body).toContain("POST /v1/invoices");
  });

  it("contains the GET /v1/public/invoices/:id endpoint", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.body).toContain("/v1/public/invoices/:id");
  });

  it("contains webhook admin endpoints", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.body).toContain("POST /v1/webhooks");
    expect(res.body).toContain("DELETE /v1/webhooks/:id");
  });

  it("documents the real HMAC signature header format", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/docs" });
    // Must contain the exact header name and the t=...,v1=... format
    expect(res.body).toContain("X-Stablerails-Signature");
    expect(res.body).toContain("t=");
    expect(res.body).toContain("v1=");
  });

  it("contains a HMAC verification code snippet", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.body).toContain("HMAC");
    expect(res.body).toContain("sha256");
  });

  it("contains the invoice lifecycle statuses", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/docs" });
    // All real statuses from the codebase
    expect(res.body).toContain("pending");
    expect(res.body).toContain("payment_detected");
    expect(res.body).toContain("paid");
    expect(res.body).toContain("expired");
  });

  it("contains the webhook payload fields (eventUid, eventType, version)", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/docs" });
    expect(res.body).toContain("eventUid");
    expect(res.body).toContain("eventType");
    expect(res.body).toContain("version");
  });

  it("has no inline style= attributes (CSP safety)", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/docs" });
    // No inline style attributes allowed — must use CSS classes in a nonce'd <style> block
    expect(res.body).not.toMatch(/style="[^"]+"/);
  });

  it("sets a Content-Security-Policy header (nonce-locked)", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/docs" });
    const csp = res.headers["content-security-policy"];
    expect(typeof csp).toBe("string");
    // Nonce must be present in the CSP header
    expect(csp).toMatch(/nonce-/);
  });
});
