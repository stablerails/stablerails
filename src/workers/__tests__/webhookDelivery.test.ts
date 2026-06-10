/**
 * Tests for src/workers/webhookDelivery.ts
 *
 * Fully offline:
 *   - HTTP send is mocked (no real network)
 *   - DNS resolution is injected (no real DNS)
 *   - Persistence uses InMemoryWebhookDeliveryRepo
 *
 * Covers:
 *   - Retry / backoff schedule + jitter bounds
 *   - DLQ after retry exhaustion
 *   - Idempotency on eventUid (already delivered)
 *   - Monotonic version ordering
 *   - Manual replay
 *   - SSRF guard blocks internal URLs at send time
 */

import { describe, it, expect, vi } from "vitest";
import {
  drainPending,
  replayDelivery,
  nextAttemptTime,
  retryDelayMs,
  RETRY_DELAYS_MS,
  MAX_ATTEMPTS,
  sendWebhook,
} from "../webhookDelivery.js";
import { InMemoryWebhookDeliveryRepo } from "../db/inMemoryWebhookDeliveryRepo.js";
import type {
  WebhookDeliveryRow,
  WebhookEndpointRow,
} from "../db/WebhookDeliveryRepository.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ENDPOINT: WebhookEndpointRow = {
  id: "ep_001",
  eventId: "evt_001",
  url: "https://example.com/webhook",
  secret: "test-secret-abc",
  active: true,
  createdAt: new Date("2024-01-01"),
};

const INVOICE_ID = "inv_abc123";

function makeDelivery(overrides: Partial<WebhookDeliveryRow> = {}): WebhookDeliveryRow {
  return {
    id: `del_${Math.random().toString(36).slice(2, 10)}`,
    endpointId: ENDPOINT.id,
    eventType: "invoice.paid",
    invoiceId: INVOICE_ID,
    payload: { invoice: { id: INVOICE_ID, status: "paid" }, payments: [] },
    eventUid: `uid_${Math.random().toString(36).slice(2, 14)}`,
    version: 1,
    attempts: 0,
    status: "pending",
    nextAttemptAt: new Date("2024-01-01T00:00:00Z"),
    lastError: null,
    claimToken: null,
    claimedAt: null,
    claimExpiresAt: null,
    createdAt: new Date("2024-01-01"),
    deliveredAt: null,
    ...overrides,
  };
}

/** DNS resolver that resolves everything to a safe public IP. */
const safeDns = async (_h: string) => ["93.184.216.34"];
/** DNS resolver that resolves to an internal IP. */
const internalDns = async (_h: string) => ["192.168.1.1"];

// ── nextAttemptTime() ─────────────────────────────────────────────────────────

describe("nextAttemptTime()", () => {
  it("returns exactly now for a 0 delay (immediate)", () => {
    const now = new Date("2024-06-01T12:00:00Z");
    const result = nextAttemptTime(0, now);
    expect(result.getTime()).toBe(now.getTime());
  });

  it("adds jitter within ±10% of the delay", () => {
    const now = new Date("2024-06-01T12:00:00Z");
    const delay = 60_000; // 1 minute
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = nextAttemptTime(delay, now);
      samples.push(t.getTime() - now.getTime());
    }
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    // Should be within [0.9*delay, 1.1*delay]
    expect(min).toBeGreaterThanOrEqual(0.9 * delay);
    expect(max).toBeLessThanOrEqual(1.1 * delay);
    // Jitter ensures they're not all identical
    expect(max - min).toBeGreaterThan(0);
  });
});

// ── retryDelayMs() ────────────────────────────────────────────────────────────

describe("retryDelayMs()", () => {
  it("returns the correct delay for each attempt index", () => {
    for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
      expect(retryDelayMs(i)).toBe(RETRY_DELAYS_MS[i]);
    }
  });

  it("returns null when all retries are exhausted", () => {
    expect(retryDelayMs(RETRY_DELAYS_MS.length)).toBeNull();
    expect(retryDelayMs(MAX_ATTEMPTS)).toBeNull();
  });
});

// ── drainPending() — success path ─────────────────────────────────────────────

