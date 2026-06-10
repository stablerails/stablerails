/**
 * GET /auth/magic — magic-link login route.
 *
 * Security invariants under test:
 *   - valid token  → fresh session cookie + 302 /dashboard
 *   - reuse        → 403 (single-use, atomic consume)
 *   - expired      → 403
 *   - unknown / malformed → 403 (no token echo)
 *   - rate-limited → 429 (login bucket, before any DB work)
 *
 * All tests use in-memory mocks — no DB, no network.
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import {
  buildTestDeps,
  MockLoginTokenRepository,
  MockOperatorRepository,
} from "./helpers/mocks.js";
import { InMemorySessionStore, SESSION_COOKIE_NAME } from "../auth.js";
import { RateLimiter } from "../../lib/rate-limit.js";

const RAW_TOKEN = "ab".repeat(32); // 64 hex chars = 32 bytes

interface Seeded {
  operatorRepo: MockOperatorRepository;
  loginTokenRepo: MockLoginTokenRepository;
  sessionStore: InMemorySessionStore;
}

function seedDeps(tokenOpts?: { expiresAt?: Date; usedAt?: Date | null }): Seeded {
  const operatorRepo = new MockOperatorRepository();
  operatorRepo.seedOperator({
    id: "op1",
    email: "operator@local",
    passwordHash: "$argon2id$irrelevant",
  });
  const loginTokenRepo = new MockLoginTokenRepository();
  loginTokenRepo.seedToken({
    rawToken: RAW_TOKEN,
    operatorId: "op1",
    ...tokenOpts,
  });
  const sessionStore = new InMemorySessionStore();
  return { operatorRepo, loginTokenRepo, sessionStore };
}

describe("GET /auth/magic — happy path", () => {
  it("valid token → session cookie + 302 to /dashboard", async () => {
    const { operatorRepo, loginTokenRepo, sessionStore } = seedDeps();
    const app = buildApp(buildTestDeps({ operatorRepo, loginTokenRepo, sessionStore }));

    const res = await app.inject({ method: "GET", url: `/auth/magic?token=${RAW_TOKEN}` });
    await app.close();

    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/dashboard");

    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");

    // Fresh session id maps to the token's operator (session fixation safe:
    // the id comes from sessionStore.create, not from anything client-sent).
    const sessionId = setCookie.split(`${SESSION_COOKIE_NAME}=`)[1]!.split(";")[0]!;
    expect(sessionId).toMatch(/^[0-9a-f]{64}$/);
    const session = sessionStore.get(sessionId);
    expect(session?.operatorId).toBe("op1");
    expect(session?.email).toBe("operator@local");
  });

  it("session cookie grants access to /dashboard", async () => {
    const { operatorRepo, loginTokenRepo, sessionStore } = seedDeps();
    const app = buildApp(buildTestDeps({ operatorRepo, loginTokenRepo, sessionStore }));

    const login = await app.inject({ method: "GET", url: `/auth/magic?token=${RAW_TOKEN}` });
    const cookie = String(login.headers["set-cookie"]).split(";")[0]!;

    const dash = await app.inject({
      method: "GET",
      url: "/dashboard",
      headers: { cookie },
    });
    await app.close();

    expect(dash.statusCode).toBe(200);
  });
});

describe("GET /auth/magic — single-use / expiry / unknown", () => {
  it("reusing a consumed token → 403 (replay-safe)", async () => {
    const { operatorRepo, loginTokenRepo, sessionStore } = seedDeps();
    const app = buildApp(buildTestDeps({ operatorRepo, loginTokenRepo, sessionStore }));

    const first = await app.inject({ method: "GET", url: `/auth/magic?token=${RAW_TOKEN}` });
    expect(first.statusCode).toBe(302);

    const second = await app.inject({ method: "GET", url: `/auth/magic?token=${RAW_TOKEN}` });
    await app.close();

    expect(second.statusCode).toBe(403);
    expect(second.headers["content-type"]).toContain("text/html");
    // Hint to mint a fresh link; the raw token must never be echoed back.
    expect(second.body).toContain("operator login-link");
    expect(second.body).not.toContain(RAW_TOKEN);
    // No session cookie on failure.
    expect(second.headers["set-cookie"]).toBeUndefined();
  });

  it("expired token → 403", async () => {
    const { operatorRepo, loginTokenRepo, sessionStore } = seedDeps({
      expiresAt: new Date(Date.now() - 1_000), // already expired
    });
    const app = buildApp(buildTestDeps({ operatorRepo, loginTokenRepo, sessionStore }));

    const res = await app.inject({ method: "GET", url: `/auth/magic?token=${RAW_TOKEN}` });
    await app.close();

    expect(res.statusCode).toBe(403);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("unknown (never minted) token → 403", async () => {
    const { operatorRepo, loginTokenRepo, sessionStore } = seedDeps();
    const app = buildApp(buildTestDeps({ operatorRepo, loginTokenRepo, sessionStore }));

    const unknown = "cd".repeat(32);
    const res = await app.inject({ method: "GET", url: `/auth/magic?token=${unknown}` });
    await app.close();

    expect(res.statusCode).toBe(403);
  });

  it("malformed token (not 64-hex) and missing token → 403", async () => {
    const { operatorRepo, loginTokenRepo, sessionStore } = seedDeps();
    const app = buildApp(buildTestDeps({ operatorRepo, loginTokenRepo, sessionStore }));

    const malformed = await app.inject({ method: "GET", url: "/auth/magic?token=nothex" });
    const missing = await app.inject({ method: "GET", url: "/auth/magic" });
    await app.close();

    expect(malformed.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
  });

  it("403 page carries a strict CSP (script-src 'none')", async () => {
    const { operatorRepo, loginTokenRepo, sessionStore } = seedDeps();
    const app = buildApp(buildTestDeps({ operatorRepo, loginTokenRepo, sessionStore }));

    const res = await app.inject({ method: "GET", url: "/auth/magic?token=nothex" });
    await app.close();

    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("style-src 'self' 'nonce-");
  });
});

describe("GET /auth/magic — rate limit", () => {
  it("returns 429 once the per-IP login bucket is exhausted", async () => {
    const { operatorRepo, loginTokenRepo, sessionStore } = seedDeps();
    // Tight login bucket: 2 attempts per window (shared with POST /v1/auth/login).
    const rateLimiter = new RateLimiter({ login: { maxRequests: 2, windowMs: 60_000 } });
    const app = buildApp(
      buildTestDeps({ operatorRepo, loginTokenRepo, sessionStore, rateLimiter }),
    );

    const r1 = await app.inject({ method: "GET", url: "/auth/magic?token=nothex" });
    const r2 = await app.inject({ method: "GET", url: "/auth/magic?token=nothex" });
    const r3 = await app.inject({ method: "GET", url: `/auth/magic?token=${RAW_TOKEN}` });
    await app.close();

    expect(r1.statusCode).toBe(403);
    expect(r2.statusCode).toBe(403);
    // Limit fires BEFORE token consumption — even a valid token gets 429.
    expect(r3.statusCode).toBe(429);
    // The valid token was NOT consumed by the rate-limited request.
    const stored = [...loginTokenRepo.store.values()][0]!;
    expect(stored.usedAt).toBeNull();
  });
});
