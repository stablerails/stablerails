/**
 * Stablerails public landing page.
 *
 * GET / — static, server-rendered, single-file HTML; no auth, no data.
 *
 * Positioning (SaaS-first): a hosted, NON-CUSTODIAL stablecoin payment service.
 * We host the watch-only part — checkout, API, webhooks, dashboard, all on our
 * domain. The merchant keeps the one thing that matters: the keys. Funds land
 * on addresses only they can sweep, signed on their own machine. Self-hosting
 * the exact same software is a first-class second path (/setup), not the lead.
 *
 * Hard constraints (unchanged):
 *  - Nonce-based CSP: every <style> and <script> tag carries the
 *    per-request nonce (helmet enableCSPNonces, same as checkout).
 *  - ZERO external requests: system font stack, inline SVG only, relative URLs
 *    for all resources. No fonts, no CDN, no analytics, no data: URIs. Absolute
 *    URLs appear ONLY as navigation anchors (<a href> to the hosted signup, the
 *    GitHub repo) — they load nothing until clicked. The hero terminal uses a
 *    "$STABLERAILS_API_URL" placeholder, never a literal https:// endpoint.
 *  - Minimal JS: a single nonce'd script that binds copy-to-clipboard buttons
 *    and the interactive payment demo via addEventListener.
 *
 * Aesthetic: "terminal sovereignty" — dark ink, monospace display type,
 * ledger hairlines, numbered sections, one green accent harmonized with
 * the checkout page (#26A17B family).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { isDemoEnabled } from "../utils.js";
import { siteNavHtml, SITE_NAV_CSS } from "./siteNav.js";

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// esc is kept for consistency and forward-use if dynamic fields are ever added.
void esc;

// Canonical hosted instance — signup / merchant login live there. Absolute so
// the page works verbatim on self-hosted instances too. Only ever rendered
// inside <a href> anchors (which load nothing until clicked).
const SIGNUP_URL = "https://stablerails.org/signup";

// Hero terminal command. Uses an env-var placeholder, never a literal URL, so
// the page keeps loading nothing from third parties.
const HERO_CMD = "curl -X POST $STABLERAILS_API_URL/v1/invoices";

/** Static hero transcript — a real hosted invoice landing, mirrors the API
 *  envelope and the two-RPC / solid-block credit language. */
const HERO_STATIC_LINES = [
  "{\"data\":{\"id\":\"inv_9f2c41d0\",\"status\":\"pending\",\"payAddress\":\"TWd4&hellip;n5pQ\"}}",
  "[watcher] solid block 83 412 907 &middot; two RPCs agree",
  "status: paid &middot; receipt confirmed by BOTH providers",
  "[webhook] 200 &middot; X-Stablerails-Signature: sha256=9f2c&hellip;",
];

interface FlowStep {
  no: string;
  title: string;
  text: string;
}

/** The five steps to live, hosted. */
const FLOW: FlowStep[] = [
  { no: "1", title: "Create an account", text: "Email and a password. No company, no KYB, no approval queue." },
  { no: "2", title: "Connect your wallet", text: "Paste an xpub and a sweep address from a wallet you control. Keys never leave your machine; we physically cannot hold your funds." },
  { no: "3", title: "Grab your API key", text: "Checkout, webhooks and the dashboard are already wired on our domain. Hand the docs to your developer or your agent." },
  { no: "4", title: "Get paid", text: "Create invoices via the API, customers pay USDT on a hosted checkout, two independent RPCs confirm, your webhook fires." },
  { no: "5", title: "Sweep on your schedule", text: "Funds sit on addresses only you can spend from. Pull them to your wallet with one local command and your passphrase." },
];

function renderFlow(): string {
  return FLOW.map(
    (s) => `
        <div class="step">
          <span class="step-no">${s.no}.</span>
          <div>
            <h3>${s.title}</h3>
            <p>${s.text}</p>
          </div>
        </div>`,
  ).join("");
}

interface Feature {
  name: string;
  text: string;
  /** Double-width cell with a real product artifact rendered in mono. */
  wide?: boolean;
  snip?: string;
}

const FEATURES: Feature[] = [
  { name: "HMAC-signed webhooks", text: "Signed delivery with retries. Verify the signature, trust the event.", wide: true, snip: "X-Stablerails-Signature: sha256=9f2c41d0&hellip;" },
  { name: "Per-invoice HD addresses", text: "A fresh deposit address for every invoice, derived from your xpub. No address reuse." },
  { name: "Hosted checkout + payment links", text: "A ready checkout page with QR, countdown and live status. Share a link, get paid." },
  { name: "Merchant dashboard", text: "Invoices, payments and API keys behind your own login, scoped to your store." },
  { name: "Two-RPC finality", text: "Two independent providers must agree on a solid block before anything reads as paid. Never 0-conf." },
  { name: "Readonly keys for agents", text: "Hand an AI agent a key that can run the store but physically cannot move funds." },
  { name: "Tron USDT today", text: "USDT (TRC-20) shipped. Polygon, Ethereum and USDC are tracked in the open." },
  { name: "Self-host anytime", text: "The exact same software runs on your own VPS, free forever. No lock-in, one export away.", wide: true, snip: "$ docker compose up -d" },
];

function renderFeatures(): string {
  return FEATURES.map(
    (f) => `
      <div class="feat${f.wide ? " feat-wide" : ""}">
        <h3>${f.name}</h3>
        <p>${f.text}</p>${f.snip ? `
        <code class="feat-snip">${f.snip}</code>` : ""}
      </div>`,
  ).join("");
}

