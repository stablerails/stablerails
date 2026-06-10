/**
 * Demo merchant-facing order page (dev only — gated by ENABLE_DEMO=1).
 *
 * GET  /demo           — HTML form: product name, amount (USD)
 * POST /demo/order     — server-side proxy: calls POST /v1/invoices with the
 *                        DEMO_MERCHANT_KEY, then redirects the browser to the
 *                        returned hostedUrl (/pay/:id).
 *
 * PAYER PRIVACY: the form collects NO payer PII (no email field) and the
 * invoice metadata carries only the product label.
 *
 * SECURITY:
 *   - DEMO_MERCHANT_KEY is read from env server-side and NEVER sent to the browser.
 *   - This module registers routes only when ENABLE_DEMO=1. In production the
 *     env flag must be absent/empty so these routes never mount.
 *   - CSP mirrors the checkout page pattern: nonce-based script-src, style unsafe-inline.
 *
 * Usage:
 *   Set ENABLE_DEMO=1, DEMO_MERCHANT_KEY=<merchant-key>, DEMO_EVENT_ID=<event-id>
 *   then visit http://localhost:3000/demo
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

/** Escape HTML entities. */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * CSP for static inline-HTML error pages (defense-in-depth).
 * These pages have no scripts and no subresources; they only use inline
 * style="" attributes → style-src 'unsafe-inline'. No nonce machinery needed.
 */
const STATIC_ERROR_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/** Send a static HTML error page with a locked-down CSP header. */
function sendStaticHtmlError(reply: FastifyReply, code: number, html: string): FastifyReply {
  return reply
    .code(code)
    .header("Content-Type", "text/html; charset=utf-8")
    .header("Content-Security-Policy", STATIC_ERROR_PAGE_CSP)
    .send(html);
}

interface DemoOrderBody {
  product?: string;
  amount?: string;
}

interface DemoRouteOpts {
  /** Base URL used to call /v1/invoices internally (same host). */
  publicBaseUrl: string;
}

function demoHostFromHeader(hostHeader: string | string[] | undefined): string {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const host = (raw ?? "").trim().toLowerCase();
  if (!host) return "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end >= 0 ? host.slice(1, end) : host;
  }
  return host.split(":")[0] ?? "";
}

