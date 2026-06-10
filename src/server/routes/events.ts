/**
 * Event routes (spec §4.1).
 *
 * POST /v1/events  — merchant+ — create event (tenant-scoped, see below)
 * GET  /v1/events  — readonly+ — list events (tenant-scoped)
 * GET  /v1/events/:id — readonly+ — get event by id (tenant-scoped)
 *
 * Tenancy (multi-merchant isolation):
 *   - Events created via a merchant key inherit that key's merchantId.
 *   - Admin keys may pass an explicit merchantId to create an event for a
 *     tenant (default: null = legacy default tenant).
 *   - Non-admin reads only see events of the caller's tenant; a legacy key
 *     (merchantId = null) sees only null-tenant events.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { EventRepository, AddressValidator } from "../../core/ports.js";
import { createEvent, EventValidationError } from "../../core/events.js";
import type { RateLimiter } from "../../lib/rate-limit.js";
import { requireScope, tenantOf, matchesTenant } from "../auth.js";
import type { ApiKeyRepository } from "../auth.js";

interface EventRouteOpts {
  eventRepo: EventRepository & {
    list?: (filter?: { merchantId?: string | null }) => Promise<import("../../core/ports.js").EventRow[]>;
  };
  addressValidator: AddressValidator;
  apiKeyRepo: ApiKeyRepository;
  rateLimiter: RateLimiter;
}

interface CreateEventBody {
  name: string;
  mainWalletAddress: string;
  derivationAccount: number;
  xpubAccount: string;
  /** Explicit tenant for the new event (admin; merchants may only echo their own). */
  merchantId?: string | null;
}

/** Tenant id format: 1-64 chars of [A-Za-z0-9_-]. */
const MERCHANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function registerEventRoutes(
  app: FastifyInstance,
  opts: EventRouteOpts,
): Promise<void> {
  const { eventRepo, addressValidator, apiKeyRepo, rateLimiter } = opts;
  const merchantAuth = requireScope("merchant", apiKeyRepo);
  // Read-only endpoints accept readonly, merchant, and admin keys.
  const readonlyAuth = requireScope("readonly", apiKeyRepo);

  // POST /v1/events — merchant+ (merchant keys create events in their own tenant)
  app.post(
    "/v1/events",
    { preHandler: merchantAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Rate limit: admin bucket
      const key = req.apiKey!;
      if (!rateLimiter.check("admin", key.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }

      const body = req.body as CreateEventBody;
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "Invalid request body" } });
      }

      // Tenancy: merchant keys always create events in their own tenant;
      // admin keys may pass an explicit merchantId (validated).
      let merchantId: string | null;
      if (key.scope === "admin") {
        if (body.merchantId !== undefined && body.merchantId !== null) {
          if (typeof body.merchantId !== "string" || !MERCHANT_ID_RE.test(body.merchantId)) {
            return reply.code(400).send({
              error: { code: "INVALID_MERCHANT_ID", message: "merchantId must be 1-64 characters of [A-Za-z0-9_-]" },
            });
          }
          merchantId = body.merchantId;
        } else {
          merchantId = null;
        }
      } else {
        // Merchant key: an explicit merchantId differing from the key's own
        // tenant is a cross-tenant write attempt.
        if (
          body.merchantId !== undefined &&
          body.merchantId !== null &&
          body.merchantId !== key.merchantId
        ) {
          return reply.code(403).send({
            error: { code: "FORBIDDEN", message: "Cannot create an event for another tenant" },
          });
        }
        merchantId = key.merchantId;
      }

      try {
        const event = await createEvent(
          {
            name: body.name,
            mainWalletAddress: body.mainWalletAddress,
            derivationAccount: body.derivationAccount,
            xpubAccount: body.xpubAccount,
            merchantId,
          },
          { eventRepo, addressValidator },
        );
        return reply.code(201).send({ data: event });
      } catch (err) {
        if (err instanceof EventValidationError) {
          return reply.code(422).send({ error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  // GET /v1/events — readonly+ (agent-facing read)
  app.get(
    "/v1/events",
    { preHandler: readonlyAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const key = req.apiKey!;
      if (!rateLimiter.check("admin", key.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }
      // Tenant scoping: admin (tenant === undefined) sees all events.
      const tenant = tenantOf(key);
      const list =
        typeof eventRepo.list === "function"
          ? await eventRepo.list(tenant === undefined ? undefined : { merchantId: tenant })
          : [];
      return reply.code(200).send({ data: list });
    },
  );

  // GET /v1/events/:id — readonly+ (agent-facing read)
  app.get(
    "/v1/events/:id",
    { preHandler: readonlyAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const key = req.apiKey!;
      if (!rateLimiter.check("admin", key.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }
      const { id } = req.params as { id: string };
      const event = await eventRepo.findById(id);
      // Tenant check: 404 (not 403) for cross-tenant reads to avoid leaking
      // resource existence to other tenants.
      if (!event || !matchesTenant(tenantOf(key), event.merchantId)) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Event "${id}" not found` } });
      }
      return reply.code(200).send({ data: event });
    },
  );
}