/** Hero terminal: a real hosted integration. The command types itself, the
 *  transcript lands line by line, and pressing Enter replays a full payment. */
function renderHeroTerminal(): string {
  return `
      <div class="term" role="group" aria-label="A hosted invoice, created over the API">
        <div class="term-bar">
          <span class="term-title">your integration</span>
        </div>
        <div class="term-body">
          <code class="term-cmd"><span class="term-prompt">$</span> <span class="type">${HERO_CMD}</span></code>
          <button class="copy-btn" id="copy-hero" type="button" data-copy="${HERO_CMD}" aria-label="Copy command to clipboard" hidden>copy</button>
        </div>
        <pre class="term-out">${HERO_STATIC_LINES.map((l) => `<span class="term-line">${l}</span>`).join("")}</pre>
        <template id="demo-tx">
          <span class="term-line">{"data":{"id":"inv_9f2c41d0","status":"pending","amountUsdt":"27.310000","payAddress":"TWd4&hellip;n5pQ"}}</span>
          <span class="term-line">[watcher] solid block 83 412 907 &middot; two RPCs agree</span>
          <span class="term-line">status: payment_detected</span>
          <span class="term-line">receipt confirmed by BOTH providers &rarr; status: <span class="ok">paid</span></span>
          <span class="term-line">[webhook] 200 &middot; X-Stablerails-Signature: sha256=9f2c&hellip;</span>
          <span class="term-line term-human">$ sweep requires your passphrase, on your machine. that part stays human.</span>
        </template>
      </div>`;
}

/** Inline SVG flow diagram: payer → per-invoice address → (passphrase gate) → your wallet.
 *  Wrapped in a horizontal scroll container so labels keep a legible minimum size on phones. */
function renderDiagram(): string {
  return `
      <div class="diagram-scroll">
      <svg class="diagram" viewBox="0 0 720 230" role="img" aria-label="Payment flow: payer sends to a per-invoice address; the watch-only server we host observes the chain; funds sweep to your wallet only after a local passphrase">
        <!-- payer -->
        <rect class="d-box" x="8" y="40" width="120" height="56" rx="6"/>
        <text class="d-label" x="68" y="64" text-anchor="middle">PAYER</text>
        <text class="d-sub" x="68" y="82" text-anchor="middle">sends USDT</text>
        <!-- arrow 1 -->
        <line class="d-line" x1="128" y1="68" x2="216" y2="68"/>
        <path class="d-arrow" d="M216 68 l-9 -5 v10 z"/>
        <!-- per-invoice address -->
        <rect class="d-box" x="218" y="40" width="180" height="56" rx="6"/>
        <text class="d-label" x="308" y="64" text-anchor="middle">PER-INVOICE ADDRESS</text>
        <text class="d-sub" x="308" y="82" text-anchor="middle">fresh HD address</text>
        <!-- arrow 2 with passphrase gate -->
        <line class="d-line" x1="398" y1="68" x2="572" y2="68"/>
        <path class="d-arrow" d="M572 68 l-9 -5 v10 z"/>
        <line class="d-gate" x1="486" y1="44" x2="486" y2="92"/>
        <text class="d-gate-label" x="486" y="32" text-anchor="middle">HUMAN PASSPHRASE</text>
        <!-- your wallet -->
        <rect class="d-box d-box-acc" x="574" y="40" width="138" height="56" rx="6"/>
        <text class="d-label d-label-acc" x="643" y="64" text-anchor="middle">YOUR WALLET</text>
        <text class="d-sub" x="643" y="82" text-anchor="middle">sweep signed locally</text>
        <!-- watch-only server (we host it; it holds nothing) -->
        <line class="d-dash" x1="308" y1="96" x2="308" y2="156"/>
        <rect class="d-box d-box-dim" x="198" y="158" width="220" height="56" rx="6"/>
        <text class="d-label" x="308" y="182" text-anchor="middle">WATCH-ONLY SERVER</text>
        <text class="d-sub" x="308" y="200" text-anchor="middle">we host it &middot; checkout + API + dashboard &middot; no keys</text>
        <!-- payment pulse: travels payer → address → (gate) → wallet -->
        <circle class="d-pulse" cx="128" cy="68" r="4"/>
      </svg>
      </div>`;
}