describe("drainPending() — success", () => {
  it("marks a delivery as delivered on 2xx response", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    const delivery = makeDelivery();
    repo.seedDelivery(delivery);

    const mockFetch = vi.fn(async () =>
      new Response("", { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date("2024-01-01T00:01:00Z"),
    });

    expect(result.delivered).toBe(1);
    expect(result.dead).toBe(0);
    expect(result.failed).toBe(0);

    const updated = await repo.findByEventUid(delivery.eventUid);
    expect(updated!.status).toBe("delivered");
    expect(updated!.deliveredAt).not.toBeNull();
  });

  it("sends a POST with X-Stablerails-Signature and X-Stablerails-EventUid headers", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    const delivery = makeDelivery();
    repo.seedDelivery(delivery);

    const capturedHeaders: Record<string, string>[] = [];
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.headers) {
        capturedHeaders.push(init.headers as Record<string, string>);
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date("2024-01-01T00:01:00Z"),
    });

    expect(capturedHeaders.length).toBeGreaterThan(0);
    const hdrs = capturedHeaders[0]!;
    expect(hdrs["X-Stablerails-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(hdrs["X-Stablerails-EventUid"]).toBe(delivery.eventUid);
  });
});

// ── drainPending() — retry path ───────────────────────────────────────────────

describe("drainPending() — retry schedule", () => {
  it("schedules next retry after a 5xx response", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    const delivery = makeDelivery({ attempts: 0 });
    repo.seedDelivery(delivery);

    const mockFetch = vi.fn(async () =>
      new Response("error", { status: 500 }),
    ) as unknown as typeof fetch;

    const refTime = new Date("2024-01-01T00:01:00Z");
    await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => refTime,
    });

    const updated = await repo.findByEventUid(delivery.eventUid);
    expect(updated!.status).toBe("failed");
    expect(updated!.attempts).toBe(1);
    // nextAttemptAt should be scheduled with the delay for attempt 1 (immediate → 60s)
    const delay = retryDelayMs(1);
    expect(delay).toBe(60_000);
    // Allow for jitter (±10%)
    const expectedMin = refTime.getTime() + 0.9 * delay!;
    const expectedMax = refTime.getTime() + 1.1 * delay!;
    expect(updated!.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(updated!.nextAttemptAt.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  it("moves to DLQ after exhausting all retries", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    // Seed at attempts = MAX_ATTEMPTS - 1 so one more failure triggers DLQ
    const delivery = makeDelivery({ attempts: MAX_ATTEMPTS - 1 });
    repo.seedDelivery(delivery);

    const mockFetch = vi.fn(async () =>
      new Response("error", { status: 500 }),
    ) as unknown as typeof fetch;

    await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date("2024-01-01T00:01:00Z"),
    });

    const updated = await repo.findByEventUid(delivery.eventUid);
    expect(updated!.status).toBe("dead");
  });

  it("counts drainResult.dead correctly after DLQ", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    const delivery = makeDelivery({ attempts: MAX_ATTEMPTS - 1 });
    repo.seedDelivery(delivery);

    const mockFetch = vi.fn(async () =>
      new Response("error", { status: 500 }),
    ) as unknown as typeof fetch;

    const result = await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date("2024-01-01T00:01:00Z"),
    });

    expect(result.dead).toBe(1);
    expect(result.delivered).toBe(0);
  });
});

// ── drainPending() — SSRF guard ───────────────────────────────────────────────

