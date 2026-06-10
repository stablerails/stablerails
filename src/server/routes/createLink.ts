/**
 * Operator "create payment link" page.
 *
 * GET  /dashboard/create-link  — form: pick event, enter fiat amount + description
 * POST /dashboard/create-link  — creates invoice via createInvoice(), shows shareable link
 *
 * Auth: session cookie gate identical to GET /dashboard.
 *
 * Invoice creation:
 *   Calls createInvoice() directly (same core function as POST /v1/invoices),
 *   with the full dependency bundle injected at startup.  The operator session
 *   gate (password-verified) replaces the API-key preHandler — it is at least as
 *   strong: the operator IS the person who mints the API keys.
 *
 * CSP: nonce-locked script-src (enableCSPNonces via @fastify/helmet).
 * No inline style= — all styles are in nonce'd <style> blocks or CSS classes.
 * All dynamic fields are HTML-escaped via esc().
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type {
  EventRepository,
  EventRow,
  InvoiceRepository,
  DepositAddressDeriver,
  Clock,
} from "../../core/ports.js";
import { createInvoice, InvoiceValidationError } from "../../core/invoices.js";
import type { CreateInvoicePorts } from "../../core/invoices.js";
import { isPausedAsync } from "../killswitch.js";

// Derive RateConfig from CreateInvoicePorts so we never import the forbidden pricing.ts.
type RateConfig = CreateInvoicePorts["rate"];
import type { InMemorySessionStore } from "../auth.js";
import { SESSION_COOKIE_NAME } from "../auth.js";
import type { RateLimiter } from "../../lib/rate-limit.js";

// ── Options ───────────────────────────────────────────────────────────────────

export interface CreateLinkRouteOpts {
  eventRepo: EventRepository & { list?: () => Promise<EventRow[]> };
  invoiceRepo: InvoiceRepository;
  deriver: DepositAddressDeriver;
  clock: Clock;
  getRateConfig: () => RateConfig;
  sessionStore: InMemorySessionStore;
  rateLimiter: RateLimiter;
  /** Base URL for public checkout links, e.g. "https://pay.example.com". */
  publicBaseUrl?: string;
}

// ── HTML escaping ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Session gate helper ───────────────────────────────────────────────────────

function extractSessionId(cookieHeader: string): string | null {
  return (
    cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.slice(SESSION_COOKIE_NAME.length + 1) ?? null
  );
}

// ── Vault CSS (shared dark theme — same tokens as dashboard.ts) ───────────────

