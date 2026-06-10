/**
 * Public API documentation page.
 *
 * GET /docs — static Vault-style HTML page; no auth, no data.
 *
 * Documents the REAL integration surface:
 *   - Public/merchant API endpoints (invoices create, public invoice status)
 *   - Webhook admin endpoints
 *   - Invoice lifecycle + statuses
 *   - Webhook event payload shape
 *   - X-Stablerails-Signature HMAC signing scheme + verification snippet
 *
 * CSP: nonce-locked style-src and script-src (enableCSPNonces).
 * No inline style= attributes — all CSS in a single nonce'd <style> block.
 * Copy buttons use a nonce'd <script> block only.
 * All user-facing text in English (integration docs).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// ── HTML escape ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// esc used only for forward-compat safety; suppress unused warning.
void esc;

// ── Page renderer ─────────────────────────────────────────────────────────────

function renderDocs(styleNonce?: string, scriptNonce?: string): string {
  const styleNonceAttr = styleNonce ? ` nonce="${styleNonce}"` : "";
  const scriptNonceAttr = scriptNonce ? ` nonce="${scriptNonce}"` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API Docs — Stablerails</title>
  <style${styleNonceAttr}>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
      background: #06090c;
      background-image:
        radial-gradient(ellipse 90% 55% at 50% -5%, rgba(38,161,123,0.10) 0%, transparent 65%),
        radial-gradient(ellipse 55% 65% at 95% 105%, rgba(38,161,123,0.05) 0%, transparent 55%);
      color: #e2e8f0;
      min-height: 100vh;
      padding: 2.5rem 1rem 4rem;
    }
    .page-wrap { max-width: 860px; margin: 0 auto; }
    .page-header {
      display: flex; align-items: center; gap: .75rem;
      margin-bottom: 2.5rem;
    }
    .usdt-icon {
      width: 30px; height: 30px; background: #26A17B; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: .95rem; font-weight: 900; color: #fff; flex-shrink: 0;
      box-shadow: 0 0 12px rgba(38,161,123,.4);
    }
    .page-title { font-size: 1.4rem; font-weight: 800; color: #f1f5f9; }
    .page-subtitle { font-size: .85rem; color: #475569; margin-top: .2rem; }
    /* ── Section ──────────────────────────────────────────────────────── */
    .section { margin-bottom: 2.5rem; }
    .section-title {
      font-size: .65rem; font-weight: 700; color: #26A17B;
      text-transform: uppercase; letter-spacing: .12em;
      margin-bottom: 1rem; padding-bottom: .4rem;
      border-bottom: 1px solid rgba(38,161,123,.18);
    }
    /* ── Endpoint card ────────────────────────────────────────────────── */
    .endpoint {
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 12px; padding: 1.1rem 1.25rem;
      margin-bottom: .75rem;
    }
    .endpoint-header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: .55rem; flex-wrap: wrap; }
    .method {
      font-family: "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", monospace;
      font-size: .72rem; font-weight: 800; letter-spacing: .07em;
      padding: .2rem .55rem; border-radius: 6px;
    }
    .method-post { background: rgba(59,130,246,.18); color: #93c5fd; border: 1px solid rgba(59,130,246,.3); }
    .method-get  { background: rgba(34,197,94,.12);  color: #86efac;  border: 1px solid rgba(34,197,94,.25); }
    .method-del  { background: rgba(239,68,68,.12);  color: #fca5a5;  border: 1px solid rgba(239,68,68,.25); }
    .path {
      font-family: "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", monospace;
      font-size: .88rem; color: #e2e8f0; font-weight: 600;
    }
    .auth-badge {
      font-size: .65rem; font-weight: 700; padding: .15rem .5rem; border-radius: 100px;
      margin-left: auto;
    }
    .auth-none     { background: rgba(71,85,105,.18); color: #64748b; border: 1px solid rgba(71,85,105,.3); }
    .auth-merchant { background: rgba(168,85,247,.12); color: #d8b4fe; border: 1px solid rgba(168,85,247,.25); }
    .auth-admin    { background: rgba(239,68,68,.12);  color: #fca5a5; border: 1px solid rgba(239,68,68,.25); }
    .auth-readonly { background: rgba(14,165,233,.12); color: #7dd3fc; border: 1px solid rgba(14,165,233,.25); }
    .endpoint-desc { font-size: .82rem; color: #94a3b8; line-height: 1.55; margin-bottom: .65rem; }
    /* ── Params table ─────────────────────────────────────────────────── */
    .params-label {
      font-size: .63rem; font-weight: 700; color: #475569;
      text-transform: uppercase; letter-spacing: .1em; margin-bottom: .4rem;
    }
    .params-table { width: 100%; border-collapse: collapse; font-size: .8rem; }
    .params-table th {
      text-align: left; padding: .3rem .6rem;
      font-size: .62rem; font-weight: 700; color: #334155;
      text-transform: uppercase; letter-spacing: .08em;
      border-bottom: 1px solid rgba(255,255,255,.05);
    }
    .params-table td { padding: .3rem .6rem; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,.03); vertical-align: top; }
    .params-table tr:last-child td { border-bottom: none; }
    .param-name { font-family: "SFMono-Regular","SF Mono",Consolas,"Liberation Mono",monospace; color: #e2e8f0; }
    .param-type { font-family: "SFMono-Regular","SF Mono",Consolas,"Liberation Mono",monospace; color: #26A17B; font-size: .75rem; }
    .param-req   { color: #f87171; font-size: .7rem; font-weight: 700; }
    .param-opt   { color: #475569; font-size: .7rem; }
    /* ── Code block ───────────────────────────────────────────────────── */
    .code-block {
      background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.07);
      border-radius: 8px; padding: .85rem 1rem;
      font-family: "SFMono-Regular","SF Mono",Consolas,"Liberation Mono",monospace;
      font-size: .78rem; color: #e2e8f0; line-height: 1.65;
      overflow-x: auto; position: relative; margin-top: .65rem;
    }
    .code-block .comment { color: #334155; }
    .code-block .key { color: #7dd3fc; }
    .code-block .val { color: #86efac; }
    .code-block .str { color: #fde68a; }
    .code-copy-btn {
      position: absolute; top: .5rem; right: .5rem;
      background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1);
      border-radius: 5px; color: #475569; font-size: .7rem;
      padding: .2rem .55rem; cursor: pointer;
      transition: color .15s, background .15s;
    }
    .code-copy-btn:hover { color: #26A17B; background: rgba(38,161,123,.1); }
    /* ── Status badge grid ────────────────────────────────────────────── */
    .status-grid { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: .6rem; }
    .status-pill {
      font-size: .72rem; font-weight: 700; padding: .25rem .7rem;
      border-radius: 100px; letter-spacing: .05em;
    }
    .s-pending          { background: rgba(245,158,11,.12); color: #fbbf24; border: 1px solid rgba(245,158,11,.3); }
    .s-payment_detected { background: rgba(52,211,153,.12); color: #34d399; border: 1px solid rgba(52,211,153,.3); }
    .s-paid             { background: rgba(34,197,94,.14);  color: #22c55e; border: 1px solid rgba(34,197,94,.35); }
    .s-underpaid        { background: rgba(249,115,22,.12); color: #fb923c; border: 1px solid rgba(249,115,22,.3); }
    .s-overpaid         { background: rgba(249,115,22,.12); color: #fb923c; border: 1px solid rgba(249,115,22,.3); }
    .s-expired          { background: rgba(239,68,68,.10);  color: #f87171; border: 1px solid rgba(239,68,68,.25); }
    .s-canceled         { background: rgba(239,68,68,.10);  color: #f87171; border: 1px solid rgba(239,68,68,.25); }
    .s-overdue          { background: rgba(239,68,68,.10);  color: #f87171; border: 1px solid rgba(239,68,68,.25); }
    /* ── Lifecycle flow ───────────────────────────────────────────────── */
    .lifecycle-flow { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin-top: .65rem; font-size: .78rem; }
    .lf-arrow { color: #334155; }
    /* ── Info box ─────────────────────────────────────────────────────── */
    .info-box {
      background: rgba(38,161,123,.07); border: 1px solid rgba(38,161,123,.2);
      border-radius: 10px; padding: .85rem 1rem; margin-top: .65rem;
      font-size: .82rem; color: #86efac; line-height: 1.6;
    }
    /* ── Spacer between lifecycle flow and table ─────────────────────── */
    .status-spacer { margin-top: .85rem; }
    /* ── Responsive ───────────────────────────────────────────────────── */
    @media (max-width: 600px) {
      .endpoint-header { gap: .5rem; }
      .auth-badge { margin-left: 0; }
    }
  </style>
</head>
<body>
<div class="page-wrap">

  <!-- Header -->
  <div class="page-header">
    <div class="usdt-icon">&#x20AE;</div>
    <div>
      <div class="page-title">Stablerails — API Reference</div>
      <div class="page-subtitle">Integration guide for merchants and operators</div>
    </div>
  </div>

  <!-- ── Authentication ─────────────────────────────────────────────────────── -->
  <div class="section">
    <div class="section-title">Authentication</div>
    <div class="endpoint">
      <div class="endpoint-desc">
        All API routes (except public status endpoints) require a Bearer token in the
        <code>Authorization</code> header. Keys have three scope levels:
      </div>
      <table class="params-table">
        <thead><tr><th>Scope</th><th>Capabilities</th></tr></thead>
        <tbody>
          <tr><td class="param-name">readonly</td><td>Read events, invoices, webhooks, API key metadata. Cannot write anything.</td></tr>
          <tr><td class="param-name">merchant</td><td>Create and cancel invoices + all readonly operations.</td></tr>
          <tr><td class="param-name">admin</td><td>Full control: key management, webhook registration, sweeps + all above.</td></tr>
        </tbody>
      </table>
      <div class="code-block">
        <button class="code-copy-btn" data-copy="Authorization: Bearer &lt;your-api-key&gt;">Copy</button>
Authorization: Bearer &lt;your-api-key&gt;
      </div>
    </div>
  </div>

  <!-- ── Invoice Endpoints ──────────────────────────────────────────────────── -->
  <div class="section">
    <div class="section-title">Invoice Endpoints</div>

    <!-- POST /v1/invoices -->
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">POST</span>
        <span class="path">/v1/invoices</span>
        <span class="auth-badge auth-merchant">merchant</span>
      </div>
      <div class="endpoint-desc">
        Create a new payment invoice. Returns the invoice with a deposit address and a
        hosted checkout URL. Supports <code>Idempotency-Key</code> header to prevent
        duplicate creation on network retries.
      </div>
      <div class="params-label">Request body (JSON)</div>
      <table class="params-table">
        <thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
        <tbody>
          <tr>
            <td class="param-name">eventId</td>
            <td class="param-type">string</td>
            <td class="param-req">required</td>
            <td>ID of the event this invoice belongs to.</td>
          </tr>
          <tr>
            <td class="param-name">priceFiat</td>
            <td class="param-type">string</td>
            <td class="param-req">required</td>
            <td>Fiat price as a decimal string, e.g. <code>"50.00"</code>.</td>
          </tr>
          <tr>
            <td class="param-name">fiatCurrency</td>
            <td class="param-type">string</td>
            <td class="param-req">required</td>
            <td>ISO 4217 currency code, e.g. <code>"USD"</code>.</td>
          </tr>
          <tr>
            <td class="param-name">ttlMinutes</td>
            <td class="param-type">integer</td>
            <td class="param-opt">optional</td>
            <td>Invoice validity in minutes (1–1440). Defaults to 30.</td>
          </tr>
          <tr>
            <td class="param-name">expiresInSeconds</td>
            <td class="param-type">number</td>
            <td class="param-opt">optional</td>
            <td>Alias for ttlMinutes (seconds). Ignored when ttlMinutes is present.</td>
          </tr>
          <tr>
            <td class="param-name">metadata</td>
            <td class="param-type">object</td>
            <td class="param-opt">optional</td>
            <td>Arbitrary key-value pairs stored with the invoice.</td>
          </tr>
        </tbody>
      </table>
      <div class="code-block">
        <button class="code-copy-btn" data-copy='{"eventId":"evt_abc","priceFiat":"50.00","fiatCurrency":"USD","ttlMinutes":60}'>Copy</button>
<span class="comment">// Request</span>
{
  <span class="key">"eventId"</span>: <span class="str">"evt_abc"</span>,
  <span class="key">"priceFiat"</span>: <span class="str">"50.00"</span>,
  <span class="key">"fiatCurrency"</span>: <span class="str">"USD"</span>,
  <span class="key">"ttlMinutes"</span>: <span class="val">60</span>
}

<span class="comment">// Response 201</span>
{
  <span class="key">"data"</span>: {
    <span class="key">"id"</span>: <span class="str">"inv_..."</span>,
    <span class="key">"status"</span>: <span class="str">"pending"</span>,
    <span class="key">"amountUsdt"</span>: <span class="str">"50.500000"</span>,
    <span class="key">"depositAddress"</span>: <span class="str">"T..."</span>,
    <span class="key">"expiresAt"</span>: <span class="str">"2026-01-01T01:00:00.000Z"</span>,
    <span class="key">"hostedUrl"</span>: <span class="str">"https://pay.example.com/pay/inv_..."</span>
  }
}
      </div>
    </div>

    <!-- GET /v1/invoices -->
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="path">/v1/invoices</span>
        <span class="auth-badge auth-readonly">readonly+</span>
      </div>
      <div class="endpoint-desc">
        List invoices. Supports filtering and cursor-based pagination.
      </div>
      <div class="params-label">Query parameters</div>
      <table class="params-table">
        <thead><tr><th>Param</th><th>Type</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td class="param-name">eventId</td><td class="param-type">string</td><td>Filter by event ID.</td></tr>
          <tr><td class="param-name">status</td><td class="param-type">string</td><td>Filter by invoice status (see lifecycle below).</td></tr>
          <tr><td class="param-name">q</td><td class="param-type">string</td><td>Full-text search on invoice fields.</td></tr>
          <tr><td class="param-name">metadata.KEY</td><td class="param-type">string</td><td>Filter by metadata field, e.g. <code>metadata.orderId=123</code>.</td></tr>
          <tr><td class="param-name">cursor</td><td class="param-type">string</td><td>Pagination cursor from previous response.</td></tr>
          <tr><td class="param-name">limit</td><td class="param-type">integer</td><td>Page size (1–100, default 20).</td></tr>
        </tbody>
      </table>
    </div>

    <!-- GET /v1/invoices/:id -->
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="path">/v1/invoices/:id</span>
        <span class="auth-badge auth-readonly">readonly+</span>
      </div>
      <div class="endpoint-desc">
        Get a single invoice with its detected payments and confirmation counts.
      </div>
    </div>

    <!-- POST /v1/invoices/:id/cancel -->
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">POST</span>
        <span class="path">/v1/invoices/:id/cancel</span>
        <span class="auth-badge auth-merchant">merchant</span>
      </div>
      <div class="endpoint-desc">
        Cancel a pending invoice. Returns 409 if the invoice is not in a cancellable state.
      </div>
    </div>
  </div>

  <!-- ── Public Endpoints (no auth) ────────────────────────────────────────── -->
  <div class="section">
    <div class="section-title">Public Endpoints (no auth required)</div>

    <!-- GET /v1/public/invoices/:id -->
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="path">/v1/public/invoices/:id</span>
        <span class="auth-badge auth-none">public</span>
      </div>
      <div class="endpoint-desc">
        Sanitized invoice status for checkout page polling. Returns a limited subset of
        invoice fields — no fiat price, no metadata.
      </div>
      <div class="code-block">
<span class="comment">// Response 200 — sanitized fields only</span>
{
  <span class="key">"data"</span>: {
    <span class="key">"id"</span>: <span class="str">"inv_..."</span>,
    <span class="key">"status"</span>: <span class="str">"pending"</span>,
    <span class="key">"amountUsdt"</span>: <span class="str">"50.500000"</span>,
    <span class="key">"depositAddress"</span>: <span class="str">"T..."</span>,
    <span class="key">"expiresAt"</span>: <span class="str">"2026-01-01T01:00:00.000Z"</span>,
    <span class="key">"network"</span>: <span class="str">"TRON"</span>,
    <span class="key">"paidAt"</span>: <span class="val">null</span>
  }
}
      </div>
    </div>

    <!-- GET /pay/:invoiceId -->
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="path">/pay/:invoiceId</span>
        <span class="auth-badge auth-none">public</span>
      </div>
      <div class="endpoint-desc">
        Hosted checkout page. Polls <code>/v1/public/invoices/:id</code> to update status
        in real-time. Use <code>hostedUrl</code> from the invoice create response to redirect
        your customer here.
      </div>
    </div>
  </div>

  <!-- ── Webhook Admin Endpoints ────────────────────────────────────────────── -->
  <div class="section">
    <div class="section-title">Webhook Admin Endpoints</div>

    <!-- POST /v1/webhooks -->
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">POST</span>
        <span class="path">/v1/webhooks</span>
        <span class="auth-badge auth-admin">admin</span>
      </div>
      <div class="endpoint-desc">
        Register a webhook endpoint. The server generates a random signing secret unless
        you provide one. The secret is returned <strong>only once</strong> at creation — store it securely.
      </div>
      <div class="params-label">Request body (JSON)</div>
      <table class="params-table">
        <thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
        <tbody>
          <tr>
            <td class="param-name">url</td>
            <td class="param-type">string</td>
            <td class="param-req">required</td>
            <td>HTTPS endpoint URL. Must be publicly reachable. Private IPs are rejected.</td>
          </tr>
          <tr>
            <td class="param-name">eventId</td>
            <td class="param-type">string</td>
            <td class="param-opt">optional</td>
            <td>Scope deliveries to a single event. Omit to receive all events.</td>
          </tr>
          <tr>
            <td class="param-name">secret</td>
            <td class="param-type">string</td>
            <td class="param-opt">optional</td>
            <td>Custom signing secret. Auto-generated (40 hex chars) if not provided.</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- GET /v1/webhooks -->
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-get">GET</span>
        <span class="path">/v1/webhooks</span>
        <span class="auth-badge auth-readonly">readonly+</span>
      </div>
      <div class="endpoint-desc">
        List all registered webhook endpoints. Secrets are not returned in list responses.
      </div>
    </div>

    <!-- DELETE /v1/webhooks/:id -->
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-del">DELETE</span>
        <span class="path">/v1/webhooks/:id</span>
        <span class="auth-badge auth-admin">admin</span>
      </div>
      <div class="endpoint-desc">
        Delete a webhook endpoint. Returns 204 on success.
      </div>
    </div>

    <!-- POST /v1/webhooks/test -->
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="method method-post">POST</span>
        <span class="path">/v1/webhooks/test</span>
        <span class="auth-badge auth-admin">admin</span>
      </div>
      <div class="endpoint-desc">
        Send a signed <code>webhook.test</code> event to a registered endpoint to verify
        connectivity and HMAC verification.
      </div>
      <div class="params-label">Request body (JSON)</div>
      <table class="params-table">
        <thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
        <tbody>
          <tr>
            <td class="param-name">endpointId</td>
            <td class="param-type">string</td>
            <td class="param-req">required</td>
            <td>ID of the registered webhook endpoint to test.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- ── Invoice Lifecycle ──────────────────────────────────────────────────── -->
  <div class="section">
    <div class="section-title">Invoice Lifecycle &amp; Statuses</div>

    <div class="endpoint">
      <div class="endpoint-desc">
        Invoices move through the following statuses:
      </div>

      <div class="lifecycle-flow">
        <span class="status-pill s-pending">pending</span>
        <span class="lf-arrow">&#8594;</span>
        <span class="status-pill s-payment_detected">payment_detected</span>
        <span class="lf-arrow">&#8594;</span>
        <span class="status-pill s-paid">paid</span>
      </div>

      <div class="status-grid">
        <span class="status-pill s-pending">pending</span>
        <span class="status-pill s-payment_detected">payment_detected</span>
        <span class="status-pill s-paid">paid</span>
        <span class="status-pill s-underpaid">underpaid</span>
        <span class="status-pill s-overpaid">overpaid</span>
        <span class="status-pill s-expired">expired</span>
        <span class="status-pill s-canceled">canceled</span>
        <span class="status-pill s-overdue">overdue</span>
      </div>

      <div class="status-spacer"></div>
      <table class="params-table">
        <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td class="param-name">pending</td><td>Waiting for payment. Deposit address assigned.</td></tr>
          <tr><td class="param-name">payment_detected</td><td>On-chain payment seen but not yet in a solid (finalized) block.</td></tr>
          <tr><td class="param-name">paid</td><td>Payment confirmed in a solid block. Both RPCs agree. Terminal.</td></tr>
          <tr><td class="param-name">underpaid</td><td>Amount received is less than the required USDT amount.</td></tr>
          <tr><td class="param-name">overpaid</td><td>Amount received exceeds the required USDT amount.</td></tr>
          <tr><td class="param-name">expired</td><td>TTL elapsed with no confirmed payment. Terminal.</td></tr>
          <tr><td class="param-name">canceled</td><td>Explicitly canceled via API. Terminal.</td></tr>
          <tr><td class="param-name">overdue</td><td>Past expiry but a partial payment was detected.</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- ── Webhook Integration ────────────────────────────────────────────────── -->
  <div class="section">
    <div class="section-title">Webhook Integration</div>

    <!-- Payload shape -->
    <div class="endpoint">
      <div class="endpoint-desc">
        The server POSTs a JSON payload to your endpoint for every invoice lifecycle event.
        Each delivery includes an <code>eventUid</code> for idempotency — store it to
        deduplicate retries.
      </div>

      <div class="params-label">Event payload shape</div>
      <div class="code-block">
{
  <span class="key">"eventUid"</span>: <span class="str">"invoice.paid:inv_abc:wh_3f9a:3"</span>,
  <span class="key">"eventType"</span>: <span class="str">"invoice.paid"</span>,
  <span class="key">"version"</span>: <span class="val">3</span>,
  <span class="comment">// ...invoice-specific payload fields...</span>
}
      </div>
      <div class="info-box">
        <strong>eventUid format:</strong> <code>{eventType}:{invoiceId}:{endpointId}:{version}</code>.
        This value is stable across retry attempts — use it as your idempotency key.
        The <code>version</code> is a monotonic counter per (invoice, endpoint) pair and
        increments only when a new lifecycle event fires, not per delivery attempt.
      </div>

      <div class="info-box">
        <strong>Retry schedule:</strong> failed deliveries are retried up to 9 times with
        exponential backoff: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h, 24 h, 24 h
        (~92 h total window). After exhausting retries the delivery moves to a dead-letter
        queue and an alert is logged.
      </div>
    </div>

    <!-- HMAC signing -->
    <div class="endpoint">
      <div class="endpoint-header">
        <span class="path">X-Stablerails-Signature</span>
      </div>
      <div class="endpoint-desc">
        Every webhook POST is signed with HMAC-SHA256 using the endpoint secret.
        The signature is in the <code>X-Stablerails-Signature</code> header:
      </div>

      <div class="code-block">
X-Stablerails-Signature: t=&lt;unixSeconds&gt;,v1=&lt;hex-hmac-sha256&gt;

<span class="comment">// Signed payload = "&lt;t&gt;.&lt;rawBody&gt;" (timestamp + dot + the exact POST body)</span>
<span class="comment">// Algorithm: HMAC-SHA256</span>
<span class="comment">// Tolerance: 300 seconds (5 minutes)</span>
      </div>

      <div class="params-label">Verification (Node.js)</div>
      <div class="code-block">
        <button class="code-copy-btn" data-copy="const crypto = require('crypto');
function verifyStablerails(rawBody, header, secret, toleranceSec = 300) {
  const tMatch = header.match(/(?:^|,)t=(\d+)/);
  const v1Match = header.match(/(?:^|,)v1=([0-9a-f]+)/);
  if (!tMatch || !v1Match) throw new Error('Malformed signature');
  const ts = Number(tMatch[1]);
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) throw new Error('Stale timestamp');
  const payload = ts + '.' + rawBody;
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  const buf1 = Buffer.from(expected, 'hex');
  const buf2 = Buffer.from(v1Match[1], 'hex');
  if (buf1.length !== buf2.length || !crypto.timingSafeEqual(buf1, buf2)) throw new Error('Signature mismatch');
}">Copy</button>
<span class="comment">// Node.js — verify the HMAC signature (constant-time compare)</span>
const crypto = require(<span class="str">'crypto'</span>);

function verifyStablerails(rawBody, header, secret, toleranceSec = <span class="val">300</span>) {
  <span class="comment">// 1. Parse t= and v1= from the header value</span>
  const tMatch  = header.match(/(?:^|,)t=(\d+)/);
  const v1Match = header.match(/(?:^|,)v1=([0-9a-f]+)/);
  if (!tMatch || !v1Match) throw new Error(<span class="str">'Malformed signature'</span>);

  const ts = Number(tMatch[<span class="val">1</span>]);

  <span class="comment">// 2. Reject stale timestamps (&gt; 5 minutes)</span>
  if (Math.abs(Date.now() / <span class="val">1000</span> - ts) &gt; toleranceSec)
    throw new Error(<span class="str">'Stale timestamp'</span>);

  <span class="comment">// 3. Recompute: HMAC-SHA256("&lt;ts&gt;.&lt;rawBody&gt;", secret)</span>
  const payload  = ts + <span class="str">'.'</span> + rawBody;
  const expected = crypto.createHmac(<span class="str">'sha256'</span>, secret)
                         .update(payload, <span class="str">'utf8'</span>).digest(<span class="str">'hex'</span>);

  <span class="comment">// 4. Constant-time compare (prevents timing attacks)</span>
  const buf1 = Buffer.from(expected, <span class="str">'hex'</span>);
  const buf2 = Buffer.from(v1Match[<span class="val">1</span>], <span class="str">'hex'</span>);
  if (buf1.length !== buf2.length || !crypto.timingSafeEqual(buf1, buf2))
    throw new Error(<span class="str">'Signature mismatch'</span>);
}
      </div>
    </div>
  </div>

</div>

<script${scriptNonceAttr}>
  document.querySelectorAll('.code-copy-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var text = btn.getAttribute('data-copy') || '';
      navigator.clipboard.writeText(text).then(function() {
        var prev = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = prev; }, 1500);
      });
    });
  });
</script>

</body>
</html>`;
}

// ── Route registration ─────────────────────────────────────────────────────────

export async function registerDocsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/docs",
    {
      config: {
        helmet: {
          enableCSPNonces: true,
          contentSecurityPolicy: {
            directives: {
              "default-src": ["'self'"],
              // style-src: nonce for the single <style> block
              "style-src": ["'self'"],
              // script-src: nonce for the copy-button <script> block
              "script-src": ["'self'"],
              // connect-src: none — copy button uses navigator.clipboard (same origin)
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
      const html = renderDocs(cspNonce?.style, cspNonce?.script);
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(html);
    },
  );
}
