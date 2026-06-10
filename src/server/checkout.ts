/**
 * Checkout page renderer (spec §5).
 *
 * Server-renders pay.html with:
 * - Deposit address + exact USDT amount
 * - Countdown to expiresAt
 * - TRON · TRC-20 network badge + warning strip
 * - QR code of the deposit address (inline SVG via qrcode library)
 * - Client JS polling /v1/public/invoices/:id for live status
 * - Copy button via addEventListener (CSP script-src-attr blocks inline handlers)
 * - All user-facing text in Russian
 *
 * Design: "Vault" — premium dark fintech aesthetic. Deep dark background with
 * teal-green (#26A17B) accent. System fonts only (no CDN). Mobile-first.
 *
 * Checkout states:
 * - PENDING / payment_detected: normal pending UI (QR, address, countdown)
 * - SUCCESS (paid / overpaid): success panel, QR/address hidden
 * - TERMINAL-unpaid (expired / canceled / overdue): terminal panel, QR/address hidden
 */

import QRCode from "qrcode";
import type { InvoiceRow } from "../core/ports.js";

/** Render an SVG QR code for the given text. Returns inline <svg>…</svg>. */
async function generateQrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", margin: 2, width: 240 });
}

/** Escape HTML entities in a string. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function renderCheckout(invoice: InvoiceRow, scriptNonce?: string, styleNonce?: string): Promise<string> {
  const qrSvg = await generateQrSvg(invoice.depositAddress);

  const expiresAtMs = invoice.expiresAt.getTime();
  const invoiceId = invoice.id;
  const address = invoice.depositAddress;
  const amount = invoice.amountUsdt;
  const fiatAmount = invoice.priceFiat;
  const fiatCurrency = invoice.fiatCurrency;
  // amountReceived: the actual on-chain amount — shown in success panel.
  const amountReceived = invoice.amountReceived;

  // Determine initial state for server-side render.
  // SUCCESS: paid or overpaid — funds confirmed, show green confirmation.
  const isSuccess = invoice.status === "paid" || invoice.status === "overpaid";
  // TERMINAL-unpaid: expired, canceled, or overdue — payment window closed.
  const isTerminal = invoice.status === "expired" || invoice.status === "canceled" || invoice.status === "overdue";
  // overdue means late funds WERE received after a prior terminal state — the
  // merchant got money.  Show distinct copy so a customer who paid is not told
  // the invoice is "invalid/expired".
  const isOverdue = invoice.status === "overdue";
  // Pending UI: visible only when not in success or terminal state.
  const pendingUiHidden = isSuccess || isTerminal;

  const statusMap: Record<string, string> = {
    pending: "Ожидание оплаты",
    payment_detected: "Платёж обнаружен",
    paid: "Оплачено",
    underpaid: "Недостаточная оплата",
    overpaid: "Оплата превышена",
    expired: "Истёк срок",
    canceled: "Отменён",
    overdue: "Просрочен",
  };

  const statusLabel = statusMap[invoice.status] ?? invoice.status;

  const styleNonceAttr = styleNonce ? ` nonce="${styleNonce}"` : "";

  // CSS class helpers for conditional show/hide.
  const hiddenIf = (cond: boolean) => cond ? " hidden" : "";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Оплата USDT — ${esc(invoiceId)}</title>
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

    /* ── Utility ────────────────────────────────────────────── */
    .hidden { display: none !important; }

    /* ── Card ──────────────────────────────────────────────── */
    .card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.075);
      border-radius: 22px;
      padding: 2rem 1.875rem;
      max-width: 460px;
      width: 100%;
      box-shadow:
        0 0 0 1px rgba(38,161,123,0.07),
        0 32px 80px rgba(0,0,0,0.65),
        0 8px 24px rgba(0,0,0,0.4);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
    }

    /* ── Card header ───────────────────────────────────────── */
    .card-header {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      margin-bottom: 1.625rem;
    }
    .usdt-icon {
      width: 28px; height: 28px;
      background: #26A17B;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.9rem; font-weight: 900; color: #fff;
      flex-shrink: 0;
      letter-spacing: -0.04em;
      box-shadow: 0 0 12px rgba(38,161,123,0.4);
    }
    .card-title {
      font-size: 0.875rem;
      font-weight: 600;
      color: #64748b;
      letter-spacing: 0.01em;
    }

    /* ── Amount hero ───────────────────────────────────────── */
    .amount-section {
      text-align: center;
      padding: 1.375rem 0 1.25rem;
      border-bottom: 1px solid rgba(255,255,255,0.05);
      margin-bottom: 1.25rem;
    }
    .amount-primary {
      display: flex;
      align-items: baseline;
      justify-content: center;
      gap: 0.4rem;
      line-height: 1;
    }
    .amount-val {
      font-size: clamp(2.75rem, 9vw, 3.75rem);
      font-weight: 800;
      color: #f8fafc;
      letter-spacing: -0.04em;
      font-variant-numeric: tabular-nums;
    }
    .amount-currency {
      font-size: clamp(1.375rem, 4.5vw, 1.875rem);
      font-weight: 700;
      color: #26A17B;
      letter-spacing: -0.02em;
    }
    .amount-fiat {
      margin-top: 0.5rem;
      font-size: 0.8rem;
      color: #475569;
      font-variant-numeric: tabular-nums;
    }

    /* ── Network badge ─────────────────────────────────────── */
    .network-row {
      display: flex;
      justify-content: center;
      margin-bottom: 1.375rem;
    }
    .network-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: rgba(38,161,123,0.1);
      border: 1px solid rgba(38,161,123,0.28);
      color: #26A17B;
      padding: 0.3rem 0.9rem;
      border-radius: 100px;
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .badge-dot {
      width: 5px; height: 5px;
      background: #26A17B;
      border-radius: 50%;
      flex-shrink: 0;
      box-shadow: 0 0 4px rgba(38,161,123,0.8);
    }

    /* ── QR code ───────────────────────────────────────────── */
    .qr-section {
      display: flex;
      flex-direction: column;
      align-items: center;
      margin-bottom: 1.375rem;
    }
    .qr-wrap {
      background: #fff;
      border-radius: 14px;
      padding: 0.875rem;
      display: inline-block;
      box-shadow: 0 4px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(38,161,123,0.1);
    }
    .qr-wrap svg { display: block; }
    .qr-caption {
      margin-top: 0.5rem;
      font-size: 0.67rem;
      color: #2d3f50;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    /* ── Address ───────────────────────────────────────────── */
    .address-section { margin-bottom: 1.25rem; }
    .field-label {
      font-size: 0.67rem;
      font-weight: 700;
      color: #475569;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      margin-bottom: 0.375rem;
    }
    .address-wrap { position: relative; }
    .address {
      font-family: "SFMono-Regular", "SF Mono", "Consolas", "Liberation Mono", "Courier New", monospace;
      font-size: 0.74rem;
      background: rgba(0,0,0,0.35);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 10px;
      padding: 0.875rem 2.75rem 0.875rem 0.875rem;
      word-break: break-all;
      color: #7dd3fc;
      cursor: pointer;
      transition: background 0.18s, border-color 0.18s, color 0.18s;
      line-height: 1.65;
      display: block;
      width: 100%;
    }
    .address:hover {
      background: rgba(38,161,123,0.07);
      border-color: rgba(38,161,123,0.25);
      color: #bae6fd;
    }
    .copy-btn {
      position: absolute;
      right: 0.625rem;
      top: 50%;
      transform: translateY(-50%);
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 7px;
      cursor: pointer;
      color: #475569;
      padding: 0.375rem;
      line-height: 0;
      transition: color 0.15s, background 0.15s, border-color 0.15s;
    }
    .copy-btn:hover {
      color: #26A17B;
      background: rgba(38,161,123,0.1);
      border-color: rgba(38,161,123,0.3);
    }

    /* ── Copy-amount shortcut ──────────────────────────────── */
    .copy-amount-wrapper {
      margin-bottom: 1.25rem;
      display: flex;
      justify-content: flex-end;
    }
    .copy-amount-btn {
      display: inline-flex; align-items: center; gap: .4rem;
      background: rgba(38,161,123,.07);
      border: 1px solid rgba(38,161,123,.25);
      border-radius: 8px;
      color: #26A17B;
      font-size: .75rem; font-weight: 700;
      padding: .35rem .85rem;
      cursor: pointer;
      transition: background .15s, border-color .15s;
      font-family: inherit;
    }
    .copy-amount-btn:hover {
      background: rgba(38,161,123,.14);
      border-color: rgba(38,161,123,.4);
    }
    .copy-hint {
      margin-top: 0.3rem;
      font-size: 0.67rem;
      color: #2d3f50;
      padding-left: 0.125rem;
      transition: color 0.2s;
      min-height: 1.2em;
    }
    .copy-hint.copied { color: #26A17B; }

    /* ── Warning strip ─────────────────────────────────────── */
    .warning-strip {
      display: flex;
      align-items: flex-start;
      gap: 0.625rem;
      background: rgba(245,158,11,0.07);
      border: 1px solid rgba(245,158,11,0.2);
      border-radius: 10px;
      padding: 0.75rem 0.875rem;
      margin-bottom: 1.25rem;
    }
    .warning-strip svg { flex-shrink: 0; margin-top: 1px; color: #d97706; }
    .warning-text { font-size: 0.74rem; color: #92400e; line-height: 1.55; }
    .warning-text strong { color: #d97706; }

    /* ── Status + countdown ────────────────────────────────── */
    .status-section {
      background: rgba(0,0,0,0.25);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 0.875rem 1rem;
      margin-bottom: 1rem;
    }
    .status-row {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      margin-bottom: 0.45rem;
    }
    .status-dot {
      width: 10px; height: 10px;
      border-radius: 50%;
      background: #334155;
      flex-shrink: 0;
      transition: background 0.3s;
    }
    .status-dot.pending {
      background: #f59e0b;
      animation: pulse-amber 1.6s ease-in-out infinite;
    }
    .status-dot.payment_detected {
      background: #34d399;
      animation: pulse-green 1s ease-in-out infinite;
    }
    .status-dot.paid { background: #22c55e; }
    .status-dot.expired,
    .status-dot.canceled,
    .status-dot.overdue,
    .status-dot.underpaid { background: #ef4444; }
    .status-dot.overpaid { background: #f97316; }

    @keyframes pulse-amber {
      0%, 100% { box-shadow: 0 0 0 0 rgba(245,158,11,0); }
      50% { box-shadow: 0 0 0 5px rgba(245,158,11,0.18); }
    }
    @keyframes pulse-green {
      0%, 100% { box-shadow: 0 0 0 0 rgba(52,211,153,0); }
      50% { box-shadow: 0 0 0 5px rgba(52,211,153,0.2); }
    }

    #status-text {
      font-size: 0.825rem;
      font-weight: 600;
      color: #cbd5e1;
    }
    .countdown-row {
      font-size: 0.77rem;
      color: #2d3f50;
      padding-left: 1.375rem;
    }
    #countdown-val {
      font-weight: 700;
      color: #64748b;
      font-variant-numeric: tabular-nums;
    }
    #countdown-val.urgent { color: #ef4444; }

    /* ── Success panel (paid / overpaid) ───────────────────── */
    .success-panel {
      background: linear-gradient(135deg, rgba(20,83,45,0.90), rgba(14,57,32,0.75));
      border: 1px solid rgba(34,197,94,0.35);
      border-radius: 16px;
      padding: 1.75rem 1.5rem;
      text-align: center;
      margin-top: 0.25rem;
      animation: fade-in-up 0.4s ease both;
    }
    .success-icon-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 1rem;
    }
    .success-icon-circle {
      width: 64px; height: 64px;
      background: rgba(34,197,94,0.15);
      border: 2px solid rgba(34,197,94,0.45);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 0 24px rgba(34,197,94,0.2);
    }
    .success-icon-circle svg { color: #22c55e; }
    .success-title {
      font-size: 1.375rem;
      font-weight: 800;
      color: #86efac;
      letter-spacing: -0.02em;
      margin-bottom: 0.5rem;
    }
    .success-amount-line {
      font-size: 0.9rem;
      font-weight: 700;
      color: #4ade80;
      font-variant-numeric: tabular-nums;
      margin-bottom: 0.625rem;
    }
    .success-amount-line span { color: #86efac; }
    .success-note {
      font-size: 0.78rem;
      color: #166534;
      line-height: 1.5;
    }

    @keyframes fade-in-up {
      from { opacity: 0; transform: translateY(10px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* ── Terminal panel (expired / canceled / overdue) ─────── */
    .terminal-panel {
      background: rgba(30,10,10,0.6);
      border: 1px solid rgba(239,68,68,0.25);
      border-radius: 16px;
      padding: 1.75rem 1.5rem;
      text-align: center;
      margin-top: 0.25rem;
    }
    .terminal-icon-wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 1rem;
    }
    .terminal-icon-circle {
      width: 64px; height: 64px;
      background: rgba(239,68,68,0.1);
      border: 2px solid rgba(239,68,68,0.3);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
    }
    .terminal-icon-circle svg { color: #ef4444; }
    .terminal-title {
      font-size: 1.125rem;
      font-weight: 700;
      color: #fca5a5;
      letter-spacing: -0.01em;
      margin-bottom: 0.5rem;
    }
    .terminal-note {
      font-size: 0.78rem;
      color: #7f1d1d;
      line-height: 1.55;
    }

    /* ── Security footer ───────────────────────────────────── */
    .security-note {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.375rem;
      margin-top: 1.25rem;
      padding-top: 1rem;
      border-top: 1px solid rgba(255,255,255,0.04);
      font-size: 0.67rem;
      color: #1e293b;
      letter-spacing: 0.02em;
    }
    .security-note svg { color: #26A17B; opacity: 0.7; flex-shrink: 0; }

    /* ── Responsive ────────────────────────────────────────── */
    @media (max-width: 480px) {
      body {
        align-items: flex-start;
        padding: 1rem 0.5rem;
        padding-top: 1.25rem;
      }
      .card {
        border-radius: 18px;
        padding: 1.625rem 1.25rem;
      }
    }
  </style>
</head>
<body>
<div class="card">

  <!-- Header -->
  <div class="card-header">
    <div class="usdt-icon">&#x20AE;</div>
    <span class="card-title">Оплата счёта</span>
  </div>

  <!-- Amount hero -->
  <div class="amount-section">
    <div class="amount-primary">
      <span class="amount-val">${esc(amount)}</span>
      <span class="amount-currency">USDT</span>
    </div>
    <div class="amount-fiat">&#x2248; ${esc(fiatAmount)}&nbsp;${esc(fiatCurrency)}</div>
  </div>

  <!-- Network badge: TRON TRC-20 -->
  <div class="network-row">
    <span class="network-badge">
      <span class="badge-dot"></span>
      TRON &middot; TRC-20
    </span>
  </div>

  <!-- QR code: hidden on success/terminal initial render -->
  <div class="qr-section${hiddenIf(pendingUiHidden)}">
    <div class="qr-wrap">${qrSvg}</div>
    <span class="qr-caption">Отсканируйте для оплаты</span>
  </div>

  <!-- Deposit address: hidden on success/terminal initial render -->
  <div class="address-section${hiddenIf(pendingUiHidden)}">
    <div class="field-label">Адрес для оплаты (Tron TRC-20)</div>
    <div class="address-wrap">
      <div class="address" id="addr">${esc(address)}</div>
      <button class="copy-btn" id="copy-btn" type="button" aria-label="Скопировать адрес">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </button>
    </div>
    <p class="copy-hint" id="copy-hint">Нажмите на адрес для копирования</p>
  </div>

  <!-- Copy-amount shortcut: hidden on success/terminal initial render -->
  <div class="copy-amount-wrapper${hiddenIf(pendingUiHidden)}">
    <button id="copy-amount-btn" class="copy-amount-btn" type="button" aria-label="Скопировать сумму USDT">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      Скопировать сумму
    </button>
  </div>

  <!-- Warning: TRON TRC-20 only — hidden on success/terminal initial render -->
  <div class="warning-strip${hiddenIf(pendingUiHidden)}">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
    <p class="warning-text">
      <strong>Только USDT на сети TRON (TRC-20).</strong>
      Другие токены и сети приведут к безвозвратной потере средств.
    </p>
  </div>

  <!-- Live status + countdown: hidden on success/terminal initial render -->
  <div class="status-section${hiddenIf(pendingUiHidden)}">
    <div class="status-row">
      <div class="status-dot ${esc(invoice.status)}" id="status-dot"></div>
      <span id="status-text">${esc(statusLabel)}</span>
    </div>
    <div class="countdown-row">
      Действителен до:&nbsp;<span id="countdown-val"></span>
    </div>
  </div>

  <!-- Success panel (paid / overpaid): shown immediately for settled initial state,
       otherwise hidden and revealed by client JS on poll transition. -->
  <div class="success-panel${hiddenIf(!isSuccess)}" id="success-panel">
    <div class="success-icon-wrap">
      <div class="success-icon-circle">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
    </div>
    <div class="success-title">Оплачено ✓</div>
    <div class="success-amount-line" id="success-amount-line">
      <span id="success-amount">${esc(amountReceived)}</span> USDT
    </div>
    <div class="success-note">Платёж подтверждён. Спасибо!</div>
  </div>

  <!-- Terminal panel (expired / canceled / overdue): shown immediately for terminal
       initial state, otherwise hidden and revealed by client JS on poll transition. -->
  <div class="terminal-panel${hiddenIf(!isTerminal)}" id="terminal-panel">
    <div class="terminal-icon-wrap">
      <div class="terminal-icon-circle">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
      </div>
    </div>
    <div class="terminal-title">${isOverdue ? "Платёж получен с опозданием" : "Срок оплаты истёк"}</div>
    <div class="terminal-note">${isOverdue
      ? "Свяжитесь с продавцом для подтверждения зачисления средств."
      : "Этот счёт недействителен. Свяжитесь с продавцом для создания нового счёта."}</div>
  </div>

  <!-- Security footer -->
  <div class="security-note">
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
    Защищённое соединение &middot; Оплата через USDT / TRC-20
  </div>

</div>

<script${scriptNonce ? ` nonce="${scriptNonce}"` : ""}>
  const INVOICE_ID = ${JSON.stringify(invoiceId)};
  const EXPIRES_AT = ${expiresAtMs};
  const AMOUNT_USDT = ${JSON.stringify(amount)};
  const POLL_INTERVAL = 5000;

  const statusLabels = {
    pending: "Ожидание оплаты",
    payment_detected: "Платёж обнаружен",
    paid: "Оплачено",
    underpaid: "Недостаточная оплата",
    overpaid: "Оплата превышена",
    expired: "Истёк срок",
    canceled: "Отменён",
    overdue: "Просрочен"
  };

  function updateCountdown() {
    const rem = EXPIRES_AT - Date.now();
    const el = document.getElementById("countdown-val");
    if (!el) return;
    if (rem <= 0) {
      el.textContent = "Истёк";
      el.className = "urgent";
      return;
    }
    const m = Math.floor(rem / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    el.textContent = m + ":" + String(s).padStart(2, "0");
    el.className = rem < 120000 ? "urgent" : "";
  }

  function copyAddress() {
    const addr = document.getElementById("addr");
    const hint = document.getElementById("copy-hint");
    if (!addr) return;
    navigator.clipboard.writeText(addr.textContent || "").then(function() {
      if (hint) {
        hint.textContent = "Скопировано!";
        hint.classList.add("copied");
        setTimeout(function() {
          hint.textContent = "Нажмите на адрес для копирования";
          hint.classList.remove("copied");
        }, 2000);
      }
    });
  }

  /**
   * Apply the SUCCESS state: reveal the success panel, hide pending-only UI.
   * Uses CSS classes to avoid inline style= attributes (CSP compliance).
   */
  function applySuccessState(receivedAmount) {
    var pendingEls = ["qr-section", "address-section", "copy-amount-wrapper", "warning-strip", "status-section"];
    pendingEls.forEach(function(id) {
      var el = document.querySelector("." + id);
      if (el) el.classList.add("hidden");
    });
    var panel = document.getElementById("success-panel");
    if (panel) panel.classList.remove("hidden");
    var amtEl = document.getElementById("success-amount");
    if (amtEl && receivedAmount) amtEl.textContent = receivedAmount;
  }

  /**
   * Apply the TERMINAL state: reveal the terminal panel, hide pending-only UI.
   * Uses CSS classes to avoid inline style= attributes (CSP compliance).
   */
  function applyTerminalState() {
    var pendingEls = ["qr-section", "address-section", "copy-amount-wrapper", "warning-strip", "status-section"];
    pendingEls.forEach(function(id) {
      var el = document.querySelector("." + id);
      if (el) el.classList.add("hidden");
    });
    var panel = document.getElementById("terminal-panel");
    if (panel) panel.classList.remove("hidden");
  }

  let terminated = false;

  async function pollStatus() {
    if (terminated) return;
    try {
      const res = await fetch("/v1/public/invoices/" + INVOICE_ID);
      if (!res.ok) return;
      const { data } = await res.json();
      if (!data) return;
      const dot = document.getElementById("status-dot");
      const txt = document.getElementById("status-text");
      if (dot) { dot.className = "status-dot " + data.status; }
      if (txt) { txt.textContent = statusLabels[data.status] || data.status; }
      if (data.status === "paid" || data.status === "overpaid") {
        // Use amountUsdt as the displayed amount — amountReceived is not in the
        // public API response. For paid this equals the received amount exactly;
        // for overpaid it shows the invoiced amount (conservative, no over-credit).
        applySuccessState(data.amountUsdt);
        terminated = true;
      } else if (data.status === "expired" || data.status === "canceled" || data.status === "overdue" || data.status === "underpaid") {
        // underpaid is in TERMINAL_STATUSES (lifecycle.ts) — polling must stop here;
        // any new funds on an underpaid address route to overdue/late_funds, never paid.
        applyTerminalState();
        terminated = true;
      }
    } catch (_) { /* network error, retry next interval */ }
  }

  // Bind copy interaction via addEventListener (CSP script-src-attr blocks inline handlers).
  document.getElementById("addr")?.addEventListener("click", copyAddress);
  document.getElementById("copy-btn")?.addEventListener("click", copyAddress);

  // Copy-amount button — copies invoice.amountUsdt to clipboard.
  // QR payload is unchanged (bare address — wallets expect a plain address, not a URI).
  function copyAmount() {
    var btn = document.getElementById("copy-amount-btn");
    navigator.clipboard.writeText(AMOUNT_USDT).then(function() {
      if (btn) {
        var prev = btn.textContent;
        btn.textContent = "Скопировано!";
        setTimeout(function() { btn.textContent = prev; }, 2000);
      }
    });
  }
  document.getElementById("copy-amount-btn")?.addEventListener("click", copyAmount);

  updateCountdown();
  setInterval(updateCountdown, 1000);
  setInterval(pollStatus, POLL_INTERVAL);
  pollStatus();
</script>
</body>
</html>`;
}
