/**
 * Public status / checkout invoice-id shape guard (pre-deploy hardening):
 * implausible ids are rejected with 404 BEFORE the rate limiter, bounding its
 * key space against an unbounded-memory DoS.
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import { buildTestDeps } from "./helpers/mocks.js";

const TOO_LONG = "x".repeat(41);
const BAD_CHARS = "../../etc/passwd";
const VALID_SHAPE = "clz1abc234def567ghi890jkl"; // cuid-like, won't exist in mocks

describe("public invoice-status id guard", () => {
  it("GET /v1/public/invoices/<41 chars> → 404 (rejected before limiter)", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: `/v1/public/invoices/${TOO_LONG}` });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("GET /v1/public/invoices/<bad charset> → 404", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: `/v1/public/invoices/${encodeURIComponent(BAD_CHARS)}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET /v1/public/invoices/<valid-shape, missing> → 404 (passes guard, real miss)", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: `/v1/public/invoices/${VALID_SHAPE}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET /pay/<41 chars> → 404 HTML", async () => {
    const app = buildApp(buildTestDeps());
    const res = await app.inject({ method: "GET", url: `/pay/${TOO_LONG}` });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
    await app.close();
  });
});