function vaultCss(nonceAttr: string): string {
  return `<style${nonceAttr}>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      background: #06090c;
      background-image:
        radial-gradient(ellipse 90% 55% at 50% -5%, rgba(38,161,123,0.10) 0%, transparent 65%),
        radial-gradient(ellipse 55% 65% at 95% 105%, rgba(38,161,123,0.05) 0%, transparent 55%);
      color: #e2e8f0;
      min-height: 100vh;
      padding: 1.5rem 1rem 3rem;
    }
    .page-header {
      max-width: 760px; margin: 0 auto 1.25rem;
      display: flex; align-items: center; gap: .75rem;
    }
    .usdt-icon {
      width: 28px; height: 28px; background: #26A17B; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: .9rem; font-weight: 900; color: #fff; flex-shrink: 0;
      box-shadow: 0 0 12px rgba(38,161,123,.4);
    }
    h1 { font-size: 1.25rem; font-weight: 700; color: #f1f5f9; }
    .back-wrap { max-width: 760px; margin: 0 auto .75rem; }
    .back-link {
      font-size: .82rem; color: #475569; text-decoration: none;
      display: inline-flex; align-items: center; gap: .4rem;
      padding: .3rem .6rem; border-radius: .4rem;
      transition: color .15s, background .15s;
    }
    .back-link:hover { color: #94a3b8; background: rgba(255,255,255,.04); }
    .card {
      max-width: 760px; margin: 0 auto;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 16px; padding: 1.75rem 2rem;
    }
    .card-title {
      font-size: 1rem; font-weight: 700; color: #f1f5f9; margin-bottom: 1.5rem;
    }
    .field { margin-bottom: 1.25rem; }
    .field-label {
      display: block;
      font-size: .67rem; font-weight: 700; color: #475569;
      text-transform: uppercase; letter-spacing: .1em; margin-bottom: .4rem;
    }
    .field-hint {
      font-size: .72rem; color: #334155; margin-top: .3rem;
    }
    select, input[type="number"], input[type="text"] {
      width: 100%;
      padding: .7rem .875rem;
      background: rgba(0,0,0,.35);
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 10px;
      color: #f1f5f9;
      font-size: .9rem;
      font-family: inherit;
      outline: none;
      -webkit-appearance: none;
      transition: border-color .15s, background .15s;
    }
    select { cursor: pointer; }
    select:focus, input[type="number"]:focus, input[type="text"]:focus {
      border-color: rgba(38,161,123,.5);
      background: rgba(38,161,123,.04);
      box-shadow: 0 0 0 3px rgba(38,161,123,.1);
    }
    input::placeholder { color: #2d3f50; }
    .amount-wrap { position: relative; }
    .amount-prefix {
      position: absolute; left: .875rem; top: 50%; transform: translateY(-50%);
      color: #475569; font-size: .9rem; pointer-events: none; font-weight: 500;
    }
    .amount-wrap input { padding-left: 1.75rem; }
    .submit-btn {
      width: 100%; padding: .875rem 1.25rem;
      background: linear-gradient(135deg, #26A17B 0%, #1e9068 100%);
      color: #fff; border: none; border-radius: 12px;
      font-size: .95rem; font-weight: 700; font-family: inherit;
      cursor: pointer; margin-top: .5rem;
      transition: opacity .15s, transform .1s;
      box-shadow: 0 4px 16px rgba(38,161,123,.32), 0 2px 4px rgba(0,0,0,.3);
      letter-spacing: -.01em;
    }
    .submit-btn:hover { opacity: .91; }
    .submit-btn:active { transform: scale(.99); }
    .alert-error {
      background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.3);
      border-radius: 10px; padding: .75rem 1rem; margin-bottom: 1.25rem;
      color: #f87171; font-size: .85rem;
    }
    .result-section { margin-top: 2rem; }
    .result-label {
      font-size: .65rem; font-weight: 700; color: #334155;
      text-transform: uppercase; letter-spacing: .1em; margin-bottom: .5rem;
    }
    .link-card {
      background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07);
      border-radius: 14px; padding: 1.25rem 1.5rem;
    }
    .link-card-title {
      font-size: .78rem; font-weight: 700; color: #475569;
      text-transform: uppercase; letter-spacing: .09em; margin-bottom: .75rem;
    }
    .link-url {
      font-family: "SFMono-Regular","SF Mono",Consolas,"Liberation Mono",monospace;
      font-size: .78rem; color: #7dd3fc; word-break: break-all; line-height: 1.6;
    }
    .copy-link-btn {
      background: none; border: none; cursor: pointer; color: #475569;
      padding: .2rem .45rem; border-radius: 4px; font-size: .8rem;
      margin-left: .4rem; vertical-align: middle;
      transition: color .15s, background .15s;
    }
    .copy-link-btn:hover { color: #26A17B; background: rgba(38,161,123,.1); }
    .result-meta {
      margin-top: .75rem; font-size: .78rem; color: #475569;
    }
    .result-meta span { color: #94a3b8; }
    .result-back-wrap { margin-top: 1.5rem; }
    .no-events-note {
      background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.22);
      border-radius: 10px; padding: .75rem 1rem; margin-bottom: 1.25rem;
      color: #d4a017; font-size: .82rem;
    }
  </style>`;
}

// ── Form HTML renderer ────────────────────────────────────────────────────────

