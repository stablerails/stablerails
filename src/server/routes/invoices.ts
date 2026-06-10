/**
 * Invoice routes (spec §4.2).
 *
 * POST   /v1/invoices               merchant — create invoice (+ Idempotency-Key)
 * GET    /v1/invoices               merchant — list invoices (eventId, status, q, metadata)
 * GET    /v1/invoices/:id           merchant — get invoice + payments + confirmations
 * POST   /v1/invoices/:id/cancel    merchant — cancel pending invoice
 */

import { createHash } from "crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { EventRepository, InvoiceRepository, InvoiceRow, InvoiceStatus, DepositAddressDeriver, Clock } from "../../core/ports.js";
import { createInvoice, cancelInvoiceById, InvoiceValidationError, LifecycleError } from "../../core/invoices.js";
import type { RateConfig } from "../../core/pricing.js";
import type { RateLimiter } from "../../lib/rate-limit.js";
import { requireScope, tenantOf, matchesTenant } from "../auth.js";
import type { ApiKeyRepository } from "../auth.js";
import { isPausedAsync } from "../killswitch.js";

// ── Idempotency store ─────────────────────────────────────────────────────────

interface IdempotencyEntry {
  statusCode: number;
  body: unknown;
  bodyHash: string;
  expiresAt: number;
}

// Idempotency store keyed by `${apiKeyId}:${idempotencyKey}` to prevent
// cross-merchant collision/poisoning.
export const idempotencyStore = new Map<string, IdempotencyEntry>();

export interface InvoiceIdempotencyRecord {
  state: "processing" | "completed";
  requestHash: string;
  statusCode: number | null;
  responseBody: unknown | null;
  expiresAt: Date;
  processingExpiresAt: Date | null;
}

export type InvoiceIdempotencyReservation =
  | { kind: "reserved"; record: InvoiceIdempotencyRecord }
  | { kind: "processing"; record: InvoiceIdempotencyRecord }
  | { kind: "completed"; record: InvoiceIdempotencyRecord }
  | { kind: "conflict"; record: InvoiceIdempotencyRecord };

interface CompleteInvoiceIdempotencyInput {
  apiKeyId: string | null;
  scopeKey: string;
  idempotencyKey: string;
  requestHash: string;
  statusCode: number;
  responseBody: unknown;
  expiresAt: Date;
}

export interface InvoiceIdempotencyRepository {
  reserve(input: {
    apiKeyId: string | null;
    scopeKey: string;
    idempotencyKey: string;
    requestHash: string;
    expiresAt: Date;
    processingExpiresAt: Date;
  }): Promise<InvoiceIdempotencyReservation>;
  findValid(
    scopeKey: string,
    idempotencyKey: string,
    now: Date,
  ): Promise<InvoiceIdempotencyRecord | null>;
  complete(input: CompleteInvoiceIdempotencyInput): Promise<void>;
  deleteExpired(now: Date): Promise<void>;
}

// Maximum invoice TTL: 24 hours in minutes.
const MAX_TTL_MINUTES = 1440;
// Maximum idempotency cache retention: 24 hours in ms (independent of invoice TTL).
const MAX_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Prune expired entries from idempotencyStore.
 * Called opportunistically on every write to prevent unbounded memory growth
 * from merchants sending many unique Idempotency-Key values.
 */
function pruneExpiredIdempotencyEntries(): void {
  const now = Date.now();
  for (const [key, entry] of idempotencyStore) {
    if (now > entry.expiresAt) {
      idempotencyStore.delete(key);
    }
  }
}

// Canonical (sorted-key) stringify so reordered JSON bodies don't spuriously 409.
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value ?? null);
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = (value as Record<string, unknown>)[k];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

function bodyFingerprint(body: unknown): string {
  return canonicalStringify(body);
}

function requestHash(body: unknown): string {
  return createHash("sha256").update(bodyFingerprint(body)).digest("hex");
}

function jsonCacheBody(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body)) as unknown;
}

function completedIdempotencyResponse(record: InvoiceIdempotencyRecord): {
  statusCode: number;
  responseBody: unknown;
} | null {
  if (record.state !== "completed" || record.statusCode === null) return null;
  return { statusCode: record.statusCode, responseBody: record.responseBody };
}

