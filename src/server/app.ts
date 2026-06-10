/**
 * Fastify application factory (spec §4).
 *
 * Wires all routes with injected dependencies so that tests can pass
 * in-memory mock implementations without any real DB or network.
 *
 * Usage:
 *   const app = buildApp(deps);
 *   await app.listen({ port: 3000 });
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";

import type { EventRepository, InvoiceRepository, DepositAddressDeriver, Clock } from "../core/ports.js";
import type { RateConfig } from "../core/pricing.js";
import type { ApiKeyRepository, OperatorRepository, LoginTokenRepository } from "./auth.js";
import { InMemorySessionStore } from "./auth.js";
import type { WebhookRepository } from "./routes/webhooksAdmin.js";
import type { SweepIntentRepository } from "./routes/sweeps.js";
import type { RateLimiter } from "../lib/rate-limit.js";
import type { KillSwitchRepository } from "./killswitch-repo.js";
import { initKillSwitchRepo } from "./killswitch.js";
import type { InvoiceIdempotencyRepository } from "./routes/invoices.js";
import type { SendResult } from "../workers/webhookDelivery.js";

import { registerEventRoutes } from "./routes/events.js";
import { registerInvoiceRoutes } from "./routes/invoices.js";
import { registerWebhookRoutes } from "./routes/webhooksAdmin.js";
import { registerApiKeyRoutes } from "./routes/apiKeys.js";
import { registerPublicStatusRoutes } from "./routes/publicStatus.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerSweepRoutes } from "./routes/sweeps.js";
import { registerKillSwitchRoutes } from "./routes/killswitchAdmin.js";
import { registerDemoRoutes } from "./routes/demo.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerWebhooksUiRoutes } from "./routes/webhooks-ui.js";
import { registerCreateLinkRoutes } from "./routes/createLink.js";
import { registerLandingRoutes } from "./routes/landing.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerDocsRoutes } from "./routes/docs.js";
import { registerTermsRoutes } from "./routes/terms.js";
import { registerLlmsRoutes } from "./routes/llms.js";
import { registerOpsStatusRoutes } from "./routes/opsStatus.js";
import { isDemoEnabled } from "./utils.js";

// ── Port / dependency bundle ──────────────────────────────────────────────────

export interface AppDeps {
  /** Optional DB-backed kill-switch store (for cross-process runtime control). */
  killSwitchRepo?: KillSwitchRepository;
  eventRepo: EventRepository & {
    list?: (filter?: { merchantId?: string | null }) => Promise<import("../core/ports.js").EventRow[]>;
  };
  invoiceRepo: InvoiceRepository & {
    list?: (opts: {
      eventId?: string;
      status?: import("../core/ports.js").InvoiceStatus;
      q?: string;
      metadata?: Record<string, string>;
      cursor?: string;
      limit?: number;
      merchantId?: string | null;
    }) => Promise<import("../core/ports.js").InvoiceRow[]>;
  };
  deriver: DepositAddressDeriver;
  clock: Clock;
  getRateConfig: () => RateConfig;
  apiKeyRepo: ApiKeyRepository;
  invoiceIdempotencyRepo?: InvoiceIdempotencyRepository;
  operatorRepo: OperatorRepository;
  /** Magic-link login tokens (GET /auth/magic). Absent → magic links 403. */
  loginTokenRepo?: LoginTokenRepository;
  webhookRepo: WebhookRepository;
  /** SweepIntent repository — required for /v1/sweeps routes. */
  sweepIntentRepo: SweepIntentRepository;
  rateLimiter: RateLimiter;
  sessionStore?: InMemorySessionStore;
  getHeadBlockNumber?: () => bigint;
  /** PUBLIC_BASE_URL for hosted checkout links (e.g. "https://pay.example.com"). */
  publicBaseUrl?: string;
  /** Optional: Tron address validator (defaults to a length+prefix check). */
  addressValidator?: import("../core/ports.js").AddressValidator;
  /** Optional signed sender for POST /v1/webhooks/test (tests inject this). */
  webhookTestSender?: (
    url: string,
    secret: string,
    rawBody: string,
    eventUid: string,
  ) => Promise<SendResult>;
  /**
   * Optional URL asserter for the webhook UI register form.
   * Defaults to assertSafeUrl (real SSRF guard with DNS).
   * Tests inject a no-op to avoid real network calls.
   */
  assertUrl?: (url: string) => Promise<void>;
  /** Logger level: "silent" for tests. */
  logLevel?: "info" | "warn" | "error" | "silent" | "debug";
}

