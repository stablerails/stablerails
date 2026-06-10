/**
 * API key management routes (spec §4.4).
 *
 * POST   /v1/api-keys       admin OR session — create key (raw shown once)
 * GET    /v1/api-keys       admin — list keys (prefix + scope only)
 * DELETE /v1/api-keys/:id   admin — revoke key
 *
 * First-run bootstrap (M2): POST /v1/api-keys also accepts a valid operator
 * session cookie. This lets a freshly-deployed operator create their first
 * admin key via the browser-based login → /api-keys flow WITHOUT already
 * having a Bearer admin key (chicken-and-egg). Bearer-admin continues to work.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { EventRepository } from "../../core/ports.js";
import type { RateLimiter } from "../../lib/rate-limit.js";
import {
  requireScope,
  generateRawKey,
  hashApiKey,
  extractPrefix,
  InMemorySessionStore,
  SESSION_COOKIE_NAME,
} from "../auth.js";
import type { ApiKeyRepository, ApiKeyScope } from "../auth.js";

interface ApiKeysRouteOpts {
  apiKeyRepo: ApiKeyRepository;
  eventRepo: EventRepository;
  rateLimiter: RateLimiter;
  /** Session store — allows POST /v1/api-keys via operator session cookie. */
  sessionStore?: InMemorySessionStore;
}

interface CreateApiKeyBody {
  label: string;
  scope: ApiKeyScope;
  eventId?: string;
  /**
   * Optional tenant binding for merchant/readonly keys (multi-merchant
   * isolation). Rejected for admin keys — admin sees everything, a tenant
   * binding on an admin key would be misleading.
   */
  merchantId?: string | null;
}

function isPrismaMissingRowError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "P2025";
}

/** Tenant id format: 1-64 chars of [A-Za-z0-9_-]. */
const MERCHANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function registerApiKeyRoutes(
  app: FastifyInstance,
  opts: ApiKeysRouteOpts,
): Promise<void> {
  const { apiKeyRepo, eventRepo, rateLimiter, sessionStore } = opts;
  const adminAuth = requireScope("admin", apiKeyRepo);
  // Read-only endpoints accept readonly, merchant, and admin keys.
  const readonlyAuth = requireScope("readonly", apiKeyRepo);

  // ── Helper: check operator session cookie ─────────────────────────────────
  // Returns the sessionId string if a valid session cookie is present, or null.
  function extractSession(req: FastifyRequest): string | null {
    if (!sessionStore) return null;
    const cookieHeader = req.headers["cookie"] ?? "";
    const sid = cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.slice(SESSION_COOKIE_NAME.length + 1);
    if (!sid) return null;
    return sessionStore.get(sid) ? sid : null;
  }

  // POST /v1/api-keys — admin Bearer OR valid operator session cookie.
  // The session path enables first-run bootstrap: a logged-in operator can
  // mint their first admin key even when no admin Bearer key exists yet.
  app.post(
    "/v1/api-keys",
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Try session auth first (cheaper — no DB hash lookup).
      const sessionId = extractSession(req);
      if (!sessionId) {
        // Fall back to admin Bearer auth.
        await adminAuth(req, reply);
        // If adminAuth sent a 401/403, req.apiKey will be absent — stop here.
        if (!req.apiKey) return;
      }

      // Rate limiting — use a stable key for both auth paths.
      // Use the actual session id (prefixed) so different sessions get independent
      // buckets; the constant "session" string collapsed all sessions into one bucket.
      const limitKey = req.apiKey ? req.apiKey.prefix : `session:${sessionId}`;
      if (!rateLimiter.check("admin", limitKey)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }

      const body = req.body as CreateApiKeyBody;
      if (!body?.label || !body?.scope) {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "label and scope are required" } });
      }
      if (body.scope !== "admin" && body.scope !== "merchant" && body.scope !== "readonly") {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: 'scope must be "admin", "merchant", or "readonly"' } });
      }
      if (body.eventId) {
        const event = await eventRepo.findById(body.eventId);
        if (!event) {
          return reply.code(404).send({
            error: { code: "EVENT_NOT_FOUND", message: `Event "${body.eventId}" not found` },
          });
        }
      }

      // Optional tenant binding (multi-merchant isolation).
      let merchantId: string | null = null;
      if (body.merchantId !== undefined && body.merchantId !== null) {
        if (typeof body.merchantId !== "string" || !MERCHANT_ID_RE.test(body.merchantId)) {
          return reply.code(400).send({
            error: { code: "BAD_REQUEST", message: "merchantId must be 1-64 characters of [A-Za-z0-9_-]" },
          });
        }
        if (body.scope === "admin") {
          // Admin keys ignore tenancy — rejecting is cleaner than silently dropping.
          return reply.code(400).send({
            error: { code: "BAD_REQUEST", message: "admin keys cannot be bound to a merchantId" },
          });
        }
        merchantId = body.merchantId;
      }

      const raw = generateRawKey();
      const hashed = hashApiKey(raw);
      const prefix = extractPrefix(raw);

      const record = await apiKeyRepo.insert({
        label: body.label,
        hashedKey: hashed,
        prefix,
        scope: body.scope,
        eventId: body.eventId ?? null,
        merchantId,
      });

      // Raw key shown ONCE only.
      return reply.code(201).send({
        data: {
          id: record.id,
          label: record.label,
          scope: record.scope,
          eventId: record.eventId,
          prefix: record.prefix,
          merchantId: record.merchantId ?? null,
          rawKey: raw, // SHOWN ONCE
          createdAt: record.createdAt,
        },
      });
    },
  );

  // GET /v1/api-keys — readonly+ (agent-facing read, metadata only — raw keys never exposed)
  app.get(
    "/v1/api-keys",
    { preHandler: readonlyAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const k = req.apiKey!;
      if (!rateLimiter.check("admin", k.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }
      const list = await apiKeyRepo.list();
      // Never expose hashedKey.
      const sanitized = list.map(({ id, label, prefix, scope, eventId, merchantId, createdAt, revokedAt }) => ({
        id,
        label,
        prefix,
        scope,
        eventId,
        merchantId: merchantId ?? null,
        createdAt,
        revokedAt,
      }));
      return reply.code(200).send({ data: sanitized });
    },
  );

  // DELETE /v1/api-keys/:id
  app.delete(
    "/v1/api-keys/:id",
    { preHandler: adminAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const k = req.apiKey!;
      if (!rateLimiter.check("admin", k.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }
      const { id } = req.params as { id: string };
      let revoked;
      try {
        revoked = await apiKeyRepo.revoke(id);
      } catch (err) {
        if (isPrismaMissingRowError(err)) {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: `API key "${id}" not found` } });
        }
        throw err;
      }
      if (!revoked) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: `API key "${id}" not found` } });
      }
      return reply.code(204).send();
    },
  );
}
