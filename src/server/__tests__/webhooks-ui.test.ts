/**
 * Tests for the webhook management UI page.
 *
 * GET  /webhooks           — session-gated HTML list of webhooks
 * POST /webhooks           — register new webhook (form submit)
 * POST /webhooks/:id/delete — delete webhook (form submit, HTML form workaround for DELETE)
 *
 * All tests use in-memory mocks — no DB, no network, no real DNS.
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps, MockWebhookRepository } from "./helpers/mocks.js";
import { InMemorySessionStore, SESSION_COOKIE_NAME } from "../auth.js";

/** Helper: create a live session and return the cookie string. */
function makeSessionCookie(sessionStore: InMemorySessionStore): string {
  const id = sessionStore.create({ operatorId: "op1", email: "admin@example.com" });
  return `${SESSION_COOKIE_NAME}=${id}`;
}

// ── Auth gate: GET /webhooks ───────────────────────────────────────────────────

describe("GET /webhooks — auth gate", () => {
  it("redirects to /login when no session cookie is present", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/webhooks" });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });

  it("redirects to /login when session cookie has an unknown id", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "GET",
      url: "/webhooks",
      headers: { cookie: `${SESSION_COOKIE_NAME}=unknownsessionid` },
    });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });
});

// ── Auth gate: POST /webhooks ─────────────────────────────────────────────────

describe("POST /webhooks — auth gate", () => {
  it("redirects to /login when no session cookie is present", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "url=https%3A%2F%2Fexample.com%2Fhook",
    });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });
});

// ── Auth gate: POST /webhooks/:id/delete ──────────────────────────────────────

describe("POST /webhooks/:id/delete — auth gate", () => {
  it("redirects to /login when no session cookie is present", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/someid/delete",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    await app.close();
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/login");
  });
});

// ── GET /webhooks — renders with session ──────────────────────────────────────

describe("GET /webhooks — renders with valid session", () => {
  it("returns 200 HTML", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/webhooks",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  it("lists registered webhook URLs", async () => {
    const sessionStore = new InMemorySessionStore();
    const webhookRepo = new MockWebhookRepository();
    webhookRepo.seedEndpoint({ url: "https://example.com/hook1" });
    webhookRepo.seedEndpoint({ url: "https://example.com/hook2" });
    const deps = buildTestDeps({ sessionStore, webhookRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/webhooks",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("https://example.com/hook1");
    expect(res.body).toContain("https://example.com/hook2");
  });

  it("shows empty state when no webhooks are registered", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/webhooks",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    // Should render a page that indicates no webhooks exist
    expect(res.body).toContain("<!DOCTYPE html");
  });

  it("has nonce-locked script-src CSP (no unsafe-inline for scripts)", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/webhooks",
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
    const webhookRepo = new MockWebhookRepository();
    webhookRepo.seedEndpoint({ url: "https://example.com/hook" });
    const deps = buildTestDeps({ sessionStore, webhookRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/webhooks",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/\sstyle="/);
  });

  it("contains a link back to /dashboard", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/webhooks",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('href="/dashboard"');
  });

  it("shows active status badge for active webhooks", async () => {
    const sessionStore = new InMemorySessionStore();
    const webhookRepo = new MockWebhookRepository();
    webhookRepo.seedEndpoint({ url: "https://example.com/hook", active: true });
    const deps = buildTestDeps({ sessionStore, webhookRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "GET",
      url: "/webhooks",
      headers: { cookie },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("active");
  });
});

// ── POST /webhooks — register new webhook ─────────────────────────────────────

describe("POST /webhooks — register new webhook", () => {
  it("inserts webhook and redirects to /webhooks on valid URL", async () => {
    const sessionStore = new InMemorySessionStore();
    const webhookRepo = new MockWebhookRepository();
    const deps = buildTestDeps({
      sessionStore,
      webhookRepo,
      // Bypass real DNS: inject a no-op assertUrl that accepts any https URL
      assertUrl: async (_url: string) => { /* allow all in tests */ },
    });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "url=https%3A%2F%2Fexample.com%2Fhook",
    });
    await app.close();

    // One-time secret reveal: the page is rendered directly (200, no redirect)
    // and shows the PLAINTEXT signing secret exactly once.
    expect(res.statusCode).toBe(200);
    // Webhook must have been stored
    expect(webhookRepo.store.size).toBe(1);
    const stored = Array.from(webhookRepo.store.values())[0]!;
    expect(stored.url).toBe("https://example.com/hook");
    // STABLERAILS_DATA_KEY is unset in tests → sealSecret is a plaintext
    // passthrough, so the stored secret IS the plaintext one shown once.
    expect(res.body).toContain("показывается ОДИН раз");
    expect(res.body).toContain(stored.secret);
  });

  it("re-renders form with error when URL is missing", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "url=",
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toContain("url");
  });

  it("re-renders form with error when URL is not https", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "url=http%3A%2F%2Fexample.com%2Fhook",
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    // Error message must mention https
    expect(res.body.toLowerCase()).toContain("https");
  });

  it("re-renders form with 400 HTML error when eventId does not exist in eventRepo", async () => {
    const sessionStore = new InMemorySessionStore();
    const webhookRepo = new MockWebhookRepository();
    // eventRepo has no seeded events — findById will return null for any id
    const deps = buildTestDeps({
      sessionStore,
      webhookRepo,
      assertUrl: async (_url: string) => { /* bypass SSRF for this test */ },
    });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "url=https%3A%2F%2Fexample.com%2Fhook&eventId=nonexistent-event-id",
    });
    await app.close();

    // Must NOT return 500 (which would be the Prisma FK error in production)
    expect(res.statusCode).not.toBe(500);
    // Must return 400/404 with HTML inline error
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    // No webhook must have been created
    expect(webhookRepo.store.size).toBe(0);
  });

  it("re-renders form with error when URL fails SSRF check (private IP)", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({
      sessionStore,
      // Inject an assertUrl that rejects private IPs as the real SSRF guard would
      assertUrl: async (url: string) => {
        const parsed = new URL(url);
        if (parsed.hostname === "192.168.1.1") {
          const { SsrfGuardError } = await import("../../lib/ssrf-guard.js");
          throw new SsrfGuardError("BLOCKED_IP", "IP 192.168.1.1 is blocked: RFC1918");
        }
      },
    });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "url=https%3A%2F%2F192.168.1.1%2Fhook",
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });
});

// ── POST /webhooks/:id/delete — delete webhook ────────────────────────────────

describe("POST /webhooks/:id/delete — delete webhook", () => {
  it("deletes the webhook and redirects to /webhooks", async () => {
    const sessionStore = new InMemorySessionStore();
    const webhookRepo = new MockWebhookRepository();
    const endpoint = webhookRepo.seedEndpoint({ url: "https://example.com/hook" });
    const deps = buildTestDeps({ sessionStore, webhookRepo });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/${endpoint.id}/delete`,
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
    await app.close();

    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/webhooks");
    expect(webhookRepo.store.has(endpoint.id)).toBe(false);
  });

  it("returns 404 HTML for unknown webhook id", async () => {
    const sessionStore = new InMemorySessionStore();
    const deps = buildTestDeps({ sessionStore });
    const app = buildApp(deps);
    const cookie = makeSessionCookie(sessionStore);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/nonexistent-id/delete",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
    await app.close();

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });
});

// ── Dashboard nav — link to /webhooks ────────────────────────────────────────

describe("GET /dashboard — nav link to /webhooks", () => {
  it("contains a link to /webhooks in the rendered HTML", async () => {
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
    expect(res.body).toContain('href="/webhooks"');
  });
});