/** Minimal address validator: Tron Base58 starts with 'T' and has ~34 chars. */
const defaultAddressValidator: import("../core/ports.js").AddressValidator = {
  isValid(address: string, _network: import("../core/ports.js").Network): boolean {
    return typeof address === "string" && address.startsWith("T") && address.length >= 33 && address.length <= 36;
  },
};

// ── Payer-privacy request logging ─────────────────────────────────────────────
// Fastify's DEFAULT `req` log serializer includes `remoteAddress` on every
// auto-logged "incoming request" line. Payer-facing routes (/pay/:id,
// /v1/public/*, /demo*) must never write payer IPs to logs, so a custom
// serializer drops the address for those URLs. Operator/auth routes keep the
// address for incident forensics; AUTH-1 login rate limiting reads the socket
// directly and is unaffected by log serialization.
const PAYER_FACING_URL = /^\/(?:pay\/|v1\/public\/|demo(?:\/|\?|$))/;

interface SerializableRequest {
  method?: string;
  url?: string;
  socket?: { remoteAddress?: string; remotePort?: number };
}

/**
 * Redact single-use credentials carried in the query string before logging.
 * The magic-link token (GET /auth/magic?token=...) grants admin-equivalent
 * dashboard access; a request that fails before the token is consumed (e.g.
 * 429) would otherwise park a still-valid credential in the access log, where
 * a log reader (weaker privilege than the DB) could replay it. Redact it.
 */
function redactSensitiveQuery(url: string): string {
  return url.replace(/([?&](?:token|secret|key)=)[^&]+/gi, "$1[redacted]");
}

