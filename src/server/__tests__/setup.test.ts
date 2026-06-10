/**
 * Tests for the setup page (GET /setup).
 *
 * Same launch-page contract as landing/terms: 200 text/html, nonce'd style
 * and script blocks, zero external loads outside navigation anchors, and the
 * three setup paths actually present with copyable commands.
 *
 * All tests use in-memory mocks — no DB, no network.
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps } from "./helpers/mocks.js";

async function fetchSetup(): Promise<{ status: number; body: string; csp?: string; contentType?: string }> {
  const app = buildApp(buildTestDeps());
  const res = await app.inject({ method: "GET", url: "/setup" });
  await app.close();
  return {
    status: res.statusCode,
    body: res.body,
    csp: res.headers["content-security-policy"] as string | undefined,
    contentType: res.headers["content-type"] as string | undefined,
  };
}

describe("GET /setup — setup page", () => {
  it("returns 200 text/html", async () => {
    const { status, contentType } = await fetchSetup();
    expect(status).toBe(200);
    expect(contentType).toMatch(/text\/html/);
  });

  it("style and script tags carry the per-request CSP nonces", async () => {
    const { body, csp } = await fetchSetup();
    expect(csp).toBeDefined();

    const styleNonce = /'nonce-([^']+)'/.exec(csp!.split(";").find((d) => d.trim().startsWith("style-src"))!)?.[1];
    const scriptNonce = /'nonce-([^']+)'/.exec(csp!.split(";").find((d) => d.trim().startsWith("script-src"))!)?.[1];
    expect(styleNonce).toBeDefined();
    expect(scriptNonce).toBeDefined();

    for (const tag of body.match(/<style[^>]*>/g) ?? []) expect(tag).toContain(`nonce="${styleNonce}"`);
    for (const tag of body.match(/<script[^>]*>/g) ?? []) expect(tag).toContain(`nonce="${scriptNonce}"`);
  });

  it("presents all three setup paths with copyable artifacts", async () => {
    const { body } = await fetchSetup();
    expect(body).toContain("Three ways.");
    expect(body).toContain("git clone https://github.com/stablerails/stablerails.git");
    expect(body).toContain("docker compose up --build");
    expect(body).toContain("Let your agent install it");
    expect(body).toContain("stablerails-mcp");
    expect(body).toContain("STABLERAILS_MCP_KEY");
    expect(body).toContain("Build it yourself");
    // The passphrase boundary is stated on the page.
    expect(body).toContain("seed passphrase");
  });

  it("loads NOTHING from external origins — absolute URLs only in navigation anchors", async () => {
    const { body } = await fetchSetup();
    const withoutAnchors = body.replace(/<a\s[^>]*>/g, "");
    // data-copy attributes carry the agent/debug prompts which reference our own
    // public URLs — strip button tags too before asserting resource purity.
    const withoutButtons = withoutAnchors.replace(/<button\s[^>]*>/g, "");
    // The visible agent/debug prompt text and source steps legitimately mention
    // stablerails.org/github URLs as text content; resource loads are policed
    // by checking src/href attributes outside anchors instead.
    expect(withoutButtons).not.toMatch(/(?:src|href)\s*=\s*"https?:\/\//);
    expect(body).not.toContain("data:image");
    expect(body).not.toContain("blob:");
  });

  it("CSP keeps connect-src 'none' and frame-ancestors 'none'", async () => {
    const { csp } = await fetchSetup();
    expect(csp).toBeDefined();
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
