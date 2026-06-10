/**
 * Admin kill-switch routes (KS-1).
 *
 * POST /v1/admin/killswitch  admin — set/clear a pause flag (cross-process)
 * GET  /v1/admin/killswitch  admin — read current state of all flags
 *
 * NOTE: Environment variables (STABLERAILS_PAUSE_*) are boot-time only.
 * This admin route is the RUNTIME control plane — it persists to the DB so
 * all processes (Fastify, watcher, webhook worker) pick up the change within
 * the cache TTL (~1-2s).
 *
 * Requires admin scope. readonly/merchant keys are rejected with 403.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { RateLimiter } from "../../lib/rate-limit.js";
import { requireScope } from "../auth.js";
import type { ApiKeyRepository } from "../auth.js";
import type { KillSwitchRepository } from "../killswitch-repo.js";
import { flushKillSwitchCache, isPausedAsync } from "../killswitch.js";
import type { KillswitchArea } from "../killswitch.js";

const VALID_AREAS: KillswitchArea[] = ["invoices", "watcher", "webhooks"];

interface KillSwitchRouteOpts {
  apiKeyRepo: ApiKeyRepository;
  rateLimiter: RateLimiter;
  /**
   * DB-backed repository for cross-process flag storage.
   * If not wired (tests without a DB), the route falls back to in-memory
   * state only (still usable for integration tests).
   */
  killSwitchRepo?: KillSwitchRepository;
}

interface SetFlagBody {
  area: KillswitchArea;
  paused: boolean;
}

export async function registerKillSwitchRoutes(
  app: FastifyInstance,
  opts: KillSwitchRouteOpts,
): Promise<void> {
  const { apiKeyRepo, rateLimiter, killSwitchRepo } = opts;
  const adminAuth = requireScope("admin", apiKeyRepo);

  // POST /v1/admin/killswitch — set or clear a flag
  app.post(
    "/v1/admin/killswitch",
    { preHandler: adminAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const k = req.apiKey!;
      if (!rateLimiter.check("admin", k.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }

      const body = req.body as SetFlagBody;
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "Invalid request body" } });
      }
      if (!body.area || !VALID_AREAS.includes(body.area)) {
        return reply.code(400).send({
          error: {
            code: "BAD_REQUEST",
            message: `area must be one of: ${VALID_AREAS.join(", ")}`,
          },
        });
      }
      if (typeof body.paused !== "boolean") {
        return reply.code(400).send({
          error: { code: "BAD_REQUEST", message: "paused must be a boolean" },
        });
      }

      // Defense-in-depth: if the repo is not wired (should never happen in prod
      // after C1/C2 fixes), return 503 rather than silently succeed with no effect.
      if (!killSwitchRepo) {
        return reply.code(503).send({
          error: {
            code: "KILLSWITCH_UNAVAILABLE",
            message: "Kill-switch DB store is not available — restart the server",
          },
        });
      }

      await killSwitchRepo.setFlag(body.area, body.paused);
      // Flush cache so isPausedAsync sees the new value immediately.
      flushKillSwitchCache();

      return reply.code(200).send({
        data: { area: body.area, paused: body.paused },
      });
    },
  );

  // GET /v1/admin/killswitch — read current state of all flags
  app.get(
    "/v1/admin/killswitch",
    { preHandler: adminAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const k = req.apiKey!;
      if (!rateLimiter.check("admin", k.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }

      // Combine DB state (if repo wired) with env + in-memory flags.
      const flags: Record<KillswitchArea, { paused: boolean; source: string }> = {
        invoices: { paused: false, source: "none" },
        watcher:  { paused: false, source: "none" },
        webhooks: { paused: false, source: "none" },
      };

      for (const area of VALID_AREAS) {
        const paused = await isPausedAsync(area);
        flags[area] = { paused, source: paused ? "active" : "none" };
      }

      return reply.code(200).send({ data: flags });
    },
  );
}
