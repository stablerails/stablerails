/**
 * Tests for the terms of use page (GET /terms).
 *
 * Same launch-page contract as the landing page:
 *  - 200 text/html
 *  - nonce-based CSP on the single <style> block, no <script> at all
 *  - "just software" legal posture copy is present
 *  - ZERO external requests: absolute URLs only in navigation anchors
 *
 * All tests use in-memory mocks — no DB, no network.
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps } from "./helpers/mocks.js";

async function fetchTerms(): Promise<{ status: number; body: string; csp?: string; contentType?: string }> {
  const app = buildApp(buildTestDeps());
  const res = await app.inject({ method: "GET", url: "/terms" });
  await app.close();
  return {
    status: res.statusCode,
    body: res.body,
    csp: res.headers["content-security-policy"] as string | undefined,
    contentType: res.headers["content-type"] as string | undefined,
  };
}

describe("GET /terms — terms of use page", () => {
  it("returns 200 text/html", async () => {
    const { status, contentType } = await fetchTerms();
    expect(status).toBe(200);
    expect(contentType).toMatch(/text\/html/);
  });

  it("every <style> tag carries the per-request CSP style nonce", async () => {
    const { body, csp } = await fetchTerms();
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

  it("serves no JavaScript at all", async () => {
    const { body } = await fetchTerms();
    expect(body).not.toContain("<script");
  });

  it("states the core legal posture", async () => {
    const { body } = await fetchTerms();
    expect(body).toContain("Software, not a service");
    expect(body).toContain("AGPL-3.0");
    expect(body).toContain("No warranty");
    expect(body).toContain("Operator responsibilities");
  });

  it("loads NOTHING from external origins — absolute URLs only in navigation anchors", async () => {
    const { body } = await fetchTerms();
    const withoutAnchors = body.replace(/<a\s[^>]*>/g, "");
    expect(withoutAnchors).not.toContain("https://");
    expect(withoutAnchors).not.toContain("http://");
    expect(body).not.toContain("data:image");
    expect(body).not.toContain("blob:");
  });

  it("CSP keeps connect-src 'none' and frame-ancestors 'none'", async () => {
    const { csp } = await fetchTerms();
    expect(csp).toBeDefined();
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