function renderForm(
  events: EventRow[],
  nonces: { script?: string; style?: string },
  errorMsg?: string,
): string {
  const styleNonceAttr = nonces.style ? ` nonce="${nonces.style}"` : "";
  const scriptNonceAttr = nonces.script ? ` nonce="${nonces.script}"` : "";

  const noEventsNote =
    events.length === 0
      ? `<div class="no-events-note">No active events found. Create an event first via the CLI or API before generating a payment link.</div>`
      : "";

  const errorHtml = errorMsg
    ? `<div class="alert-error">${esc(errorMsg)}</div>`
    : "";

  const eventOptions = events
    .map((e) => `<option value="${esc(e.id)}">${esc(e.name)} — ${esc(e.id)}</option>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Создать ссылку — Stablerails</title>
  ${vaultCss(styleNonceAttr)}
</head>
<body>

  <div class="page-header">
    <div class="usdt-icon">&#x20AE;</div>
    <h1>Создать платёжную ссылку</h1>
  </div>

  <div class="back-wrap">
    <a class="back-link" href="/dashboard">&#x2190; Назад к панели</a>
  </div>

  <div class="card">
    <div class="card-title">Параметры платежа</div>

    ${noEventsNote}
    ${errorHtml}

    <form method="POST" action="/dashboard/create-link">
      <div class="field">
        <label class="field-label" for="eventId">Событие</label>
        <select id="eventId" name="eventId" required>
          <option value="">— выберите событие —</option>
          ${eventOptions}
        </select>
      </div>

      <div class="field">
        <label class="field-label" for="amount">Сумма (USD)</label>
        <div class="amount-wrap">
          <span class="amount-prefix">$</span>
          <input type="number" id="amount" name="amount"
                 min="0.01" step="0.01" placeholder="10.00" required />
        </div>
        <div class="field-hint">Минимум $0.01</div>
      </div>

      <div class="field">
        <label class="field-label" for="description">Описание / товар (необязательно)</label>
        <input type="text" id="description" name="description"
               maxlength="200" placeholder="Название товара или услуги" />
      </div>

      <button type="submit" class="submit-btn">
        Создать ссылку
      </button>
    </form>
  </div>

  <script${scriptNonceAttr}>
    document.querySelector('form').addEventListener('submit', function() {
      var btn = document.querySelector('.submit-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Создание…'; }
    });
  </script>
</body>
</html>`;
}

// ── Success HTML renderer ─────────────────────────────────────────────────────

function renderSuccess(
  payUrl: string,
  invoiceId: string,
  eventId: string,
  amountUsdt: string,
  nonces: { script?: string; style?: string },
): string {
  const styleNonceAttr = nonces.style ? ` nonce="${nonces.style}"` : "";
  const scriptNonceAttr = nonces.script ? ` nonce="${nonces.script}"` : "";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ссылка создана — Stablerails</title>
  ${vaultCss(styleNonceAttr)}
</head>
<body>

  <div class="page-header">
    <div class="usdt-icon">&#x20AE;</div>
    <h1>Платёжная ссылка создана</h1>
  </div>

  <div class="back-wrap">
    <a class="back-link" href="/dashboard">&#x2190; Назад к панели</a>
  </div>

  <div class="card">
    <div class="card-title">Готово — отправьте ссылку плательщику</div>

    <div class="result-label">Ссылка для оплаты</div>
    <div class="link-card">
      <div class="link-card-title">Ссылка для плательщика</div>
      <span class="link-url" id="pay-url">${esc(payUrl)}</span>
      <button class="copy-link-btn" id="copy-link-btn" aria-label="Скопировать ссылку" title="Скопировать">⧉</button>
    </div>

    <div class="result-meta">
      Счёт: <span>${esc(invoiceId)}</span> &middot;
      Событие: <span>${esc(eventId)}</span> &middot;
      К оплате: <span>${esc(amountUsdt)} USDT</span>
    </div>

    <div class="result-back-wrap">
      <a class="back-link" href="/dashboard/create-link">&#x2190; Создать ещё одну ссылку</a>
    </div>
  </div>

  <script${scriptNonceAttr}>
    document.getElementById('copy-link-btn').addEventListener('click', function() {
      var url = document.getElementById('pay-url').textContent || '';
      navigator.clipboard.writeText(url).then(function() {
        var btn = document.getElementById('copy-link-btn');
        if (btn) {
          var prev = btn.textContent;
          btn.textContent = '✓';
          setTimeout(function() { btn.textContent = prev; }, 1500);
        }
      });
    });
  </script>
</body>
</html>`;
}

// ── Error HTML renderer ───────────────────────────────────────────────────────

function renderError(
  message: string,
  statusCode: number,
  nonces: { style?: string },
): string {
  const styleNonceAttr = nonces.style ? ` nonce="${nonces.style}"` : "";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ошибка — Stablerails</title>
  ${vaultCss(styleNonceAttr)}
</head>
<body>

  <div class="page-header">
    <div class="usdt-icon">&#x20AE;</div>
    <h1>Stablerails</h1>
  </div>

  <div class="back-wrap">
    <a class="back-link" href="/dashboard/create-link">&#x2190; Назад к форме</a>
  </div>

  <div class="card">
    <div class="card-title">Ошибка ${esc(String(statusCode))}</div>
    <div class="alert-error">${esc(message)}</div>
    <a class="back-link" href="/dashboard/create-link">Попробовать снова</a>
  </div>

</body>
</html>`;
}

// ── CSP config (shared for GET and POST) ──────────────────────────────────────

const CSP_CONFIG = {
  helmet: {
    enableCSPNonces: true,
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "style-src": ["'self'"],
        "script-src": ["'self'"],
        "connect-src": ["'none'"],
        "img-src": ["'self'"],
        "frame-ancestors": ["'none'"],
      },
    },
  },
} as const;

// ── Route registration ────────────────────────────────────────────────────────

