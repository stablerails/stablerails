/**
 * Tenant isolation for GET /v1/webhooks (TENANT-1).
 *
 * The list endpoint is readonly+ (agent-facing), so it MUST be tenant-scoped:
 *   - merchant/readonly keys see only endpoints whose event belongs to their
 *     tenant; endpoints with eventId = null belong to the legacy null tenant;
 *   - event-scoped keys see only endpoints bound to their event;
 *   - endpoints referencing a missing event are hidden (fail closed);
 *   - admin keys see everything.
 *
 * All tests are offline: in-memory repos via buildTestDeps(), no DATABASE_URL.
 */

import { describe, it, expect } from "vitest";
import { buildApp } from "../app.js";
import {
  buildTestDeps,
  MockEventRepository,
  MockApiKeyRepository,
  MockWebhookRepository,
} from "./helpers/mocks.js";

function bearer(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

const KEY_READONLY_A = "readonly_a_key_1234567890abcdef0";
const KEY_MERCHANT_B = "merchant_b_key_1234567890abcdef00";
const KEY_LEGACY = "legacy_readonly_key_1234567890ab";
const KEY_ADMIN = "admin_key_1234567890abcdef000000";
const KEY_EVENT_A = "event_a_scoped_key_1234567890abc";

interface ListedEndpoint {
  id: string;
  eventId: string | null;
  url: string;
}

async function buildWebhookApp() {
  const deps = buildTestDeps();
  const apiKeyRepo = deps.apiKeyRepo as MockApiKeyRepository;
  const eventRepo = deps.eventRepo as MockEventRepository;
  const webhookRepo = deps.webhookRepo as MockWebhookRepository;

  apiKeyRepo.seedKey({ rawKey: KEY_READONLY_A, scope: "readonly", label: "ro-a", merchantId: "merchant-a" });
  apiKeyRepo.seedKey({ rawKey: KEY_MERCHANT_B, scope: "merchant", label: "m-b", merchantId: "merchant-b" });
  apiKeyRepo.seedKey({ rawKey: KEY_LEGACY, scope: "readonly", label: "legacy" });
  apiKeyRepo.seedKey({ rawKey: KEY_ADMIN, scope: "admin", label: "admin" });
  apiKeyRepo.seedKey({ rawKey: KEY_EVENT_A, scope: "readonly", label: "evt-a-scoped", eventId: "evt_a", merchantId: "merchant-a" });

  eventRepo.seed({ id: "evt_a", merchantId: "merchant-a", derivationAccount: 1 });
  eventRepo.seed({ id: "evt_a2", merchantId: "merchant-a", derivationAccount: 2 });
  eventRepo.seed({ id: "evt_b", merchantId: "merchant-b", derivationAccount: 3 });
  eventRepo.seed({ id: "evt_legacy", merchantId: null, derivationAccount: 4 });

  const epA = await webhookRepo.insert({ eventId: "evt_a", url: "https://a.example.com/hook", secret: "s".repeat(16) });
  const epA2 = await webhookRepo.insert({ eventId: "evt_a2", url: "https://a2.example.com/hook", secret: "s".repeat(16) });
  const epB = await webhookRepo.insert({ eventId: "evt_b", url: "https://b.example.com/hook", secret: "s".repeat(16) });
  const epLegacyEvent = await webhookRepo.insert({ eventId: "evt_legacy", url: "https://lg-evt.example.com/hook", secret: "s".repeat(16) });
  const epGlobal = await webhookRepo.insert({ eventId: null, url: "https://global.example.com/hook", secret: "s".repeat(16) });
  // Endpoint whose event no longer exists — must be hidden from non-admins.
  const epGhost = await webhookRepo.insert({ eventId: "evt_ghost", url: "https://ghost.example.com/hook", secret: "s".repeat(16) });

  const app = buildApp(deps);
  return { app, epA, epA2, epB, epLegacyEvent, epGlobal, epGhost };
}

async function listWith(app: Awaited<ReturnType<typeof buildWebhookApp>>["app"], key: string): Promise<ListedEndpoint[]> {
  const res = await app.inject({ method: "GET", url: "/v1/webhooks", headers: bearer(key) });
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as { data: ListedEndpoint[] }).data;
}

describe("GET /v1/webhooks — tenant scoping", () => {
  it("readonly key of tenant A sees only tenant A endpoints", async () => {
    const { app, epA, epA2 } = await buildWebhookApp();
    const data = await listWith(app, KEY_READONLY_A);
    expect(data.map((e) => e.id).sort()).toEqual([epA.id, epA2.id].sort());
  });

  it("merchant key of tenant B sees only tenant B endpoints", async () => {
    const { app, epB } = await buildWebhookApp();
    const data = await listWith(app, KEY_MERCHANT_B);
    expect(data.map((e) => e.id)).toEqual([epB.id]);
  });

  it("legacy null-tenant key sees null-tenant event endpoints and global endpoints only", async () => {
    const { app, epLegacyEvent, epGlobal } = await buildWebhookApp();
    const data = await listWith(app, KEY_LEGACY);
    expect(data.map((e) => e.id).sort()).toEqual([epLegacyEvent.id, epGlobal.id].sort());
  });

  it("event-scoped key sees only endpoints bound to its event", async () => {
    const { app, epA } = await buildWebhookApp();
    const data = await listWith(app, KEY_EVENT_A);
    expect(data.map((e) => e.id)).toEqual([epA.id]);
  });

  it("endpoints referencing a missing event are hidden from non-admin keys (fail closed)", async () => {
    const { app, epGhost } = await buildWebhookApp();
    for (const key of [KEY_READONLY_A, KEY_MERCHANT_B, KEY_LEGACY]) {
      const data = await listWith(app, key);
      expect(data.map((e) => e.id)).not.toContain(epGhost.id);
    }
  });

  it("admin key sees all endpoints including global and orphaned ones", async () => {
    const { app, epA, epA2, epB, epLegacyEvent, epGlobal, epGhost } = await buildWebhookApp();
    const data = await listWith(app, KEY_ADMIN);
    expect(data.map((e) => e.id).sort()).toEqual(
      [epA.id, epA2.id, epB.id, epLegacyEvent.id, epGlobal.id, epGhost.id].sort(),
    );
  });

  it("no secret field is ever present in list responses", async () => {
    const { app } = await buildWebhookApp();
    const res = await app.inject({ method: "GET", url: "/v1/webhooks", headers: bearer(KEY_ADMIN) });
    expect(res.body).not.toContain("secret");
  });
});
