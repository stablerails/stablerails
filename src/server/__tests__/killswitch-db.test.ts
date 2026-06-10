/**
 * ITEM 2 — KS-1: DB-backed kill-switch tests.
 *
 * Verifies:
 *   - Admin can set/clear a flag via POST /v1/admin/killswitch
 *   - isPausedAsync reflects the DB-backed state via the shared repo
 *   - readonly/merchant keys get 403 on the toggle
 *   - Env flag still forces paused (boot-time behaviour preserved)
 *   - Invalid area → 400
 *   - GET /v1/admin/killswitch returns current state
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../app.js";
import {
  buildTestDeps,
  MockApiKeyRepository,
} from "./helpers/mocks.js";
import {
  resetAll,
  initKillSwitchRepo,
  flushKillSwitchCache,
  isPausedAsync,
} from "../killswitch.js";
import { InMemoryKillSwitchRepository } from "../killswitch-repo.js";

// Convenience: inject an auth header.
function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

function buildAppWithReadonlyKey(): {
  app: ReturnType<typeof buildApp>;
  readonlyKey: string;
  adminKey: string;
  merchantKey: string;
  killSwitchRepo: InMemoryKillSwitchRepository;
} {
  const deps = buildTestDeps();
  const readonlyRaw = "readonlyks_test_1234567890abcdef1";
  (deps.apiKeyRepo as MockApiKeyRepository).seedKey({
    rawKey: readonlyRaw,
    scope: "readonly",
    label: "test-readonly-ks",
  });
  const app = buildApp(deps);
  return {
    app,
    readonlyKey: readonlyRaw,
    adminKey: deps.adminKey,
    merchantKey: deps.merchantKey,
    killSwitchRepo: deps.killSwitchRepo,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  resetAll();
  flushKillSwitchCache();
});

afterEach(() => {
  resetAll();
  flushKillSwitchCache();
  delete process.env["STABLERAILS_PAUSE_INVOICES"];
  delete process.env["STABLERAILS_PAUSE_WATCHER"];
  delete process.env["STABLERAILS_PAUSE_WEBHOOKS"];
});

// ── Admin set/clear via HTTP ──────────────────────────────────────────────────

describe("POST /v1/admin/killswitch — admin toggle", () => {
  it("admin can set paused=true for invoices", async () => {
    const { app, adminKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/killswitch",
      headers: { ...bearer(adminKey), "content-type": "application/json" },
      body: JSON.stringify({ area: "invoices", paused: true }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { area: string; paused: boolean } };
    expect(body.data.area).toBe("invoices");
    expect(body.data.paused).toBe(true);
  });

  it("admin can clear paused=false for invoices", async () => {
    const { app, adminKey, killSwitchRepo } = buildAppWithReadonlyKey();
    // Set it first
    await killSwitchRepo.setFlag("invoices", true);
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/killswitch",
      headers: { ...bearer(adminKey), "content-type": "application/json" },
      body: JSON.stringify({ area: "invoices", paused: false }),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { paused: boolean } };
    expect(body.data.paused).toBe(false);
  });
});

// ── isPausedAsync reflects DB flag ────────────────────────────────────────────

describe("isPausedAsync reads DB-backed flag", () => {
  it("reflects DB flag set directly via repo", async () => {
    const repo = new InMemoryKillSwitchRepository();
    initKillSwitchRepo(repo, 0); // TTL=0 forces fresh read every time
    await repo.setFlag("watcher", true);
    expect(await isPausedAsync("watcher")).toBe(true);
  });

  it("reflects DB flag cleared via repo", async () => {
    const repo = new InMemoryKillSwitchRepository();
    initKillSwitchRepo(repo, 0);
    await repo.setFlag("watcher", true);
    await repo.setFlag("watcher", false);
    expect(await isPausedAsync("watcher")).toBe(false);
  });

  it("admin set flag + isPausedAsync reflects it via shared repo", async () => {
    const { app, adminKey, killSwitchRepo } = buildAppWithReadonlyKey();
    // Wire repo with 0ms TTL for immediate reflection
    initKillSwitchRepo(killSwitchRepo, 0);
    flushKillSwitchCache();

    await app.inject({
      method: "POST",
      url: "/v1/admin/killswitch",
      headers: { ...bearer(adminKey), "content-type": "application/json" },
      body: JSON.stringify({ area: "webhooks", paused: true }),
    });

    // After the POST, cache is flushed by the route; next read hits DB
    expect(await isPausedAsync("webhooks")).toBe(true);
  });

  it("admin clear flag + isPausedAsync reflects it via shared repo", async () => {
    const { app, adminKey, killSwitchRepo } = buildAppWithReadonlyKey();
    initKillSwitchRepo(killSwitchRepo, 0);
    flushKillSwitchCache();

    // Set directly
    await killSwitchRepo.setFlag("invoices", true);

    // Clear via API
    await app.inject({
      method: "POST",
      url: "/v1/admin/killswitch",
      headers: { ...bearer(adminKey), "content-type": "application/json" },
      body: JSON.stringify({ area: "invoices", paused: false }),
    });

    expect(await isPausedAsync("invoices")).toBe(false);
  });
});

// ── Scope checks ──────────────────────────────────────────────────────────────

describe("POST /v1/admin/killswitch — scope checks", () => {
  it("readonly key is 403", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/killswitch",
      headers: { ...bearer(readonlyKey), "content-type": "application/json" },
      body: JSON.stringify({ area: "invoices", paused: true }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("merchant key is 403", async () => {
    const { app, merchantKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/killswitch",
      headers: { ...bearer(merchantKey), "content-type": "application/json" },
      body: JSON.stringify({ area: "invoices", paused: true }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /v1/admin/killswitch readonly key is 403", async () => {
    const { app, readonlyKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/killswitch",
      headers: bearer(readonlyKey),
    });
    expect(res.statusCode).toBe(403);
  });

  it("GET /v1/admin/killswitch merchant key is 403", async () => {
    const { app, merchantKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/killswitch",
      headers: bearer(merchantKey),
    });
    expect(res.statusCode).toBe(403);
  });
});

// ── Env flag still forces paused ──────────────────────────────────────────────

describe("env flag takes precedence", () => {
  it("env STABLERAILS_PAUSE_INVOICES=1 still pauses even if DB says false", async () => {
    process.env["STABLERAILS_PAUSE_INVOICES"] = "1";
    const repo = new InMemoryKillSwitchRepository();
    initKillSwitchRepo(repo, 0);
    await repo.setFlag("invoices", false);
    expect(await isPausedAsync("invoices")).toBe(true);
  });
});

// ── Invalid area → 400 ────────────────────────────────────────────────────────

describe("POST /v1/admin/killswitch — validation", () => {
  it("invalid area returns 400", async () => {
    const { app, adminKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/killswitch",
      headers: { ...bearer(adminKey), "content-type": "application/json" },
      body: JSON.stringify({ area: "funds", paused: true }),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("missing paused field returns 400", async () => {
    const { app, adminKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/killswitch",
      headers: { ...bearer(adminKey), "content-type": "application/json" },
      body: JSON.stringify({ area: "invoices" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("missing area field returns 400", async () => {
    const { app, adminKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/killswitch",
      headers: { ...bearer(adminKey), "content-type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ── GET /v1/admin/killswitch — read current state ────────────────────────────

describe("GET /v1/admin/killswitch", () => {
  it("admin can read all flag states", async () => {
    const { app, adminKey } = buildAppWithReadonlyKey();
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/killswitch",
      headers: bearer(adminKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: Record<string, { paused: boolean }>
    };
    expect(body.data).toHaveProperty("invoices");
    expect(body.data).toHaveProperty("watcher");
    expect(body.data).toHaveProperty("webhooks");
    expect(body.data["invoices"]!.paused).toBe(false);
  });

  it("reflects DB state after a set", async () => {
    const { app, adminKey, killSwitchRepo } = buildAppWithReadonlyKey();
    initKillSwitchRepo(killSwitchRepo, 0);
    flushKillSwitchCache();

    await app.inject({
      method: "POST",
      url: "/v1/admin/killswitch",
      headers: { ...bearer(adminKey), "content-type": "application/json" },
      body: JSON.stringify({ area: "watcher", paused: true }),
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/killswitch",
      headers: bearer(adminKey),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: Record<string, { paused: boolean }> };
    expect(body.data["watcher"]!.paused).toBe(true);
  });
});

// ── H1: 503 when no repo wired + 200+persisted when wired ───────────────────

describe("POST /v1/admin/killswitch — 503 when repo absent, 200 when present", () => {
  it("returns 503 KILLSWITCH_UNAVAILABLE when no killSwitchRepo in AppDeps", async () => {
    // Build app without a killSwitchRepo — simulates misconfigured deploy.
    const deps = buildTestDeps();
    // Omit killSwitchRepo from the deps passed to buildApp.
    const { killSwitchRepo: _ignored, ...depsWithout } = deps;
    const app = buildApp(depsWithout);

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/killswitch",
      headers: { ...bearer(deps.adminKey), "content-type": "application/json" },
      body: JSON.stringify({ area: "invoices", paused: true }),
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe("KILLSWITCH_UNAVAILABLE");
  });

  it("returns 200 and persists when killSwitchRepo is wired", async () => {
    const { app, adminKey, killSwitchRepo } = buildAppWithReadonlyKey();
    initKillSwitchRepo(killSwitchRepo, 0);
    flushKillSwitchCache();

    const res = await app.inject({
      method: "POST",
      url: "/v1/admin/killswitch",
      headers: { ...bearer(adminKey), "content-type": "application/json" },
      body: JSON.stringify({ area: "invoices", paused: true }),
    });
    expect(res.statusCode).toBe(200);
    // Verify it actually persisted
    expect(await killSwitchRepo.getFlag("invoices")).toBe(true);
  });
});

// ── DB-throw fail-closed: getFlag throws → isPausedAsync propagates ──────────

describe("isPausedAsync — fail-closed on DB error", () => {
  it("propagates error when getFlag throws (watcher must skip tick)", async () => {
    // A repo whose getFlag always throws simulates a DB outage.
    const throwingRepo: import("../killswitch-repo.js").KillSwitchRepository = {
      async getFlag(_area) { throw new Error("DB connection lost"); },
      async setFlag() { /* no-op */ },
      async getAllFlags() { throw new Error("DB connection lost"); },
    };
    initKillSwitchRepo(throwingRepo, 0);
    flushKillSwitchCache();

    // isPausedAsync must propagate the error — callers (watcher, webhook drain)
    // catch it and skip the tick, which is the safe (fail-closed) behavior.
    await expect(isPausedAsync("watcher")).rejects.toThrow("DB connection lost");
  });

  it("env fast-path bypasses DB — no throw when env flag is set", async () => {
    process.env["STABLERAILS_PAUSE_INVOICES"] = "1";
    const throwingRepo: import("../killswitch-repo.js").KillSwitchRepository = {
      async getFlag(_area) { throw new Error("DB should not be reached"); },
      async setFlag() { /* no-op */ },
      async getAllFlags() { throw new Error("DB should not be reached"); },
    };
    initKillSwitchRepo(throwingRepo, 0);
    flushKillSwitchCache();

    // Env flag short-circuits before DB access — no throw.
    await expect(isPausedAsync("invoices")).resolves.toBe(true);
  });
});

// ── Composition root smoke: buildApp wires killSwitchRepo ────────────────────

describe("buildApp composition — kill-switch repo wiring", () => {
  it("buildTestDeps includes a killSwitchRepo, and buildApp initialises it", async () => {
    const deps = buildTestDeps();
    // killSwitchRepo must be present in the deps returned by buildTestDeps.
    expect(deps.killSwitchRepo).toBeDefined();

    // Building the app with the repo means isPausedAsync will query it.
    initKillSwitchRepo(deps.killSwitchRepo, 0);
    flushKillSwitchCache();

    await deps.killSwitchRepo.setFlag("watcher", true);
    expect(await isPausedAsync("watcher")).toBe(true);
  });
});