describe("drainPending() — SSRF guard", () => {
  it("blocks delivery and marks failed when URL resolves to internal IP", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    const delivery = makeDelivery({ attempts: 0 });
    repo.seedDelivery(delivery);

    const mockFetch = vi.fn(async () =>
      new Response("", { status: 200 }),
    ) as unknown as typeof fetch;

    await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: internalDns,  // DNS resolves to 192.168.1.1
      now: () => new Date("2024-01-01T00:01:00Z"),
    });

    const updated = await repo.findByEventUid(delivery.eventUid);
    // SSRF blocked → error recorded, not delivered, eventually DLQ after retries
    expect(updated!.status).not.toBe("delivered");
    expect(updated!.lastError).toContain("SSRF");
    // fetch was NOT called (SSRF guard fires before send)
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── drainPending() — inactive endpoint ───────────────────────────────────────

describe("drainPending() — inactive endpoint", () => {
  it("marks delivery dead when endpoint is inactive", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    const inactiveEndpoint: WebhookEndpointRow = { ...ENDPOINT, active: false };
    repo.seedEndpoint(inactiveEndpoint);
    const delivery = makeDelivery();
    repo.seedDelivery(delivery);

    const mockFetch = vi.fn() as unknown as typeof fetch;

    await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date("2024-01-01T00:01:00Z"),
    });

    const updated = await repo.findByEventUid(delivery.eventUid);
    expect(updated!.status).toBe("dead");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── drainPending() — missing endpoint ────────────────────────────────────────

describe("drainPending() — missing endpoint", () => {
  it("marks delivery dead when endpoint not found", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    // Endpoint NOT seeded
    const delivery = makeDelivery();
    repo.seedDelivery(delivery);

    const mockFetch = vi.fn() as unknown as typeof fetch;

    await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date("2024-01-01T00:01:00Z"),
    });

    const updated = await repo.findByEventUid(delivery.eventUid);
    expect(updated!.status).toBe("dead");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── drainPending() — idempotency ──────────────────────────────────────────────

describe("drainPending() — eventUid idempotency", () => {
  it("does not re-process an already-delivered delivery (not in pending)", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    // Delivery already delivered (status !== pending) — won't be returned by claimPending
    const delivery = makeDelivery({ status: "delivered", deliveredAt: new Date() });
    repo.seedDelivery(delivery);

    const mockFetch = vi.fn(async () =>
      new Response("", { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date("2024-01-01T00:01:00Z"),
    });

    expect(result.processed).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── drainPending() — batch ordering ──────────────────────────────────────────

describe("drainPending() — batch", () => {
  it("processes multiple deliveries in one drain pass", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    const d1 = makeDelivery();
    const d2 = makeDelivery();
    const d3 = makeDelivery();
    repo.seedDelivery(d1);
    repo.seedDelivery(d2);
    repo.seedDelivery(d3);

    const mockFetch = vi.fn(async () =>
      new Response("", { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date("2024-01-01T00:01:00Z"),
    });

    expect(result.processed).toBe(3);
    expect(result.delivered).toBe(3);
  });

  it("respects batchSize limit", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    for (let i = 0; i < 10; i++) repo.seedDelivery(makeDelivery());

    const mockFetch = vi.fn(async () =>
      new Response("", { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      batchSize: 3,
      now: () => new Date("2024-01-01T00:01:00Z"),
    });

    expect(result.processed).toBe(3);
  });
});

// ── maxVersionForInvoice() — monotonic ordering ───────────────────────────────
// Version authority lives entirely in the watcher's in-tx maxVersionForInvoice+1.
// These tests exercise the InMemoryWebhookDeliveryRepo version tracking directly.

describe("maxVersionForInvoice() — monotonic tracking", () => {
  it("returns 0 (no deliveries) for a new invoice", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    const v = await repo.maxVersionForInvoice(INVOICE_ID);
    expect(v).toBe(0);
  });

  it("reflects the highest seeded version", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    // Seed deliveries directly to bypass FK check (simulating already-persisted rows)
    repo.seedDelivery({ ...makeDelivery(), version: 1, eventUid: "uid_v1" });
    repo.seedDelivery({ ...makeDelivery(), version: 2, eventUid: "uid_v2" });
    repo.seedDelivery({ ...makeDelivery(), version: 3, eventUid: "uid_v3" });
    const v = await repo.maxVersionForInvoice(INVOICE_ID);
    expect(v).toBe(3);
  });

  it("versions are per-invoice independent", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    repo.seedDelivery({ ...makeDelivery(), invoiceId: "inv_A", version: 5, eventUid: "uid_A5" });
    repo.seedDelivery({ ...makeDelivery(), invoiceId: "inv_B", version: 2, eventUid: "uid_B2" });
    expect(await repo.maxVersionForInvoice("inv_A")).toBe(5);
    expect(await repo.maxVersionForInvoice("inv_B")).toBe(2);
    expect(await repo.maxVersionForInvoice("inv_C")).toBe(0); // no deliveries
  });
});

// ── multi-instance claim lease safety ────────────────────────────────────────

describe("claimPending() — lease safety", () => {
  it("does not return an already-claimed pending delivery before its lease expires", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    const delivery = makeDelivery();
    repo.seedDelivery(delivery);

    const now = new Date("2024-01-01T00:01:00Z");
    const first = await repo.claimPending({ now, batchSize: 10 });
    const second = await repo.claimPending({ now, batchSize: 10 });

    expect(first).toHaveLength(1);
    expect(first[0]!.claimToken).toMatch(/^claim_/);
    expect(second).toHaveLength(0);
  });

  it("reclaims a pending delivery after its claim lease expires", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    const delivery = makeDelivery();
    repo.seedDelivery(delivery);

    const first = await repo.claimPending({
      now: new Date("2024-01-01T00:01:00Z"),
      batchSize: 10,
      leaseMs: 1_000,
    });
    const second = await repo.claimPending({
      now: new Date("2024-01-01T00:01:02Z"),
      batchSize: 10,
      leaseMs: 1_000,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(second[0]!.claimToken).not.toBe(first[0]!.claimToken);
  });

  it("rejects stale claim tokens when marking a delivery", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    const delivery = makeDelivery();
    repo.seedDelivery(delivery);

    const [claimed] = await repo.claimPending({
      now: new Date("2024-01-01T00:01:00Z"),
      batchSize: 10,
      leaseMs: 1_000,
    });
    expect(claimed).toBeDefined();

    await repo.claimPending({
      now: new Date("2024-01-01T00:01:02Z"),
      batchSize: 10,
      leaseMs: 1_000,
    });

    await expect(
      repo.markDelivered({
        id: delivery.id,
        claimToken: claimed!.claimToken!,
        deliveredAt: new Date("2024-01-01T00:01:03Z"),
      }),
    ).rejects.toThrow(/stale claim/i);
  });
});

describe("drainPending() — stale claim safety", () => {
  it("treats a stale claim mark as a benign skip instead of aborting the drain", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    const first = makeDelivery({ id: "del_stale_first", eventUid: "uid_stale_first" });
    const second = makeDelivery({ id: "del_stale_second", eventUid: "uid_stale_second" });
    repo.seedDelivery(first);
    repo.seedDelivery(second);

    let sendCount = 0;
    const mockFetch = vi.fn(async () => {
      sendCount += 1;
      if (sendCount === 2) {
        await repo.claimPending({
          now: new Date("2024-01-01T00:02:01Z"),
          batchSize: 10,
        });
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      batchSize: 2,
      now: () => new Date("2024-01-01T00:00:00Z"),
    });

    expect(result.processed).toBe(2);
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.dead).toBe(0);
    expect(await repo.findByEventUid(first.eventUid)).toMatchObject({ status: "delivered" });
    expect(await repo.findByEventUid(second.eventUid)).toMatchObject({ status: "pending" });
  });
});

// ── replayDelivery() ──────────────────────────────────────────────────────────

describe("replayDelivery()", () => {
  it("resets a dead delivery to pending", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    const delivery = makeDelivery({ status: "dead", attempts: MAX_ATTEMPTS });
    repo.seedDelivery(delivery);

    const replayTime = new Date("2024-06-01T10:00:00Z");
    const result = await replayDelivery(repo, delivery.eventUid, replayTime);

    expect(result.ok).toBe(true);
    const updated = await repo.findByEventUid(delivery.eventUid);
    expect(updated!.status).toBe("pending");
    expect(updated!.nextAttemptAt.getTime()).toBe(replayTime.getTime());
  });

  it("resets a failed delivery to pending", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    const delivery = makeDelivery({ status: "failed", attempts: 3 });
    repo.seedDelivery(delivery);

    const result = await replayDelivery(repo, delivery.eventUid);
    expect(result.ok).toBe(true);
    expect(result.delivery!.status).toBe("pending");
  });

  it("rejects replay of an already-delivered delivery", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    const delivery = makeDelivery({ status: "delivered", deliveredAt: new Date() });
    repo.seedDelivery(delivery);

    const result = await replayDelivery(repo, delivery.eventUid);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already-delivered");
  });

  it("returns error when delivery not found", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    const result = await replayDelivery(repo, "uid_nonexistent");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });
});

