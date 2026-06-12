/**
 * Shared site navigation — ONE menu across every public page
 * (landing, /setup, /agents, /docs, /terms, /hosted).
 *
 * SaaS-first: the primary actions are the hosted "sign in" / "sign up"
 * controls. They point at the canonical hosted instance ABSOLUTELY, so the
 * same nav works verbatim on self-hosted instances too (where local /signup
 * and /m/login do not exist). The self-hoster's own operator login lives in
 * page footers, not here.
 *
 * Self-contained: namespaced .snav* classes so it drops into any page's
 * existing <style> without collisions. No JS, no external loads. Absolute
 * URLs appear only as <a href> navigation anchors (they load nothing until
 * clicked) — this preserves every page's "zero third-party requests" invariant.
 */

export interface SiteNavOpts {
  /** Highlighted item. */
  active?: "home" | "setup" | "agents" | "docs";
}

/** Canonical hosted instance — where signup / merchant login actually live. */
const HOSTED_BASE = "https://stablerails.org";

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
    .snav-links { margin-left: auto; display: flex; align-items: center; gap: 1.3rem; flex-wrap: wrap; }
    .snav-links a { color: #8e988f; text-decoration: none; transition: color .15s ease; display: inline-block; padding: .55rem 0; margin: -.55rem 0; }
    .snav-links a:hover { color: #ece9e2; text-decoration: none; }
    .snav-links a.snav-active { color: #ece9e2; }
    .snav-signin { color: #ece9e2 !important; }
    .snav-cta {
      color: #04130d !important; background: #3ddc97;
      border: 1px solid #3ddc97; padding: .42rem .9rem; border-radius: 6px; font-weight: 700;
      margin: 0 !important;
      transition: background .15s ease, transform 160ms cubic-bezier(.23, 1, .32, 1);
    }
    .snav-links a.snav-cta:hover { background: #26A17B; border-color: #26A17B; color: #04130d !important; text-decoration: none; transform: translateY(-1px); }
    @media (max-width: 560px) { .snav-links { gap: .9rem; } }
`;

export function siteNavHtml(opts: SiteNavOpts = {}): string {
  const { active } = opts;
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
      <a href="/setup"${cls("setup")}>self-host</a>
      <a href="/docs"${cls("docs")}>docs</a>
      <a href="/agents"${cls("agents")}>agents</a>
      <a href="https://github.com/stablerails/stablerails" rel="noopener">github</a>
      <a class="snav-signin" href="${HOSTED_BASE}/m/login">sign in</a>
      <a class="snav-cta" href="${HOSTED_BASE}/signup">sign up</a>
    </div>
  </nav>`;
}
