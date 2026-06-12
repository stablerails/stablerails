/**
 * Tests for the Stablerails public landing page (GET /).
 *
 * Asserts the launch-page contract:
 *  - 200 text/html
 *  - nonce-based CSP: every <style> and <script> tag carries the per-request nonce
 *  - key positioning copy is present ("npx stablerails init", "non-custodial", ...)
 *  - ZERO external requests: no http(s):// URLs outside navigation anchors —
 *    nothing on the page LOADS from another origin; <a href> links to the
 *    GitHub repo are user-initiated navigation, not resource loads
 *
 * All tests use in-memory mocks — no DB, no network.
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps } from "./helpers/mocks.js";

async function fetchLanding(): Promise<{ status: number; body: string; csp?: string; contentType?: string }> {
  const app = buildApp(buildTestDeps());
  const res = await app.inject({ method: "GET", url: "/" });
  await app.close();
  return {
    status: res.statusCode,
    body: res.body,
    csp: res.headers["content-security-policy"] as string | undefined,
    contentType: res.headers["content-type"] as string | undefined,
  };
}

describe("GET / — Stablerails landing page", () => {
  it("returns 200 text/html", async () => {
    const { status, contentType } = await fetchLanding();
    expect(status).toBe(200);
    expect(contentType).toMatch(/text\/html/);
  });

  it("every <style> tag carries the per-request CSP style nonce", async () => {
    const { body, csp } = await fetchLanding();
    expect(csp).toBeDefined();

    const styleSrc = csp!.split(";").find((d) => d.trim().startsWith("style-src"));
    expect(styleSrc).toBeDefined();
    const styleNonce = /'nonce-([^']+)'/.exec(styleSrc!)?.[1];
    expect(styleNonce).toBeDefined();

    const styleTags = body.match(/<style[^>]*>/g) ?? [];
    expect(styleTags.length).toBeGreaterThan(0);
    for (const tag of styleTags) {
      expect(tag).toContain(`nonce="${styleNonce}"`);
    }
  });

  it("every <script> tag carries the per-request CSP script nonce", async () => {
    const { body, csp } = await fetchLanding();
    expect(csp).toBeDefined();

    const scriptSrc = csp!.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    const scriptNonce = /'nonce-([^']+)'/.exec(scriptSrc!)?.[1];
    expect(scriptNonce).toBeDefined();

    const scriptTags = body.match(/<script[^>]*>/g) ?? [];
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) {
      expect(tag).toContain(`nonce="${scriptNonce}"`);
    }
  });

  it("leads with the hosted signup CTA (SaaS-first)", async () => {
    const { body } = await fetchLanding();
    expect(body).toContain("Create account");
    // The signup CTA points at the canonical hosted instance, absolutely, so
    // the page works verbatim on self-hosted instances too.
    expect(body).toContain('href="https://stablerails.org/signup"');
  });

  it("contains the core positioning copy", async () => {
    const { body } = await fetchLanding();
    expect(body).toContain("non-custodial");
    expect(body).toContain("AGPL-3.0");
    expect(body).toContain("Keys never leave your machine.");
    expect(body).toContain("Neither can your AI agent.");
    expect(body).toContain("No KYC.");
    expect(body).toContain("not a payment service");
    expect(body).toContain("This page loads nothing from third parties");
  });

  it("links the agent path and docs with relative URLs", async () => {
    const { body } = await fetchLanding();
    expect(body).toContain('href="/agents.md"');
    expect(body).toContain('href="/llms.txt"');
    expect(body).toContain('href="/docs"');
    expect(body).toContain('href="/login"');
    expect(body).toContain('href="/terms"');
  });

  it("links the GitHub repository", async () => {
    const { body } = await fetchLanding();
    expect(body).toContain('href="https://github.com/stablerails/stablerails"');
    // No dead placeholder links survive on the launch page.
    expect(body).not.toContain('href="#"');
  });

  it("loads NOTHING from external origins — absolute URLs only in navigation anchors", async () => {
    const { body } = await fetchLanding();
    // The privacy claim is structural: nothing on the page LOADS from another
    // origin — no fonts, no CDN scripts, no analytics, no external images.
    // Navigation anchors (<a href="https://github.com/...">) load nothing
    // until clicked, so they are exempt; every other occurrence of an
    // absolute URL (src, srcset, url(), @import, <link href>) is a failure.
    const withoutAnchors = body.replace(/<a\s[^>]*>/g, "");
    expect(withoutAnchors).not.toContain("https://");
    expect(withoutAnchors).not.toContain("http://");
    // And no data:/blob: resource loads either (img-src is 'self').
    expect(body).not.toContain("data:image");
    expect(body).not.toContain("blob:");
  });

  it("CSP keeps connect-src 'none' and frame-ancestors 'none'", async () => {
    const { csp } = await fetchLanding();
    expect(csp).toBeDefined();
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