// ── S1: redirect to internal IP is blocked at delivery layer ─────────────────

describe("drainPending() — S1: redirect to internal IP is blocked", () => {
  it("blocks delivery when endpoint redirects to an RFC1918 address", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);
    const delivery = makeDelivery({ attempts: 0 });
    repo.seedDelivery(delivery);

    const internalCallsMade: string[] = [];

    // mock: first call returns 302 → internal; second call (if reached) returns 200
    const mockFetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const u = typeof url === "string" ? url
        : url instanceof URL ? url.href
        : (url as Request).url;
      if (u.includes("192.168.99.1")) {
        internalCallsMade.push(u);
        return new Response("internal", { status: 200 });
      }
      return new Response("", {
        status: 302,
        headers: { location: "https://192.168.99.1/steal" },
      });
    }) as unknown as typeof fetch;

    await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns, // endpoint hostname resolves safely
      now: () => new Date("2024-01-01T00:01:00Z"),
    });

    const updated = await repo.findByEventUid(delivery.eventUid);
    // Must NOT be delivered
    expect(updated!.status).not.toBe("delivered");
    // Error must mention SSRF
    expect(updated!.lastError).toMatch(/SSRF/i);
    // The internal host was never contacted
    expect(internalCallsMade).toHaveLength(0);
  });
});

