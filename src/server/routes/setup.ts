/**
 * Setup page.
 *
 * GET /setup — static, server-rendered, single-file HTML; no auth, no data.
 *
 * "Run Stablerails. Three ways." — operator one-liner (Docker), agent-driven
 * install (copyable prompt + MCP config), from source. Plus a prerequisites
 * ledger and a copyable LLM-troubleshoot prompt.
 *
 * Same hard constraints as the landing: nonce CSP, zero third-party loads,
 * single <style> and single <script> block (copy buttons only, hidden until
 * JS reveals them), works without JS, reduced-motion respected.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const REPO_URL = "https://github.com/stablerails/stablerails";

const DOCKER_CMDS = [
  "git clone https://github.com/stablerails/stablerails.git",
  "cd stablerails && cp .env.docker.example .env",
  "docker compose up --build",
].join("\n");

const AGENT_PROMPT =
  "Read https://stablerails.org/agents.md and set up a Stablerails instance for me. " +
  "Before you begin, ask me: (1) testnet or mainnet? (2) local machine or a VPS? " +
  "(3) which Tron address should swept funds go to? " +
  "Then install it, run init, and give me the one-time dashboard login link. " +
  "Use a readonly API key for yourself. Never ask me for a seed passphrase.";

const MCP_CONFIG = `{
  "mcpServers": {
    "stablerails": {
      "command": "stablerails-mcp",
      "env": {
        "STABLERAILS_API_URL": "https://pay.example.com",
        "STABLERAILS_MCP_KEY": "&lt;mcpKey from init&gt;"
      }
    }
  }
}`;

const DEBUG_PROMPT =
  "My Stablerails instance misbehaves. Read https://stablerails.org/llms.txt for the architecture, " +
  "then debug with me: ask for docker compose logs, the worker output and my (redacted) .env, " +
  "and check the two RPC endpoints respond to /walletsolidity/getnowblock. " +
  "Nothing in debugging ever requires my seed passphrase. Do not ask for it.";

interface SourceStep {
  cmd: string;
  note: string;
}

const SOURCE_STEPS: SourceStep[] = [
  { cmd: "git clone " + REPO_URL + ".git && cd stablerails", note: "audit first — it is all here" },
  { cmd: "npm ci && npm run build", note: "Node 22+, Postgres 16+" },
  { cmd: "npx prisma migrate deploy", note: "DATABASE_URL in .env" },
  { cmd: "npm run dev & npm run worker", note: "server + chain watcher" },
];

function copyBlock(id: string, text: string, display?: string): string {
  return `
      <div class="cmd" role="group">
        <pre class="cmd-text">${display ?? text}</pre>
        <button class="copy-btn" id="copy-${id}" type="button" data-copy="${text.replace(/"/g, "&quot;")}" aria-label="Copy to clipboard" hidden>copy</button>
      </div>`;
}

function renderSetup(styleNonce?: string, scriptNonce?: string): string {
  const styleNonceAttr = styleNonce ? ` nonce="${styleNonce}"` : "";
  const scriptNonceAttr = scriptNonce ? ` nonce="${scriptNonce}"` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0a0e0c" />
  <meta name="description" content="Run Stablerails three ways: one Docker command, an AI-agent install, or from source. No signup, no KYB, nothing to wait for." />
  <title>Setup &middot; Stablerails</title>
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
      background-image: repeating-linear-gradient(to bottom, transparent 0 27px, rgba(236, 233, 226, .025) 27px 28px);
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
    .sub { color: var(--muted); max-width: 56ch; }
    .path {
      border: 1px solid var(--line-strong); border-radius: 10px; background: var(--panel);
      padding: 1.4rem; margin: 1.4rem 0;
    }
    .path-no { font-family: var(--mono); font-size: .7rem; letter-spacing: .14em; text-transform: uppercase; color: var(--acc); display: block; margin-bottom: .5rem; }
    .path h2 { font-family: var(--mono); font-size: 1.1rem; letter-spacing: -.01em; margin-bottom: .3rem; }
    .path p { font-size: .9rem; color: var(--muted); max-width: 60ch; margin-bottom: .4rem; }
    .cmd {
      display: flex; align-items: flex-start; gap: 1rem;
      border: 1px solid var(--line-strong); border-radius: 8px;
      background: var(--ink); padding: .9rem 1rem; margin-top: .8rem;
    }
    .cmd-text { font-family: var(--mono); font-size: .85rem; color: var(--text); flex: 1; overflow-x: auto; white-space: pre; line-height: 1.7; }
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
    .steps-list { margin-top: .8rem; display: grid; gap: .5rem; }
    .step-row { display: flex; gap: 1rem; align-items: baseline; font-family: var(--mono); font-size: .85rem; flex-wrap: wrap; }
    .step-row code { color: var(--text); }
    .step-row span { color: var(--dim); font-size: .75rem; }
    .req { border-top: 1px solid var(--line); margin-top: 3rem; padding-top: 2.2rem; }
    .req h2, .debug h2, .next h2 { font-family: var(--mono); font-size: 1.2rem; margin-bottom: 1.2rem; }
    .req-table { display: grid; gap: 0; border-top: 1px solid var(--line); max-width: 640px; }
    .req-row { display: flex; justify-content: space-between; gap: 1.5rem; border-bottom: 1px solid var(--line); padding: .65rem 0; font-size: .88rem; flex-wrap: wrap; }
    .req-row dt { font-family: var(--mono); color: var(--text); }
    .req-row dd { color: var(--muted); text-align: right; flex: 1; min-width: 14rem; }
    .debug { border-top: 1px solid var(--line); margin-top: 3rem; padding-top: 2.2rem; }
    .debug p { color: var(--muted); font-size: .9rem; max-width: 60ch; }
    .next { border-top: 1px solid var(--line); margin: 3rem 0 0; padding: 2.2rem 0 4rem; }
    .next-links { display: flex; flex-wrap: wrap; gap: 1.6rem; font-family: var(--mono); font-size: .85rem; }
    .footer { border-top: 1px solid var(--line); padding: 1.6rem 0 2.6rem; color: var(--dim); font-size: .75rem; font-family: var(--mono); }
    @media (max-width: 520px) { .cmd { flex-direction: column; } .req-row dd { text-align: left; } }
  </style>
</head>
<body>

<header class="wrap">
  <nav class="nav" aria-label="Main">
    <a class="nav-mark" href="/">stable<span class="rails">rails</span></a>
    <span>
      <a href="/docs">docs</a> &nbsp;&middot;&nbsp;
      <a href="/agents.md">agents</a> &nbsp;&middot;&nbsp;
      <a href="${REPO_URL}" rel="noopener">github</a>
    </span>
  </nav>
</header>

<main class="wrap">
  <section class="hero">
    <h1>Run Stablerails. <em>Three ways.</em></h1>
    <p class="sub">One Docker command. One prompt to your agent. Or from source. No signup, no KYB, no one to wait for &mdash; it&#39;s your server.</p>
  </section>

  <section class="path" id="docker">
    <span class="path-no">Path 1 &middot; you type</span>
    <h2>Docker, one screen</h2>
    <p>Server, worker and Postgres from one compose file. Every script is in the repo &mdash; audit before you run.</p>
    ${copyBlock("docker", DOCKER_CMDS)}
    <p class="fine">Then: <code>docker compose exec server node dist/cli/index.js init</code> mints your operator, API keys and a one-time dashboard login link. Full walkthrough in the <a href="${REPO_URL}#readme" rel="noopener">README</a>.</p>
  </section>

  <section class="path" id="agent">
    <span class="path-no">Path 2 &middot; your agent types</span>
    <h2>Let your agent install it</h2>
    <p>Paste this to any capable agent. It will ask the right questions, then do everything &mdash; on a readonly key.</p>
    ${copyBlock("agent", AGENT_PROMPT)}
    <p>Wire the MCP server so your agent can create invoices and watch payments afterwards:</p>
    ${copyBlock("mcp", MCP_CONFIG.replace(/&lt;/g, "<").replace(/&gt;/g, ">"), MCP_CONFIG)}
    <p class="fine">The boundary is physical: readonly keys can&#39;t move funds, and the seed passphrase is never part of any agent flow.</p>
  </section>

  <section class="path" id="source">
    <span class="path-no">Path 3 &middot; from source</span>
    <h2>Build it yourself</h2>
    <div class="steps-list">${SOURCE_STEPS.map(
      (s) => `
      <div class="step-row"><code>$ ${s.cmd}</code><span>${s.note}</span></div>`,
    ).join("")}
    </div>
  </section>

  <section class="req">
    <h2>What you need</h2>
    <dl class="req-table">
      <div class="req-row"><dt>a Linux box</dt><dd>runs comfortably on a $5 VPS (2 vCPU / 4 GB)</dd></div>
      <div class="req-row"><dt>Docker</dt><dd>or Node 22+ with Postgres 16+</dd></div>
      <div class="req-row"><dt>two Tron RPC endpoints</dt><dd>independent providers, both must agree &mdash; free tiers work</dd></div>
      <div class="req-row"><dt>a Tron address you control</dt><dd>the sweep destination &mdash; pinned on your machine, never on the server</dd></div>
      <div class="req-row"><dt>a domain</dt><dd>optional &mdash; Caddy handles TLS if you want a public checkout</dd></div>
      <div class="req-row"><dt>time</dt><dd>~15 minutes</dd></div>
    </dl>
  </section>

  <section class="debug">
    <h2>Something broke? Let an LLM debug it with you</h2>
    <p>The whole system is machine-readable by design. Paste this to your agent:</p>
    ${copyBlock("debug", DEBUG_PROMPT)}
    <p class="fine">Nothing in debugging ever requires your seed passphrase. An assistant that asks for it is wrong.</p>
  </section>

  <section class="next">
    <h2>Next</h2>
    <div class="next-links">
      <a href="https://testnet.stablerails.org/demo" rel="noopener">try the live demo &rarr;</a>
      <a href="/agents.md">/agents.md &rarr;</a>
      <a href="/docs">read the docs &rarr;</a>
    </div>
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

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/setup",
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
      const html = renderSetup(cspNonce?.style, cspNonce?.script);
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(html);
    },
  );
}
