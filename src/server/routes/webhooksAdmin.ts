/**
 * Webhook management routes (spec §4.3).
 *
 * POST   /v1/webhooks           admin — register webhook endpoint
 * GET    /v1/webhooks           admin — list webhooks
 * DELETE /v1/webhooks/:id       admin — delete webhook
 * POST   /v1/webhooks/test      admin — send test event to endpoint
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "crypto";
import type { EventRepository } from "../../core/ports.js";
import type { RateLimiter } from "../../lib/rate-limit.js";
import { sealSecret } from "../../lib/secretBox.js";
import { assertSafeUrl, SsrfGuardError } from "../../lib/ssrf-guard.js";
import { requireScope, tenantOf, matchesTenant } from "../auth.js";
import type { ApiKeyRepository } from "../auth.js";
import { sendWithEventUid, type SendResult } from "../../workers/webhookDelivery.js";

export interface WebhookEndpointRecord {
  id: string;
  eventId: string | null;
  url: string;
  secret: string;
  active: boolean;
  createdAt: Date;
}

export interface WebhookRepository {
  insert(input: {
    eventId: string | null;
    url: string;
    secret: string;
  }): Promise<WebhookEndpointRecord>;
  list(): Promise<WebhookEndpointRecord[]>;
  findById(id: string): Promise<WebhookEndpointRecord | null>;
  delete(id: string): Promise<void>;
}

interface WebhooksRouteOpts {
  webhookRepo: WebhookRepository;
  eventRepo: EventRepository;
  apiKeyRepo: ApiKeyRepository;
  rateLimiter: RateLimiter;
  webhookTestSender?: (
    url: string,
    secret: string,
    rawBody: string,
    eventUid: string,
  ) => Promise<SendResult>;
}

interface CreateWebhookBody {
  url: string;
  eventId?: string;
  secret?: string;
}

export async function registerWebhookRoutes(
  app: FastifyInstance,
  opts: WebhooksRouteOpts,
): Promise<void> {
  const { webhookRepo, eventRepo, apiKeyRepo, rateLimiter, webhookTestSender = sendWithEventUid } = opts;
  const adminAuth = requireScope("admin", apiKeyRepo);
  // Read-only endpoints accept readonly, merchant, and admin keys.
  const readonlyAuth = requireScope("readonly", apiKeyRepo);

  // POST /v1/webhooks
  app.post(
    "/v1/webhooks",
    { preHandler: adminAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const k = req.apiKey!;
      if (!rateLimiter.check("admin", k.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }
      const body = req.body as CreateWebhookBody;
      if (!body?.url) {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "url is required" } });
      }

      // Validate the webhook URL: must be https:// and must pass SSRF pre-screen.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(body.url);
      } catch {
        return reply.code(400).send({
          error: { code: "INVALID_URL", message: "url must be a valid URL" },
        });
      }
      if (parsedUrl.protocol !== "https:") {
        return reply.code(400).send({
          error: { code: "INVALID_URL", message: "url must use https://" },
        });
      }
      try {
        // SSRF pre-screen: blocks private IPs, loopback, link-local, etc.
        await assertSafeUrl(body.url);
      } catch (e) {
        if (e instanceof SsrfGuardError) {
          return reply.code(400).send({
            error: { code: "INVALID_URL", message: `url is not allowed: ${e.message}` },
          });
        }
        throw e;
      }

      if (body.eventId) {
        const event = await eventRepo.findById(body.eventId);
        if (!event) {
          return reply.code(404).send({
            error: { code: "EVENT_NOT_FOUND", message: `Event "${body.eventId}" not found` },
          });
        }
      }

      // Caller-supplied HMAC secret must be a non-trivial string: `??` alone
      // would store an empty "" (or any weak short value) verbatim and use it
      // as the HMAC key, making signatures forgeable.
      const MIN_SECRET_LENGTH = 16;
      if (body.secret != null) {
        if (typeof body.secret !== "string" || body.secret.length < MIN_SECRET_LENGTH) {
          return reply.code(400).send({
            error: {
              code: "INVALID_SECRET",
              message: `secret must be a string of at least ${MIN_SECRET_LENGTH} characters`,
            },
          });
        }
      }
      const secret = body.secret ?? randomBytes(32).toString("hex");
      // Encrypt at rest (no-op plaintext passthrough when STABLERAILS_DATA_KEY is
      // unset). The stored value (possibly ciphertext) never leaves the server.
      const endpoint = await webhookRepo.insert({
        eventId: body.eventId ?? null,
        url: body.url,
        secret: sealSecret(secret),
      });
      // The PLAINTEXT secret is revealed exactly once — here, at creation —
      // so the caller can configure signature verification (essential for the
      // server-generated secret). It is never retrievable again: list/get/test
      // responses strip it, and the persisted form may be ciphertext.
      // Explicit field list (no `...endpoint` spread) so the stored secret
      // (ciphertext or plaintext) can never leak into the response.
      return reply.code(201).send({
        data: {
          id: endpoint.id,
          eventId: endpoint.eventId,
          url: endpoint.url,
          active: endpoint.active,
          createdAt: endpoint.createdAt,
          secret,
        },
      });
    },
  );

  // GET /v1/webhooks — readonly+ (agent-facing read), TENANT-SCOPED.
  // Endpoint tenancy is inherited through the endpoint's event (TENANT-1):
  // merchant/readonly keys see only endpoints of their own tenant; endpoints
  // with eventId = null belong to the legacy null tenant; event-scoped keys
  // see only endpoints bound to their event. Admin keys see everything.
  app.get(
    "/v1/webhooks",
    { preHandler: readonlyAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const k = req.apiKey!;
      if (!rateLimiter.check("admin", k.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }
      const list = await webhookRepo.list();
      const tenant = tenantOf(k);
      // undefined value = event missing → fail closed (endpoint stays hidden).
      const eventTenantCache = new Map<string, string | null | undefined>();
      const visible: WebhookEndpointRecord[] = [];
      for (const ep of list) {
        // Event-scoped keys are confined to endpoints of their own event.
        if (k.eventId != null && ep.eventId !== k.eventId) continue;
        if (tenant === undefined) {
          visible.push(ep); // admin
          continue;
        }
        if (ep.eventId === null) {
          // Global/legacy endpoint — belongs to the null (default) tenant.
          if (tenant === null) visible.push(ep);
          continue;
        }
        if (!eventTenantCache.has(ep.eventId)) {
          const event = await eventRepo.findById(ep.eventId);
          eventTenantCache.set(ep.eventId, event ? (event.merchantId ?? null) : undefined);
        }
        const epTenant = eventTenantCache.get(ep.eventId);
        if (epTenant !== undefined && matchesTenant(tenant, epTenant)) visible.push(ep);
      }
      // Secret is returned ONLY at create time — strip it from list responses.
      const sanitized = visible.map(({ id, eventId, url, active, createdAt }) => ({
        id,
        eventId,
        url,
        active,
        createdAt,
      }));
      return reply.code(200).send({ data: sanitized });
    },
  );

  // DELETE /v1/webhooks/:id
  app.delete(
    "/v1/webhooks/:id",
    { preHandler: adminAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const k = req.apiKey!;
      if (!rateLimiter.check("admin", k.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }
      const { id } = req.params as { id: string };
      const existing = await webhookRepo.findById(id);
      if (!existing) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Webhook "${id}" not found` } });
      }
      await webhookRepo.delete(id);
      return reply.code(204).send();
    },
  );

  // POST /v1/webhooks/test
  app.post(
    "/v1/webhooks/test",
    { preHandler: adminAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const k = req.apiKey!;
      if (!rateLimiter.check("admin", k.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }
      const body = req.body as { endpointId: string };
      if (!body?.endpointId) {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "endpointId required" } });
      }
      const endpoint = await webhookRepo.findById(body.endpointId);
      if (!endpoint) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Webhook "${body.endpointId}" not found` } });
      }
      if (!endpoint.active) {
        return reply.code(409).send({
          error: { code: "WEBHOOK_INACTIVE", message: "Webhook endpoint is inactive" },
        });
      }
      const eventUid = `webhook.test:${endpoint.id}:${Date.now()}:${randomBytes(6).toString("hex")}`;
      const rawBody = JSON.stringify({
        eventUid,
        eventType: "webhook.test",
        version: 1,
        endpointId: endpoint.id,
        test: true,
      });
      const result = await webhookTestSender(endpoint.url, endpoint.secret, rawBody, eventUid);
      return reply.code(200).send({
        data: {
          endpointId: endpoint.id,
          url: endpoint.url,
          delivered: result.ok,
          ...(result.status !== undefined && { status: result.status }),
          ...(!result.ok && { error: "Delivery failed" }),
        },
      });
    },
  );
}
