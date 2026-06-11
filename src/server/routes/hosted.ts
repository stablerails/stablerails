/**
 * Hosted offering page.
 *
 * GET /hosted — static, server-rendered, single-file HTML; no auth, no data.
 *
 * The simple path: accept USDT without running a server. We host the
 * watch-only part (checkout, API, dashboard, watcher); the merchant keeps
 * the keys and sweeps from their own machine. Hosting runs on donations,
 * so the 0% fees claim stays literal.
 *
 * The signup CTA points at the canonical hosted instance ABSOLUTELY, so
 * this page works verbatim on self-hosted instances too (where local
 * /signup is disabled by default).
 *
 * Same hard constraints as the rest of the site: nonce CSP, zero
 * third-party loads, no JS at all on this page.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { siteNavHtml, SITE_NAV_CSS } from "./siteNav.js";

const SIGNUP_URL = "https://stablerails.org/signup";

interface FlowStep {
  no: string;
  title: string;
  text: string;
}

const FLOW: FlowStep[] = [
  { no: "1", title: "Create an account", text: "Email and password. No company, no KYB, no approval queue." },
  { no: "2", title: "Connect your wallet", text: "Paste an xpub and a sweep address from a wallet you control. Keys never leave your machine — we physically cannot hold your funds." },
  { no: "3", title: "Grab your API key", text: "Checkout pages, webhooks and the dashboard are already wired on our domain. Hand the docs to your developer or your agent." },
  { no: "4", title: "Get paid", text: "Create invoices via API, customers pay USDT on a hosted checkout, two independent RPCs confirm, your webhook fires." },
  { no: "5", title: "Sweep on your schedule", text: "Funds sit on addresses only you can spend from. Pull them to your wallet with one local command and your passphrase." },
];

function renderHosted(styleNonce?: string): string {
  const styleNonceAttr = styleNonce ? ` nonce="${styleNonce}"` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0a0e0c" />
  <meta name="description" content="Accept USDT without running a server: hosted Stablerails. We host the watch-only part; you keep the keys. Runs on donations — 0% fees stays literal." />
  <title>Hosted &middot; Stablerails</title>
  <style${styleNonceAttr}>
    :root {
      color-scheme: dark;
      --ink: #0a0e0c; --panel: #0e1411;
      --line: rgba(236, 233, 226, .08); --line-strong: rgba(236, 233, 226, .16);
      --text: #ece9e2; --muted: #8e988f; --dim: #79847c;
      --acc: #26A17B; --acc-bright: #3ddc97; --acc-soft: rgba(38, 161, 123, .12);
      --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--sans); background: var(--ink); color: var(--text); line-height: 1.6;
      background-image: repeating-linear-gradient(to bottom, transparent 0 27px, rgba(236, 233, 226, .02) 27px 28px);
      -webkit-font-smoothing: antialiased;
    }
    ::selection { background: var(--acc); color: #04130d; }
    a { color: var(--acc-bright); text-decoration: none; }
    a:hover { text-decoration: underline; text-underline-offset: 3px; }
    a:focus-visible { outline: 2px solid var(--acc-bright); outline-offset: 2px; }
    a { -webkit-tap-highlight-color: transparent; }
    .wrap { max-width: 880px; margin: 0 auto; padding: 0 24px; }
${SITE_NAV_CSS}
    .hero { padding: 4.5rem 0 2.5rem; }
    h1 { font-family: var(--mono); font-size: clamp(1.8rem, 5vw, 2.6rem); letter-spacing: -.03em; margin-bottom: .8rem; text-wrap: balance; }
    h1 em { font-style: normal; color: var(--acc-bright); }
    .sub { color: var(--muted); max-width: 58ch; }
    .cta {
      display: inline-block; margin-top: 1.6rem;
      font-family: var(--mono); font-size: .9rem; font-weight: 700; letter-spacing: .04em;
      color: #04130d; background: var(--acc-bright);
      border-radius: 8px; padding: .8rem 1.6rem;
      transition: transform 160ms cubic-bezier(.23, 1, .32, 1);
    }
    .cta:hover { text-decoration: none; transform: translateY(-1px); }
    .cta:active { transform: scale(.98); }
    .steps { margin: 2.4rem 0; display: grid; gap: 1.5rem; }
    .step { display: flex; gap: 1.1rem; align-items: flex-start; }
    .step-no { font-family: var(--mono); font-size: 1.05rem; font-weight: 700; color: var(--acc-bright); flex-shrink: 0; min-width: 1.6rem; }
    .step h2 { font-size: 1rem; font-weight: 700; margin-bottom: .25rem; }
    .step p { font-size: .9rem; color: var(--muted); max-width: 60ch; text-wrap: pretty; }
    .honest {
      border: 1px solid rgba(38, 161, 123, .4); background: var(--acc-soft);
      border-radius: 10px; padding: 1.2rem 1.4rem; margin: 2.4rem 0; max-width: 640px;
    }
    .honest strong { font-family: var(--mono); }
    .honest p { font-size: .9rem; color: var(--muted); margin-top: .3rem; }
    .vs { border-top: 1px solid var(--line); margin-top: 2.6rem; padding: 2rem 0 4rem; font-size: .9rem; color: var(--muted); }
    .vs a { font-family: var(--mono); }
    .footer { border-top: 1px solid var(--line); padding: 1.6rem 0 2.6rem; color: var(--dim); font-size: .75rem; font-family: var(--mono); }
  </style>
</head>
<body>

<header class="wrap">
  ${siteNavHtml()}
</header>

<main class="wrap">
  <section class="hero">
    <h1>Accept USDT today. <em>No server required.</em></h1>
    <p class="sub">We run the watch-only part: checkout, API, webhooks, dashboard. You keep the part that matters &mdash; the keys. Funds go to addresses only you can spend from.</p>
    <a class="cta" href="${SIGNUP_URL}">Create account &rarr;</a>
  </section>

  <section class="steps" aria-label="How it works">${FLOW.map(
    (s) => `
    <div class="step">
      <span class="step-no">${s.no}.</span>
      <div>
        <h2>${s.title}</h2>
        <p>${s.text}</p>
      </div>
    </div>`,
  ).join("")}
  </section>

  <div class="honest">
    <strong>What it costs: whatever you decide.</strong>
    <p>Hosting runs on donations. The dashboard shows what you processed and what a typical 1% processor would have charged; if the rails earn their keep, chip in. The software itself has no fee code path &mdash; 0% is literal, here and self-hosted.</p>
  </div>

  <section class="vs">
    Want full sovereignty instead? <a href="/setup">Self-host it &rarr;</a> &mdash; same software, your VPS, free forever. Leaving hosted later is one export away: your keys already work everywhere.
  </section>
</main>

<footer class="footer">
  <div class="wrap">&copy; Stablerails contributors &middot; AGPL-3.0 &middot; <a href="/">home</a> &middot; <a href="/terms">terms</a></div>
</footer>

</body>
</html>`;
}

export async function registerHostedRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/hosted",
    {
      config: {
        helmet: {
          enableCSPNonces: true,
          contentSecurityPolicy: {
            directives: {
              "default-src": ["'self'"],
              "style-src": ["'self'"],
              "script-src": ["'self'"],
              "img-src": ["'self'"],
              "connect-src": ["'none'"],
              "frame-ancestors": ["'none'"],
            },
          },
        },
      },
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const cspNonce = (reply as FastifyReply & { cspNonce?: { style?: string } }).cspNonce;
      const html = renderHosted(cspNonce?.style);
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(html);
    },
  );
}
