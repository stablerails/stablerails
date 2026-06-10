/**
 * Stablerails public landing page.
 *
 * GET / — static, server-rendered, single-file HTML; no auth, no data.
 *
 * Positioning: free, open-source (AGPL-3.0), SELF-HOSTED, NON-CUSTODIAL
 * stablecoin payment SOFTWARE (never "payment system" or "service" —
 * the BTCPay legal posture).
 *
 * Hard constraints:
 *  - Nonce-based CSP: every <style> and <script> tag carries the
 *    per-request nonce (helmet enableCSPNonces, same as checkout).
 *  - ZERO external requests: system font stack, inline SVG only,
 *    relative URLs for all resources. No fonts, no CDN, no analytics,
 *    no data: URIs. Absolute URLs appear only as navigation anchors
 *    (<a href> to the GitHub repo) — they load nothing until clicked.
 *  - Minimal JS: a single nonce'd script that binds copy-to-clipboard
 *    buttons via addEventListener (script-src-attr blocks inline handlers).
 *
 * Aesthetic: "terminal sovereignty" — dark ink, monospace display type,
 * ledger hairlines, numbered sections, one green accent harmonized with
 * the checkout page (#26A17B family).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { isDemoEnabled } from "../utils.js";

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

const INIT_COMMAND = "npx stablerails init";

interface Feature {
  code: string;
  name: string;
  text: string;
}

const FEATURES: Feature[] = [
  { code: "F-01", name: "Per-invoice HD addresses", text: "A fresh deposit address for every invoice, derived from your xpub. No address reuse." },
  { code: "F-02", name: "Hosted checkout + payment links", text: "A ready checkout page with QR, countdown and live status. Share a link, get paid." },
  { code: "F-03", name: "HMAC-signed webhooks", text: "Signed delivery with retries. Verify the signature, trust the event." },
  { code: "F-04", name: "Multi-merchant tenancy", text: "One instance, many stores. Scoped API keys per merchant." },
  { code: "F-05", name: "Operator dashboard", text: "Invoices, payments, sweeps and CSV export behind an operator login." },
  { code: "F-06", name: "Kill-switch", text: "Pause invoicing, watching or webhooks at runtime — per area, no restart." },
  { code: "F-07", name: "Prometheus metrics", text: "First-class /metrics endpoint for your own monitoring. Your data stays yours." },
  { code: "F-08", name: "Docker deploy", text: "Server, worker and Postgres in one compose file. Up in minutes on a $5 box." },
];

function renderFeatures(): string {
  return FEATURES.map(
    (f) => `
      <div class="feat">
        <span class="feat-code">${f.code}</span>
        <h3>${f.name}</h3>
        <p>${f.text}</p>
      </div>`,
  ).join("");
}

/** Terminal-framed copyable command block. */
function renderCommandBlock(idSuffix: string): string {
  return `
      <div class="term" role="group" aria-label="Install command">
        <div class="term-bar">
          <span class="term-dot"></span><span class="term-dot"></span><span class="term-dot"></span>
          <span class="term-title">get started &middot; 30 seconds</span>
        </div>
        <div class="term-body">
          <code class="term-cmd"><span class="term-prompt">$</span> ${INIT_COMMAND}</code>
          <button class="copy-btn" id="copy-${idSuffix}" type="button" data-copy="${INIT_COMMAND}" aria-label="Copy command to clipboard">copy</button>
        </div>
      </div>`;
}

/** Inline SVG flow diagram: payer → per-invoice address → (passphrase gate) → your wallet. */
function renderDiagram(): string {
  return `
      <svg class="diagram" viewBox="0 0 720 230" role="img" aria-label="Payment flow: payer sends to a per-invoice address; the watch-only server observes the chain; funds sweep to your wallet only after a local passphrase">
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
        <!-- watch-only server (observes, holds nothing) -->
        <line class="d-dash" x1="308" y1="96" x2="308" y2="156"/>
        <rect class="d-box d-box-dim" x="198" y="158" width="220" height="56" rx="6"/>
        <text class="d-label" x="308" y="182" text-anchor="middle">WATCH-ONLY SERVER</text>
        <text class="d-sub" x="308" y="200" text-anchor="middle">observes the chain &middot; holds no keys</text>
      </svg>`;
}