export async function registerCreateLinkRoutes(
  app: FastifyInstance,
  opts: CreateLinkRouteOpts,
): Promise<void> {
  const {
    eventRepo,
    invoiceRepo,
    deriver,
    clock,
    getRateConfig,
    sessionStore,
    rateLimiter,
    publicBaseUrl = "http://localhost:3000",
  } = opts;

  // ── GET /dashboard/create-link — show form ──────────────────────────────────
  app.get(
    "/dashboard/create-link",
    { config: CSP_CONFIG },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("dashboard", ip)) {
        return reply.code(429).header("Content-Type", "text/html; charset=utf-8").send(
          "<html><body><h1>Слишком много запросов</h1></body></html>",
        );
      }

      // Session gate — identical to GET /dashboard
      const cookieHeader = req.headers["cookie"] ?? "";
      const sessionId = extractSessionId(cookieHeader);
      if (!sessionId) return reply.code(302).header("Location", "/login").send();
      const session = sessionStore.get(sessionId);
      if (!session) return reply.code(302).header("Location", "/login").send();

      const events = typeof eventRepo.list === "function" ? await eventRepo.list() : [];
      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;
      const html = renderForm(events, { script: cspNonce?.script, style: cspNonce?.style });

      return reply.code(200).header("Content-Type", "text/html; charset=utf-8").send(html);
    },
  );

  // ── POST /dashboard/create-link — create invoice, show link ────────────────
  app.post(
    "/dashboard/create-link",
    { config: CSP_CONFIG },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("dashboard", ip)) {
        return reply.code(429).header("Content-Type", "text/html; charset=utf-8").send(
          "<html><body><h1>Слишком много запросов</h1></body></html>",
        );
      }

      // Session gate
      const cookieHeader = req.headers["cookie"] ?? "";
      const sessionId = extractSessionId(cookieHeader);
      if (!sessionId) return reply.code(302).header("Location", "/login").send();
      const session = sessionStore.get(sessionId);
      if (!session) return reply.code(302).header("Location", "/login").send();

      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;
      const nonces = { script: cspNonce?.script, style: cspNonce?.style };

      const body = req.body as Record<string, string | undefined>;
      const eventId = (body["eventId"] ?? "").trim();
      const amountStr = (body["amount"] ?? "").trim();
      const description = (body["description"] ?? "").trim();

      // Input validation
      if (!eventId) {
        const html = renderError("eventId is required", 400, nonces);
        return reply.code(400).header("Content-Type", "text/html; charset=utf-8").send(html);
      }

      const amount = parseFloat(amountStr);
      if (!amountStr || !Number.isFinite(amount) || amount <= 0) {
        const html = renderError(
          `Invalid amount: "${amountStr || "(empty)"}". Enter a positive number (e.g. 10.00).`,
          400,
          nonces,
        );
        return reply.code(400).header("Content-Type", "text/html; charset=utf-8").send(html);
      }

      // Metadata: store description as product (same convention as /demo/order)
      const metadata: Record<string, string> | null = description
        ? { product: description }
        : null;

      // Kill-switch: mirror the same guard as POST /v1/invoices (invoices.ts:233).
      // An operator kill-switch engagement must block the dashboard form too —
      // otherwise a paused system still mints invoices/deposit-addresses at a
      // possibly stale rate while the public API correctly rejects with 503.
      if (await isPausedAsync("invoices")) {
        const html = renderError("Invoice creation is temporarily paused", 503, nonces);
        return reply.code(503).header("Content-Type", "text/html; charset=utf-8").send(html);
      }

      // Call the existing createInvoice core function directly.
      // The operator session gate provides at least the same auth level as a
      // merchant API key — the operator IS the person who minted those keys.
      let invoice: import("../../core/ports.js").InvoiceRow;
      try {
        invoice = await createInvoice(
          {
            eventId,
            priceFiat: amount.toFixed(2),
            fiatCurrency: "USD",
            metadata,
            ttlMinutes: 30,
          },
          {
            invoiceRepo,
            eventRepo,
            deriver,
            clock,
            rate: getRateConfig(),
          },
        );
      } catch (err) {
        if (err instanceof InvoiceValidationError) {
          const statusCode =
            err.code === "EVENT_NOT_FOUND" ? 404
            : err.code === "AMOUNT_TOO_SMALL" ? 400
            : 422;
          const html = renderError(err.message, statusCode, nonces);
          return reply.code(statusCode).header("Content-Type", "text/html; charset=utf-8").send(html);
        }
        // RangeError/TypeError from pricing (e.g. zero-amount after toFixed rounding)
        // mirrors the same handling in POST /v1/invoices
        if (err instanceof RangeError || err instanceof TypeError) {
          const html = renderError((err as Error).message, 422, nonces);
          return reply.code(422).header("Content-Type", "text/html; charset=utf-8").send(html);
        }
        throw err;
      }

      const payUrl = `${publicBaseUrl}/pay/${invoice.id}`;
      const html = renderSuccess(payUrl, invoice.id, invoice.eventId, invoice.amountUsdt, nonces);

      return reply.code(200).header("Content-Type", "text/html; charset=utf-8").send(html);
    },
  );
}
