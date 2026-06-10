/**
 * Tests for GET /metrics — Prometheus scrape endpoint.
 *
 * Gate: bearer token from METRICS_TOKEN env var.
 * - METRICS_TOKEN unset  → 404 (feature disabled)
 * - no/wrong token       → 401
 * - correct token        → 200 + text/plain; version=0.0.4
 */

import { describe, it, expect, afterEach } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps, MockInvoiceRepository } from "./helpers/mocks.js";

// Preserve original env value so each test starts clean.
const ORIGINAL_METRICS_TOKEN = process.env["METRICS_TOKEN"];

afterEach(() => {
  if (ORIGINAL_METRICS_TOKEN === undefined) {
    delete process.env["METRICS_TOKEN"];
  } else {
    process.env["METRICS_TOKEN"] = ORIGINAL_METRICS_TOKEN;
  }
});

// ── Feature disabled when env var is unset ────────────────────────────────────

describe("GET /metrics — disabled (METRICS_TOKEN unset)", () => {
  it("returns 404 when METRICS_TOKEN is not set", async () => {
    delete process.env["METRICS_TOKEN"];
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();
    expect(res.statusCode).toBe(404);
  });
});

// ── Token gate ────────────────────────────────────────────────────────────────

describe("GET /metrics — token gate", () => {
  it("returns 401 when no Authorization header is provided", async () => {
    process.env["METRICS_TOKEN"] = "secret-metrics-token";
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/metrics" });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when wrong token is provided", async () => {
    process.env["METRICS_TOKEN"] = "secret-metrics-token";
    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer wrong-token" },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when Authorization scheme is not Bearer", async () => {
    process.env["METRICS_TOKEN"] = "secret-metrics-token";
    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Basic secret-metrics-token" },
    });
    await app.close();
    expect(res.statusCode).toBe(401);
  });
});

// ── Successful scrape ─────────────────────────────────────────────────────────

describe("GET /metrics — successful scrape", () => {
  it("returns 200 with correct Content-Type on valid token", async () => {
    process.env["METRICS_TOKEN"] = "correct-token";
    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer correct-token" },
    });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.headers["content-type"]).toMatch(/version=0\.0\.4/);
  });

  it("body contains stablerails_invoices_total metric per status", async () => {
    process.env["METRICS_TOKEN"] = "correct-token";
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "inv1", eventId: "e1", status: "paid", amountReceived: "100.000000" });
    invoiceRepo.seed({ id: "inv2", eventId: "e1", status: "pending", amountReceived: "0.000000" });
    const app = buildApp(buildTestDeps({ invoiceRepo }));
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer correct-token" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('stablerails_invoices_total{status="paid"} 1');
    expect(res.body).toContain('stablerails_invoices_total{status="pending"} 1');
    // Statuses with zero count still appear
    expect(res.body).toContain('stablerails_invoices_total{status="expired"} 0');
  });

  it("body contains stablerails_usdt_received_total metric", async () => {
    process.env["METRICS_TOKEN"] = "tok";
    const invoiceRepo = new MockInvoiceRepository();
    invoiceRepo.seed({ id: "inv1", eventId: "e1", status: "paid", amountReceived: "75.500000" });
    invoiceRepo.seed({ id: "inv2", eventId: "e1", status: "paid", amountReceived: "24.500000" });
    const app = buildApp(buildTestDeps({ invoiceRepo }));
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer tok" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("stablerails_usdt_received_total 100.000000");
  });

  it("body follows Prometheus text format (HELP + TYPE before metric lines)", async () => {
    process.env["METRICS_TOKEN"] = "tok";
    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer tok" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const lines = res.body.split("\n");
    // HELP and TYPE lines must precede each metric family
    const helpIdx = lines.findIndex((l) => l.startsWith("# HELP stablerails_invoices_total"));
    const typeIdx = lines.findIndex((l) => l.startsWith("# TYPE stablerails_invoices_total"));
    const metricIdx = lines.findIndex((l) => l.startsWith("stablerails_invoices_total{"));
    expect(helpIdx).toBeGreaterThanOrEqual(0);
    expect(typeIdx).toBeGreaterThan(helpIdx);
    expect(metricIdx).toBeGreaterThan(typeIdx);
  });
});
