import { describe, it, expect, afterEach, vi } from "vitest";

import { buildApp } from "../app.js";
import { buildTestDeps } from "./helpers/mocks.js";

const ENV_KEYS = [
  "ENABLE_DEMO",
  "STABLERAILS_ENV",
  "NODE_ENV",
  "DEMO_MERCHANT_KEY",
  "DEMO_EVENT_ID",
  "PUBLIC_BASE_URL",
] as const;

const originalEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  restoreEnv();
});

describe("demo routes", () => {
  it("does not mount demo routes in production even when ENABLE_DEMO is set", async () => {
    process.env["ENABLE_DEMO"] = "1";
    delete process.env["STABLERAILS_ENV"];
    process.env["NODE_ENV"] = "production";
    process.env["DEMO_MERCHANT_KEY"] = "merchantkey_test_1234567890abcdef";
    process.env["DEMO_EVENT_ID"] = "event_prod";

    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: "/demo" });
    await app.close();

    expect(res.statusCode).toBe(404);
  });

  it("rejects demo order requests from non-local hosts before processing the form", async () => {
    process.env["ENABLE_DEMO"] = "1";
    process.env["STABLERAILS_ENV"] = "development";
    process.env["NODE_ENV"] = "development";

    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "POST",
      url: "/demo/order",
      headers: {
        host: "pay.example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "product=Test&amount=0",
    });
    await app.close();

    expect(res.statusCode).toBe(403);
  });

  it("allows demo GET from non-local host when STABLERAILS_ENV=testnet", async () => {
    process.env["ENABLE_DEMO"] = "1";
    process.env["STABLERAILS_ENV"] = "testnet";
    delete process.env["NODE_ENV"];

    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "GET",
      url: "/demo",
      headers: { host: "paytest.example.com" },
    });
    await app.close();

    // 200 because STABLERAILS_ENV=testnet lifts the localhost restriction.
    expect(res.statusCode).toBe(200);
  });

  it("allows demo POST from non-local host when STABLERAILS_ENV=testnet (503 = not configured, not 403)", async () => {
    process.env["ENABLE_DEMO"] = "1";
    process.env["STABLERAILS_ENV"] = "testnet";
    delete process.env["NODE_ENV"];
    delete process.env["DEMO_MERCHANT_KEY"];
    delete process.env["DEMO_EVENT_ID"];

    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "POST",
      url: "/demo/order",
      headers: {
        host: "paytest.example.com",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "product=Test&amount=1.00",
    });
    await app.close();

    // localhost restriction is lifted — request proceeds to demo logic (503 = keys not configured)
    expect(res.statusCode).toBe(503);
  });

  it("demo order succeeds without an email field and sends no payer PII in metadata", async () => {
    process.env["ENABLE_DEMO"] = "1";
    process.env["STABLERAILS_ENV"] = "development";
    process.env["NODE_ENV"] = "development";
    process.env["DEMO_MERCHANT_KEY"] = "merchantkey_test_1234567890abcdef";
    process.env["DEMO_EVENT_ID"] = "event_demo";

    // Stub the server-side proxy fetch to /v1/invoices.
    const fetchMock = vi.fn(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({ data: { id: "inv_demo_1", hostedUrl: "/pay/inv_demo_1" } }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const app = buildApp(buildTestDeps());
      const res = await app.inject({
        method: "POST",
        url: "/demo/order",
        headers: {
          host: "localhost:3000",
          "content-type": "application/x-www-form-urlencoded",
        },
        // No email field — the form no longer has one.
        body: "product=Test+Product&amount=1.00",
      });
      await app.close();

      expect(res.statusCode).toBe(302);
      expect(res.headers["location"]).toBe("/pay/inv_demo_1");

      // The proxied invoice payload must carry the product label only — no email.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      const payload = JSON.parse(init.body as string) as { metadata: Record<string, string> };
      expect(payload.metadata).toEqual({ product: "Test Product" });
      expect("email" in payload.metadata).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GET /demo form contains no email input (payer privacy)", async () => {
    process.env["ENABLE_DEMO"] = "1";
    process.env["STABLERAILS_ENV"] = "development";
    process.env["NODE_ENV"] = "development";
    process.env["DEMO_MERCHANT_KEY"] = "merchantkey_test_1234567890abcdef";
    process.env["DEMO_EVENT_ID"] = "event_demo";

    const app = buildApp(buildTestDeps());
    const res = await app.inject({
      method: "GET",
      url: "/demo",
      headers: { host: "localhost:3000" },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('type="email"');
    expect(res.body).not.toContain('name="email"');
  });
});