async function waitForCompletedIdempotency(
  repo: InvoiceIdempotencyRepository,
  scopeKey: string,
  idempotencyKey: string,
  requestHashValue: string,
  now: () => Date,
): Promise<InvoiceIdempotencyRecord | null> {
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const record = await repo.findValid(scopeKey, idempotencyKey, now());
    if (!record) return null;
    if (record.requestHash !== requestHashValue) return record;
    if (record.state === "completed") return record;
  }
  return null;
}

interface CreateInvoiceBody {
  eventId: string;
  priceFiat: string;
  fiatCurrency: string;
  metadata?: Record<string, unknown>;
  /** Preferred field name (implemented). */
  ttlMinutes?: number;
  /**
   * Spec §4 alias for ttlMinutes (1 min = 60s).
   * When both are supplied, ttlMinutes takes precedence.
   * Accepted to close the spec-vs-implementation drift (L1).
   */
  expiresInSeconds?: number;
}

interface InvoiceRouteOpts {
  eventRepo: EventRepository;
  invoiceRepo: InvoiceRepository & {
    list?: (opts: {
      eventId?: string;
      status?: InvoiceStatus;
      q?: string;
      metadata?: Record<string, string>;
      cursor?: string;
      limit?: number;
      merchantId?: string | null;
    }) => Promise<InvoiceRow[]>;
  };
  deriver: DepositAddressDeriver;
  clock: Clock;
  getRateConfig: () => RateConfig;
  apiKeyRepo: ApiKeyRepository;
  rateLimiter: RateLimiter;
  invoiceIdempotencyRepo?: InvoiceIdempotencyRepository;
  /** PUBLIC_BASE_URL for hosted checkout links (e.g. "https://pay.example.com"). */
  publicBaseUrl?: string;
  /** Optional: head block number for confirmations calc (injected, defaults to 0n). */
  getHeadBlockNumber?: () => bigint;
}

/** Build the hosted checkout URL for an invoice. */
function hostedUrl(baseUrl: string, invoiceId: string): string {
  return `${baseUrl}/pay/${invoiceId}`;
}

function isEventAllowed(key: { eventId: string | null }, eventId: string): boolean {
  return key.eventId === null || key.eventId === eventId;
}

function forbiddenEventBody(eventId: string): { error: { code: string; message: string } } {
  return {
    error: {
      code: "EVENT_FORBIDDEN",
      message: `API key is not allowed to access event "${eventId}"`,
    },
  };
}

