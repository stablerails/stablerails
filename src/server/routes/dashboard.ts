/**
 * Operator dashboard routes.
 *
 * GET  /dashboard              — HTML invoice list + summary stats (session-gated)
 * GET  /dashboard/invoices.csv — CSV export of all invoices (session-gated)
 *
 * Auth: session cookie `stablerails_session` via InMemorySessionStore.
 * Gate pattern copied from GET /api-keys in auth.ts — read cookie → sessionStore.get(id) → 302 /login if absent.
 *
 * Stats are display-only arithmetic via parseMicro/formatMicro — zero money-logic.
 * All dynamic fields are HTML-escaped via esc().
 * CSP: nonce-locked script-src (injected by @fastify/helmet enableCSPNonces).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { InvoiceRepository, InvoiceRow, InvoiceStatus } from "../../core/ports.js";
import type { InMemorySessionStore } from "../auth.js";
import { SESSION_COOKIE_NAME } from "../auth.js";
import type { RateLimiter } from "../../lib/rate-limit.js";

export interface DashboardRouteOpts {
  invoiceRepo: InvoiceRepository;
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

// ── Session gate ──────────────────────────────────────────────────────────────

function extractSessionId(cookieHeader: string): string | null {
  return (
    cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.slice(SESSION_COOKIE_NAME.length + 1) ?? null
  );
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

/**
 * Guard against CSV formula injection.
 * Fields starting with = + - @ would be interpreted as Excel/Sheets formulas.
 * Prefix them with a single quote so spreadsheet apps treat them as text.
 */