function renderLanding(scriptNonce?: string, styleNonce?: string, demoEnabled?: boolean): string {
  const styleNonceAttr = styleNonce ? ` nonce="${styleNonce}"` : "";
  const scriptNonceAttr = scriptNonce ? ` nonce="${scriptNonce}"` : "";
  // Local demo when this instance has it enabled; otherwise the public
  // testnet playground (play money, real payment flow).
  const demoHref = demoEnabled ? "/demo" : "https://testnet.stablerails.org/demo";
  const demoRel = demoEnabled ? "" : ` rel="noopener"`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0a0e0c" />
  <meta name="description" content="Stablerails: hosted, non-custodial USDT payments. We host checkout, API, webhooks and your dashboard; you hold the keys and sweep from your own machine. 0% per-transaction fees, no KYC, agent-friendly. Self-host the same software anytime." />
  <title>Stablerails &middot; hosted, non-custodial USDT payments</title>
  <style${styleNonceAttr}>
    :root {
      color-scheme: dark;
      --ink: #0a0e0c;
      --panel: #0e1411;
      --line: rgba(236, 233, 226, .08);
      --line-strong: rgba(236, 233, 226, .16);
      --text: #ece9e2;
      --muted: #8e988f;
      --dim: #79847c;
      --acc: #26A17B;
      --acc-bright: #3ddc97;
      --acc-soft: rgba(38, 161, 123, .12);
      --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; overflow-x: clip; }
    body {
      font-family: var(--sans);
      background: var(--ink);
      background-image:
        radial-gradient(ellipse 80% 42% at 50% -8%, rgba(38, 161, 123, .07) 0%, transparent 62%),
        repeating-linear-gradient(to bottom, transparent 0 27px, rgba(236, 233, 226, .02) 27px 28px);
      color: var(--text);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    ::selection { background: var(--acc); color: #04130d; }
    a { color: var(--acc-bright); text-decoration: none; }
    a:hover { text-decoration: underline; text-underline-offset: 3px; }
    a:focus-visible, button:focus-visible { outline: 2px solid var(--acc-bright); outline-offset: 2px; }
    a, button { -webkit-tap-highlight-color: transparent; }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }

    /* ── top nav (shared) ────────────────────────────────── */${SITE_NAV_CSS}

    /* ── hero ────────────────────────────────────────────── */
    .hero { padding: 6rem 0 5rem; }
    .badge {
      display: inline-flex; align-items: center; gap: .55rem;
      font-family: var(--mono); font-size: .68rem; font-weight: 600;
      letter-spacing: .14em; text-transform: uppercase;
      color: var(--acc-bright);
      border: 1px solid rgba(38, 161, 123, .35); background: var(--acc-soft);
      padding: .35rem .85rem; border-radius: 100px;
      margin-bottom: 1.8rem;
    }
    .railhead { position: relative; margin-bottom: 1.8rem; }
    .hero-h1 {
      font-family: var(--mono); font-weight: 700;
      font-size: clamp(2.1rem, 6.4vw, 3.7rem);
      letter-spacing: -.035em; line-height: 1.04;
      color: var(--text); text-wrap: balance;
    }
    .hero-h1 em { font-style: normal; color: var(--acc-bright); }
    /* full-bleed rails under the headline: two hairline rails + ties */
    .rail-svg {
      position: absolute; left: calc(50% - 50vw); width: 100vw; height: 28px;
      bottom: -16px; display: block; pointer-events: none;
    }
    .rail-line {
      stroke: var(--line-strong); stroke-width: 1;
      stroke-dasharray: 1; stroke-dashoffset: 0;
      animation: rail-draw 1.1s cubic-bezier(.16, 1, .3, 1) .25s both;
    }
    .rail-line-2 { animation-delay: .4s; }
    .rail-tie {
      stroke: rgba(236, 233, 226, .07); stroke-width: 16;
      stroke-dasharray: .004 .024;
    }
    @keyframes rail-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
    .tagline {
      font-size: clamp(1.05rem, 2.6vw, 1.3rem);
      color: var(--text); max-width: 600px; line-height: 1.5;
      margin-bottom: 1.6rem; text-wrap: balance;
    }
    .cta-row { display: flex; flex-wrap: wrap; gap: 1.1rem 1.4rem; align-items: center; margin-bottom: 2.4rem; }
    .cta-primary {
      display: inline-flex; align-items: center; gap: .4rem;
      font-family: var(--mono); font-size: .92rem; font-weight: 700; letter-spacing: .02em;
      color: #04130d; background: var(--acc-bright);
      border-radius: 8px; padding: .85rem 1.5rem;
      transition: background .15s ease, transform 160ms cubic-bezier(.23, 1, .32, 1);
    }
    .cta-primary:hover { text-decoration: none; background: var(--acc); transform: translateY(-1px); }
    .cta-primary:active { transform: scale(.98); }
    .cta-secondary {
      font-family: var(--mono); font-size: .9rem; color: var(--text);
      border-bottom: 1px solid var(--line-strong); padding-bottom: .12rem;
      transition: color .15s ease, border-color .15s ease;
    }
    .cta-secondary:hover { color: var(--acc-bright); border-color: var(--acc); text-decoration: none; }

    /* terminal command block */
    .term {
      max-width: 600px; border: 1px solid var(--line-strong); border-radius: 12px;
      background: var(--panel); overflow: hidden;
      box-shadow: 0 18px 50px rgba(0, 0, 0, .45), 0 0 0 1px rgba(38, 161, 123, .07);
    }
    .term-bar {
      display: flex; align-items: center; gap: .4rem;
      padding: .55rem .9rem; border-bottom: 1px solid var(--line);
      background: rgba(236, 233, 226, .02);
    }
    .term-title { font-family: var(--mono); font-size: .7rem; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
    .term-body { display: flex; align-items: center; gap: 1rem; padding: 1rem 1.1rem; }
    .term-cmd { font-family: var(--mono); font-size: .92rem; color: var(--text); flex: 1; overflow-x: auto; white-space: nowrap; }
    .term-prompt { color: var(--acc-bright); margin-right: .5rem; }
    .term-out {
      font-family: var(--mono); font-size: .78rem; color: var(--dim);
      padding: 0 1.1rem 1rem; line-height: 1.7; overflow-x: auto;
    }
    .term-line { display: block; white-space: pre-wrap; word-break: break-all; }
    .term-out .ok { color: var(--acc-bright); font-weight: 700; }
    .term-out .term-human { color: var(--text); }
    .term-out .term-hint { color: var(--acc); cursor: default; }
    .term-out .term-cmdline { color: var(--text); }
    /* hero terminal: the command types itself, then output lines land one by one */
    .hero .type {
      display: inline-block; overflow: hidden; white-space: nowrap; vertical-align: bottom;
      animation: typing 1.1s steps(${HERO_CMD.length}, end) .5s both;
    }
    @keyframes typing { from { width: 0; } to { width: ${HERO_CMD.length}ch; } }
    .hero .term-line { opacity: 0; animation: line-in .25s ease-out forwards; }
    .hero .term-line:nth-child(1) { animation-delay: 1.9s; }
    .hero .term-line:nth-child(2) { animation-delay: 2.2s; }
    .hero .term-line:nth-child(3) { animation-delay: 2.5s; }
    .hero .term-line:nth-child(4) { animation-delay: 2.8s; }
    @keyframes line-in { to { opacity: 1; } }
    .copy-btn {
      font-family: var(--mono); font-size: .7rem; font-weight: 700;
      letter-spacing: .1em; text-transform: uppercase;
      color: var(--acc-bright); background: var(--acc-soft);
      border: 1px solid rgba(38, 161, 123, .4); border-radius: 6px;
      padding: .45rem .9rem; cursor: pointer; flex-shrink: 0;
      min-width: 5.2rem; text-align: center; user-select: none;
      transition: background .15s ease, color .15s ease, border-color .15s ease,
                  transform 160ms cubic-bezier(.23, 1, .32, 1);
    }
    @media (hover: hover) and (pointer: fine) {
      .copy-btn:hover { background: rgba(38, 161, 123, .25); }
    }
    .copy-btn:active { transform: scale(.97); }
    .copy-btn.copied { color: #04130d; background: var(--acc-bright); border-color: var(--acc-bright); }
    .hero-alt {
      margin-top: 1.4rem; font-family: var(--mono); font-size: .85rem; color: var(--muted);
    }
    .hero-alt a { color: var(--text); border-bottom: 1px solid var(--line-strong); padding-bottom: .1rem; transition: color .15s ease, border-color .15s ease; }
    .hero-alt a:hover { color: var(--acc-bright); border-color: var(--acc); text-decoration: none; }
    .hero > * { animation: rise .55s cubic-bezier(.16, 1, .3, 1) both; }
    .hero > *:nth-child(2) { animation-delay: .07s; }
    .hero > *:nth-child(3) { animation-delay: .14s; }
    .hero > *:nth-child(4) { animation-delay: .21s; }
    .hero > *:nth-child(5) { animation-delay: .28s; }
    @keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
    /* sections fade in on scroll; .js-reveal is set by JS, so no-JS visitors see everything */
    .js-reveal .sec {
      opacity: 0; transform: translateY(16px);
      transition: opacity .55s cubic-bezier(.16, 1, .3, 1), transform .55s cubic-bezier(.16, 1, .3, 1);
    }
    .js-reveal .sec.in { opacity: 1; transform: none; }
    @media (prefers-reduced-motion: reduce) {
      .hero > *, .hero .type, .hero .term-line, .d-gate, .rail-line { animation: none !important; }
      .hero .term-line { opacity: 1; }
      .d-pulse { display: none; }
      html { scroll-behavior: auto; }
    }

    /* zero ledger: the row of everything we never take */
    .zeros {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 1.2rem;
      border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
      padding: 2.6rem 0;
    }
    .zero-fig {
      display: block; font-family: var(--mono); font-weight: 700; line-height: 1;
      font-size: clamp(2.1rem, 4.6vw, 3.2rem); letter-spacing: -.03em; color: var(--text);
      margin-bottom: .5rem;
    }
    .zero-cap { font-family: var(--mono); font-size: .75rem; letter-spacing: .06em; color: var(--muted); }
    @media (max-width: 720px) { .zeros { grid-template-columns: repeat(2, 1fr); row-gap: 2rem; } }

    /* ── numbered editorial sections ─────────────────────── */
    .sec { border-top: 1px solid var(--line); padding: 6rem 0; display: grid; grid-template-columns: 260px 1fr; gap: 3.5rem; }
    .sec-rail { font-family: var(--mono); }
    .sec-no { display: block; font-size: .72rem; letter-spacing: .18em; color: var(--acc); margin-bottom: .9rem; }
    .sec-rail h2 { font-family: var(--mono); font-size: 1.5rem; font-weight: 700; letter-spacing: -.02em; line-height: 1.3; color: var(--text); text-wrap: balance; }
    .sec-body p { color: var(--muted); max-width: 62ch; }
    .legal { text-wrap: pretty; }

    /* how it works */
    .steps { display: grid; gap: 1.6rem; margin-bottom: 1.6rem; }
    .step { display: flex; gap: 1.1rem; align-items: flex-start; }
    .step-no {
      font-family: var(--mono); font-size: 1.05rem; font-weight: 700; color: var(--acc-bright);
      flex-shrink: 0; min-width: 1.6rem;
    }
    .step h3 { font-size: 1rem; font-weight: 700; margin-bottom: .25rem; text-wrap: balance; }
    .step h3 em { font-style: normal; color: var(--acc-bright); }
    .step p { font-size: .9rem; color: var(--muted); max-width: 56ch; text-wrap: pretty; }
    .timeline {
      font-family: var(--mono); font-size: .78rem; letter-spacing: .04em; color: var(--muted);
      border: 1px solid var(--line-strong); border-radius: 6px;
      padding: .55rem .9rem; display: inline-block; margin: 0 0 1.8rem;
    }
    .diagram-scroll { overflow-x: auto; margin: .6rem 0 1.8rem; }
    .diagram { display: block; width: 100%; min-width: 600px; height: auto; margin: 0; font-family: var(--mono); }
    .d-box { fill: var(--panel); stroke: var(--line-strong); }
    .d-box-acc { stroke: var(--acc); }
    .d-box-dim { stroke: var(--line); stroke-dasharray: 4 4; }
    .d-label { fill: var(--text); font-size: 12px; font-weight: 700; letter-spacing: .06em; font-family: var(--mono); }
    .d-label-acc { fill: var(--acc-bright); }
    .d-sub { fill: var(--dim); font-size: 10px; font-family: var(--mono); }
    .d-line { stroke: var(--line-strong); stroke-width: 1.5; }
    .d-arrow { fill: var(--line-strong); }
    .d-dash { stroke: var(--line-strong); stroke-width: 1.5; stroke-dasharray: 4 4; }
    .d-gate { stroke: var(--acc-bright); stroke-width: 2; animation: gate-pulse 5s ease infinite .8s; }
    .d-gate-label { fill: var(--acc-bright); font-size: 9px; letter-spacing: .12em; font-family: var(--mono); }
    /* payment pulse: a payment travels the rail, pauses at the human gate, lands in the wallet */
    .d-pulse { fill: var(--acc-bright); opacity: 0; animation: flow 5s cubic-bezier(.45, .05, .55, .95) infinite .8s; }
    @keyframes flow {
      0% { transform: translateX(0); opacity: 0; }
      6% { opacity: 1; }
      44% { transform: translateX(348px); }
      54% { transform: translateX(368px); }
      86% { transform: translateX(444px); opacity: 1; }
      94%, 100% { transform: translateX(444px); opacity: 0; }
    }
    @keyframes gate-pulse { 44%, 54% { stroke-width: 2; } 49% { stroke-width: 4; } }
    .callout {
      font-family: var(--mono); font-size: 1.05rem; font-weight: 700;
      color: var(--text); border: 1px solid rgba(38, 161, 123, .4);
      background: var(--acc-soft); padding: .9rem 1.2rem; border-radius: 8px;
      max-width: 480px;
    }
    .callout::before { content: "▸ " / ""; color: var(--acc-bright); }

    /* cost */
    .cost-fig { font-family: var(--mono); font-weight: 700; font-size: clamp(2.4rem, 6vw, 3.6rem); letter-spacing: -.03em; color: var(--acc-bright); line-height: 1; margin-bottom: .8rem; }
    .cost-body p { color: var(--muted); max-width: 60ch; margin-bottom: 1rem; }
    .cost-body p strong { color: var(--text); }

    /* security ledger */
    .sec-security .sec-headline {
      font-size: clamp(1.5rem, 3.6vw, 2.2rem); font-weight: 800; letter-spacing: -.02em;
      line-height: 1.25; color: var(--text); margin-bottom: 2.2rem; max-width: 22ch;
    }
    .sec-security .sec-headline em { font-style: normal; color: var(--acc-bright); }
    .ledger { display: grid; grid-template-columns: 1fr 1fr; column-gap: 2rem; border-top: 1px solid var(--line); }
    .ledger-row { border-bottom: 1px solid var(--line); padding: 1.45rem 1.2rem 1.45rem 0; }
    .ledger-row:nth-child(even) { border-left: 1px solid var(--line); padding-left: 1.4rem; }
    .ledger-row dt { font-family: var(--mono); font-size: .82rem; font-weight: 700; color: var(--text); margin-bottom: .35rem; }
    .ledger-row dd { font-size: .86rem; color: var(--muted); text-wrap: pretty; }

    /* agent block */
    .agent-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-top: 2rem; }
    .agent-path {
      border: 1px solid var(--line); border-radius: 12px; padding: 1.6rem;
      background: linear-gradient(180deg, rgba(236, 233, 226, .025), transparent 40%), var(--panel);
      box-shadow: 0 10px 32px rgba(0, 0, 0, .28);
    }
    .agent-path h3 { font-family: var(--mono); font-size: .78rem; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); margin-bottom: 1rem; }
    .agent-link { display: inline-block; font-family: var(--mono); font-size: .95rem; font-weight: 700; color: var(--acc-bright); margin-top: .4rem; }
    .agent-note { margin-top: .8rem; font-size: .8rem; color: var(--dim); }
    .agent-except { color: var(--text); font-weight: 600; }

    /* features */
    .feat-grid { display: grid; grid-template-columns: repeat(4, 1fr); border-left: 1px solid var(--line); border-top: 1px solid var(--line); }
    .feat { border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 1.5rem; }
    .feat-wide { grid-column: span 2; }
    .feat h3 { font-size: .88rem; font-weight: 700; margin-bottom: .3rem; }
    .feat p { font-size: .85rem; color: var(--dim); line-height: 1.5; }
    .feat-snip {
      display: block; margin-top: .6rem;
      font-family: var(--mono); font-size: .72rem; color: var(--acc-bright);
      background: rgba(236, 233, 226, .03); border: 1px solid var(--line);
      border-radius: 6px; padding: .45rem .7rem;
      overflow-x: auto; white-space: nowrap;
    }
    .roadmap {
      margin-top: 1.6rem; display: inline-block;
      font-family: var(--mono); font-size: .75rem; letter-spacing: .08em;
      color: var(--muted); border: 1px dashed var(--line-strong);
      border-radius: 100px; padding: .45rem 1.1rem;
    }
    .roadmap b { color: var(--acc-bright); font-weight: 600; }

    /* self-host fork */
    .selfhost {
      border: 1px solid var(--line-strong); border-radius: 12px;
      background: linear-gradient(180deg, rgba(38, 161, 123, .05), transparent 55%), var(--panel);
      padding: 1.8rem; max-width: 640px;
    }
    .selfhost p { color: var(--muted); font-size: .92rem; margin-bottom: 1rem; }
    .selfhost .cta-secondary { font-size: .95rem; }

    /* legal */
    .none-ledger { max-width: 640px; margin-bottom: 1.6rem; }
    .none-row { display: flex; align-items: baseline; gap: .8rem; font-family: var(--mono); font-size: .85rem; padding: .5rem 0; }
    .none-row dt { color: var(--muted); flex-shrink: 0; }
    .none-row .dots { flex: 1; border-bottom: 1px dotted var(--line-strong); transform: translateY(-4px); }
    .none-row dd { color: var(--acc-bright); text-align: right; }
    .legal {
      font-family: var(--mono); font-size: .82rem; line-height: 1.7; color: var(--muted);
      border: 1px solid var(--line-strong); border-radius: 10px;
      padding: 1.3rem 1.5rem; background: var(--panel); max-width: 640px;
    }
    .legal strong { color: var(--text); }

    /* closing */
    .closing-cta { margin-top: .4rem; }

    /* footer */
    .footer { border-top: 1px solid var(--line); padding: 2.4rem 0 3rem; }
    .footer-links { display: flex; flex-wrap: wrap; gap: 1.6rem; font-family: var(--mono); font-size: .78rem; margin-bottom: 1.4rem; }
    .footer-links a { color: var(--muted); transition: color .15s ease; display: inline-block; padding: .55rem 0; margin: -.55rem 0; }
    .footer-links a:hover { color: var(--acc-bright); text-decoration: none; }
    .footer-fine { font-size: .75rem; color: var(--dim); display: flex; flex-wrap: wrap; gap: .4rem 1.4rem; align-items: center; }
    .footer-fine .no3p { display: block; width: 100%; font-size: .78rem; color: var(--acc-bright); font-family: var(--mono); margin-bottom: .5rem; }

    @media (max-width: 880px) {
      .sec { grid-template-columns: 1fr; gap: 1.8rem; padding: 4rem 0; }
      .ledger, .agent-grid { grid-template-columns: 1fr; }
      .ledger-row:nth-child(even) { border-left: 0; padding-left: 0; }
      .feat-grid { grid-template-columns: repeat(2, 1fr); }
      .hero { padding: 3.5rem 0 3.5rem; }
    }
    @media (max-width: 520px) {
      .feat-grid { grid-template-columns: 1fr; }
      .feat-wide { grid-column: auto; }
      .term-body { flex-direction: column; align-items: stretch; }
    }
  </style>
</head>
<body>

<header class="wrap">
  ${siteNavHtml({ active: "home" })}
</header>

<main class="wrap">

  <!-- ── 1 · HERO ──────────────────────────────────────────── -->
  <section class="hero">
    <div class="badge">Non-custodial &middot; hosted</div>
    <div class="railhead">
      <h1 class="hero-h1">Get paid in USDT.<br/>Hold your <em>own keys</em>.</h1>
      <svg class="rail-svg" aria-hidden="true" focusable="false">
        <line class="rail-tie" x1="0" y1="14" x2="100%" y2="14" pathLength="1"/>
        <line class="rail-line" x1="0" y1="6" x2="100%" y2="6" pathLength="1"/>
        <line class="rail-line rail-line-2" x1="0" y1="22" x2="100%" y2="22" pathLength="1"/>
      </svg>
    </div>
    <p class="tagline">We host checkout, the API, webhooks and your dashboard. Funds land on addresses only you can sweep.</p>
    <div class="cta-row">
      <a class="cta-primary" href="${SIGNUP_URL}">Create account &rarr;</a>
      <a class="cta-secondary" href="/setup">or self-host it</a>
    </div>
    ${renderHeroTerminal()}
    <p class="hero-alt">Hand it to your agent: <a href="/agents">/agents &rarr;</a> &middot; or pay in the <a href="${demoHref}"${demoRel}>live demo &rarr;</a></p>
  </section>

  <!-- ── ZERO LEDGER ──────────────────────────────────────── -->
  <section class="zeros" aria-label="What we never take">
    <div class="zero"><span class="zero-fig">0%</span><span class="zero-cap">per-payment fee</span></div>
    <div class="zero"><span class="zero-fig">0</span><span class="zero-cap">keys on the server</span></div>
    <div class="zero"><span class="zero-fig">0</span><span class="zero-cap">KYC, no company needed</span></div>
    <div class="zero"><span class="zero-fig">0</span><span class="zero-cap">ways for us to move your money</span></div>
  </section>

  <!-- ── 2 · HOW IT WORKS ─────────────────────────────────── -->
  <section class="sec" id="how-it-works">
    <div class="sec-rail">
      <span class="sec-no">01</span>
      <h2>From sign-up to paid</h2>
    </div>
    <div class="sec-body">
      <div class="steps">${renderFlow()}
      </div>
      <p class="timeline">sign up &rarr; first invoice: ~5 min &middot; payment &rarr; confirmed: ~1 min &middot; sweep: whenever you decide</p>
      ${renderDiagram()}
      <p class="callout">Keys never leave your machine.</p>
    </div>
  </section>

  <!-- ── 3 · SECURITY MODEL ───────────────────────────────── -->
  <section class="sec sec-security" id="security">
    <div class="sec-rail">
      <span class="sec-no">02</span>
      <h2>We host the rails. You hold the keys.</h2>
    </div>
    <div class="sec-body">
      <p class="sec-headline">Our servers cannot steal your funds. <em>Neither can your AI agent.</em></p>
      <dl class="ledger">
        <div class="ledger-row">
          <dt>The server we host is watch-only</dt>
          <dd>Zero keys on it. Full compromise, worst case: an attacker reads invoice metadata. Funds untouchable.</dd>
        </div>
        <div class="ledger-row">
          <dt>Signing is local, human, deliberate</dt>
          <dd>Sweeps are signed only via the local CLI on your machine, behind a passphrase, with optional Touch ID. No passphrase, no movement.</dd>
        </div>
        <div class="ledger-row">
          <dt>Destination pinned locally</dt>
          <dd>The sweep destination is pinned on your machine. A fully compromised server cannot redirect a sweep to an attacker.</dd>
        </div>
        <div class="ledger-row">
          <dt>Two RPCs must agree</dt>
          <dd>Two providers must read the same on-chain receipt at a solid block. Disagree: nothing credits, retry next tick. Never a false &#39;paid&#39;.</dd>
        </div>
        <div class="ledger-row">
          <dt>AI agents get readonly keys</dt>
          <dd>Agents can run your store: create invoices, read events, watch sweeps. They physically cannot move your money.</dd>
        </div>
        <div class="ledger-row">
          <dt>100% open source</dt>
          <dd>Every line is public, signer included. 1,000+ offline tests: clone, run, audit.</dd>
        </div>
        <div class="ledger-row">
          <dt>No lock-in</dt>
          <dd>Funds already sit in addresses you control; your data exports in one call. Self-host the same software and keep going.</dd>
        </div>
        <div class="ledger-row">
          <dt>Survives the project</dt>
          <dd>AGPL-3.0 is irrevocable. The code is yours to run forever, with us or without us.</dd>
        </div>
      </dl>
    </div>
  </section>

  <!-- ── 4 · WHAT IT COSTS ────────────────────────────────── -->
  <section class="sec" id="pricing">
    <div class="sec-rail">
      <span class="sec-no">03</span>
      <h2>What it costs</h2>
    </div>
    <div class="sec-body cost-body">
      <div class="cost-fig">0%</div>
      <p><strong>Free while we&#39;re in beta.</strong> There is no per-payment fee, hosted or self-hosted: the software has no fee code path. You are never billed a cut of what you collect.</p>
      <p>If the rails earn their keep, you&#39;ll be able to support hosting directly. Either way, what your customers pay is what lands in your wallet.</p>
    </div>
  </section>

  <!-- ── 5 · AGENT-FRIENDLY ───────────────────────────────── -->
  <section class="sec" id="agents">
    <div class="sec-rail">
      <span class="sec-no">04</span>
      <h2>Built for the agentic web</h2>
    </div>
    <div class="sec-body">
      <p>MCP server included. Machine-readable <a href="/llms.txt">/llms.txt</a>. JSON output everywhere. An AI agent can integrate your store, create invoices and watch payments, <span class="agent-except">except the one thing it must never do: touch your passphrase.</span></p>
      <div class="agent-grid">
        <div class="agent-path">
          <h3>You point it at the docs</h3>
          <a class="agent-link" href="/agents">/agents &rarr;</a>
          <p class="agent-note">A copyable prompt and the MCP config. Your agent reads the API and gets to work.</p>
        </div>
        <div class="agent-path">
          <h3>It runs on a readonly key</h3>
          <a class="agent-link" href="/agents.md">/agents.md &rarr;</a>
          <p class="agent-note">Everything an agent needs to operate the store, plus a hard boundary: on a readonly key, even a misled agent can&#39;t move funds.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ── 6 · FEATURES ─────────────────────────────────────── -->
  <section class="sec" id="features">
    <div class="sec-rail">
      <span class="sec-no">05</span>
      <h2>What&#39;s in the box</h2>
    </div>
    <div class="sec-body">
      <div class="feat-grid">${renderFeatures()}
      </div>
      <span class="roadmap"><b>Tron (USDT) shipped</b> &middot; Polygon, Ethereum, USDC &rarr; <a href="https://github.com/stablerails/stablerails/issues" rel="noopener">tracked in the open</a></span>
    </div>
  </section>

  <!-- ── 7 · SELF-HOST ────────────────────────────────────── -->
  <section class="sec" id="self-host">
    <div class="sec-rail">
      <span class="sec-no">06</span>
      <h2>Prefer full sovereignty?</h2>
    </div>
    <div class="sec-body">
      <div class="selfhost">
        <p>Run the exact same software on your own VPS: your URL, your data, free forever. One Docker command, an agent prompt, or from source. Leaving hosted later is one export away, and your keys already work everywhere.</p>
        <a class="cta-secondary" href="/setup">Self-host it &rarr;</a>
      </div>
    </div>
  </section>

  <!-- ── 8 · JUST SOFTWARE ────────────────────────────────── -->
  <section class="sec" id="legal">
    <div class="sec-rail">
      <span class="sec-no">07</span>
      <h2>Non-custodial, by architecture</h2>
    </div>
    <div class="sec-body">
      <dl class="none-ledger">
        <div class="none-row"><dt>KYC</dt><span class="dots"></span><dd>none</dd></div>
        <div class="none-row"><dt>company / legal entity</dt><span class="dots"></span><dd>not required</dd></div>
        <div class="none-row"><dt>our access to your keys</dt><span class="dots"></span><dd>zero, by design</dd></div>
        <div class="none-row"><dt>our access to your funds</dt><span class="dots"></span><dd>zero, you sweep locally</dd></div>
        <div class="none-row"><dt>per-payment fee</dt><span class="dots"></span><dd>$0, no fee code path</dd></div>
      </dl>
      <div class="legal">
        <strong>Stablerails is software, not a payment service.</strong> Whether you self-host or use our hosted instance, the server is watch-only: it never holds, transmits, or can access anyone&#39;s keys or funds. You alone sweep, from your own machine. No KYC. No payer emails collected, no payer IPs logged. Compliance with your local laws stays yours. <a href="/terms">Terms</a> &middot; <a href="/docs">Read the docs &rarr;</a>
      </div>
    </div>
  </section>

  <!-- ── 9 · CLOSING CTA ──────────────────────────────────── -->
  <section class="sec" id="start">
    <div class="sec-rail">
      <span class="sec-no">08</span>
      <h2>Start accepting USDT</h2>
    </div>
    <div class="sec-body">
      <div class="cta-row closing-cta">
        <a class="cta-primary" href="${SIGNUP_URL}">Create account &rarr;</a>
        <a class="cta-secondary" href="/setup">or self-host it</a>
      </div>
      <p class="hero-alt">Hand it to your agent: <a href="/agents">/agents &rarr;</a> &middot; or pay in the <a href="${demoHref}"${demoRel}>live demo &rarr;</a></p>
    </div>
  </section>

</main>

<!-- ── FOOTER ───────────────────────────────────────────── -->
<footer class="footer">
  <div class="wrap">
    <div class="footer-links">
      <a href="https://github.com/stablerails/stablerails" rel="noopener">github</a>
      <a href="/setup">self-host</a>
      <a href="/docs">docs</a>
      <a href="/agents">agents</a>
      <a href="/llms.txt">llms.txt</a>
      <a href="/terms">terms</a>
      <a href="/login">operator login</a>
    </div>
    <div class="footer-fine">
      <span class="no3p">This page loads nothing from third parties: no fonts, no analytics, no trackers. Open your network tab and verify.</span>
      <span>&copy; Stablerails contributors &middot; AGPL-3.0</span>
    </div>
  </div>
</footer>

<script${scriptNonceAttr}>
  // Copy-to-clipboard for command blocks. Bound via addEventListener —
  // CSP script-src-attr blocks inline handlers. Buttons ship hidden and are
  // revealed here, so a no-JS visitor never sees a dead control.
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    var timer;
    btn.hidden = false;
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = "copied";
        btn.classList.add("copied");
        clearTimeout(timer);
        timer = setTimeout(function () {
          btn.textContent = "copy";
          btn.classList.remove("copied");
        }, 1600);
      }).catch(function () { /* clipboard unavailable — no-op */ });
    });
  });

  // Interactive hero demo: press ⏎ (or click/tap the terminal) and watch a
  // payment land — every line mirrors the real envelope and the real
  // two-RPC / solid-block language. Transcript ships in an inert <template>.
  (function () {
    var term = document.querySelector(".hero .term");
    var out = document.querySelector(".hero .term-out");
    var tpl = document.getElementById("demo-tx");
    if (!term || !out || !tpl) return;
    out.setAttribute("aria-live", "polite");
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var hint = null;
    var playing = false;
    function addLine(text, cls) {
      var el = document.createElement("span");
      el.className = "term-line" + (cls ? " " + cls : "");
      el.textContent = text;
      out.appendChild(el);
      return el;
    }
    function showHint(label) { hint = addLine(label, "term-hint"); }
    function play() {
      if (playing) return;
      playing = true;
      if (hint) { hint.remove(); hint = null; }
      var cmd = addLine("$ ", "term-cmdline");
      var demoCmd = "stablerails watch inv_9f2c41d0";
      var lines = Array.prototype.slice.call(tpl.content.querySelectorAll(".term-line"));
      function emit(i) {
        if (i >= lines.length) { showHint("⏎ replay"); playing = false; return; }
        out.appendChild(lines[i].cloneNode(true));
        setTimeout(function () { emit(i + 1); }, reduce ? 0 : 650);
      }
      if (reduce) { cmd.textContent = "$ " + demoCmd; emit(0); return; }
      var pos = 0;
      var typer = setInterval(function () {
        pos += 1;
        cmd.textContent = "$ " + demoCmd.slice(0, pos);
        if (pos >= demoCmd.length) {
          clearInterval(typer);
          setTimeout(function () { emit(0); }, 350);
        }
      }, 28);
    }
    setTimeout(function () { showHint("press ⏎  watch a payment land"); }, reduce ? 400 : 3600);
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && t.closest && t.closest("button, a, input, textarea, select, summary")) return;
      play();
    });
    term.addEventListener("click", function (e) {
      if (e.target.closest("button, a")) return;
      play();
    });
  })();

  // Scroll-reveal for sections. Gated behind .js-reveal so content is always
  // visible without JS; skipped entirely under prefers-reduced-motion.
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches && "IntersectionObserver" in window) {
    document.documentElement.classList.add("js-reveal");
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add("in"); io.unobserve(entry.target); }
      });
    }, { rootMargin: "0px 0px -10% 0px" });
    document.querySelectorAll(".sec").forEach(function (s) { io.observe(s); });
  }
</script>

</body>
</html>`;
}

export async function registerLandingRoutes(app: FastifyInstance): Promise<void> {
  // Exact "/" route — no wildcard
  app.get(
    "/",
    {
      config: {
        helmet: {
          enableCSPNonces: true,
          contentSecurityPolicy: {
            directives: {
              "default-src": ["'self'"],
              // style-src: nonce for the single <style> block
              "style-src": ["'self'"],
              // script-src: 'self' + the per-request nonce from enableCSPNonces.
              // Do not use 'none' here because when a nonce is present Chrome
              // ignores 'none' and logs a console warning.
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
      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;
      // Mirror the condition used in app.ts to mount the demo routes.
      const demoEnabled = isDemoEnabled();
      const html = renderLanding(cspNonce?.script, cspNonce?.style, demoEnabled);
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(html);
    },
  );
}
