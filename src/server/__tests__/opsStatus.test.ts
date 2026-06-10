/**
 * Tests for GET /ops/status — operator-session-gated system health page.
 *
 * All tests use in-memory mocks — no DB, no network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps } from "./helpers/mocks.js";
import { InMemorySessionStore, SESSION_COOKIE_NAME } from "../auth.js";

/** Helper: create a live session and return the cookie string. */
function makeSessionCookie(sessionStore: InMemorySessionStore): string {
  const id = sessionStore.create({ operatorId: "op1", email: "admin@example.com" });
  return `${SESSION_COOKIE_NAME}=${id}`;
}

// ── Auth gate: 302 without session ───────────────────────────────────────────

describe("GET /ops/status — auth gate", () => {
  it("redirects to /login when no session cookie is present", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/ops/status" });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });

  it("redirects to /login when session cookie has an unknown id", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: { cookie: `${SESSION_COOKIE_NAME}=nosuchsession` },
    });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });
});

// ── 200 with valid session ────────────────────────────────────────────────────

describe("GET /ops/status — renders with valid session", () => {
  it("returns 200 HTML with text/html content-type", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("has nonce-locked script-src CSP (no unsafe-inline)", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/ops/status",
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
});

// ── Kill-switch reflection ────────────────────────────────────────────────────

describe("GET /ops/status — kill-switch reflection", () => {
  it("shows all areas as active when no kill-switch is set", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // All three areas must be visible
    expect(res.body).toMatch(/invoices/i);
    expect(res.body).toMatch(/watcher/i);
    expect(res.body).toMatch(/webhooks/i);
  });

  it("shows invoices area as paused when kill-switch is set", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    // Set invoices paused via the in-memory repo
    await deps.killSwitchRepo.setFlag("invoices", true);
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // Page must surface that invoices is paused
    expect(res.body).toMatch(/invoices/i);
    expect(res.body).toMatch(/paused/i);
  });

  it("shows watcher area as paused when kill-switch is set", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    await deps.killSwitchRepo.setFlag("watcher", true);
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/watcher/i);
    expect(res.body).toMatch(/paused/i);
  });
});

// ── No secret leakage ─────────────────────────────────────────────────────────

describe("GET /ops/status — no secret leakage", () => {
  const FAKE_PRIMARY_URL = "https://api.trongrid.io/some/path?apikey=SECRET_KEY_SHOULD_NOT_APPEAR";
  const FAKE_SECONDARY_URL = "https://secondary.trx.io:9090/path?token=ANOTHER_SECRET";

  beforeEach(() => {
    process.env["TRON_RPC_PRIMARY_URL"] = FAKE_PRIMARY_URL;
    process.env["TRON_RPC_SECONDARY_URL"] = FAKE_SECONDARY_URL;
    process.env["TRON_RPC_PRIMARY_API_KEY"] = "HEADER_API_KEY_SECRET";
    process.env["TRON_RPC_SECONDARY_API_KEY"] = "HEADER_API_KEY_SECONDARY_SECRET";
  });

  afterEach(() => {
    delete process.env["TRON_RPC_PRIMARY_URL"];
    delete process.env["TRON_RPC_SECONDARY_URL"];
    delete process.env["TRON_RPC_PRIMARY_API_KEY"];
    delete process.env["TRON_RPC_SECONDARY_API_KEY"];
  });

  it("redacts query-string credentials from RPC URLs", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // Query-string secrets must NOT appear
    expect(res.body).not.toContain("SECRET_KEY_SHOULD_NOT_APPEAR");
    expect(res.body).not.toContain("ANOTHER_SECRET");
    // The hostname should appear (safe part of the URL)
    expect(res.body).toContain("api.trongrid.io");
  });

  it("never exposes TRON_RPC_*_API_KEY header values", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("HEADER_API_KEY_SECRET");
    expect(res.body).not.toContain("HEADER_API_KEY_SECONDARY_SECRET");
  });
});

// ── No inline style= attributes (CSP invariant) ───────────────────────────────

describe("GET /ops/status — no inline style= attributes", () => {
  it("rendered HTML has no inline style= attributes", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/\sstyle="/);
  });
});

// ── DB-down resilience ────────────────────────────────────────────────────────

describe("GET /ops/status — DB-down resilience", () => {
  it("returns 200 (not 500) when kill-switch DB reads throw", async () => {
    const sessionStore = new InMemorySessionStore();
    // Simulate a repo where every DB call throws (DB unreachable)
    const throwingRepo = {
      getFlag: (_area: string) => Promise.reject(new Error("DB connection lost")),
      setFlag: (_area: string, _paused: boolean) => Promise.reject(new Error("DB connection lost")),
      getAllFlags: () => Promise.reject(new Error("DB connection lost")),
    };
    const deps = buildTestDeps({ sessionStore, killSwitchRepo: throwingRepo as Parameters<typeof buildTestDeps>[0]["killSwitchRepo"] });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: { cookie },
    });
    await app.close();

    // Must NOT 500 — the health page is needed exactly when the DB is down
    expect(res.statusCode).toBe(200);
    // DB connectivity section must show unreachable, not vanish
    expect(res.body).toMatch(/unreachable/i);
  });
});

// ── Path-token URL redaction ──────────────────────────────────────────────────

describe("GET /ops/status — path-token URL redaction", () => {
  const PATH_TOKEN = "PATHSECRETTOKEN_QN_12345";
  const PRIMARY_WITH_PATH_TOKEN = `https://neat-rpc.tron-mainnet.quiknode.pro/${PATH_TOKEN}/jsonrpc`;

  beforeEach(() => {
    process.env["TRON_RPC_PRIMARY_URL"] = PRIMARY_WITH_PATH_TOKEN;
    process.env["TRON_RPC_SECONDARY_URL"] = "https://api.trongrid.io/walletsolidity";
  });

  afterEach(() => {
    delete process.env["TRON_RPC_PRIMARY_URL"];
    delete process.env["TRON_RPC_SECONDARY_URL"];
  });

  it("does not expose path-embedded token for QuickNode-style URLs", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/ops/status",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // Path-embedded secret MUST NOT appear in the rendered HTML
    expect(res.body).not.toContain(PATH_TOKEN);
    // Hostname must still appear so the operator can identify the provider
    expect(res.body).toContain("neat-rpc.tron-mainnet.quiknode.pro");
  });
});
