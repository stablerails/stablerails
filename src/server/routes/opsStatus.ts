/**
 * Ops status route.
 *
 * GET /ops/status — operator-SESSION-GATED (identical gate to /dashboard)
 *   Read-only system health page (Vault style).
 *
 * Shows:
 *   - Kill-switch states (invoices / watcher / webhooks paused?)
 *   - RPC providers configured (hostnames only — credentials redacted)
 *   - DB connectivity (getAllFlags ping via killSwitchRepo)
 *
 * Security invariants:
 *   - Session gate identical to /dashboard (cookie → sessionStore.get → 302 /login)
 *   - CSP: nonce-locked script-src (enableCSPNonces), no unsafe-inline
 *   - No inline style= attributes — all styling via nonce'd <style> block
 *   - esc() on every dynamic field
 *   - RPC URLs: only hostname shown (path, query strings, and userinfo stripped)
 *   - API keys (header-based) are never rendered
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { InMemorySessionStore } from "../auth.js";
import { SESSION_COOKIE_NAME } from "../auth.js";
import type { RateLimiter } from "../../lib/rate-limit.js";
import type { KillSwitchRepository } from "../killswitch-repo.js";
import { isPausedAsync, isPaused } from "../killswitch.js";
import type { KillswitchArea } from "../killswitch.js";

// ── Route options ─────────────────────────────────────────────────────────────

export interface OpsStatusRouteOpts {
  sessionStore: InMemorySessionStore;
  rateLimiter: RateLimiter;
  /**
   * DB-backed kill-switch repo — used both to surface per-area kill-switch state
   * and as the DB connectivity probe (if getAllFlags() succeeds, the DB is reachable).
   * If absent (edge-case test setup), DB status is shown as "unavailable".
   */
  killSwitchRepo?: KillSwitchRepository;
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

// ── Session gate (identical to /dashboard) ────────────────────────────────────

function extractSessionId(cookieHeader: string): string | null {
  return (
    cookieHeader
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.slice(SESSION_COOKIE_NAME.length + 1) ?? null
  );
}

// ── RPC provider info (redacted — never expose secrets or full URLs) ──────────

interface RpcProviderInfo {
  name: string;
  /** Redacted display URL: hostname only (no path, no query string, no credentials). */
  displayUrl: string;
  /** Whether the environment variable is configured. */
  configured: boolean;
}

/**
 * Read RPC provider URLs from environment and extract the hostname only.
 * Path segments are intentionally stripped because some providers (e.g.
 * QuickNode, Alchemy) embed auth tokens directly in the URL path. Displaying
 * only the hostname is sufficient for an operator to identify the provider
 * without risking credential exposure via screenshots or browser history.
 * API keys (TRON_RPC_*_API_KEY) are intentionally NOT included — they are
 * never rendered to the operator.
 */
function getRpcProviders(): { primary: RpcProviderInfo; secondary: RpcProviderInfo } {
  const primaryRaw = process.env["TRON_RPC_PRIMARY_URL"];
  const secondaryRaw = process.env["TRON_RPC_SECONDARY_URL"];

  /** Extract hostname only — never expose path, query string, or userinfo. */
  function hostOnly(rawUrl: string): string {
    try {
      return new URL(rawUrl).host;
    } catch {
      return "[invalid-url]";
    }
  }

  const primary: RpcProviderInfo = primaryRaw
    ? { name: "Primary", displayUrl: hostOnly(primaryRaw), configured: true }
    : { name: "Primary", displayUrl: "not configured", configured: false };

  const secondary: RpcProviderInfo = secondaryRaw
    ? { name: "Secondary", displayUrl: hostOnly(secondaryRaw), configured: true }
    : { name: "Secondary", displayUrl: "not configured", configured: false };

  return { primary, secondary };
}

// ── Status data (assembled before render) ─────────────────────────────────────

interface KillswitchStatus {
  area: KillswitchArea;
  paused: boolean;
}