export async function registerInvoiceRoutes(
  app: FastifyInstance,
  opts: InvoiceRouteOpts,
): Promise<void> {
  const {
    eventRepo,
    invoiceRepo,
    deriver,
    clock,
    getRateConfig,
    apiKeyRepo,
    rateLimiter,
    invoiceIdempotencyRepo,
    getHeadBlockNumber,
    publicBaseUrl = process.env["PUBLIC_BASE_URL"] ?? "http://localhost:3000",
  } = opts;

  const merchantAuth = requireScope("merchant", apiKeyRepo);
  // Read-only endpoints accept readonly, merchant, and admin keys.
  const readonlyAuth = requireScope("readonly", apiKeyRepo);

  // POST /v1/invoices — with Idempotency-Key support
  app.post(
    "/v1/invoices",
    { preHandler: merchantAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const key = req.apiKey!;

      // Kill-switch: pause invoice creation (async — consults DB-backed shared store).
      if (await isPausedAsync("invoices")) {
        return reply.code(503).send({
          error: { code: "SERVICE_PAUSED", message: "Invoice creation is temporarily paused" },
        });
      }

      if (!rateLimiter.check("invoice_create", key.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }

      const idempotencyKey = req.headers["idempotency-key"] as string | undefined;
      const body = req.body as CreateInvoiceBody;
      const idempotencyScopeKey = `api:${key.id}`;
      const incomingRequestHash = requestHash(body);

      if (body?.eventId && !isEventAllowed(key, body.eventId)) {
        return reply.code(403).send(forbiddenEventBody(body.eventId));
      }

      // Tenancy (BOLA fix): a non-admin key may only create invoices for
      // events of its own tenant. Cross-tenant attempts return the same 404
      // EVENT_NOT_FOUND as a nonexistent event — no existence leak.
      const tenant = tenantOf(key);
      if (tenant !== undefined && body?.eventId) {
        const targetEvent = await eventRepo.findById(body.eventId);
        if (targetEvent && !matchesTenant(tenant, targetEvent.merchantId)) {
          return reply.code(404).send({
            error: { code: "EVENT_NOT_FOUND", message: `Event "${body.eventId}" not found` },
          });
        }
      }

      const rate = getRateConfig();

      // SEC-2: Validate TTL before use — reject out-of-range values at the route boundary.
      // This prevents an unbounded ttlMinutes from inflating idempotency cache retention.
      // ttlMinutes takes precedence; expiresInSeconds is the spec §4 alias (÷60, rounded up).
      let ttlMinutes: number;
      if (typeof body?.ttlMinutes !== "undefined") {
        if (
          typeof body.ttlMinutes !== "number" ||
          !Number.isFinite(body.ttlMinutes) ||
          !Number.isInteger(body.ttlMinutes) ||
          body.ttlMinutes < 1 ||
          body.ttlMinutes > MAX_TTL_MINUTES
        ) {
          return reply.code(400).send({
            error: {
              code: "TTL_OUT_OF_RANGE",
              message: `ttlMinutes must be an integer between 1 and ${MAX_TTL_MINUTES}`,
            },
          });
        }
        ttlMinutes = body.ttlMinutes;
      } else if (typeof body?.expiresInSeconds !== "undefined") {
        if (
          typeof body.expiresInSeconds !== "number" ||
          !Number.isFinite(body.expiresInSeconds) ||
          body.expiresInSeconds <= 0 ||
          body.expiresInSeconds > MAX_TTL_MINUTES * 60
        ) {
          return reply.code(400).send({
            error: {
              code: "TTL_OUT_OF_RANGE",
              message: `expiresInSeconds must be between 1 and ${MAX_TTL_MINUTES * 60}`,
            },
          });
        }
        ttlMinutes = Math.max(1, Math.ceil(body.expiresInSeconds / 60));
      } else {
        ttlMinutes = 30;
      }

      const ttlMs = Math.min(ttlMinutes * 60_000, MAX_IDEMPOTENCY_TTL_MS);

      // Idempotency check/reservation — scoped per API key to prevent
      // cross-merchant poisoning. The DB-backed path reserves before create so
      // only the reservation owner can call createInvoice.
      if (idempotencyKey) {
        if (invoiceIdempotencyRepo) {
          const now = clock.now();
          const expiresAt = new Date(now.getTime() + ttlMs);
          await invoiceIdempotencyRepo.deleteExpired(now);
          const reservation = await invoiceIdempotencyRepo.reserve({
            apiKeyId: key.id,
            scopeKey: idempotencyScopeKey,
            idempotencyKey,
            requestHash: incomingRequestHash,
            expiresAt,
            processingExpiresAt: new Date(now.getTime() + 30_000),
          });

          if (reservation.kind === "conflict" || reservation.record.requestHash !== incomingRequestHash) {
            return reply.code(409).send({
              error: {
                code: "IDEMPOTENCY_CONFLICT",
                message: "Idempotency-Key was already used with a different request body",
              },
            });
          }

          if (reservation.kind === "completed") {
            const cached = completedIdempotencyResponse(reservation.record);
            if (cached) return reply.code(cached.statusCode).send(cached.responseBody);
          }

          if (reservation.kind === "processing") {
            const completed = await waitForCompletedIdempotency(
              invoiceIdempotencyRepo,
              idempotencyScopeKey,
              idempotencyKey,
              incomingRequestHash,
              () => clock.now(),
            );
            if (completed?.requestHash !== incomingRequestHash) {
              return reply.code(409).send({
                error: {
                  code: "IDEMPOTENCY_CONFLICT",
                  message: "Idempotency-Key was already used with a different request body",
                },
              });
            }
            const cached = completed ? completedIdempotencyResponse(completed) : null;
            if (cached) return reply.code(cached.statusCode).send(cached.responseBody);
            return reply.code(425).send({
              error: {
                code: "IDEMPOTENCY_IN_PROGRESS",
                message: "Idempotency-Key is currently processing",
              },
            });
          }
        } else {
          const storeKey = `${key.id}:${idempotencyKey}`;
          const existing = idempotencyStore.get(storeKey);
          if (existing) {
            if (Date.now() > existing.expiresAt) {
              idempotencyStore.delete(storeKey);
            } else {
              const incomingFingerprint = bodyFingerprint(body);
              if (existing.bodyHash !== incomingFingerprint) {
                return reply.code(409).send({
                  error: {
                    code: "IDEMPOTENCY_CONFLICT",
                    message: "Idempotency-Key was already used with a different request body",
                  },
                });
              }
              return reply.code(existing.statusCode).send(existing.body);
            }
          }
        }
      }

      let statusCode = 201;
      let responseBody: unknown;

      try {
        const invoice = await createInvoice(
          {
            eventId: body.eventId,
            priceFiat: body.priceFiat,
            fiatCurrency: body.fiatCurrency,
            metadata: body.metadata ?? null,
            ttlMinutes,
          },
          { invoiceRepo, eventRepo, deriver, clock, rate },
        );
        statusCode = 201;
        responseBody = {
          data: {
            ...invoice,
            hostedUrl: hostedUrl(publicBaseUrl, invoice.id),
          },
        };
      } catch (err) {
        if (err instanceof InvoiceValidationError) {
          if (err.code === "EVENT_NOT_FOUND") {
            statusCode = 404;
          } else if (err.code === "AMOUNT_TOO_SMALL") {
            // Minimum amount violation is a client input error → 400.
            statusCode = 400;
          } else {
            statusCode = 422;
          }
          responseBody = { error: { code: err.code, message: err.message } };
        } else if (err instanceof RangeError || err instanceof TypeError) {
          statusCode = 422;
          responseBody = { error: { code: "VALIDATION_ERROR", message: (err as Error).message } };
        } else {
          throw err;
        }
      }

      // Store idempotency entry, capped at MAX_IDEMPOTENCY_TTL_MS regardless of invoice TTL.
      // Prune expired entries opportunistically on each write to prevent memory DoS
      // from merchants sending many unique Idempotency-Key values.
      if (idempotencyKey) {
        if (invoiceIdempotencyRepo) {
          const now = clock.now();
          await invoiceIdempotencyRepo.complete({
            apiKeyId: key.id,
            scopeKey: idempotencyScopeKey,
            idempotencyKey,
            requestHash: incomingRequestHash,
            statusCode,
            responseBody: jsonCacheBody(responseBody),
            expiresAt: new Date(now.getTime() + ttlMs),
          });
        } else {
          pruneExpiredIdempotencyEntries();
          const storeKey = `${key.id}:${idempotencyKey}`;
          idempotencyStore.set(storeKey, {
            statusCode,
            body: responseBody,
            bodyHash: bodyFingerprint(body),
            expiresAt: Date.now() + ttlMs,
          });
        }
      }

      return reply.code(statusCode).send(responseBody);
    },
  );

  // GET /v1/invoices — list (readonly+ agent-facing read)
  app.get(
    "/v1/invoices",
    { preHandler: readonlyAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const key = req.apiKey!;
      // Merchant reads use their own bucket — don't consume admin quota.
      if (!rateLimiter.check("merchant_read", key.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }
      const qs = req.query as Record<string, string>;

      // Clamp + validate limit: NaN/missing → default 20, floor 1, cap 100.
      let limit = 20;
      if (qs["limit"] !== undefined) {
        const parsed = parseInt(qs["limit"], 10);
        if (!Number.isNaN(parsed)) {
          limit = Math.max(1, Math.min(100, parsed));
        }
        // If NaN just keep default (20)
      }

      // Parse metadata.<key>=<value> filter params (injection-safe: typed JSON path).
      const metadataFilters: Record<string, string> = {};
      for (const [k, v] of Object.entries(qs)) {
        const match = /^metadata\.([^=]+)$/.exec(k);
        if (match && typeof v === "string") {
          const fieldKey = match[1];
          if (fieldKey) metadataFilters[fieldKey] = v;
        }
      }

      if (key.eventId && qs["eventId"] && qs["eventId"] !== key.eventId) {
        return reply.code(403).send(forbiddenEventBody(qs["eventId"]));
      }

      const effectiveEventId = key.eventId ?? qs["eventId"];

      // Tenancy (BOLA fix): non-admin keys only see invoices whose event
      // belongs to their tenant (admin → no filter).
      const tenant = tenantOf(key);
      const list =
        typeof invoiceRepo.list === "function"
          ? await invoiceRepo.list({
              eventId: effectiveEventId,
              status: qs["status"] as InvoiceStatus | undefined,
              q: qs["q"],
              metadata: Object.keys(metadataFilters).length > 0 ? metadataFilters : undefined,
              cursor: qs["cursor"],
              limit,
              ...(tenant !== undefined ? { merchantId: tenant } : {}),
            })
          : [];
      return reply.code(200).send({ data: list });
    },
  );

  // GET /v1/invoices/:id — with payments + confirmations (readonly+ agent-facing read)
  app.get(
    "/v1/invoices/:id",
    { preHandler: readonlyAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const key = req.apiKey!;
      // Merchant reads use their own bucket.
      if (!rateLimiter.check("merchant_read", key.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }
      const { id } = req.params as { id: string };
      const result = await invoiceRepo.findWithPayments(id);
      if (!result) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Invoice "${id}" not found` } });
      }
      if (!isEventAllowed(key, result.invoice.eventId)) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Invoice "${id}" not found` } });
      }
      // Tenancy (BOLA fix): invoice tenant = its event's merchantId. Cross-tenant
      // reads return the same 404 as not-found — no existence leak.
      const tenant = tenantOf(key);
      if (tenant !== undefined) {
        const owningEvent = await eventRepo.findById(result.invoice.eventId);
        if (!matchesTenant(tenant, owningEvent?.merchantId)) {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Invoice "${id}" not found` } });
        }
      }
      const headBlock = getHeadBlockNumber ? getHeadBlockNumber() : 0n;
      const paymentsWithConf = result.payments.map((p) => ({
        ...p,
        blockNumber: p.blockNumber.toString(),
        // Clamp to 0: headBlock defaults to 0n when not wired, and even with a
        // real head source a race between a freshly-confirmed block and the
        // cached head value could produce a transient negative delta.
        confirmations:
          p.status === "confirmed" || p.status === "detected"
            ? Math.max(0, Number(headBlock - p.blockNumber))
            : 0,
      }));
      return reply.code(200).send({
        data: {
          ...result.invoice,
          hostedUrl: hostedUrl(publicBaseUrl, result.invoice.id),
          payments: paymentsWithConf,
          confirmations: paymentsWithConf.reduce(
            (max, p) => Math.max(max, p.confirmations),
            0,
          ),
        },
      });
    },
  );

  // POST /v1/invoices/:id/cancel
  app.post(
    "/v1/invoices/:id/cancel",
    { preHandler: merchantAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const key = req.apiKey!;
      // Cancel is a write on a merchant-owned resource — use merchant_read for
      // the non-admin read portion; this keeps admin quota separate.
      if (!rateLimiter.check("merchant_read", key.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }
      const { id } = req.params as { id: string };
      // Event-scoped key (main line): may only touch its own event's invoices.
      if (key.eventId) {
        const existing = await invoiceRepo.findById(id);
        if (!existing || !isEventAllowed(key, existing.eventId)) {
          return reply.code(404).send({ error: { code: "NOT_FOUND", message: `Invoice "${id}" not found` } });
        }
      }
      // Tenancy (BOLA fix): a non-admin key may only cancel invoices of its
      // own tenant. Cross-tenant attempts return the same 404 as not-found.
      const tenant = tenantOf(key);
      if (tenant !== undefined) {
        const found = await invoiceRepo.findById(id);
        if (found) {
          const owningEvent = await eventRepo.findById(found.eventId);
          if (!matchesTenant(tenant, owningEvent?.merchantId)) {
            return reply.code(404).send({
              error: { code: "INVOICE_NOT_FOUND", message: `Invoice "${id}" not found` },
            });
          }
        }
      }
      try {
        const updated = await cancelInvoiceById(id, { invoiceRepo });
        return reply.code(200).send({ data: updated });
      } catch (err) {
        if (err instanceof InvoiceValidationError) {
          return reply.code(404).send({ error: { code: err.code, message: err.message } });
        }
        if (err instanceof LifecycleError) {
          return reply.code(409).send({ error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );
}
