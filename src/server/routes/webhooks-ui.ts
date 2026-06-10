/**
 * Operator-session-gated webhook management page (spec: webhook-ui).
 *
 * GET  /webhooks            — HTML list of registered webhooks (session-gated)
 * POST /webhooks            — register a new webhook endpoint (form submit)
 * POST /webhooks/:id/delete — delete a webhook (HTML form workaround for DELETE)
 *
 * Auth: session cookie `stablerails_session` via InMemorySessionStore.
 * Gate pattern identical to GET /dashboard in dashboard.ts.
 *
 * Reuses WebhookRepository from webhooksAdmin.ts — no reimplementation of
 * webhook logic or delivery. URL validation delegates to assertSafeUrl
 * (injectable for tests via opts.assertUrl).
 *
 * CSP: nonce-locked script-src (injected by @fastify/helmet enableCSPNonces).
 * All dynamic fields are HTML-escaped via esc().
 * No inline style= attributes — styles live in a nonce'd <style> block.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { WebhookRepository, WebhookEndpointRecord } from "./webhooksAdmin.js";
import type { InMemorySessionStore } from "../auth.js";
import { SESSION_COOKIE_NAME } from "../auth.js";
import type { RateLimiter } from "../../lib/rate-limit.js";
import { assertSafeUrl, SsrfGuardError } from "../../lib/ssrf-guard.js";
import { sealSecret } from "../../lib/secretBox.js";
import type { EventRepository } from "../../core/ports.js";

export interface WebhooksUiRouteOpts {
  webhookRepo: WebhookRepository;
  /** Required to validate optional eventId field before insert (mirrors webhooksAdmin.ts:107-114). */
  eventRepo: EventRepository;
  sessionStore: InMemorySessionStore;
  rateLimiter: RateLimiter;
  /**
   * URL asserter for SSRF + https validation.
   * Defaults to assertSafeUrl (real DNS-backed guard).
   * Tests inject a no-op to avoid network calls.
   */
  assertUrl?: (url: string) => Promise<void>;
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