function formulaGuard(value: string): string {
  if (/^[=+\-@]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

/**
 * Wrap a CSV field value in double-quotes, escaping internal double-quotes by doubling them.
 * Also applies the formula-injection guard.
 */
function csvField(value: string): string {
  const guarded = formulaGuard(value);
  const escaped = guarded.replace(/"/g, '""');
  return `"${escaped}"`;
}

function invoiceToCsvRow(inv: InvoiceRow): string {
  const paidAt = inv.paidAt ? inv.paidAt.toISOString() : "";
  return [
    csvField(inv.id),
    csvField(inv.status),
    csvField(inv.priceFiat),
    csvField(inv.fiatCurrency),
    csvField(inv.amountUsdt),
    csvField(inv.amountReceived),
    csvField(inv.depositAddress),
    csvField(inv.createdAt.toISOString()),
    csvField(paidAt),
  ].join(",");
}

const CSV_HEADER = "id,status,priceFiat,fiatCurrency,amountUsdt,amountReceived,depositAddress,createdAt,paidAt";

// ── Status badge (uses CSS classes, no inline style) ─────────────────────────

// Known statuses — used to validate ?status= query param before passing to repo.
// An invalid value would cause PrismaClientValidationError (→ 500) if not caught here.
const KNOWN_STATUSES = new Set<string>([
  "pending",
  "payment_detected",
  "paid",
  "underpaid",
  "overpaid",
  "expired",
  "canceled",
  "overdue",
]);

function statusBadge(status: string): string {
  // Sanitise: only emit the CSS class for known statuses; unknown → badge-unknown.
  const cssClass = KNOWN_STATUSES.has(status) ? `badge-${status}` : "badge-unknown";
  return `<span class="status-badge ${cssClass}">${esc(status)}</span>`;
}

// ── Vault CSS (shared dark theme) ─────────────────────────────────────────────

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
      max-width: 1200px; margin: 0 auto 1.5rem;
      display: flex; align-items: center; gap: .75rem;
    }
    .usdt-icon {
      width: 28px; height: 28px; background: #26A17B; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: .9rem; font-weight: 900; color: #fff; flex-shrink: 0;
      box-shadow: 0 0 12px rgba(38,161,123,.4);
    }
    h1 { font-size: 1.25rem; font-weight: 700; color: #f1f5f9; }
    .summary-grid {
      max-width: 1200px; margin: 0 auto 1.5rem;
      display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .75rem;
    }
    .stat-card {
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 14px; padding: 1rem 1.25rem;
    }
    .stat-label { font-size: .67rem; font-weight: 700; color: #475569; text-transform: uppercase; letter-spacing: .1em; margin-bottom: .3rem; }
    .stat-value { font-size: 1.625rem; font-weight: 800; color: #f8fafc; letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
    .stat-value.green { color: #26A17B; }
    .filter-bar {
      max-width: 1200px; margin: 0 auto 1rem;
      display: flex; gap: .5rem; align-items: center; flex-wrap: wrap;
    }
    .filter-bar label { font-size: .8rem; color: #94a3b8; }
    .filter-bar select, .filter-bar input {
      background: #0f172a; border: 1px solid #334155; border-radius: .5rem;
      color: #f1f5f9; font-size: .85rem; padding: .35rem .65rem;
    }
    .filter-bar button {
      background: #1e3a5f; border: 1px solid #2563eb; border-radius: .5rem;
      color: #93c5fd; font-size: .85rem; font-weight: 600; padding: .35rem .85rem;
      cursor: pointer;
    }
    .filter-bar button:hover { background: #1d4ed8; color: #fff; }
    .csv-link {
      margin-left: auto;
      background: rgba(38,161,123,.1); border: 1px solid rgba(38,161,123,.3);
      border-radius: .5rem; color: #26A17B; font-size: .8rem; font-weight: 600;
      padding: .35rem .85rem; text-decoration: none;
    }
    .csv-link:hover { background: rgba(38,161,123,.18); }
    .table-wrap {
      max-width: 1200px; margin: 0 auto;
      overflow-x: auto;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 14px;
    }
    table { width: 100%; border-collapse: collapse; }
    thead tr { border-bottom: 1px solid rgba(255,255,255,.07); }
    th {
      padding: .65rem 1rem; text-align: left; font-size: .67rem; font-weight: 700;
      color: #475569; text-transform: uppercase; letter-spacing: .08em; white-space: nowrap;
    }
    td { padding: .6rem 1rem; font-size: .82rem; color: #cbd5e1; border-bottom: 1px solid rgba(255,255,255,.04); white-space: nowrap; }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", monospace; font-size: .78rem; }
    .addr-cell { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
    .copy-cell-btn {
      background: none; border: none; cursor: pointer; color: #475569; padding: .15rem .3rem;
      border-radius: 4px; font-size: .75rem; margin-left: .25rem; vertical-align: middle;
      transition: color .15s, background .15s;
    }
    .copy-cell-btn:hover { color: #26A17B; background: rgba(38,161,123,.1); }
    .pagination { max-width: 1200px; margin: 1rem auto 0; display: flex; gap: .5rem; }
    .page-btn {
      background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08);
      border-radius: .5rem; color: #94a3b8; font-size: .85rem; padding: .4rem .9rem;
      text-decoration: none;
    }
    .page-btn:hover { background: rgba(255,255,255,.08); color: #e2e8f0; }
    .empty-state { padding: 2.5rem; text-align: center; color: #334155; font-size: .9rem; }
    /* ── Amount / timestamp cells ───────────────────────────────────────────── */
    .cell-amount-usdt { color: #26A17B; font-size: .75rem; }
    .cell-timestamp { color: #94a3b8; font-size: .77rem; }
    .cell-paid-at { color: #64748b; font-size: .77rem; }
    /* ── Status badge base + per-status colors ──────────────────────────────── */
    .status-badge {
      padding: .15rem .55rem; border-radius: 100px;
      font-size: .7rem; font-weight: 700; letter-spacing: .06em;
      display: inline-block;
    }
    .badge-paid          { background: #22c55e22; color: #22c55e; border: 1px solid #22c55e44; }
    .badge-payment_detected { background: #34d39922; color: #34d399; border: 1px solid #34d39944; }
    .badge-pending       { background: #f59e0b22; color: #f59e0b; border: 1px solid #f59e0b44; }
    .badge-overdue       { background: #ef444422; color: #ef4444; border: 1px solid #ef444444; }
    .badge-expired       { background: #ef444422; color: #ef4444; border: 1px solid #ef444444; }
    .badge-canceled      { background: #ef444422; color: #ef4444; border: 1px solid #ef444444; }
    .badge-underpaid     { background: #f9731622; color: #f97316; border: 1px solid #f9731644; }
    .badge-overpaid      { background: #f9731622; color: #f97316; border: 1px solid #f9731644; }
    .badge-unknown       { background: #64748b22; color: #64748b; border: 1px solid #64748b44; }
    /* ── Summary section label ──────────────────────────────────────────────── */
    .summary-label {
      max-width: 1200px; margin: 0 auto .4rem;
      font-size: .65rem; font-weight: 700; color: #334155;
      text-transform: uppercase; letter-spacing: .1em;
    }
    /* ── Create link button ───────────────────────────────────────────────── */
    .create-link-btn {
      background: rgba(38,161,123,.15); border-color: rgba(38,161,123,.4);
    }
    .create-link-btn:hover { background: rgba(38,161,123,.25); }
    /* ── Invoice ID link to detail page ────────────────────────────────────── */
    .detail-id-link {
      color: #94a3b8; text-decoration: none;
      transition: color .15s;
    }
    .detail-id-link:hover { color: #26A17B; text-decoration: underline; }
  </style>`;
}

// ── Detail page extra CSS (beyond vaultCss) ───────────────────────────────────

function detailCss(nonceAttr: string): string {
  return `<style${nonceAttr}>
    .back-link {
      font-size: .82rem; color: #475569; text-decoration: none;
      display: inline-flex; align-items: center; gap: .4rem;
      padding: .3rem .6rem; border-radius: .4rem;
      transition: color .15s, background .15s;
    }
    .back-link:hover { color: #94a3b8; background: rgba(255,255,255,.04); }
    .detail-card {
      max-width: 720px; margin: 0 auto;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 16px; padding: 1.5rem 1.75rem;
    }
    .detail-title {
      font-size: 1rem; font-weight: 700; color: #f1f5f9;
      margin-bottom: 1.25rem;
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: .65rem;
    }
    .detail-field {
      background: rgba(0,0,0,.2); border: 1px solid rgba(255,255,255,.05);
      border-radius: 10px; padding: .75rem 1rem;
    }
    .detail-label {
      font-size: .64rem; font-weight: 700; color: #475569;
      text-transform: uppercase; letter-spacing: .09em; margin-bottom: .35rem;
    }
    .detail-value {
      font-size: .85rem; color: #e2e8f0; word-break: break-all; line-height: 1.55;
    }
    .detail-value.mono {
      font-family: "SFMono-Regular","SF Mono",Consolas,"Liberation Mono",monospace;
      font-size: .78rem;
    }
    .detail-value.ts { color: #94a3b8; font-size: .78rem; }
    .detail-section-label {
      font-size: .65rem; font-weight: 700; color: #334155;
      text-transform: uppercase; letter-spacing: .1em;
      max-width: 720px; margin: 1.25rem auto .4rem;
    }
    .copy-detail-btn {
      background: none; border: none; cursor: pointer; color: #475569;
      padding: .15rem .35rem; border-radius: 4px; font-size: .75rem;
      margin-left: .4rem; vertical-align: middle;
      transition: color .15s, background .15s;
    }
    .copy-detail-btn:hover { color: #26A17B; background: rgba(38,161,123,.1); }
    .pay-link-wrap {
      max-width: 720px; margin: 0 auto;
      background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07);
      border-radius: 16px; padding: 1.25rem 1.75rem;
    }
    .pay-link-title {
      font-size: .78rem; font-weight: 700; color: #475569;
      text-transform: uppercase; letter-spacing: .09em; margin-bottom: .75rem;
    }
    .pay-link-url {
      font-family: "SFMono-Regular","SF Mono",Consolas,"Liberation Mono",monospace;
      font-size: .78rem; color: #7dd3fc; word-break: break-all; line-height: 1.6;
    }
    .not-found-wrap {
      max-width: 480px; margin: 4rem auto; text-align: center;
    }
    .not-found-code {
      font-size: 4rem; font-weight: 900; color: #1e293b;
      letter-spacing: -.04em; margin-bottom: .5rem;
    }
    .not-found-msg { font-size: 1rem; color: #475569; margin-bottom: 1.5rem; }
    .not-found-link {
      display: inline-flex; align-items: center; gap: .4rem;
      color: #26A17B; font-size: .875rem; text-decoration: none;
    }
    .not-found-link:hover { text-decoration: underline; }
    .detail-back-wrap {
      max-width: 720px; margin: 0 auto .75rem;
    }
  </style>`;
}

// ── Detail page renderer ──────────────────────────────────────────────────────

function renderDetailPage(
  invoice: InvoiceRow,
  publicBaseUrl: string,
  nonces: { script?: string; style?: string },
): string {
  const styleNonceAttr = nonces.style ? ` nonce="${nonces.style}"` : "";
  const scriptNonceAttr = nonces.script ? ` nonce="${nonces.script}"` : "";

  const payUrl = `${publicBaseUrl}/pay/${invoice.id}`;

  const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const paidFmt = invoice.paidAt ? fmt(invoice.paidAt) : "—";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Счёт ${esc(invoice.id)} — Stablerails</title>
  ${vaultCss(styleNonceAttr)}
  ${detailCss(styleNonceAttr)}
</head>
<body>

  <div class="page-header">
    <div class="usdt-icon">&#x20AE;</div>
    <h1>Детали счёта</h1>
  </div>

  <div class="detail-back-wrap">
    <a class="back-link" href="/dashboard">&#x2190; Назад к панели</a>
  </div>

  <div class="detail-card">
    <div class="detail-title">Информация о счёте</div>
    <div class="detail-grid">
      <div class="detail-field">
        <div class="detail-label">ID счёта</div>
        <div class="detail-value mono">${esc(invoice.id)}<button class="copy-detail-btn" data-copy="${esc(invoice.id)}" aria-label="Скопировать ID" title="Скопировать">⧉</button></div>
      </div>
      <div class="detail-field">
        <div class="detail-label">ID события</div>
        <div class="detail-value mono">${esc(invoice.eventId)}</div>
      </div>
      <div class="detail-field">
        <div class="detail-label">Сумма фиат</div>
        <div class="detail-value">${esc(invoice.priceFiat)} ${esc(invoice.fiatCurrency)}</div>
      </div>
      <div class="detail-field">
        <div class="detail-label">К оплате (USDT)</div>
        <div class="detail-value mono">${esc(invoice.amountUsdt)} USDT</div>
      </div>
      <div class="detail-field">
        <div class="detail-label">Получено (USDT)</div>
        <div class="detail-value mono">${esc(invoice.amountReceived)} USDT</div>
      </div>
      <div class="detail-field">
        <div class="detail-label">Статус</div>
        <div class="detail-value">${statusBadge(invoice.status)}</div>
      </div>
      <div class="detail-field">
        <div class="detail-label">Создан</div>
        <div class="detail-value ts">${esc(fmt(invoice.createdAt))}</div>
      </div>
      <div class="detail-field">
        <div class="detail-label">Действителен до</div>
        <div class="detail-value ts">${esc(fmt(invoice.expiresAt))}</div>
      </div>
      <div class="detail-field">
        <div class="detail-label">Оплачен</div>
        <div class="detail-value ts">${esc(paidFmt)}</div>
      </div>
      <div class="detail-field">
        <div class="detail-label">Адрес депозита</div>
        <div class="detail-value mono">${esc(invoice.depositAddress)}<button class="copy-detail-btn" data-copy="${esc(invoice.depositAddress)}" aria-label="Скопировать адрес" title="Скопировать">⧉</button></div>
      </div>
    </div>
  </div>

  <div class="detail-section-label">Платёжная ссылка</div>
  <div class="pay-link-wrap">
    <div class="pay-link-title">Ссылка для плательщика</div>
    <span class="pay-link-url">${esc(payUrl)}</span>
    <button class="copy-detail-btn" data-copy="${esc(payUrl)}" aria-label="Скопировать ссылку" title="Скопировать">⧉</button>
  </div>

  <script${scriptNonceAttr}>
    document.querySelectorAll('.copy-detail-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var text = btn.getAttribute('data-copy') || '';
        navigator.clipboard.writeText(text).then(function() {
          var prev = btn.textContent;
          btn.textContent = '✓';
          setTimeout(function() { btn.textContent = prev; }, 1500);
        });
      });
    });
  </script>
</body>
</html>`;
}

// ── Detail page styled-404 renderer ──────────────────────────────────────────

function renderDetailNotFound(nonces: { style?: string }): string {
  const styleNonceAttr = nonces.style ? ` nonce="${nonces.style}"` : "";
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Счёт не найден — Stablerails</title>
  ${vaultCss(styleNonceAttr)}
  ${detailCss(styleNonceAttr)}
</head>
<body>
  <div class="page-header">
    <div class="usdt-icon">&#x20AE;</div>
    <h1>Stablerails</h1>
  </div>
  <div class="not-found-wrap">
    <div class="not-found-code">404</div>
    <div class="not-found-msg">Счёт не найден</div>
    <a class="not-found-link" href="/dashboard">&#x2190; Назад к панели</a>
  </div>
</body>
</html>`;
}

// ── Dashboard HTML renderer ───────────────────────────────────────────────────

function renderDashboard(
  invoices: InvoiceRow[],
  summary: { totalCount: number; settledCount: number; pendingCount: number; totalAmountReceived: string },
  opts: { status?: string; eventId?: string; nextCursor?: string; currentCursor?: string },
  nonces: { script?: string; style?: string },
): string {
  const styleNonceAttr = nonces.style ? ` nonce="${nonces.style}"` : "";
  const scriptNonceAttr = nonces.script ? ` nonce="${nonces.script}"` : "";

  // Build query string for filter links
  const buildQs = (extra: Record<string, string | undefined>): string => {
    const merged: Record<string, string> = {};
    if (opts.status) merged["status"] = opts.status;
    if (opts.eventId) merged["eventId"] = opts.eventId;
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === "") {
        delete merged[k];
      } else {
        merged[k] = v;
      }
    }
    const qs = new URLSearchParams(merged).toString();
    return qs ? `?${qs}` : "";
  };

  const rows = invoices.length === 0
    ? `<tr><td colspan="6" class="empty-state">Счёт не найден</td></tr>`
    : invoices
        .map((inv) => {
          const shortId = inv.id.slice(0, 12) + (inv.id.length > 12 ? "…" : "");
          const addrShort = inv.depositAddress.slice(0, 8) + "…" + inv.depositAddress.slice(-4);
          const createdFmt = inv.createdAt.toISOString().replace("T", " ").slice(0, 16);
          const paidFmt = inv.paidAt ? inv.paidAt.toISOString().replace("T", " ").slice(0, 16) : "—";
          return `<tr>
            <td class="mono" title="${esc(inv.id)}"><a class="detail-id-link" href="/dashboard/invoices/${esc(inv.id)}">${esc(shortId)}</a></td>
            <td><span>${esc(inv.priceFiat)} ${esc(inv.fiatCurrency)}</span><br><span class="mono cell-amount-usdt">${esc(inv.amountUsdt)} USDT</span></td>
            <td>${statusBadge(inv.status)}</td>
            <td class="mono cell-timestamp">${createdFmt}</td>
            <td><span class="addr-cell mono" title="${esc(inv.depositAddress)}">${esc(addrShort)}</span><button class="copy-cell-btn" data-addr="${esc(inv.depositAddress)}" aria-label="Скопировать адрес" title="Скопировать">⧉</button></td>
            <td class="mono cell-paid-at">${paidFmt}</td>
          </tr>`;
        })
        .join("\n");

  const csvQs = buildQs({});

  const paginationHtml = opts.nextCursor
    ? `<div class="pagination"><a class="page-btn" href="/dashboard${buildQs({ cursor: opts.nextCursor })}">Следующая &rarr;</a></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dashboard — Stablerails</title>
  ${vaultCss(styleNonceAttr)}
</head>
<body>

  <div class="page-header">
    <div class="usdt-icon">&#x20AE;</div>
    <h1>Панель оператора</h1>
  </div>

  <div class="filter-bar">
    <a class="csv-link" href="/webhooks">&#x2B; Webhooks</a>
  </div>

  <div class="summary-label">Сводка по событию &middot; за всё время</div>
  <div class="summary-grid">
    <div class="stat-card">
      <div class="stat-label">Всего счётов</div>
      <div class="stat-value">${esc(String(summary.totalCount))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Оплачено</div>
      <div class="stat-value green">${esc(String(summary.settledCount))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Ожидает</div>
      <div class="stat-value">${esc(String(summary.pendingCount))}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Получено USDT</div>
      <div class="stat-value green">${esc(summary.totalAmountReceived)}</div>
    </div>
  </div>

  <div class="filter-bar">
    <label for="status-filter">Статус:</label>
    <select id="status-filter">
      <option value="">— все —</option>
      <option value="pending" ${opts.status === "pending" ? 'selected' : ''}>pending</option>
      <option value="paid" ${opts.status === "paid" ? 'selected' : ''}>paid</option>
      <option value="payment_detected" ${opts.status === "payment_detected" ? 'selected' : ''}>payment_detected</option>
      <option value="expired" ${opts.status === "expired" ? 'selected' : ''}>expired</option>
      <option value="canceled" ${opts.status === "canceled" ? 'selected' : ''}>canceled</option>
      <option value="overpaid" ${opts.status === "overpaid" ? 'selected' : ''}>overpaid</option>
      <option value="underpaid" ${opts.status === "underpaid" ? 'selected' : ''}>underpaid</option>
      <option value="overdue" ${opts.status === "overdue" ? 'selected' : ''}>overdue</option>
    </select>
    ${opts.eventId ? `<label for="event-filter">Событие:</label><input id="event-filter" type="text" value="${esc(opts.eventId)}" placeholder="eventId" />` : `<input id="event-filter" type="text" value="" placeholder="eventId (необязательно)" />`}
    <button id="apply-filter">Применить</button>
    <a class="csv-link" href="/dashboard/invoices.csv${csvQs}">⬇ Скачать CSV</a>
    <a class="csv-link create-link-btn" href="/dashboard/create-link">+ Создать ссылку</a>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Сумма</th>
          <th>Статус</th>
          <th>Создан</th>
          <th>Адрес</th>
          <th>Оплачен</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  ${paginationHtml}

  <script${scriptNonceAttr}>
    // Filter apply
    document.getElementById('apply-filter').addEventListener('click', function() {
      var status = document.getElementById('status-filter').value;
      var eventId = document.getElementById('event-filter').value.trim();
      var params = new URLSearchParams();
      if (status) params.set('status', status);
      if (eventId) params.set('eventId', eventId);
      var qs = params.toString();
      window.location.href = '/dashboard' + (qs ? '?' + qs : '');
    });

    // Copy deposit address cells
    document.querySelectorAll('.copy-cell-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var addr = btn.getAttribute('data-addr') || '';
        navigator.clipboard.writeText(addr).then(function() {
          var prev = btn.textContent;
          btn.textContent = '✓';
          setTimeout(function() { btn.textContent = prev; }, 1500);
        });
      });
    });
  </script>
</body>
</html>`;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerDashboardRoutes(
  app: FastifyInstance,
  opts: DashboardRouteOpts,
): Promise<void> {
  const { invoiceRepo, sessionStore, rateLimiter, publicBaseUrl = "http://localhost:3000" } = opts;

  // ── GET /dashboard ──────────────────────────────────────────────────────────
  app.get(
    "/dashboard",
    {
      config: {
        helmet: {
          enableCSPNonces: true,
          contentSecurityPolicy: {
            directives: {
              "default-src": ["'self'"],
              // style-src: nonce injected by @fastify/helmet enableCSPNonces
              "style-src": ["'self'"],
              // script-src: nonce injected by @fastify/helmet — locks inline <script> to per-request nonce
              "script-src": ["'self'"],
              // connect-src: none — no XHR/fetch from dashboard (server-rendered)
              "connect-src": ["'none'"],
              "img-src": ["'self'"],
              "frame-ancestors": ["'none'"],
            },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // IP-keyed rate limit (must come before session lookup)
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("dashboard", ip)) {
        return reply.code(429).header("Content-Type", "text/html; charset=utf-8").send(
          "<html><body><h1>Слишком много запросов</h1></body></html>",
        );
      }

      // Session gate: read cookie → sessionStore.get(id) → 302 /login if absent
      const cookieHeader = req.headers["cookie"] ?? "";
      const sessionId = extractSessionId(cookieHeader);
      if (!sessionId) {
        return reply.code(302).header("Location", "/login").send();
      }
      const session = sessionStore.get(sessionId);
      if (!session) {
        return reply.code(302).header("Location", "/login").send();
      }

      const query = req.query as Record<string, string | undefined>;
      // Validate ?status= before passing to repo — unknown values cause
      // PrismaClientValidationError (→ 500). Treat unknown value as no filter.
      const rawStatus = query["status"];
      const statusFilter: InvoiceStatus | undefined =
        rawStatus && KNOWN_STATUSES.has(rawStatus) ? (rawStatus as InvoiceStatus) : undefined;
      const eventIdFilter = query["eventId"];
      const cursor = query["cursor"];

      const PAGE_LIMIT = 100;

      const [invoices, summary] = await Promise.all([
        invoiceRepo.list({
          eventId: eventIdFilter,
          status: statusFilter,
          cursor,
          limit: PAGE_LIMIT,
        }),
        invoiceRepo.summary(eventIdFilter),
      ]);

      // Cursor for next page: if we got exactly PAGE_LIMIT rows, there may be more.
      // Encode the last row's id as a base64url JSON cursor.
      let nextCursor: string | undefined;
      if (invoices.length === PAGE_LIMIT) {
        const lastId = invoices[invoices.length - 1]?.id;
        if (lastId) {
          nextCursor = Buffer.from(JSON.stringify({ id: lastId })).toString("base64url");
        }
      }

      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;

      const html = renderDashboard(
        invoices,
        { totalCount: summary.totalCount, settledCount: summary.settledCount, pendingCount: summary.pendingCount, totalAmountReceived: summary.totalAmountReceived },
        { status: statusFilter, eventId: eventIdFilter, nextCursor, currentCursor: cursor },
        { script: cspNonce?.script, style: cspNonce?.style },
      );

      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(html);
    },
  );

  // ── GET /dashboard/invoices.csv ─────────────────────────────────────────────
  app.get(
    "/dashboard/invoices.csv",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("dashboard", ip)) {
        return reply.code(429).send("Rate limited");
      }

      // Session gate
      const cookieHeader = req.headers["cookie"] ?? "";
      const sessionId = extractSessionId(cookieHeader);
      if (!sessionId) {
        return reply.code(302).header("Location", "/login").send();
      }
      const session = sessionStore.get(sessionId);
      if (!session) {
        return reply.code(302).header("Location", "/login").send();
      }

      const query = req.query as Record<string, string | undefined>;
      // Validate ?status= — same guard as the dashboard route.
      const rawStatusCsv = query["status"];
      const statusFilter: InvoiceStatus | undefined =
        rawStatusCsv && KNOWN_STATUSES.has(rawStatusCsv) ? (rawStatusCsv as InvoiceStatus) : undefined;
      const eventIdFilter = query["eventId"];

      // Fetch all rows via cursor pagination. Cap at 10 000 rows to guard memory.
      // A note is logged if the cap is hit.
      const PAGE = 100;
      const MAX_ROWS = 10_000;
      const allRows: InvoiceRow[] = [];
      let cursor: string | undefined;
      let capped = false;

      while (true) {
        const batch = await invoiceRepo.list({
          eventId: eventIdFilter,
          status: statusFilter,
          cursor,
          limit: PAGE,
        });
        allRows.push(...batch);
        // Use > MAX_ROWS (not >=) so that at exactly MAX_ROWS we fetch one more
        // sentinel batch. If that returns 0 rows the loop exits cleanly without
        // setting capped; if it returns rows we know there are more than MAX_ROWS
        // and we trim to MAX_ROWS and set capped.
        if (allRows.length > MAX_ROWS) {
          capped = true;
          allRows.splice(MAX_ROWS); // keep exactly MAX_ROWS rows
          break;
        }
        if (batch.length < PAGE) break;
        const lastId = batch[batch.length - 1]?.id;
        if (!lastId) break;
        cursor = Buffer.from(JSON.stringify({ id: lastId })).toString("base64url");
      }

      if (capped) {
        app.log?.warn?.({ maxRows: MAX_ROWS }, "CSV export capped at MAX_ROWS rows");
      }

      const lines = [CSV_HEADER, ...allRows.map(invoiceToCsvRow)];
      const csvBody = lines.join("\r\n");

      const replyWithHeaders = reply
        .code(200)
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="invoices.csv"');

      // Surface truncation to the client via a response header so callers can
      // detect and warn operators that the export is incomplete.
      if (capped) {
        replyWithHeaders.header("X-Truncated-Rows", "true");
      }

      return replyWithHeaders.send(csvBody);
    },
  );

  // ── GET /dashboard/invoices/:id ─────────────────────────────────────────────
  //
  // NOTE: This route is registered AFTER /dashboard/invoices.csv so Fastify's
  // router resolves the exact path "invoices.csv" before the param path ":id".
  app.get(
    "/dashboard/invoices/:id",
    {
      config: {
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
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("dashboard", ip)) {
        return reply.code(429).header("Content-Type", "text/html; charset=utf-8").send(
          "<html><body><h1>Слишком много запросов</h1></body></html>",
        );
      }

      // Session gate — same as /dashboard
      const cookieHeader = req.headers["cookie"] ?? "";
      const sessionId = extractSessionId(cookieHeader);
      if (!sessionId) {
        return reply.code(302).header("Location", "/login").send();
      }
      const session = sessionStore.get(sessionId);
      if (!session) {
        return reply.code(302).header("Location", "/login").send();
      }

      const { id } = req.params as { id: string };
      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;

      const invoice = await invoiceRepo.findById(id);
      if (!invoice) {
        const html = renderDetailNotFound({ style: cspNonce?.style });
        return reply
          .code(404)
          .header("Content-Type", "text/html; charset=utf-8")
          .send(html);
      }

      const html = renderDetailPage(invoice, publicBaseUrl, {
        script: cspNonce?.script,
        style: cspNonce?.style,
      });
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(html);
    },
  );
}
