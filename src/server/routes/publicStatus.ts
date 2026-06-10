/**
 * Public status routes (spec §4.5).
 *
 * GET /v1/public/invoices/:id — sanitized invoice status for checkout page polling
 * GET /pay/:invoiceId         — checkout page (HTML, server-rendered)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { InvoiceRepository } from "../../core/ports.js";
import type { RateLimiter } from "../../lib/rate-limit.js";
import { renderCheckout } from "../checkout.js";

interface PublicStatusRouteOpts {
  invoiceRepo: InvoiceRepository;
  rateLimiter: RateLimiter;
}

/**
 * CSP for static inline-HTML error pages (defense-in-depth).
 * These pages contain no scripts, styles, images or other subresources,
 * so everything is locked down — no nonce machinery needed.
 */
const STATIC_ERROR_PAGE_CSP = "default-src 'none'";

/** Sanitized invoice fields returned to the public. */
interface PublicInvoice {
  id: string;
  status: string;
  amountUsdt: string;
  depositAddress: string;
  expiresAt: string;
  network: string;
  paidAt: string | null;
}

function sanitize(inv: import("../../core/ports.js").InvoiceRow): PublicInvoice {
  return {
    id: inv.id,
    status: inv.status,
    amountUsdt: inv.amountUsdt,
    depositAddress: inv.depositAddress,
    expiresAt: inv.expiresAt.toISOString(),
    network: inv.network,
    paidAt: inv.paidAt ? inv.paidAt.toISOString() : null,
  };
}

/**
 * Plausible invoice-id shape gate. Invoice ids are cuids (~25 chars, [a-z0-9]).
 * Reject anything that cannot be a real id BEFORE it reaches the rate limiter,
 * so an attacker cannot (a) feed multi-KB URL params as limiter keys nor
 * (b) explode the limiter's key space with arbitrary junk. ≤40 chars, id charset.
 */
const PLAUSIBLE_INVOICE_ID = /^[A-Za-z0-9_-]{1,40}$/;

export async function registerPublicStatusRoutes(
  app: FastifyInstance,
  opts: PublicStatusRouteOpts,
): Promise<void> {
  const { invoiceRepo, rateLimiter } = opts;

  // GET /v1/public/invoices/:id — JSON status for polling
  app.get(
    "/v1/public/invoices/:id",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };

      // Reject implausible ids before the limiter (bounds its key space — see
      // PLAUSIBLE_INVOICE_ID). Same 404 as a real miss; no existence signal.
      if (!PLAUSIBLE_INVOICE_ID.test(id)) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Invoice not found" } });
      }

      // Payer privacy: rate-limit by INVOICE ID, never by client IP. Payer-facing
      // routes must not read, store, or log payer network identifiers.
      // Trade-off: per-invoice keying means one hostile payer can exhaust another
      // payer's polling budget for the SAME invoice only — acceptable; cross-invoice
      // DoS is bounded by invoice count. (XFF forging is also moot: the key is
      // server-side data, not anything the client controls beyond the URL.)
      if (!rateLimiter.check("public_status", id)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }

      const invoice = await invoiceRepo.findById(id);
      if (!invoice) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Invoice not found" } });
      }

      return reply.code(200).send({ data: sanitize(invoice) });
    },
  );

  // GET /pay/:invoiceId — checkout page with CSP nonce for inline <script>.
  // The checkout page fetches /v1/public/invoices/:id (same-origin) for status polling.
  app.get(
    "/pay/:invoiceId",
    {
      config: {
        helmet: {
          enableCSPNonces: true,
          contentSecurityPolicy: {
            directives: {
              "default-src": ["'self'"],
              // style-src: nonce injected by @fastify/helmet (enableCSPNonces). The nonce is
              // applied to the <style> tag in renderCheckout — 'unsafe-inline' is NOT listed
              // because a nonce in style-src makes 'unsafe-inline' ineffective per CSP spec.
              "style-src": ["'self'"],
              // script-src nonce injected by @fastify/helmet for the inline polling script.
              "script-src": ["'self'"],
              // connect-src allows the client JS to poll /v1/public/invoices/:id
              "connect-src": ["'self'"],
              // img-src allows inline SVG QR code (data: URI)
              "img-src": ["'self'", "data:"],
              "frame-ancestors": ["'none'"],
            },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { invoiceId } = req.params as { invoiceId: string };

      // Reject implausible ids before the limiter (bounds its key space).
      if (!PLAUSIBLE_INVOICE_ID.test(invoiceId)) {
        return reply
          .code(404)
          .header("Content-Type", "text/html; charset=utf-8")
          .header("Content-Security-Policy", STATIC_ERROR_PAGE_CSP)
          .send("<html><body><h1>Счёт не найден</h1></body></html>");
      }

      // Rate-limit the checkout page using the same bucket as JSON status polling.
      // Payer privacy: keyed by INVOICE ID, never by client IP (see the polling
      // route above for the trade-off; one hostile payer can only starve the
      // budget of the SAME invoice, cross-invoice DoS is bounded by invoice count).
      if (!rateLimiter.check("public_status", invoiceId)) {
        return reply
          .code(429)
          .header("Content-Type", "text/html; charset=utf-8")
          .header("Content-Security-Policy", STATIC_ERROR_PAGE_CSP)
          .send("<html><body><h1>Слишком много запросов</h1></body></html>");
      }

      const invoice = await invoiceRepo.findById(invoiceId);
      if (!invoice) {
        return reply
          .code(404)
          .header("Content-Type", "text/html; charset=utf-8")
          .header("Content-Security-Policy", STATIC_ERROR_PAGE_CSP)
          .send("<html><body><h1>Счёт не найден</h1></body></html>");
      }

      // Pass both the script and style nonces so the inline <script> and <style> are
      // allowed by the browser. @fastify/helmet sets reply.cspNonce.{script,style}
      // when enableCSPNonces is true; a nonce in style-src makes 'unsafe-inline' void.
      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;
      const scriptNonce = cspNonce?.script;
      const styleNonce = cspNonce?.style;
      const html = await renderCheckout(invoice, scriptNonce, styleNonce);
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(html);
    },
  );
}
