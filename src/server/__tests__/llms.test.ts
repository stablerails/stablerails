/**
 * GET /llms.txt and GET /agents.md — public AI-agent onboarding routes.
 *
 * Asserts:
 *   1. Both routes return 200 with the right content-type — no auth required.
 *   2. /llms.txt contains the init command, the readonly-key model, and the
 *      human passphrase gate (the security contract).
 *   3. /agents.md serves the embedded AGENTS.md runbook with the same key facts.
 *
 * Registers registerLlmsRoutes directly on a bare Fastify instance — the routes
 * are pure static content with no deps, so no buildApp/mocks are needed (and the
 * test stays valid regardless of when app.ts wires the registration).
 */

import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerLlmsRoutes } from "../routes/llms.js";

function buildBareApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerLlmsRoutes(app);
  return app;
}

describe("AI-agent onboarding routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  describe("GET /llms.txt", () => {
    it("returns 200 text/plain with no auth", async () => {
      app = buildBareApp();
      const res = await app.inject({ method: "GET", url: "/llms.txt" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/plain/);
    });

    it("contains the init command, readonly model, and passphrase gate", async () => {
      app = buildBareApp();
      const res = await app.inject({ method: "GET", url: "/llms.txt" });
      expect(res.body).toContain("stablerails init");
      expect(res.body).toContain("readonly");
      expect(res.body).toContain("passphrase");
    });

    it("points to the key URLs (/docs, /agents.md, /v1)", async () => {
      app = buildBareApp();
      const res = await app.inject({ method: "GET", url: "/llms.txt" });
      expect(res.body).toContain("/docs");
      expect(res.body).toContain("/agents.md");
      expect(res.body).toContain("/v1");
    });

    it("sets a cache header", async () => {
      app = buildBareApp();
      const res = await app.inject({ method: "GET", url: "/llms.txt" });
      expect(res.headers["cache-control"]).toContain("max-age");
    });
  });

  describe("GET /agents.md", () => {
    it("returns 200 text/markdown with no auth", async () => {
      app = buildBareApp();
      const res = await app.inject({ method: "GET", url: "/agents.md" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    });

    it("contains the init command, readonly model, and passphrase gate", async () => {
      app = buildBareApp();
      const res = await app.inject({ method: "GET", url: "/agents.md" });
      expect(res.body).toContain("stablerails init");
      expect(res.body).toContain("readonly");
      expect(res.body).toContain("passphrase");
    });

    it("states the two human-only steps (seed init, sweep execute)", async () => {
      app = buildBareApp();
      const res = await app.inject({ method: "GET", url: "/agents.md" });
      expect(res.body).toContain("stablerails seed init");
      expect(res.body).toContain("sweep execute");
      expect(res.body).toContain("HUMAN STEP");
    });
  });
});
