/**
 * Agents page.
 *
 * GET /agents — static, server-rendered, single-file HTML; no auth, no data.
 *
 * The HUMAN-facing agent page: copyable prompts you paste into your agent
 * (install, operate, debug) plus the MCP config. The machine-facing files
 * stay at their own URLs — /agents.md (runbook the agent reads) and
 * /llms.txt (architecture index) — and are explained here.
 *
 * Same hard constraints as landing/setup: nonce CSP, zero third-party loads,
 * single <style> + single <script> (copy buttons only, hidden until JS),
 * works without JS.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AGENT_PROMPT, MCP_CONFIG, copyBlock } from "./setup.js";

const OPERATE_PROMPT =
  "Connect to my Stablerails instance. Read https://stablerails.org/agents.md for the API shape. " +
  "Base URL and a READONLY api key are in my environment (STABLERAILS_API_URL, STABLERAILS_MCP_KEY). " +
  "Create a 25 USDT invoice for 'Consulting, June', give me the checkout link, " +
  "and tell me when it is paid. Never ask me for a seed passphrase.";

function renderAgents(styleNonce?: string, scriptNonce?: string): string {
  const styleNonceAttr = styleNonce ? ` nonce="${styleNonce}"` : "";
  const scriptNonceAttr = scriptNonce ? ` nonce="${scriptNonce}"` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0a0e0c" />
  <meta name="description" content="Stablerails for AI agents: copy-paste prompts to install and operate a self-hosted stablecoin payment instance. Readonly keys: agents accept money, they cannot move it." />
  <title>Agents &middot; Stablerails</title>
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
    a:focus-visible, button:focus-visible { outline: 2px solid var(--acc-bright); outline-offset: 2px; }
    a, button { -webkit-tap-highlight-color: transparent; }
    .wrap { max-width: 880px; margin: 0 auto; padding: 0 24px; }
    .nav {
      display: flex; align-items: baseline; justify-content: space-between; gap: 1.4rem;
      padding: 1.1rem 0; border-bottom: 1px solid var(--line);
      font-family: var(--mono); font-size: .8rem;
    }
    .nav-mark { color: var(--text); font-weight: 700; }
    .nav-mark .rails { color: var(--acc-bright); }
    .nav-mark:hover { text-decoration: none; }
    .nav a { color: var(--muted); }
    .nav a.nav-mark { color: var(--text); }
    .hero { padding: 4rem 0 2.5rem; }
    h1 { font-family: var(--mono); font-size: clamp(1.8rem, 5vw, 2.6rem); letter-spacing: -.03em; margin-bottom: .8rem; }
    h1 em { font-style: normal; color: var(--acc-bright); }
    .sub { color: var(--muted); max-width: 58ch; }
    .boundary {
      font-family: var(--mono); font-size: .9rem; font-weight: 700; color: var(--text);
      border: 1px solid rgba(38, 161, 123, .4); background: var(--acc-soft);
      border-radius: 8px; padding: .9rem 1.2rem; margin-top: 1.4rem; max-width: 620px;
    }
    .block {
      border: 1px solid var(--line); border-radius: 12px; margin: 1.4rem 0; padding: 1.6rem;
      background: linear-gradient(180deg, rgba(236, 233, 226, .025), transparent 40%), var(--panel);
      box-shadow: 0 10px 32px rgba(0, 0, 0, .28);
    }
    .block-no { font-family: var(--mono); font-size: .7rem; letter-spacing: .14em; text-transform: uppercase; color: var(--acc); display: block; margin-bottom: .5rem; }
    .block h2 { font-family: var(--mono); font-size: 1.1rem; letter-spacing: -.01em; margin-bottom: .3rem; }
    .block p { font-size: .9rem; color: var(--muted); max-width: 62ch; margin-bottom: .4rem; }
    .cmd {
      display: flex; align-items: flex-start; gap: 1rem;
      border: 1px solid var(--line-strong); border-radius: 8px;
      background: var(--ink); padding: .9rem 1rem; margin-top: .8rem;
    }
    .cmd-text { font-family: var(--mono); font-size: .85rem; color: var(--text); flex: 1; overflow-x: auto; white-space: pre-wrap; word-break: break-word; line-height: 1.7; }
    .copy-btn {
      font-family: var(--mono); font-size: .7rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
      color: var(--acc-bright); background: var(--acc-soft);
      border: 1px solid rgba(38, 161, 123, .4); border-radius: 6px;
      padding: .45rem .9rem; cursor: pointer; flex-shrink: 0;
      min-width: 5.2rem; text-align: center; user-select: none;
      transition: background .15s ease, color .15s ease, border-color .15s ease, transform 160ms cubic-bezier(.23, 1, .32, 1);
    }
    @media (hover: hover) and (pointer: fine) { .copy-btn:hover { background: rgba(38, 161, 123, .25); } }
    .copy-btn:active { transform: scale(.97); }
    .copy-btn.copied { color: #04130d; background: var(--acc-bright); border-color: var(--acc-bright); }
    .fine { font-family: var(--mono); font-size: .78rem; color: var(--dim); margin-top: .6rem; }
    .files { border-top: 1px solid var(--line); margin-top: 3rem; padding-top: 2.2rem; }
    .files h2 { font-family: var(--mono); font-size: 1.2rem; margin-bottom: 1.2rem; }
    .file-row { display: flex; gap: 1.2rem; align-items: baseline; padding: .6rem 0; border-bottom: 1px solid var(--line); font-size: .9rem; flex-wrap: wrap; }
    .file-row a { font-family: var(--mono); flex-shrink: 0; min-width: 8.5rem; }
    .file-row span { color: var(--muted); }
    .footer { border-top: 1px solid var(--line); margin-top: 3rem; padding: 1.6rem 0 2.6rem; color: var(--dim); font-size: .75rem; font-family: var(--mono); }
    @media (max-width: 520px) { .cmd { flex-direction: column; } }
  </style>
</head>
<body>

<header class="wrap">
  <nav class="nav" aria-label="Main">
    <a class="nav-mark" href="/">stable<span class="rails">rails</span></a>
    <span>
      <a href="/setup">setup</a> &nbsp;&middot;&nbsp;
      <a href="/docs">docs</a> &nbsp;&middot;&nbsp;
      <a href="https://github.com/stablerails/stablerails" rel="noopener">github</a>
    </span>
  </nav>
</header>

<main class="wrap">
  <section class="hero">
    <h1>Your agent runs the store. <em>It cannot touch the money.</em></h1>
    <p class="sub">Stablerails ships an MCP server, machine-readable docs and JSON everywhere. An agent can install, configure and operate the whole stack. Copy a prompt below and paste it into any capable agent.</p>
    <p class="boundary">The boundary is physical: agents run on readonly keys and the seed passphrase is never part of any agent flow. An agent that accepts payments still cannot move a single token.</p>
  </section>

  <section class="block" id="install">
    <span class="block-no">Prompt 1 &middot; install</span>
    <h2>Set up an instance for me</h2>
    <p>Your agent asks the right questions (testnet or mainnet, where funds sweep), installs everything, and hands you a one-time dashboard login link.</p>
    ${copyBlock("agent-install", AGENT_PROMPT)}
  </section>

  <section class="block" id="mcp">
    <span class="block-no">Prompt 2 &middot; connect</span>
    <h2>Wire the MCP server</h2>
    <p>Once an instance runs, register the MCP server so your agent can create invoices, read payments and watch sweeps directly.</p>
    ${copyBlock("agent-mcp", MCP_CONFIG.replace(/&lt;/g, "<").replace(/&gt;/g, ">"), MCP_CONFIG)}
  </section>

  <section class="block" id="operate">
    <span class="block-no">Prompt 3 &middot; operate</span>
    <h2>Run my payments</h2>
    <p>Day-to-day operation by prompt: invoices, checkout links, payment status. The agent reports; the chain settles.</p>
    ${copyBlock("agent-operate", OPERATE_PROMPT)}
  </section>

  <section class="files">
    <h2>The machine-readable surface</h2>
    <div class="file-row"><a href="/agents.md">/agents.md</a><span>the runbook your agent actually reads: endpoints, auth, onboarding flow, hard boundaries. Raw markdown on purpose &mdash; it is for the agent, not for you.</span></div>
    <div class="file-row"><a href="/llms.txt">/llms.txt</a><span>architecture index for LLMs (llms.txt convention): what this server is, where the docs live.</span></div>
    <div class="file-row"><a href="/docs">/docs</a><span>the human-readable API reference: webhooks, HMAC signatures, invoice lifecycle.</span></div>
  </section>
</main>

<footer class="footer">
  <div class="wrap">&copy; Stablerails contributors &middot; AGPL-3.0 &middot; <a href="/">home</a> &middot; <a href="/terms">terms</a></div>
</footer>

<script${scriptNonceAttr}>
  // Copy buttons ship hidden and are revealed here — no dead controls without JS.
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
</script>

</body>
</html>`;
}

export async function registerAgentsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/agents",
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
      const cspNonce = (reply as FastifyReply & { cspNonce?: { script?: string; style?: string } }).cspNonce;
      const html = renderAgents(cspNonce?.style, cspNonce?.script);
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(html);
    },
  );
}
