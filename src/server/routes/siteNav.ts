/**
 * Shared site navigation — ONE menu across every public page
 * (landing, /setup, /agents, /docs, /terms).
 *
 * Self-contained: namespaced .snav* classes so it drops into any page's
 * existing <style> without collisions. No JS, no external loads.
 */

export interface SiteNavOpts {
  /** Highlighted item. */
  active?: "home" | "setup" | "agents" | "docs";
  /** Where "live demo" points (local /demo when enabled, testnet otherwise). */
  demoHref?: string;
}

export const DEFAULT_DEMO_HREF = "https://testnet.stablerails.org/demo";

export const SITE_NAV_CSS = `
    .snav {
      display: flex; align-items: center; gap: 1.5rem;
      padding: 1.1rem 0; border-bottom: 1px solid rgba(236, 233, 226, .08);
      font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
      font-size: .8rem;
    }
    .snav-mark { display: inline-flex; align-items: center; gap: .55rem; color: #ece9e2; font-weight: 700; letter-spacing: -.02em; text-decoration: none; }
    .snav-mark:hover { text-decoration: none; }
    .snav-mark svg { color: #26A17B; }
    .snav-mark .rails { color: #3ddc97; }
    .snav-links { margin-left: auto; display: flex; align-items: center; gap: 1.4rem; flex-wrap: wrap; }
    .snav-links a { color: #8e988f; text-decoration: none; transition: color .15s ease; display: inline-block; padding: .55rem 0; margin: -.55rem 0; }
    .snav-links a:hover { color: #ece9e2; text-decoration: none; }
    .snav-links a.snav-active { color: #ece9e2; }
    .snav-login { border: 1px solid rgba(236, 233, 226, .16); padding: .35rem .8rem; border-radius: 6px; transition: color .15s ease, border-color .15s ease; }
    .snav-links a.snav-login:hover { border-color: #26A17B; color: #3ddc97; }
    @media (max-width: 520px) { .snav-links { gap: .9rem; } }
`;

export function siteNavHtml(opts: SiteNavOpts = {}): string {
  const { active, demoHref = DEFAULT_DEMO_HREF } = opts;
  const demoRel = demoHref.startsWith("http") ? ` rel="noopener"` : "";
  const cls = (k: SiteNavOpts["active"]): string => (active === k ? ` class="snav-active"` : "");
  return `
  <nav class="snav" aria-label="Main">
    <a class="snav-mark" href="/">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M4 7h16M4 17h16M8 7v10M16 7v10"/>
      </svg>
      stable<span class="rails">rails</span>
    </a>
    <div class="snav-links">
      <a href="/setup"${cls("setup")}>setup</a>
      <a href="/agents"${cls("agents")}>agents</a>
      <a href="/docs"${cls("docs")}>docs</a>
      <a href="https://github.com/stablerails/stablerails" rel="noopener">github</a>
      <a href="${demoHref}"${demoRel}>live demo</a>
      <a class="snav-login" href="/login">operator login</a>
    </div>
  </nav>`;
}