function renderLanding(scriptNonce?: string, styleNonce?: string, demoEnabled?: boolean): string {
  const styleNonceAttr = styleNonce ? ` nonce="${styleNonce}"` : "";
  const scriptNonceAttr = scriptNonce ? ` nonce="${scriptNonce}"` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Stablerails — free, open-source, self-hosted, non-custodial stablecoin payment software. 0% fees, no KYC, agent-friendly. Your keys never touch the server." />
  <title>Stablerails — self-hosted, non-custodial stablecoin payments</title>
  <style${styleNonceAttr}>
    :root {
      --ink: #0a0e0c;
      --panel: #0e1411;
      --line: rgba(236, 233, 226, .08);
      --line-strong: rgba(236, 233, 226, .16);
      --text: #ece9e2;
      --muted: #8e988f;
      --dim: #5c665e;
      --acc: #26A17B;
      --acc-bright: #3ddc97;
      --acc-soft: rgba(38, 161, 123, .12);
      --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: var(--sans);
      background: var(--ink);
      background-image:
        radial-gradient(ellipse 80% 42% at 50% -8%, rgba(38, 161, 123, .13) 0%, transparent 62%),
        radial-gradient(rgba(236, 233, 226, .035) 1px, transparent 1px);
      background-size: auto, 28px 28px;
      color: var(--text);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    ::selection { background: var(--acc); color: #04130d; }
    a { color: var(--acc-bright); text-decoration: none; }
    a:hover { text-decoration: underline; text-underline-offset: 3px; }
    a:focus-visible, button:focus-visible { outline: 2px solid var(--acc-bright); outline-offset: 2px; border-radius: 2px; }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 0 24px; }

    /* ── top nav ─────────────────────────────────────────── */
    .nav {
      display: flex; align-items: center; gap: 1.5rem;
      padding: 1.1rem 0; border-bottom: 1px solid var(--line);
      font-family: var(--mono); font-size: .8rem;
    }
    .nav-mark { display: inline-flex; align-items: center; gap: .55rem; color: var(--text); font-weight: 700; letter-spacing: -.02em; }
    .nav-mark:hover { text-decoration: none; }
    .nav-mark svg { color: var(--acc); }
    .nav-links { margin-left: auto; display: flex; align-items: center; gap: 1.4rem; flex-wrap: wrap; }
    .nav-links a { color: var(--muted); }
    .nav-links a:hover { color: var(--text); text-decoration: none; }
    .nav-login { border: 1px solid var(--line-strong); padding: .35rem .8rem; border-radius: 6px; }
    .nav-login:hover { border-color: var(--acc); color: var(--acc-bright); }

    /* ── hero ────────────────────────────────────────────── */
    .hero { padding: 6rem 0 5rem; }
    .badge {
      display: inline-flex; align-items: center; gap: .55rem;
      font-family: var(--mono); font-size: .68rem; font-weight: 600;
      letter-spacing: .14em; text-transform: uppercase;
      color: var(--acc-bright);
      border: 1px solid rgba(38, 161, 123, .35); background: var(--acc-soft);
      padding: .35rem .85rem; border-radius: 100px;
      margin-bottom: 2.2rem;
    }
    .badge-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--acc-bright); box-shadow: 0 0 6px rgba(61, 220, 151, .9); }
    .wordmark {
      font-family: var(--mono); font-weight: 700;
      font-size: clamp(2.8rem, 9vw, 5.4rem);
      letter-spacing: -.045em; line-height: 1;
      margin-bottom: 1.4rem; color: var(--text);
    }
    .wordmark .rails { color: var(--acc-bright); }
    .cursor {
      display: inline-block; width: .55em; height: .92em;
      background: var(--acc-bright); margin-left: .12em;
      transform: translateY(.08em);
      animation: blink 1.1s steps(1) infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
    .tagline {
      font-size: clamp(1.05rem, 2.6vw, 1.35rem);
      color: var(--text); max-width: 620px; line-height: 1.5;
      margin-bottom: .8rem;
    }
    .tagline-tags {
      font-family: var(--mono); font-size: .82rem; color: var(--muted);
      letter-spacing: .04em; margin-bottom: 2.6rem;
    }
    .tagline-tags b { color: var(--acc-bright); font-weight: 600; }

    /* terminal command block */
    .term {
      max-width: 560px; border: 1px solid var(--line-strong); border-radius: 10px;
      background: var(--panel); overflow: hidden;
      box-shadow: 0 18px 50px rgba(0, 0, 0, .45), 0 0 0 1px rgba(38, 161, 123, .07);
    }
    .term-bar {
      display: flex; align-items: center; gap: .4rem;
      padding: .55rem .9rem; border-bottom: 1px solid var(--line);
      background: rgba(236, 233, 226, .02);
    }
    .term-dot { width: 9px; height: 9px; border-radius: 50%; background: rgba(236, 233, 226, .14); }
    .term-title { margin-left: .6rem; font-family: var(--mono); font-size: .66rem; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
    .term-body { display: flex; align-items: center; gap: 1rem; padding: 1rem 1.1rem; }
    .term-cmd { font-family: var(--mono); font-size: .98rem; color: var(--text); flex: 1; overflow-x: auto; white-space: nowrap; }
    .term-prompt { color: var(--acc-bright); margin-right: .5rem; }
    .copy-btn {
      font-family: var(--mono); font-size: .72rem; font-weight: 700;
      letter-spacing: .1em; text-transform: uppercase;
      color: var(--acc-bright); background: var(--acc-soft);
      border: 1px solid rgba(38, 161, 123, .4); border-radius: 6px;
      padding: .45rem .9rem; cursor: pointer; flex-shrink: 0;
      transition: background .15s, color .15s, border-color .15s;
    }
    .copy-btn:hover { background: rgba(38, 161, 123, .25); }
    .copy-btn.copied { color: #04130d; background: var(--acc-bright); border-color: var(--acc-bright); }
    .hero-alt {
      margin-top: 1.4rem; font-family: var(--mono); font-size: .85rem;
    }
    .hero-alt a { color: var(--text); border-bottom: 1px solid var(--line-strong); padding-bottom: .1rem; }
    .hero-alt a:hover { color: var(--acc-bright); border-color: var(--acc); text-decoration: none; }
    .hero-fine { margin-top: 1.6rem; font-size: .8rem; color: var(--dim); max-width: 540px; }
    .hero > * { animation: rise .6s ease both; }
    .hero > *:nth-child(2) { animation-delay: .07s; }
    .hero > *:nth-child(3) { animation-delay: .14s; }
    .hero > *:nth-child(4) { animation-delay: .21s; }
    .hero > *:nth-child(5) { animation-delay: .28s; }
    .hero > *:nth-child(6) { animation-delay: .35s; }
    @keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) {
      .hero > *, .cursor { animation: none !important; }
      html { scroll-behavior: auto; }
    }

    /* ── numbered editorial sections ─────────────────────── */
    .sec { border-top: 1px solid var(--line); padding: 4.5rem 0; display: grid; grid-template-columns: 260px 1fr; gap: 3rem; }
    .sec-rail { font-family: var(--mono); }
    .sec-no { display: block; font-size: .72rem; letter-spacing: .18em; color: var(--acc); margin-bottom: .9rem; }
    .sec-rail h2 { font-family: var(--mono); font-size: 1.35rem; font-weight: 700; letter-spacing: -.02em; line-height: 1.3; color: var(--text); }
    .sec-body p { color: var(--muted); max-width: 62ch; }

    /* how it works */
    .steps { display: grid; gap: 1.6rem; margin-bottom: 2.4rem; }
    .step { display: flex; gap: 1.1rem; align-items: flex-start; }
    .step-no {
      font-family: var(--mono); font-size: .78rem; font-weight: 700; color: var(--acc-bright);
      border: 1px solid rgba(38, 161, 123, .4); border-radius: 6px;
      padding: .28rem .55rem; flex-shrink: 0; background: var(--acc-soft);
    }
    .step h3 { font-size: 1rem; font-weight: 700; margin-bottom: .25rem; }
    .step p { font-size: .9rem; color: var(--muted); max-width: 56ch; }
    .diagram { width: 100%; height: auto; margin: .6rem 0 1.8rem; font-family: var(--mono); }
    .d-box { fill: var(--panel); stroke: var(--line-strong); }
    .d-box-acc { stroke: var(--acc); }
    .d-box-dim { stroke: var(--line); stroke-dasharray: 4 4; }
    .d-label { fill: var(--text); font-size: 12px; font-weight: 700; letter-spacing: .06em; font-family: var(--mono); }
    .d-label-acc { fill: var(--acc-bright); }
    .d-sub { fill: var(--dim); font-size: 10px; font-family: var(--mono); }
    .d-line { stroke: var(--line-strong); stroke-width: 1.5; }
    .d-arrow { fill: var(--line-strong); }
    .d-dash { stroke: var(--line-strong); stroke-width: 1.5; stroke-dasharray: 4 4; }
    .d-gate { stroke: var(--acc-bright); stroke-width: 2; }
    .d-gate-label { fill: var(--acc-bright); font-size: 9px; letter-spacing: .12em; font-family: var(--mono); }
    .callout {
      font-family: var(--mono); font-size: 1.05rem; font-weight: 700;
      color: var(--text); border-left: 3px solid var(--acc);
      background: var(--acc-soft); padding: .9rem 1.2rem; border-radius: 0 8px 8px 0;
      max-width: 480px;
    }

    /* security ledger */
    .sec-security .sec-headline {
      font-size: clamp(1.5rem, 3.6vw, 2.2rem); font-weight: 800; letter-spacing: -.02em;
      line-height: 1.25; color: var(--text); margin-bottom: 2.2rem; max-width: 22ch;
    }
    .sec-security .sec-headline em { font-style: normal; color: var(--acc-bright); }
    .ledger { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid var(--line); }
    .ledger-row { border-bottom: 1px solid var(--line); padding: 1.2rem 1.2rem 1.2rem 0; }
    .ledger-row dt { font-family: var(--mono); font-size: .82rem; font-weight: 700; color: var(--text); margin-bottom: .35rem; }
    .ledger-row dt::before { content: "▸ "; color: var(--acc-bright); }
    .ledger-row dd { font-size: .86rem; color: var(--muted); }

    /* agent block */
    .agent-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-top: 2rem; }
    .agent-path { border: 1px solid var(--line-strong); border-radius: 10px; padding: 1.4rem; background: var(--panel); }
    .agent-path h3 { font-family: var(--mono); font-size: .78rem; letter-spacing: .14em; text-transform: uppercase; color: var(--dim); margin-bottom: 1rem; }
    .agent-path .term { max-width: none; box-shadow: none; }
    .agent-link { display: inline-block; font-family: var(--mono); font-size: .95rem; font-weight: 700; color: var(--acc-bright); margin-top: .4rem; }
    .agent-note { margin-top: .8rem; font-size: .8rem; color: var(--dim); }
    .agent-except { color: var(--text); font-weight: 600; }

    /* features */
    .feat-grid { display: grid; grid-template-columns: repeat(4, 1fr); border-left: 1px solid var(--line); border-top: 1px solid var(--line); }
    .feat { border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 1.2rem; }
    .feat-code { font-family: var(--mono); font-size: .64rem; letter-spacing: .14em; color: var(--acc); display: block; margin-bottom: .6rem; }
    .feat h3 { font-size: .88rem; font-weight: 700; margin-bottom: .3rem; }
    .feat p { font-size: .78rem; color: var(--dim); line-height: 1.5; }
    .roadmap {
      margin-top: 1.6rem; display: inline-block;
      font-family: var(--mono); font-size: .74rem; letter-spacing: .08em;
      color: var(--muted); border: 1px dashed var(--line-strong);
      border-radius: 100px; padding: .45rem 1.1rem;
    }
    .roadmap b { color: var(--acc-bright); font-weight: 600; }

    /* honesty + legal */
    .plain { font-size: 1rem; color: var(--muted); max-width: 62ch; }
    .plain strong { color: var(--text); }
    .legal {
      font-family: var(--mono); font-size: .82rem; line-height: 1.7; color: var(--muted);
      border: 1px solid var(--line-strong); border-radius: 10px;
      padding: 1.3rem 1.5rem; background: var(--panel); max-width: 640px;
    }
    .legal strong { color: var(--text); }

    /* footer */
    .footer { border-top: 1px solid var(--line); padding: 2.4rem 0 3rem; }
    .footer-links { display: flex; flex-wrap: wrap; gap: 1.6rem; font-family: var(--mono); font-size: .78rem; margin-bottom: 1.4rem; }
    .footer-links a { color: var(--muted); }
    .footer-links a:hover { color: var(--acc-bright); text-decoration: none; }
    .footer-fine { font-size: .72rem; color: var(--dim); display: flex; flex-wrap: wrap; gap: .4rem 1.4rem; align-items: center; }
    .footer-fine .no3p { color: var(--acc); font-family: var(--mono); }

    @media (max-width: 880px) {
      .sec { grid-template-columns: 1fr; gap: 1.6rem; padding: 3.2rem 0; }
      .ledger, .agent-grid { grid-template-columns: 1fr; }
      .feat-grid { grid-template-columns: repeat(2, 1fr); }
      .hero { padding: 4rem 0 3.5rem; }
    }
    @media (max-width: 520px) {
      .feat-grid { grid-template-columns: 1fr; }
      .term-body { flex-direction: column; align-items: stretch; }
      .nav-links { gap: .9rem; }
    }
  </style>
</head>
<body>

<header class="wrap">
  <nav class="nav" aria-label="Main">
    <a class="nav-mark" href="/">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M4 7h16M4 17h16M8 7v10M16 7v10"/>
      </svg>
      stablerails
    </a>
    <div class="nav-links">
      <a href="/docs">docs</a>
      <a href="/agents.md">agents</a>
      <a href="https://github.com/stablerails/stablerails" rel="noopener">github</a>${demoEnabled ? `
      <a href="/demo">live demo</a>` : ""}
      <a class="nav-login" href="/login">operator login</a>
    </div>
  </nav>
</header>

<main class="wrap">

  <!-- ── 1 · HERO ──────────────────────────────────────────── -->
  <section class="hero">
    <div class="badge"><span class="badge-dot"></span>open source &middot; AGPL-3.0 &middot; self-hosted</div>
    <h1 class="wordmark">stable<span class="rails">rails</span><span class="cursor" aria-hidden="true"></span></h1>
    <p class="tagline">Self-hosted, non-custodial stablecoin payments. Software you run — rails you own.</p>
    <p class="tagline-tags"><b>0% fees</b> &middot; <b>no KYC</b> &middot; <b>agent-friendly</b> &middot; your keys never touch the server</p>
    ${renderCommandBlock("hero")}
    <p class="hero-alt">Or hand it to your AI agent <a href="/agents.md">/agents.md &rarr;</a></p>
    <p class="hero-fine">Free and open-source (AGPL-3.0). You only ever pay network gas &mdash; and that goes to the blockchain, not to us.</p>
  </section>

  <!-- ── 2 · HOW IT WORKS ─────────────────────────────────── -->
  <section class="sec" id="how-it-works">
    <div class="sec-rail">
      <span class="sec-no">01 / FLOW</span>
      <h2>How it works</h2>
    </div>
    <div class="sec-body">
      <div class="steps">
        <div class="step">
          <span class="step-no">01</span>
          <div>
            <h3>Run the watch-only server</h3>
            <p>It serves your checkout and verifies payments on-chain. It holds no keys &mdash; there is nothing on it worth stealing.</p>
          </div>
        </div>
        <div class="step">
          <span class="step-no">02</span>
          <div>
            <h3>Every invoice gets its own deposit address</h3>
            <p>Fresh HD-derived addresses per invoice. When a payment lands at a solid block, your webhook fires.</p>
          </div>
        </div>
        <div class="step">
          <span class="step-no">03</span>
          <div>
            <h3>Funds sweep to YOUR wallet &mdash; signed locally</h3>
            <p>The sweep is signed on your machine, behind a passphrase you type at your own terminal. The server only ever sees the finished, signed transaction.</p>
          </div>
        </div>
      </div>
      ${renderDiagram()}
      <p class="callout">Keys never leave your machine.</p>
    </div>
  </section>

  <!-- ── 3 · SECURITY MODEL ───────────────────────────────── -->
  <section class="sec sec-security" id="security">
    <div class="sec-rail">
      <span class="sec-no">02 / THREAT MODEL</span>
      <h2>Security model</h2>
    </div>
    <div class="sec-body">
      <p class="sec-headline">Your server cannot steal your funds. <em>Neither can your AI agent.</em></p>
      <dl class="ledger">
        <div class="ledger-row">
          <dt>Watch-only server</dt>
          <dd>The server holds zero private keys. It can see payments arrive; it cannot spend a single token.</dd>
        </div>
        <div class="ledger-row">
          <dt>Signing is local, human, deliberate</dt>
          <dd>Sweeps are signed only via the local CLI, behind a human passphrase &mdash; optional Touch ID. No passphrase, no movement.</dd>
        </div>
        <div class="ledger-row">
          <dt>Destination pinned locally</dt>
          <dd>The sweep destination is pinned on your machine. A fully compromised server cannot redirect a sweep to an attacker.</dd>
        </div>
        <div class="ledger-row">
          <dt>Two RPCs must agree</dt>
          <dd>A payment counts only when two independent RPC providers confirm it at a solid block. Never 0-conf.</dd>
        </div>
        <div class="ledger-row">
          <dt>AI agents get readonly keys</dt>
          <dd>Agents can run your store &mdash; create invoices, read events, watch sweeps. They physically cannot move your money.</dd>
        </div>
        <div class="ledger-row">
          <dt>100% open source</dt>
          <dd>Every line is public, including the signer. Don&#39;t trust our claims &mdash; audit them.</dd>
        </div>
      </dl>
    </div>
  </section>

  <!-- ── 4 · AGENT-FRIENDLY ───────────────────────────────── -->
  <section class="sec" id="agents">
    <div class="sec-rail">
      <span class="sec-no">03 / AGENTIC WEB</span>
      <h2>Built for the agentic web</h2>
    </div>
    <div class="sec-body">
      <p>MCP server out of the box. Machine-readable <a href="/llms.txt">/llms.txt</a>. JSON output everywhere. An AI agent can install, configure and operate the whole stack &mdash; <span class="agent-except">except the one thing it must never do: touch your passphrase.</span></p>
      <div class="agent-grid">
        <div class="agent-path">
          <h3>Path A &middot; you type</h3>
          ${renderCommandBlock("agent")}
        </div>
        <div class="agent-path">
          <h3>Path B &middot; your agent reads</h3>
          <a class="agent-link" href="/agents.md">/agents.md &rarr;</a>
          <p class="agent-note">Hand this file to any capable agent. It contains everything needed to install, configure and run an instance &mdash; and a clear boundary around what it may never ask of you.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- ── 5 · FEATURES ─────────────────────────────────────── -->
  <section class="sec" id="features">
    <div class="sec-rail">
      <span class="sec-no">04 / SHIPPED</span>
      <h2>What&#39;s in the box</h2>
    </div>
    <div class="sec-body">
      <div class="feat-grid">${renderFeatures()}
      </div>
      <span class="roadmap"><b>Tron (USDT) today</b> &mdash; Polygon &middot; Ethereum &middot; USDC next</span>
    </div>
  </section>

  <!-- ── 6 · HONESTY ──────────────────────────────────────── -->
  <section class="sec" id="honesty">
    <div class="sec-rail">
      <span class="sec-no">05 / PLAIN TRUTH</span>
      <h2>No KYC.<br>Not anonymous.</h2>
    </div>
    <div class="sec-body">
      <p class="plain"><strong>USDT on Tron is a transparent ledger, and the token itself is centrally managed</strong> &mdash; the issuer can freeze addresses. We collect no payer emails and log no payer IPs, but on-chain privacy is limited by the asset itself. We&#39;d rather tell you that here than in the fine print.</p>
    </div>
  </section>

  <!-- ── 7 · JUST SOFTWARE ────────────────────────────────── -->
  <section class="sec" id="legal">
    <div class="sec-rail">
      <span class="sec-no">06 / LEGAL</span>
      <h2>Just software</h2>
    </div>
    <div class="sec-body">
      <div class="legal">
        <strong>Stablerails is software, not a payment service.</strong> Each operator runs their own instance and controls their own keys and funds. The project never holds, transmits, or has access to anyone&#39;s money. <a href="/docs">Read the docs &rarr;</a>
      </div>
    </div>
  </section>

</main>

<!-- ── 8 · FOOTER ───────────────────────────────────────── -->
<footer class="footer">
  <div class="wrap">
    <div class="footer-links">
      <a href="https://github.com/stablerails/stablerails" rel="noopener">github</a>
      <a href="/docs">docs</a>
      <a href="/agents.md">agents.md</a>
      <a href="/llms.txt">llms.txt</a>
      <a href="/terms">terms</a>
      <a href="/login">operator login</a>
    </div>
    <div class="footer-fine">
      <span class="no3p">This page loads nothing from third parties &mdash; no fonts, no analytics, no trackers.</span>
      <span>&copy; Stablerails contributors &middot; AGPL-3.0</span>
    </div>
  </div>
</footer>

<script${scriptNonceAttr}>
  // Copy-to-clipboard for command blocks. Bound via addEventListener —
  // CSP script-src-attr blocks inline handlers.
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      navigator.clipboard.writeText(text).then(function () {
        var prev = btn.textContent;
        btn.textContent = "copied";
        btn.classList.add("copied");
        setTimeout(function () {
          btn.textContent = prev;
          btn.classList.remove("copied");
        }, 1600);
      }).catch(function () { /* clipboard unavailable — no-op */ });
    });
  });
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