function isLocalDemoHost(hostHeader: string | string[] | undefined): boolean {
  const host = demoHostFromHeader(hostHeader);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

async function requireLocalDemoHost(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // On testnet deployments (STABLERAILS_ENV=testnet) the demo is intentionally
  // public — the restriction is relaxed so the hosted /demo URL is reachable.
  // On all other runtimes (dev, staging, etc.) keep localhost-only.
  if (process.env["STABLERAILS_ENV"] === "testnet") return;

  if (isLocalDemoHost(req.headers.host)) return;

  await reply
    .code(403)
    .header("Content-Type", "text/html; charset=utf-8")
    .send(
      `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem">` +
      `<h2>Demo unavailable</h2><p>The demo page is only available from localhost.</p>` +
      `</body></html>`,
    );
}

/**
 * Register GET /demo and POST /demo/order.
 * Called only when ENABLE_DEMO=1 — caller must check before registering.
 */
export async function registerDemoRoutes(
  app: FastifyInstance,
  opts: DemoRouteOpts,
): Promise<void> {
  const { publicBaseUrl } = opts;

  const merchantKey = process.env["DEMO_MERCHANT_KEY"] ?? "";
  const eventId = process.env["DEMO_EVENT_ID"] ?? "";

  // ── GET /demo — order form ─────────────────────────────────────────────────
  app.get(
    "/demo",
    {
      preHandler: requireLocalDemoHost,
      config: {
        helmet: {
          enableCSPNonces: true,
          contentSecurityPolicy: {
            directives: {
              "default-src": ["'self'"],
              // style-src: nonce injected by @fastify/helmet (enableCSPNonces). The nonce is
              // applied to the <style> tag below — 'unsafe-inline' is NOT listed because a
              // nonce in style-src makes 'unsafe-inline' ineffective per CSP spec.
              "style-src": ["'self'"],
              // script-src nonce covers the <script> block set below.
              "script-src": ["'self'"],
              "connect-src": ["'none'"],
              "img-src": ["'self'"],
              "frame-ancestors": ["'none'"],
            },
          },
        },
      },
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;
      const scriptNonce = cspNonce?.script ?? "";
      const styleNonce = cspNonce?.style ?? "";
      const nonceAttr = scriptNonce ? ` nonce="${esc(scriptNonce)}"` : "";
      const styleNonceAttr = styleNonce ? ` nonce="${esc(styleNonce)}"` : "";

      const warningHtml =
        !merchantKey || !eventId
          ? `<div class="alert-warn">
               <strong>Demo not fully configured.</strong><br>
               Set <code>DEMO_MERCHANT_KEY</code> and <code>DEMO_EVENT_ID</code>
               env vars then restart the server (see dev-bootstrap.sh).
             </div>`
          : "";

      // Premium dark fintech design — "Vault" aesthetic matching the checkout page.
      // System fonts only (no CDN), fully self-contained, mobile-first, CSP-safe.
      const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Stablerails Demo — Тестовый заказ</title>
  <style${styleNonceAttr}>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      background: #06090c;
      background-image:
        radial-gradient(ellipse 90% 55% at 50% -5%, rgba(38,161,123,0.14) 0%, transparent 65%),
        radial-gradient(ellipse 55% 65% at 95% 105%, rgba(38,161,123,0.06) 0%, transparent 55%);
      color: #e2e8f0;
      min-height: 100svh;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem 1rem;
    }

    /* ── Card ──────────────────────────────────────────── */
    .card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.075);
      border-radius: 22px;
      max-width: 440px;
      width: 100%;
      box-shadow:
        0 0 0 1px rgba(38,161,123,0.07),
        0 32px 80px rgba(0,0,0,0.65),
        0 8px 24px rgba(0,0,0,0.4);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      overflow: hidden;
    }

    /* ── Store hero header ─────────────────────────────── */
    .store-hero {
      position: relative;
      height: 96px;
      background: linear-gradient(160deg, #081a13 0%, #0d2219 50%, #06110d 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 0.3rem;
      overflow: hidden;
      border-bottom: 1px solid rgba(38,161,123,0.12);
    }
    .hero-glow {
      position: absolute;
      width: 240px; height: 160px;
      border-radius: 50%;
      background: radial-gradient(ellipse, rgba(38,161,123,0.28) 0%, transparent 70%);
      top: -60px; left: 50%; transform: translateX(-50%);
      pointer-events: none;
    }
    .hero-glow-r {
      position: absolute;
      width: 140px; height: 140px;
      border-radius: 50%;
      background: radial-gradient(ellipse, rgba(38,161,123,0.1) 0%, transparent 70%);
      bottom: -50px; right: -20px;
      pointer-events: none;
    }
    .store-logo {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      position: relative;
      z-index: 1;
    }
    .logo-mark {
      width: 30px; height: 30px;
      background: #26A17B;
      border-radius: 9px;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.95rem; font-weight: 900; color: #fff;
      letter-spacing: -0.05em;
      box-shadow: 0 0 12px rgba(38,161,123,0.5);
    }
    .logo-name {
      font-size: 1.05rem;
      font-weight: 700;
      color: #e2e8f0;
      letter-spacing: -0.02em;
    }
    .logo-name .accent { color: #26A17B; }
    .demo-badge-hero {
      position: relative;
      z-index: 1;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      background: rgba(245,158,11,0.1);
      border: 1px solid rgba(245,158,11,0.22);
      color: #b45309;
      padding: 0.18rem 0.55rem;
      border-radius: 100px;
      font-size: 0.6rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    /* ── Form area ──────────────────────────────────────── */
    .form-body {
      padding: 1.75rem 1.875rem 1.875rem;
    }

    .form-header { margin-bottom: 1.5rem; }
    .form-title {
      font-size: 1.15rem;
      font-weight: 700;
      color: #f1f5f9;
      letter-spacing: -0.02em;
      margin-bottom: 0.25rem;
    }
    .form-subtitle {
      font-size: 0.78rem;
      color: #334155;
    }

    .field { margin-bottom: 1.1rem; }

    label {
      display: block;
      font-size: 0.67rem;
      font-weight: 700;
      color: #475569;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 0.35rem;
    }

    input[type="text"],
    input[type="number"] {
      width: 100%;
      padding: 0.75rem 0.875rem;
      background: rgba(0,0,0,0.35);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 10px;
      color: #f1f5f9;
      font-size: 0.9rem;
      font-family: inherit;
      transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
      outline: none;
      -webkit-appearance: none;
    }
    input[type="text"]:focus,
    input[type="number"]:focus {
      border-color: rgba(38,161,123,0.5);
      background: rgba(38,161,123,0.04);
      box-shadow: 0 0 0 3px rgba(38,161,123,0.1);
    }
    input::placeholder { color: #2d3f50; }

    .amount-field-wrap { position: relative; }
    .amount-prefix {
      position: absolute;
      left: 0.875rem;
      top: 50%;
      transform: translateY(-50%);
      color: #475569;
      font-size: 0.9rem;
      pointer-events: none;
      font-weight: 500;
    }
    .amount-field-wrap input { padding-left: 1.75rem; }

    /* ── CTA button ─────────────────────────────────────── */
    .submit-btn {
      width: 100%;
      padding: 0.875rem 1.25rem;
      background: linear-gradient(135deg, #26A17B 0%, #1e9068 100%);
      color: #fff;
      border: none;
      border-radius: 12px;
      font-size: 0.95rem;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.1s, box-shadow 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      margin-top: 0.375rem;
      box-shadow: 0 4px 16px rgba(38,161,123,0.32), 0 2px 4px rgba(0,0,0,0.3);
      letter-spacing: -0.01em;
    }
    .submit-btn:hover {
      opacity: 0.91;
      box-shadow: 0 6px 22px rgba(38,161,123,0.4), 0 2px 6px rgba(0,0,0,0.3);
    }
    .submit-btn:active { transform: scale(0.99); }
    .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

    /* ── Alert boxes ────────────────────────────────────── */
    .alert-warn {
      background: rgba(113,63,18,0.35);
      border: 1px solid rgba(245,158,11,0.22);
      border-radius: 10px;
      padding: 0.75rem 0.875rem;
      margin-bottom: 1.25rem;
      color: #d4a017;
      font-size: 0.78rem;
      line-height: 1.55;
    }
    .alert-warn code {
      background: rgba(0,0,0,0.3);
      padding: 0.1rem 0.35rem;
      border-radius: 5px;
      font-size: 0.73rem;
      font-family: "SFMono-Regular", "Consolas", monospace;
    }

    /* ── Security strip ─────────────────────────────────── */
    .security-strip {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.375rem;
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid rgba(255,255,255,0.04);
      font-size: 0.67rem;
      color: #1e293b;
      letter-spacing: 0.02em;
    }
    .security-strip svg { color: #26A17B; opacity: 0.65; flex-shrink: 0; }

    /* ── Responsive ─────────────────────────────────────── */
    @media (max-width: 480px) {
      body { padding: 0; align-items: flex-start; }
      .card { border-radius: 0; min-height: 100svh; min-height: 100vh; box-shadow: none; border: none; }
      .store-hero { border-radius: 0; }
      .form-body { padding: 1.5rem 1.25rem 1.5rem; }
    }
  </style>
</head>
<body>
<div class="card">

  <!-- Store hero header -->
  <div class="store-hero">
    <div class="hero-glow"></div>
    <div class="hero-glow-r"></div>
    <div class="store-logo">
      <div class="logo-mark">&#x20AE;</div>
      <span class="logo-name">USDT<span class="accent">&middot;Pay</span></span>
    </div>
    <span class="demo-badge-hero">Dev Demo</span>
  </div>

  <!-- Form body -->
  <div class="form-body">
    <div class="form-header">
      <h1 class="form-title">Тестовый заказ</h1>
      <p class="form-subtitle">Демо-стенд &mdash; только для разработки</p>
    </div>

    ${warningHtml}

    <form id="order-form" method="POST" action="/demo/order">
      <div class="field">
        <label for="product">Товар / Описание</label>
        <input type="text" id="product" name="product" value="Test Product" required maxlength="120" />
      </div>

      <div class="field">
        <label for="amount">Сумма (USD)</label>
        <div class="amount-field-wrap">
          <span class="amount-prefix">$</span>
          <input type="number" id="amount" name="amount" value="1.00"
                 min="0.01" step="0.01" required />
        </div>
      </div>

      <button type="submit" class="submit-btn" id="submit-btn">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 8v8M8 12h8"/>
        </svg>
        Оплатить через USDT
      </button>
    </form>

    <div class="security-strip">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      </svg>
      Защищённое соединение &middot; USDT / TRC-20
    </div>
  </div>

</div>

<script${nonceAttr}>
  // Disable the submit button on click to prevent double-submit.
  document.getElementById('order-form').addEventListener('submit', function() {
    var btn = document.getElementById('submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Перенаправление…'; }
  });
</script>
</body>
</html>`;

      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(html);
    },
  );

  // ── POST /demo/order — server-side invoice creation + redirect ─────────────
  // The form posts here (application/x-www-form-urlencoded).
  // We proxy to POST /v1/invoices using DEMO_MERCHANT_KEY (never exposed to browser).
  app.post(
    "/demo/order",
    { preHandler: requireLocalDemoHost },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as DemoOrderBody;
      const product = (body.product ?? "Demo Product").trim() || "Demo Product";
      const amountStr = (body.amount ?? "1.00").trim();

      const amount = parseFloat(amountStr);
      if (!isFinite(amount) || amount <= 0) {
        return sendStaticHtmlError(
          reply,
          400,
          `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem">` +
            `<h2>Invalid amount</h2><p>${esc(amountStr)} is not a valid positive number.</p>` +
            `<p><a href="/demo" style="color:#60a5fa">Back</a></p></body></html>`,
        );
      }

      if (!merchantKey || !eventId) {
        return sendStaticHtmlError(
          reply,
          503,
          `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem">` +
            `<h2>Demo not configured</h2>` +
            `<p>Set DEMO_MERCHANT_KEY and DEMO_EVENT_ID and restart.</p>` +
            `<p><a href="/demo" style="color:#60a5fa">Back</a></p></body></html>`,
        );
      }

      // Build the invoice request payload.
      // Payer privacy: metadata carries the product label only — never payer PII.
      const metadata: Record<string, string> = { product };

      // Call the local server's own POST /v1/invoices.
      // Using the loopback URL rather than "self" to avoid certificate issues in dev.
      const apiUrl = publicBaseUrl.replace(/\/$/, "");

      let invoiceData: { hostedUrl?: string; id?: string } | null = null;
      let errorMsg: string | null = null;

      try {
        const res = await fetch(`${apiUrl}/v1/invoices`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${merchantKey}`,
          },
          body: JSON.stringify({
            eventId,
            priceFiat: amount.toFixed(2),
            fiatCurrency: "USD",
            metadata,
            ttlMinutes: 30,
          }),
        });

        const json = (await res.json()) as {
          data?: { hostedUrl?: string; id?: string };
          error?: { code: string; message: string };
        };

        if (!res.ok || json.error) {
          errorMsg = json.error?.message ?? `HTTP ${res.status}`;
        } else {
          invoiceData = json.data ?? null;
        }
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
      }

      if (errorMsg || !invoiceData?.hostedUrl) {
        const msg = esc(errorMsg ?? "No hostedUrl in response");
        return sendStaticHtmlError(
          reply,
          502,
          `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:2rem">` +
            `<h2>Invoice creation failed</h2><p>${msg}</p>` +
            `<p><a href="/demo" style="color:#60a5fa">Back</a></p></body></html>`,
        );
      }

      // Redirect the browser to the hosted checkout page.
      return reply.code(302).header("Location", invoiceData.hostedUrl).send();
    },
  );
}
