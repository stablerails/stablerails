/**
 * Kill-switch unit tests.
 *
 * Covers:
 *   - isPaused() with env vars
 *   - isPaused() with in-memory flags
 *   - pauseArea / resumeArea / resetAll
 *   - pausedAreas() snapshot
 *   - POST /v1/invoices returns 503 when invoices are paused
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  isPaused,
  pauseArea,
  resumeArea,
  resetAll,
  pausedAreas,
} from "../killswitch.js";
import { buildApp } from "../app.js";
import { buildTestDeps } from "./helpers/mocks.js";

// ── Kill-switch unit tests ────────────────────────────────────────────────────

describe("killswitch: in-memory flags", () => {
  beforeEach(() => resetAll());
  afterEach(() => resetAll());

  it("all areas are unpaused by default", () => {
    expect(isPaused("invoices")).toBe(false);
    expect(isPaused("watcher")).toBe(false);
    expect(isPaused("webhooks")).toBe(false);
  });

  it("pauseArea sets the flag", () => {
    pauseArea("invoices");
    expect(isPaused("invoices")).toBe(true);
    expect(isPaused("watcher")).toBe(false);
  });

  it("resumeArea clears the flag", () => {
    pauseArea("watcher");
    resumeArea("watcher");
    expect(isPaused("watcher")).toBe(false);
  });

  it("resetAll clears all flags", () => {
    pauseArea("invoices");
    pauseArea("watcher");
    pauseArea("webhooks");
    resetAll();
    expect(isPaused("invoices")).toBe(false);
    expect(isPaused("watcher")).toBe(false);
    expect(isPaused("webhooks")).toBe(false);
  });

  it("pausedAreas() returns all currently paused areas", () => {
    pauseArea("invoices");
    pauseArea("webhooks");
    const paused = pausedAreas();
    expect(paused).toContain("invoices");
    expect(paused).toContain("webhooks");
    expect(paused).not.toContain("watcher");
  });

  it("pauseArea is idempotent", () => {
    pauseArea("invoices");
    pauseArea("invoices");
    expect(isPaused("invoices")).toBe(true);
    resumeArea("invoices");
    expect(isPaused("invoices")).toBe(false);
  });
});

describe("killswitch: env vars", () => {
  beforeEach(() => resetAll());
  afterEach(() => {
    resetAll();
    delete process.env["STABLERAILS_PAUSE_INVOICES"];
    delete process.env["STABLERAILS_PAUSE_WATCHER"];
    delete process.env["STABLERAILS_PAUSE_WEBHOOKS"];
  });

  it("env var '1' pauses the area", () => {
    process.env["STABLERAILS_PAUSE_INVOICES"] = "1";
    expect(isPaused("invoices")).toBe(true);
  });

  it("env var 'true' pauses the area", () => {
    process.env["STABLERAILS_PAUSE_WATCHER"] = "true";
    expect(isPaused("watcher")).toBe(true);
  });

  it("env var '0' does NOT pause", () => {
    process.env["STABLERAILS_PAUSE_WEBHOOKS"] = "0";
    expect(isPaused("webhooks")).toBe(false);
  });

  it("env var 'false' does NOT pause", () => {
    process.env["STABLERAILS_PAUSE_INVOICES"] = "false";
    expect(isPaused("invoices")).toBe(false);
  });

  it("env var unset + in-memory flag pauses", () => {
    delete process.env["STABLERAILS_PAUSE_INVOICES"];
    pauseArea("invoices");
    expect(isPaused("invoices")).toBe(true);
  });

  it("env var OR in-memory flag = paused", () => {
    process.env["STABLERAILS_PAUSE_INVOICES"] = "1";
    // in-memory NOT set — env alone should pause
    expect(isPaused("invoices")).toBe(true);
  });
});

// ── HTTP route: POST /v1/invoices returns 503 when paused ─────────────────────

describe("POST /v1/invoices with kill-switch", () => {
  beforeEach(() => resetAll());
  afterEach(() => {
    resetAll();
    delete process.env["STABLERAILS_PAUSE_INVOICES"];
  });

  it("returns 503 SERVICE_PAUSED when invoice creation is paused (in-memory flag)", async () => {
    pauseArea("invoices");

    const deps = buildTestDeps();
    const app = buildApp(deps);

    // Seed an event so the request would normally succeed
    const eventRes = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${deps.adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "KS Test Event",
        mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
        derivationAccount: 0,
        xpubAccount: "xpub_test_mock",
      }),
    });
    const eventBody = JSON.parse(eventRes.body) as { data: { id: string } };
    const eventId = eventBody.data.id;

    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { authorization: `Bearer ${deps.merchantKey}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId, priceFiat: "50.00", fiatCurrency: "USD" }),
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("SERVICE_PAUSED");
  });

  it("returns 503 when STABLERAILS_PAUSE_INVOICES=1 env var is set", async () => {
    process.env["STABLERAILS_PAUSE_INVOICES"] = "1";

    const deps = buildTestDeps();
    const app = buildApp(deps);

    const eventRes = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${deps.adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "KS Test Event 2",
        mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
        derivationAccount: 0,
        xpubAccount: "xpub_test_mock2",
      }),
    });
    const eventBody = JSON.parse(eventRes.body) as { data: { id: string } };
    const eventId = eventBody.data.id;

    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { authorization: `Bearer ${deps.merchantKey}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId, priceFiat: "50.00", fiatCurrency: "USD" }),
    });

    expect(res.statusCode).toBe(503);
  });

  it("creates invoice normally when kill-switch is off", async () => {
    const deps = buildTestDeps();
    const app = buildApp(deps);

    const eventRes = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${deps.adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "KS Test Event 3",
        mainWalletAddress: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
        derivationAccount: 0,
        xpubAccount: "xpub_test_mock3",
      }),
    });
    const eventBody = JSON.parse(eventRes.body) as { data: { id: string } };
    const eventId = eventBody.data.id;

    const res = await app.inject({
      method: "POST",
      url: "/v1/invoices",
      headers: { authorization: `Bearer ${deps.merchantKey}`, "content-type": "application/json" },
      body: JSON.stringify({ eventId, priceFiat: "50.00", fiatCurrency: "USD" }),
    });

    expect(res.statusCode).toBe(201);
  });
});