function serializePayerSafeRequest(req: SerializableRequest): Record<string, unknown> {
  const url = redactSensitiveQuery(req.url ?? "");
  if (PAYER_FACING_URL.test(url)) {
    // No remoteAddress / remotePort — payer network identifiers stay out of logs.
    return { method: req.method, url };
  }
  return {
    method: req.method,
    url,
    remoteAddress: req.socket?.remoteAddress,
    remotePort: req.socket?.remotePort,
  };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const {
    eventRepo,
    invoiceRepo,
    deriver,
    clock,
    getRateConfig,
    apiKeyRepo,
    invoiceIdempotencyRepo,
    operatorRepo,
    loginTokenRepo,
    webhookRepo,
    sweepIntentRepo,
    rateLimiter,
    sessionStore = new InMemorySessionStore(),
    getHeadBlockNumber,
    publicBaseUrl,
    addressValidator = defaultAddressValidator,
    webhookTestSender,
    assertUrl,
    logLevel = "info",
    killSwitchRepo,
  } = deps;

  // Wire DB-backed kill-switch repo (if provided) so isPausedAsync queries DB.
  // Must happen before routes are registered so the hot path sees the repo.
  if (killSwitchRepo) {
    initKillSwitchRepo(killSwitchRepo);
  }

  const app = Fastify({
    logger:
      logLevel === "silent"
        ? false
        : { level: logLevel, serializers: { req: serializePayerSafeRequest } },
  });

  // ── Security headers (SEC-3) ──────────────────────────────────────────────
  // Registered globally — applies to ALL routes (JSON API + HTML).
  // Per-route HTML routes override contentSecurityPolicy with nonces via
  // { helmet: { enableCSPNonces: true, contentSecurityPolicy: {...} } } config.
  //
  // Intentionally disabled:
  //   - HSTS: TLS/proxy topology is not confirmed; enabling HSTS prematurely
  //     can brick non-HTTPS environments.
  //   - Global CSP: JSON API routes don't serve HTML; applying CSP globally
  //     would bloat every response. HTML routes set their own CSP via route config.
  void app.register(helmet, {
    // Apply to all routes by default.
    global: true,
    // HSTS disabled — TLS termination topology not confirmed.
    strictTransportSecurity: false,
    // No global CSP — HTML routes configure their own per-route CSP with nonces.
    contentSecurityPolicy: false,
    // Clickjacking protection: deny all framing.
    frameguard: { action: "deny" },
    // Prevent MIME-type sniffing.
    noSniff: true,
    // Conservative referrer policy: no origin or path leaked cross-origin.
    referrerPolicy: { policy: "no-referrer" },
    // Hide server implementation details.
    hidePoweredBy: true,
    // Prevent IE from opening downloads in the site context.
    ieNoOpen: true,
    // Allow XSS auditor (legacy IE) to block.
    xssFilter: true,
  });

  // Parse JSON body.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_, body, done) => {
      try {
        const parsed = Object.fromEntries(new URLSearchParams(body as string));
        done(null, parsed);
      } catch (e) {
        done(e as Error, undefined);
      }
    },
  );

  // ── Global error handler ─────────────────────────────────────────────────
  //
  // AUTH-4: Non-500 errors from our own typed/sanitized validators carry a
  // human-readable message in err.message (set by our code). Framework errors
  // (e.g. Fastify JSON parse failure, FST_ERR_CTP_* codes) carry raw library
  // text that may leak implementation details — those get a generic message.
  //
  // Heuristic: if err.code starts with "FST_" it is a Fastify-internal error.
  // All other codes are assumed to come from our own code and carry safe messages.
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    const statusCode = err.statusCode ?? 500;
    const isFastifyInternal = typeof err.code === "string" && err.code.startsWith("FST_");
    const isServerError = statusCode >= 500;

    let message: string;
    if (isServerError) {
      message = "Internal server error";
    } else if (isFastifyInternal) {
      // Generic message keyed by code — do not expose raw library error text.
      message = "Bad request";
    } else {
      // Our own typed validation error — message is safe to surface.
      message = err.message;
    }

    reply.code(statusCode).send({
      error: {
        code: err.code ?? "INTERNAL_ERROR",
        message,
      },
    });
  });

  // ── Register routes ───────────────────────────────────────────────────────
  void registerEventRoutes(app, { eventRepo, addressValidator, apiKeyRepo, rateLimiter });
  void registerInvoiceRoutes(app, {
    eventRepo,
    invoiceRepo,
    deriver,
    clock,
    getRateConfig,
    apiKeyRepo,
    invoiceIdempotencyRepo,
    rateLimiter,
    getHeadBlockNumber,
    publicBaseUrl,
  });
  void registerWebhookRoutes(app, { webhookRepo, eventRepo, apiKeyRepo, rateLimiter, webhookTestSender });
  void registerApiKeyRoutes(app, { apiKeyRepo, eventRepo, rateLimiter, sessionStore });
  void registerPublicStatusRoutes(app, { invoiceRepo, rateLimiter });
  void registerAuthRoutes(app, { operatorRepo, sessionStore, apiKeyRepo, rateLimiter, loginTokenRepo });
  void registerSweepRoutes(app, {
    eventRepo,
    invoiceRepo,
    sweepIntentRepo,
    apiKeyRepo,
    rateLimiter,
  });
  void registerKillSwitchRoutes(app, { apiKeyRepo, rateLimiter, killSwitchRepo });
  void registerDashboardRoutes(app, { invoiceRepo, sessionStore, rateLimiter, publicBaseUrl });
  void registerWebhooksUiRoutes(app, { webhookRepo, eventRepo, sessionStore, rateLimiter, assertUrl });
  void registerCreateLinkRoutes(app, {
    eventRepo,
    invoiceRepo,
    deriver,
    clock,
    getRateConfig,
    sessionStore,
    rateLimiter,
    publicBaseUrl,
  });
  void registerOpsStatusRoutes(app, { sessionStore, rateLimiter, killSwitchRepo });
  void registerLandingRoutes(app);
  void registerMetricsRoutes(app, { invoiceRepo });
  void registerDocsRoutes(app);
  void registerTermsRoutes(app);
  registerLlmsRoutes(app);

  // ── Demo page (gated by ENABLE_DEMO=1) ───────────────────────────────────
  // Never mount in production, even if the env flag is accidentally set.
  if (isDemoEnabled()) {
    void registerDemoRoutes(app, {
      publicBaseUrl: publicBaseUrl ?? "http://localhost:3000",
    });
  }

  return app;
}
