/**
 * Webhook secret encryption at rest — delivery-path tests.
 *
 * Verifies that drainPending():
 *   - decrypts an enc:v1: endpoint secret and signs with the PLAINTEXT key
 *     when STABLERAILS_DATA_KEY is set;
 *   - still works with plaintext legacy secrets (lazy migration);
 *   - fails closed on decrypt failure (wrong key) — never signs with garbage
 *     and never falls back to the raw stored ciphertext.
 *
 * Fully offline: in-memory repo + mock fetch + injected DNS resolver
 * (same patterns as webhookDelivery.test.ts). STABLERAILS_DATA_KEY is
 * saved/restored around every test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drainPending } from "../webhookDelivery.js";
import { InMemoryWebhookDeliveryRepo } from "../db/inMemoryWebhookDeliveryRepo.js";
import { sealSecret } from "../../lib/secretBox.js";
import { verify } from "../../lib/hmac.js";
import type {
  WebhookDeliveryRow,
  WebhookEndpointRow,
} from "../db/WebhookDeliveryRepository.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DATA_KEY_A = "a".repeat(64);
const DATA_KEY_B = "b".repeat(64);
const PLAIN_SECRET = "test-webhook-secret-0123456789";

const ENV_NAME = "STABLERAILS_DATA_KEY";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_NAME];
  delete process.env[ENV_NAME];
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_NAME];
  } else {
    process.env[ENV_NAME] = savedEnv;
  }
});

function makeEndpoint(secret: string): WebhookEndpointRow {
  return {
    id: "ep_enc_001",
    eventId: "evt_001",
    url: "https://example.com/webhook",
    secret,
    active: true,
    createdAt: new Date("2024-01-01"),
  };
}

function makeDelivery(overrides: Partial<WebhookDeliveryRow> = {}): WebhookDeliveryRow {
  return {
    id: `del_${Math.random().toString(36).slice(2, 10)}`,
    endpointId: "ep_enc_001",
    eventType: "invoice.paid",
    invoiceId: "inv_abc123",
    payload: { invoice: { id: "inv_abc123", status: "paid" }, payments: [] },
    eventUid: `uid_${Math.random().toString(36).slice(2, 14)}`,
    version: 1,
    attempts: 0,
    status: "pending",
    nextAttemptAt: new Date("2024-01-01T00:00:00Z"),
    lastError: null,
    createdAt: new Date("2024-01-01"),
    deliveredAt: null,
    ...overrides,
  };
}

/** DNS resolver that resolves everything to a safe public IP. */
const safeDns = async (_h: string) => ["93.184.216.34"];

/** Mock fetch that captures the signed body + headers of each POST. */
function makeCapturingFetch(captured: { body: string; headers: Record<string, string> }[]) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    captured.push({
      body: String(init?.body ?? ""),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
}

// ── Encrypted secret: signs with the decrypted plaintext ─────────────────────

describe("drainPending() — encrypted endpoint secret", () => {
  it("decrypts the secret and produces a signature verifiable with the plaintext", async () => {
    process.env[ENV_NAME] = DATA_KEY_A;

    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(makeEndpoint(sealSecret(PLAIN_SECRET)));
    const delivery = makeDelivery();
    repo.seedDelivery(delivery);

    const captured: { body: string; headers: Record<string, string> }[] = [];
    const mockFetch = makeCapturingFetch(captured);

    const result = await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date(),
    });

    expect(result.delivered).toBe(1);
    expect(captured).toHaveLength(1);
    const { body, headers } = captured[0]!;
    const sigHeader = headers["X-Stablerails-Signature"];
    expect(sigHeader).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    // verify() throws on mismatch — passing means it was signed with the
    // PLAINTEXT secret, i.e. decryption happened before HMAC signing.
    expect(() => verify(body, sigHeader, PLAIN_SECRET)).not.toThrow();
  });
});

// ── Plaintext legacy secret: still works (lazy migration) ────────────────────

describe("drainPending() — plaintext legacy secret", () => {
  it("signs with the stored plaintext secret even when a data key is set", async () => {
    process.env[ENV_NAME] = DATA_KEY_A;

    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(makeEndpoint(PLAIN_SECRET)); // legacy plaintext row
    const delivery = makeDelivery();
    repo.seedDelivery(delivery);

    const captured: { body: string; headers: Record<string, string> }[] = [];
    const mockFetch = makeCapturingFetch(captured);

    const result = await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date(),
    });

    expect(result.delivered).toBe(1);
    const { body, headers } = captured[0]!;
    expect(() => verify(body, headers["X-Stablerails-Signature"], PLAIN_SECRET)).not.toThrow();
  });

  it("signs with the stored plaintext secret when no data key is set", async () => {
    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(makeEndpoint(PLAIN_SECRET));
    const delivery = makeDelivery();
    repo.seedDelivery(delivery);

    const captured: { body: string; headers: Record<string, string> }[] = [];
    const mockFetch = makeCapturingFetch(captured);

    const result = await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date(),
    });

    expect(result.delivered).toBe(1);
    const { body, headers } = captured[0]!;
    expect(() => verify(body, headers["X-Stablerails-Signature"], PLAIN_SECRET)).not.toThrow();
  });
});

// ── Decrypt failure: fail closed ──────────────────────────────────────────────

describe("drainPending() — decrypt failure fails closed", () => {
  it("does not send when the secret was sealed under a different key", async () => {
    // Seal under key A, then run delivery with key B → decrypt must fail.
    process.env[ENV_NAME] = DATA_KEY_A;
    const sealed = sealSecret(PLAIN_SECRET);
    process.env[ENV_NAME] = DATA_KEY_B;

    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(makeEndpoint(sealed));
    const delivery = makeDelivery();
    repo.seedDelivery(delivery);

    const captured: { body: string; headers: Record<string, string> }[] = [];
    const mockFetch = makeCapturingFetch(captured);

    const result = await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date(),
    });

    // Never reached the network: no signature with garbage, no fallback to
    // signing with the raw ciphertext.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.delivered).toBe(0);

    const updated = await repo.findByEventUid(delivery.eventUid);
    expect(updated!.status).not.toBe("delivered");
    expect(updated!.lastError).toMatch(/decrypt/i);
  });

  it("does not send an encrypted secret when the data key is unset", async () => {
    process.env[ENV_NAME] = DATA_KEY_A;
    const sealed = sealSecret(PLAIN_SECRET);
    delete process.env[ENV_NAME];

    const repo = new InMemoryWebhookDeliveryRepo();
    repo.seedEndpoint(makeEndpoint(sealed));
    const delivery = makeDelivery();
    repo.seedDelivery(delivery);

    const captured: { body: string; headers: Record<string, string> }[] = [];
    const mockFetch = makeCapturingFetch(captured);

    const result = await drainPending(repo, {
      fetchFn: mockFetch,
      resolve: safeDns,
      now: () => new Date(),
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.delivered).toBe(0);
    const updated = await repo.findByEventUid(delivery.eventUid);
    expect(updated!.status).not.toBe("delivered");
  });
});