interface OpsStatusData {
  killswitches: KillswitchStatus[];
  rpcProviders: { primary: RpcProviderInfo; secondary: RpcProviderInfo };
  dbReachable: boolean | null; // null = probe not wired
}

// ── HTML renderer ─────────────────────────────────────────────────────────────

function renderOpsStatus(
  data: OpsStatusData,
  nonces: { style?: string },
): string {
  const styleNonceAttr = nonces.style ? ` nonce="${nonces.style}"` : "";

  // Kill-switch rows
  const ksRows = data.killswitches
    .map(({ area, paused }) => {
      const stateClass = paused ? "state-paused" : "state-active";
      const stateLabel = paused ? "paused" : "active";
      return `<tr>
        <td class="mono">${esc(area)}</td>
        <td><span class="state-badge ${stateClass}">${esc(stateLabel)}</span></td>
      </tr>`;
    })
    .join("\n");

  // RPC provider rows
  const { primary, secondary } = data.rpcProviders;
  const rpcRows = [primary, secondary]
    .map((p) => {
      const configClass = p.configured ? "state-active" : "state-unknown";
      const configLabel = p.configured ? "configured" : "not configured";
      return `<tr>
        <td>${esc(p.name)}</td>
        <td class="mono">${esc(p.displayUrl)}</td>
        <td><span class="state-badge ${configClass}">${esc(configLabel)}</span></td>
      </tr>`;
    })
    .join("\n");

  // DB connectivity row
  let dbStateClass: string;
  let dbStateLabel: string;
  if (data.dbReachable === true) {
    dbStateClass = "state-active";
    dbStateLabel = "reachable";
  } else if (data.dbReachable === false) {
    dbStateClass = "state-paused";
    dbStateLabel = "unreachable";
  } else {
    dbStateClass = "state-unknown";
    dbStateLabel = "unavailable";
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ops Status — Stablerails</title>
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
      padding: 1.5rem 1rem 3rem;
    }
    .page-header {
      max-width: 900px; margin: 0 auto 1.5rem;
      display: flex; align-items: center; gap: .75rem;
    }
    .usdt-icon {
      width: 28px; height: 28px; background: #26A17B; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: .9rem; font-weight: 900; color: #fff; flex-shrink: 0;
      box-shadow: 0 0 12px rgba(38,161,123,.4);
    }
    h1 { font-size: 1.25rem; font-weight: 700; color: #f1f5f9; }
    .back-link {
      max-width: 900px; margin: 0 auto .75rem; display: block;
      font-size: .82rem; color: #475569; text-decoration: none;
      display: inline-flex; align-items: center; gap: .4rem;
      padding: .3rem .6rem; border-radius: .4rem;
      transition: color .15s, background .15s;
    }
    .back-link:hover { color: #94a3b8; background: rgba(255,255,255,.04); }
    .back-link-wrap { max-width: 900px; margin: 0 auto .75rem; }
    .section-label {
      max-width: 900px; margin: 1.25rem auto .5rem;
      font-size: .65rem; font-weight: 700; color: #334155;
      text-transform: uppercase; letter-spacing: .1em;
    }
    .table-wrap {
      max-width: 900px; margin: 0 auto;
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.07);
      border-radius: 14px;
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; }
    thead tr { border-bottom: 1px solid rgba(255,255,255,.07); }
    th {
      padding: .6rem 1rem; text-align: left; font-size: .65rem; font-weight: 700;
      color: #475569; text-transform: uppercase; letter-spacing: .08em;
    }
    td {
      padding: .6rem 1rem; font-size: .82rem; color: #cbd5e1;
      border-bottom: 1px solid rgba(255,255,255,.04);
    }
    tr:last-child td { border-bottom: none; }
    .mono {
      font-family: "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", monospace;
      font-size: .78rem;
    }
    .state-badge {
      padding: .15rem .55rem; border-radius: 100px;
      font-size: .7rem; font-weight: 700; letter-spacing: .06em;
      display: inline-block;
    }
    .state-active  { background: #22c55e22; color: #22c55e; border: 1px solid #22c55e44; }
    .state-paused  { background: #ef444422; color: #ef4444; border: 1px solid #ef444444; }
    .state-unknown { background: #64748b22; color: #64748b; border: 1px solid #64748b44; }
  </style>
</head>
<body>

  <div class="page-header">
    <div class="usdt-icon">&#x20AE;</div>
    <h1>Ops Status</h1>
  </div>

  <div class="back-link-wrap">
    <a class="back-link" href="/dashboard">&#x2190; Dashboard</a>
  </div>

  <div class="section-label">Kill-switch state</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Area</th>
          <th>State</th>
        </tr>
      </thead>
      <tbody>${ksRows}</tbody>
    </table>
  </div>

  <div class="section-label">RPC providers</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Provider</th>
          <th>Hostname</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${rpcRows}</tbody>
    </table>
  </div>

  <div class="section-label">Database</div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Check</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>DB ping (SELECT 1)</td>
          <td><span class="state-badge ${dbStateClass}">${esc(dbStateLabel)}</span></td>
        </tr>
      </tbody>
    </table>
  </div>

</body>
</html>`;
}

// ── Route registration ────────────────────────────────────────────────────────

const KILLSWITCH_AREAS: KillswitchArea[] = ["invoices", "watcher", "webhooks"];

export async function registerOpsStatusRoutes(
  app: FastifyInstance,
  opts: OpsStatusRouteOpts,
): Promise<void> {
  const { sessionStore, rateLimiter, killSwitchRepo } = opts;

  app.get(
    "/ops/status",
    {
      config: {
        helmet: {
          enableCSPNonces: true,
          contentSecurityPolicy: {
            directives: {
              "default-src": ["'self'"],
              // style-src: nonce injected by @fastify/helmet (enableCSPNonces)
              "style-src": ["'self'"],
              // script-src: nonce injected by @fastify/helmet. No inline <script> on
              // this page, but a nonce-locked directive prevents future regressions.
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
          "<html><body><h1>Too Many Requests</h1></body></html>",
        );
      }

      // Session gate: identical to /dashboard
      const cookieHeader = req.headers["cookie"] ?? "";
      const sessionId = extractSessionId(cookieHeader);
      if (!sessionId) {
        return reply.code(302).header("Location", "/login").send();
      }
      const session = sessionStore.get(sessionId);
      if (!session) {
        return reply.code(302).header("Location", "/login").send();
      }

      // Kill-switch states — read via isPausedAsync (uses DB-backed repo if wired).
      // Each read is individually guarded: if the DB is unreachable, fall back to
      // the synchronous isPaused() which reads env flags + in-memory flags + the
      // last cached DB value. This ensures the page never 500 when the DB is down
      // — exactly the moment an operator most needs it.
      const ksResults = await Promise.all(
        KILLSWITCH_AREAS.map(async (area) => {
          let paused: boolean;
          try {
            paused = await isPausedAsync(area);
          } catch {
            // DB unreachable — fall back to env + in-memory + last-cached state.
            paused = isPaused(area);
          }
          return { area, paused };
        }),
      );

      // DB connectivity — probe via killSwitchRepo.getAllFlags() (lightweight read)
      let dbReachable: boolean | null = null;
      if (killSwitchRepo) {
        try {
          await killSwitchRepo.getAllFlags();
          dbReachable = true;
        } catch {
          dbReachable = false;
        }
      }

      // RPC provider info — hostname+path only, credentials stripped
      const rpcProviders = getRpcProviders();

      const data: OpsStatusData = {
        killswitches: ksResults,
        rpcProviders,
        dbReachable,
      };

      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;
      const html = renderOpsStatus(data, { style: cspNonce?.style });

      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(html);
    },
  );
}