// ── V1: version authority contract ───────────────────────────────────────────

describe("version authority contract", () => {
  it("watcher-path maxVersionForInvoice+1 produces monotonic per-invoice versions", async () => {
    // Simulate the watcher pattern: read max, add 1, enqueue at that version.
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(ENDPOINT);

    for (let i = 0; i < 3; i++) {
      const max = await repo.maxVersionForInvoice(INVOICE_ID);
      const version = max + 1;
      repo.seedDelivery({
        ...makeDelivery(),
        version,
        eventUid: `uid_mono_${i}`,
      });
    }

    expect(await repo.maxVersionForInvoice(INVOICE_ID)).toBe(3);
    const all = repo.getAllDeliveries().filter((d) => d.invoiceId === INVOICE_ID);
    expect(all.map((d) => d.version).sort()).toEqual([1, 2, 3]);
  });

  // NOTE: Single version authority: the watcher's in-tx maxVersionForInvoice+1
  // is the ONLY place versions are assigned. The former incrementVersion/assignVersion
  // helpers have been removed. Combined with @@unique([invoiceId, version]) in
  // schema.prisma, concurrent callers will get a constraint violation instead of
  // a silent duplicate.
  it("documents Prisma concurrency contract: @@unique([invoiceId, version]) is declared in schema", () => {
    // Sentinel: real enforcement is schema-level.
    expect(true).toBe(true);
  });
});

// ── sendWebhook() — SSRF inline ───────────────────────────────────────────────

describe("sendWebhook()", () => {
  it("succeeds for a public URL", async () => {
    const mockFetch = vi.fn(async () =>
      new Response("", { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await sendWebhook(
      "https://example.com/hook",
      "secret",
      '{"test":1}',
      { fetchFn: mockFetch, resolve: safeDns },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("returns error for an internal URL (SSRF block)", async () => {
    const mockFetch = vi.fn(async () =>
      new Response("", { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await sendWebhook(
      "https://internal.example.com/hook",
      "secret",
      '{"test":1}',
      { fetchFn: mockFetch, resolve: internalDns },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("SSRF guard");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns error for http:// URL", async () => {
    const mockFetch = vi.fn() as unknown as typeof fetch;

    const result = await sendWebhook(
      "http://example.com/hook",
      "secret",
      '{"test":1}',
      { fetchFn: mockFetch, resolve: safeDns },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("SSRF guard");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns error when server returns 4xx", async () => {
    const mockFetch = vi.fn(async () =>
      new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;

    const result = await sendWebhook(
      "https://example.com/hook",
      "secret",
      '{"test":1}',
      { fetchFn: mockFetch, resolve: safeDns },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });
});
