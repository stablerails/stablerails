/**
 * Tests for the agents page (GET /agents) — the human-facing page with
 * copy-paste prompts; machine files (/agents.md, /llms.txt) stay separate.
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps } from "./helpers/mocks.js";

async function fetchAgents(): Promise<{ status: number; body: string; csp?: string }> {
  const app = buildApp(buildTestDeps());
  const res = await app.inject({ method: "GET", url: "/agents" });
  await app.close();
  return { status: res.statusCode, body: res.body, csp: res.headers["content-security-policy"] as string | undefined };
}

describe("GET /agents — agents page", () => {
  it("returns 200 with the three copyable prompts and the boundary", async () => {
    const { status, body } = await fetchAgents();
    expect(status).toBe(200);
    expect(body).toContain("Set up an instance for me");
    expect(body).toContain("Wire the MCP server");
    expect(body).toContain("Run my payments");
    expect(body).toContain("STABLERAILS_MCP_KEY");
    expect(body).toContain("seed passphrase is never part of any agent flow");
    expect(body).toContain('href="/agents.md"');
    expect(body).toContain('href="/llms.txt"');
  });

  it("carries CSP nonces and loads nothing external", async () => {
    const { body, csp } = await fetchAgents();
    expect(csp).toContain("connect-src 'none'");
    const styleNonce = /'nonce-([^']+)'/.exec(csp!.split(";").find((d) => d.trim().startsWith("style-src"))!)?.[1];
    for (const tag of body.match(/<style[^>]*>/g) ?? []) expect(tag).toContain(`nonce="${styleNonce}"`);
    const withoutAnchors = body.replace(/<a\s[^>]*>/g, "").replace(/<button\s[^>]*>/g, "");
    expect(withoutAnchors).not.toMatch(/(?:src|href)\s*=\s*"https?:\/\//);
  });
});
