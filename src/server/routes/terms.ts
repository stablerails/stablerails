/**
 * Terms of use page.
 *
 * GET /terms — static, server-rendered, single-file HTML; no auth, no data.
 *
 * Legal posture mirrors the landing page: Stablerails is SOFTWARE, not a
 * payment service. The project never holds keys or funds; every instance is
 * operated independently by whoever deploys it. The terms restate the
 * AGPL-3.0 license, its warranty/liability disclaimers, and the operator's
 * own responsibilities.
 *
 * Hard constraints (same as landing/docs):
 *  - Nonce-based CSP, single <style> block, no JS at all on this page.
 *  - ZERO external requests: system font stack, relative URLs only.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const REPO_URL = "https://github.com/stablerails/stablerails";

function renderTerms(styleNonce?: string): string {
  const styleNonceAttr = styleNonce ? ` nonce="${styleNonce}"` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Terms — Stablerails</title>
  <meta name="description" content="Terms of use for Stablerails — free, open-source, self-hosted stablecoin payment software.">
  <style${styleNonceAttr}>
    :root {
      --ink: #0c0f0d;
      --paper: #f6f5f1;
      --line: #d8d6cf;
      --mut: #6b6f6c;
      --acc: #26a17b;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--paper);
      color: var(--ink);
      font: 16px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 760px; margin: 0 auto; padding: 0 24px; }
    header.wrap { padding-top: 28px; padding-bottom: 8px; }
    .nav { display: flex; align-items: baseline; justify-content: space-between; border-bottom: 1px solid var(--line); padding-bottom: 16px; }
    a { color: inherit; text-decoration: none; border-bottom: 1px solid var(--line); }
    a:hover { border-bottom-color: var(--acc); color: var(--acc); }
    .nav a { border-bottom: none; }
    .nav-mark { font-weight: 700; }
    .nav-mark .rails { color: var(--acc); }
    main.wrap { padding-top: 40px; padding-bottom: 64px; }
    h1 { font-size: 26px; letter-spacing: -0.02em; margin-bottom: 6px; }
    .updated { color: var(--mut); font-size: 13px; margin-bottom: 36px; }
    section { margin-bottom: 30px; }
    h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
    h2 .no { color: var(--acc); margin-right: 8px; }
    p { margin-bottom: 10px; }
    p, li { color: #2a2e2b; }
    ul { padding-left: 20px; margin-bottom: 10px; }
    li { margin-bottom: 4px; }
    .footer { border-top: 1px solid var(--line); padding: 20px 0 40px; color: var(--mut); font-size: 13px; }
  </style>
</head>
<body>

<header class="wrap">
  <nav class="nav" aria-label="Main">
    <a class="nav-mark" href="/">stable<span class="rails">rails</span></a>
    <a href="/docs">docs</a>
  </nav>
</header>

<main class="wrap">
  <h1>Terms of use</h1>
  <p class="updated">Stablerails — free and open-source software, AGPL-3.0.</p>

  <section>
    <h2><span class="no">01</span>Software, not a service</h2>
    <p>Stablerails is self-hosted software, not a payment service, money transmitter, exchange, or custodian. The project and its contributors do not operate payment infrastructure for you, do not hold, transmit, convert, or have access to anyone&#39;s funds or private keys, and are not a party to any transaction processed by an instance of the software.</p>
    <p>Every Stablerails instance is deployed and operated independently by its operator, on the operator&#39;s own infrastructure, under the operator&#39;s sole control and responsibility.</p>
  </section>

  <section>
    <h2><span class="no">02</span>License</h2>
    <p>Stablerails is licensed under the GNU Affero General Public License, version 3.0 (AGPL-3.0). The full license text is distributed with the source code at <a href="${REPO_URL}" rel="noopener">${REPO_URL.replace("https://", "")}</a>. Your use, modification, and redistribution of the software are governed by that license.</p>
  </section>

  <section>
    <h2><span class="no">03</span>No warranty</h2>
    <p>As stated in sections 15 and 16 of the AGPL-3.0: the software is provided &quot;as is&quot;, without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. The entire risk as to the quality and performance of the software is with you.</p>
    <p>In no event will any author, contributor, or copyright holder be liable for damages of any kind arising from the use of or inability to use the software — including loss of funds, lost profits, or data loss — even if advised of the possibility of such damages.</p>
  </section>

  <section>
    <h2><span class="no">04</span>Operator responsibilities</h2>
    <p>If you run a Stablerails instance, you alone are responsible for:</p>
    <ul>
      <li>the safekeeping of your seed phrases, passphrases, and API keys — they cannot be recovered by anyone else;</li>
      <li>the security, availability, and maintenance of the servers you deploy on;</li>
      <li>compliance with all laws and regulations that apply to you and your business in your jurisdiction, including any licensing, tax, accounting, sanctions, AML, or KYC obligations;</li>
      <li>your relationships with your own customers, including refunds and disputes.</li>
    </ul>
    <p>The software gives you no exemption from any legal obligation. &quot;No KYC built in&quot; describes the software&#39;s design; it is not legal advice and not a statement about what the law requires of you.</p>
  </section>

  <section>
    <h2><span class="no">05</span>Fees</h2>
    <p>The project charges nothing: no commission, no spread, no service fee. Transactions pay only the network (gas) fees of the underlying blockchain, which go to the network — not to the project.</p>
  </section>

  <section>
    <h2><span class="no">06</span>Privacy</h2>
    <p>The project collects no data from instances of the software. Self-hosted instances store their data on the operator&#39;s own infrastructure. This website serves static pages, loads nothing from third parties, and uses no analytics, cookies, or trackers.</p>
  </section>

  <section>
    <h2><span class="no">07</span>Contributions</h2>
    <p>Contributions to the project are accepted under the AGPL-3.0. By submitting a contribution you license it under the same terms as the project.</p>
  </section>

  <section>
    <h2><span class="no">08</span>Changes</h2>
    <p>These terms may be revised as the project evolves; the current version is always published at this address and in the source repository.</p>
  </section>
</main>

<footer class="footer">
  <div class="wrap">
    <span>&copy; Stablerails contributors &middot; AGPL-3.0 &middot; <a href="/">home</a> &middot; <a href="${REPO_URL}" rel="noopener">github</a></span>
  </div>
</footer>

</body>
</html>`;
}

export async function registerTermsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/terms",
    {
      config: {
        helmet: {
          enableCSPNonces: true,
          contentSecurityPolicy: {
            directives: {
              "default-src": ["'self'"],
              // style-src: nonce for the single <style> block
              "style-src": ["'self'"],
              // script-src: no JS on this page at all; keep 'self' (see landing.ts
              // note — 'none' plus a nonce triggers a Chrome console warning)
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
      const html = renderTerms(cspNonce?.style);
      return reply
        .code(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .send(html);
    },
  );
}