// ── Vault CSS (shared dark theme, imported from dashboard.ts pattern) ─────────

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
    .nav-bar {
      max-width: 1200px; margin: 0 auto 1.5rem;
      display: flex; gap: .5rem; flex-wrap: wrap;
    }
    .nav-link {
      font-size: .8rem; color: #475569; text-decoration: none;
      padding: .3rem .6rem; border-radius: .4rem;
      transition: color .15s, background .15s;
    }
    .nav-link:hover { color: #94a3b8; background: rgba(255,255,255,.04); }
    .nav-link.active { color: #26A17B; border-bottom: 2px solid #26A17B; border-radius: 0; }
    .section-label {
      max-width: 1200px; margin: 0 auto .4rem;
      font-size: .65rem; font-weight: 700; color: #334155;
      text-transform: uppercase; letter-spacing: .1em;
    }
    .table-wrap {
      max-width: 1200px; margin: 0 auto 2rem;
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
    .url-cell { max-width: 360px; overflow: hidden; text-overflow: ellipsis; }
    .empty-state { padding: 2.5rem; text-align: center; color: #334155; font-size: .9rem; }
    .status-badge {
      padding: .15rem .55rem; border-radius: 100px;
      font-size: .7rem; font-weight: 700; letter-spacing: .06em; display: inline-block;
    }
    .badge-active   { background: #22c55e22; color: #22c55e; border: 1px solid #22c55e44; }
    .badge-inactive { background: #ef444422; color: #ef4444; border: 1px solid #ef444444; }
    .register-card {
      max-width: 1200px; margin: 0 auto 2rem;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 14px; padding: 1.25rem 1.5rem;
    }
    .register-title {
      font-size: .78rem; font-weight: 700; color: #475569;
      text-transform: uppercase; letter-spacing: .09em; margin-bottom: .85rem;
    }
    .field-row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: flex-end; }
    .field-group { display: flex; flex-direction: column; gap: .3rem; flex: 1 1 280px; }
    .field-label { font-size: .72rem; color: #94a3b8; font-weight: 600; }
    .field-input {
      background: #0f172a; border: 1px solid #334155; border-radius: .5rem;
      color: #f1f5f9; font-size: .875rem; padding: .5rem .75rem;
      min-width: 0; width: 100%;
    }
    .field-input:focus { outline: none; border-color: #26A17B; box-shadow: 0 0 0 2px rgba(38,161,123,.15); }
    .btn-register {
      background: rgba(38,161,123,.12); border: 1px solid rgba(38,161,123,.35);
      border-radius: .5rem; color: #26A17B; font-size: .875rem; font-weight: 700;
      padding: .5rem 1.1rem; cursor: pointer; white-space: nowrap;
    }
    .btn-register:hover { background: rgba(38,161,123,.22); }
    .btn-delete {
      background: none; border: 1px solid rgba(239,68,68,.3);
      border-radius: .4rem; color: #ef4444; font-size: .75rem; font-weight: 600;
      padding: .25rem .6rem; cursor: pointer;
    }
    .btn-delete:hover { background: rgba(239,68,68,.08); }
    .error-banner {
      max-width: 1200px; margin: 0 auto .75rem;
      background: rgba(239,68,68,.08); border: 1px solid rgba(239,68,68,.25);
      border-radius: .5rem; padding: .6rem 1rem;
      font-size: .82rem; color: #ef4444;
    }
    .secret-banner {
      max-width: 1200px; margin: 0 auto .75rem;
      background: rgba(38,161,123,.08); border: 1px solid rgba(38,161,123,.3);
      border-radius: .5rem; padding: .6rem 1rem;
      font-size: .82rem; color: #26A17B; word-break: break-all;
    }
    .ts-cell { color: #64748b; font-size: .77rem; }
    .event-cell { color: #94a3b8; font-size: .78rem; }
  </style>`;
}

// ── Page renderer ─────────────────────────────────────────────────────────────

function renderPage(
  webhooks: WebhookEndpointRecord[],
  nonces: { script?: string; style?: string },
  error?: string,
  createdSecret?: string,
): string {
  const styleNonceAttr = nonces.style ? ` nonce="${nonces.style}"` : "";
  const scriptNonceAttr = nonces.script ? ` nonce="${nonces.script}"` : "";

  const rows =
    webhooks.length === 0
      ? `<tr><td colspan="5" class="empty-state">Webhook-endpoints не зарегистрированы</td></tr>`
      : webhooks
          .map((wh) => {
            const activeBadge = wh.active
              ? `<span class="status-badge badge-active">active</span>`
              : `<span class="status-badge badge-inactive">inactive</span>`;
            const eventCell = wh.eventId
              ? `<span class="event-cell mono">${esc(wh.eventId)}</span>`
              : `<span class="event-cell">—</span>`;
            const createdFmt = wh.createdAt.toISOString().replace("T", " ").slice(0, 16);
            return `<tr>
              <td class="mono url-cell" title="${esc(wh.url)}">${esc(wh.url)}</td>
              <td>${eventCell}</td>
              <td>${activeBadge}</td>
              <td class="ts-cell">${esc(createdFmt)}</td>
              <td>
                <form method="POST" action="/webhooks/${esc(wh.id)}/delete">
                  <button class="btn-delete" type="submit" aria-label="Удалить webhook">Удалить</button>
                </form>
              </td>
            </tr>`;
          })
          .join("\n");

  const errorHtml = error
    ? `<div class="error-banner">${esc(error)}</div>`
    : "";

  // One-time secret reveal: shown ONLY on the post-create render. The stored
  // value may be ciphertext (WH-6) and is never retrievable again.
  const secretHtml = createdSecret
    ? `<div class="secret-banner">Webhook создан. Секрет для подписи (показывается ОДИН раз — сохраните сейчас): <span class="mono">${esc(createdSecret)}</span></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Webhooks — Stablerails</title>
  ${vaultCss(styleNonceAttr)}
</head>
<body>

  <div class="page-header">
    <div class="usdt-icon">&#x20AE;</div>
    <h1>Webhook-endpoints</h1>
  </div>

  <div class="nav-bar">
    <a class="nav-link" href="/dashboard">&#x2190; Панель оператора</a>
  </div>

  ${errorHtml}
  ${secretHtml}

  <div class="section-label">Зарегистрированные endpoints</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>URL</th>
          <th>Event ID</th>
          <th>Статус</th>
          <th>Создан</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="section-label">Зарегистрировать новый endpoint</div>
  <div class="register-card">
    <div class="register-title">Новый webhook</div>
    <form method="POST" action="/webhooks">
      <div class="field-row">
        <div class="field-group">
          <label class="field-label" for="wh-url">HTTPS URL <span aria-hidden="true">*</span></label>
          <input
            class="field-input mono"
            id="wh-url"
            name="url"
            type="url"
            placeholder="https://example.com/webhook"
            required
          />
        </div>
        <div class="field-group">
          <label class="field-label" for="wh-event">Event ID (необязательно)</label>
          <input
            class="field-input mono"
            id="wh-event"
            name="eventId"
            type="text"
            placeholder="evt_..."
          />
        </div>
        <button class="btn-register" type="submit">Зарегистрировать</button>
      </div>
    </form>
  </div>

  <script${scriptNonceAttr}>
    // Progressive enhancement: client-side URL validation on submit.
    // Server re-validates anyway; this is UX only.
    var form = document.querySelector('form[action="/webhooks"]');
    if (form) {
      form.addEventListener('submit', function(e) {
        var urlInput = document.getElementById('wh-url');
        if (!urlInput) return;
        var val = urlInput.value.trim();
        if (!val.startsWith('https://')) {
          e.preventDefault();
          alert('URL должен начинаться с https://');
        }
      });
    }
  </script>
</body>
</html>`;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerWebhooksUiRoutes(
  app: FastifyInstance,
  opts: WebhooksUiRouteOpts,
): Promise<void> {
  const { webhookRepo, eventRepo, sessionStore, rateLimiter } = opts;
  // Use injected assertUrl (tests) or the real SSRF guard (production).
  const doAssertUrl = opts.assertUrl ?? assertSafeUrl;

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
  };

  // ── Session gate helper ────────────────────────────────────────────────────

  function gateSession(
    req: FastifyRequest,
    reply: FastifyReply,
  ): boolean {
    const cookieHeader = req.headers["cookie"] ?? "";
    const sessionId = extractSessionId(cookieHeader);
    if (!sessionId) {
      void reply.code(302).header("Location", "/login").send();
      return false;
    }
    const session = sessionStore.get(sessionId);
    if (!session) {
      void reply.code(302).header("Location", "/login").send();
      return false;
    }
    return true;
  }

  // ── GET /webhooks ──────────────────────────────────────────────────────────

  app.get(
    "/webhooks",
    { config: CSP_CONFIG },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("dashboard", ip)) {
        return reply.code(429).header("Content-Type", "text/html; charset=utf-8").send(
          "<html><body><h1>Слишком много запросов</h1></body></html>",
        );
      }

      if (!gateSession(req, reply)) return;

      const webhooks = await webhookRepo.list();
      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;

      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(
          renderPage(webhooks, {
            script: cspNonce?.script,
            style: cspNonce?.style,
          }),
        );
    },
  );

  // ── POST /webhooks — register ──────────────────────────────────────────────

  app.post(
    "/webhooks",
    { config: CSP_CONFIG },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("dashboard", ip)) {
        return reply.code(429).header("Content-Type", "text/html; charset=utf-8").send(
          "<html><body><h1>Слишком много запросов</h1></body></html>",
        );
      }

      if (!gateSession(req, reply)) return;

      const body = req.body as Record<string, string | undefined>;
      const rawUrl = (body?.["url"] ?? "").trim();
      const rawEventId = (body?.["eventId"] ?? "").trim() || undefined;

      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;
      const nonces = { script: cspNonce?.script, style: cspNonce?.style };

      // Validate: URL must be non-empty
      if (!rawUrl) {
        const webhooks = await webhookRepo.list();
        return reply
          .code(400)
          .header("Content-Type", "text/html; charset=utf-8")
          .send(renderPage(webhooks, nonces, "url обязателен"));
      }

      // Validate: must be a valid URL with https scheme
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUrl);
      } catch {
        const webhooks = await webhookRepo.list();
        return reply
          .code(400)
          .header("Content-Type", "text/html; charset=utf-8")
          .send(renderPage(webhooks, nonces, "Некорректный URL"));
      }
      if (parsedUrl.protocol !== "https:") {
        const webhooks = await webhookRepo.list();
        return reply
          .code(400)
          .header("Content-Type", "text/html; charset=utf-8")
          .send(renderPage(webhooks, nonces, "URL должен использовать https://"));
      }

      // SSRF pre-screen (reuses assertSafeUrl or injected mock)
      try {
        await doAssertUrl(rawUrl);
      } catch (e) {
        if (e instanceof SsrfGuardError) {
          const webhooks = await webhookRepo.list();
          return reply
            .code(400)
            .header("Content-Type", "text/html; charset=utf-8")
            .send(renderPage(webhooks, nonces, `URL не допустим: ${e.message}`));
        }
        throw e;
      }

      // Validate optional eventId: must refer to an existing Event row
      // (mirrors webhooksAdmin.ts:107-114 — same guard, friendly HTML error instead of P2003 FK crash)
      if (rawEventId) {
        const event = await eventRepo.findById(rawEventId);
        if (!event) {
          const webhooks = await webhookRepo.list();
          return reply
            .code(400)
            .header("Content-Type", "text/html; charset=utf-8")
            .send(renderPage(webhooks, nonces, `Событие "${esc(rawEventId)}" не найдено`));
        }
      }

      // Generate a signing secret (same approach as webhooksAdmin.ts).
      const { randomBytes } = await import("crypto");
      const secret = randomBytes(32).toString("hex");

      // WH-6: encrypt at rest (no-op plaintext passthrough when
      // STABLERAILS_DATA_KEY is unset) — same sealing as the API route.
      await webhookRepo.insert({
        eventId: rawEventId ?? null,
        url: rawUrl,
        secret: sealSecret(secret),
      });

      // One-time secret reveal: render the page directly (no redirect) so the
      // operator can copy the PLAINTEXT signing secret exactly once. It is
      // never retrievable again — the stored form may be ciphertext.
      const webhooks = await webhookRepo.list();
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(renderPage(webhooks, nonces, undefined, secret));
    },
  );

  // ── POST /webhooks/:id/delete — delete ─────────────────────────────────────

  app.post(
    "/webhooks/:id/delete",
    { config: CSP_CONFIG },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ip = req.socket?.remoteAddress ?? "unknown";
      if (!rateLimiter.check("dashboard", ip)) {
        return reply.code(429).header("Content-Type", "text/html; charset=utf-8").send(
          "<html><body><h1>Слишком много запросов</h1></body></html>",
        );
      }

      if (!gateSession(req, reply)) return;

      const { id } = req.params as { id: string };
      const existing = await webhookRepo.findById(id);

      if (!existing) {
        const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;
        const nonces = { script: cspNonce?.script, style: cspNonce?.style };
        const webhooks = await webhookRepo.list();
        return reply
          .code(404)
          .header("Content-Type", "text/html; charset=utf-8")
          .send(renderPage(webhooks, nonces, `Webhook "${esc(id)}" не найден`));
      }

      await webhookRepo.delete(id);

      return reply.code(302).header("Location", "/webhooks").send();
    },
  );
}
