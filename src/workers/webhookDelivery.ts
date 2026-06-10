/**
 * Webhook delivery worker (spec §8).
 *
 * Drains pending WebhookDelivery rows and POSTs the signed payload to the
 * registered endpoint URL via the SSRF guard.
 *
 * Design points:
 *   - At-least-once: carries `eventUid` for receiver-side idempotency.
 *   - Per-invoice monotonic `version`: incremented by the delivery layer.
 *   - Exponential backoff + jitter: 1m, 5m, 30m, 2h, 6h, 12h, 24h (×3) → DLQ (10 total sends).
 *   - Dead-letter queue: after exhausting retries, status → "dead" + alert logged.
 *   - Manual replay: replayDelivery(id) resets a dead/failed delivery to pending.
 *   - No signer imports: only uses the per-endpoint `secret` for HMAC signing.
 *
 * SSRF guard routes every POST through guardedFetch: HTTPS-only, redirect:manual,
 * SSRF re-validation on every redirect hop. DNS pinning is ACTIVE via a real undici
 * dependency: hostname resolved once in buildPinnedFetch, TCP connection pinned to
 * the pre-validated IP via undici Agent connect.lookup — no second OS DNS round-trip
 * is possible, defeating TTL=0 DNS-rebinding attacks.
 * DNS resolver is injectable for offline tests.
 *
 * Multi-instance safety: production claimPending uses a short DB claim lease
 * with SELECT ... FOR UPDATE SKIP LOCKED, and mark* calls include the claimToken.
 */

import { sign } from "../lib/hmac.js";
import { guardedFetch, type DnsResolver } from "../lib/ssrf-guard.js";
import { openSecret, SecretBoxError } from "../lib/secretBox.js";
import { rootLogger } from "../lib/logger.js";
import { isPausedAsync } from "../server/killswitch.js";
import type {
  WebhookDeliveryRow,
  DeliveryWorkerRepository,
  WebhookDeliveryStatus,
} from "./db/WebhookDeliveryRepository.js";

const log = rootLogger.child("webhook-delivery");
const CLAIM_LEASE_MARGIN_MS = 60_000;

// ── Retry schedule ────────────────────────────────────────────────────────────

/**
 * Delay buckets in milliseconds, indexed by `attemptsDone` (number of attempts
 * already made, 0-based). `retryDelayMs(attemptsDone)` maps to this array.
 *
 * After the FIRST failure `attemptsDone=1` → 60s (index 1 is used; index 0 is
 * unreachable because `attemptsDone` is always ≥1 when scheduling a retry).
 * After the LAST entry, `retryDelayMs` returns null → delivery moves to DLQ.
 *
 * Effective schedule: 60s, 5m, 30m, 2h, 6h, 12h, 24h, 24h, 24h (10 retries)
 * Total retry window: ~0 + 1m + 5m + 30m + 2h + 6h + 12h + 24h + 24h ≈ 69h
 *
 * Note: index 0 (0ms) is reserved for future "immediate first retry" use; it
 * is currently unreachable because attemptsDone starts at 1 after first failure.
 */
export const RETRY_DELAYS_MS = [
  0,
  60_000,         // 1 min  (first retry after attempt 1)
  300_000,        // 5 min
  1_800_000,      // 30 min
  7_200_000,      // 2 h
  21_600_000,     // 6 h
  43_200_000,     // 12 h
  86_400_000,     // 24 h
  86_400_000,     // 24 h
  86_400_000,     // 24 h
];

/** Total attempts before DLQ: 10 retries (indices 1–9) + 1 initial = 10 actual sends. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length; // 10 sends before DLQ

/**
 * Compute the next attempt time with ±10% jitter.
 * @param baseDelayMs  Base delay from RETRY_DELAYS_MS.
 * @param now          Reference time for scheduling.
 */
export function nextAttemptTime(baseDelayMs: number, now: Date): Date {
  if (baseDelayMs === 0) {
    return new Date(now.getTime());
  }
  const jitter = (Math.random() * 0.2 - 0.1) * baseDelayMs; // ±10%
  return new Date(now.getTime() + baseDelayMs + jitter);
}

/** Return the next retry delay in ms for a given attempt count (0-indexed). */
export function retryDelayMs(attemptsDone: number): number | null {
  const delay = RETRY_DELAYS_MS[attemptsDone];
  return delay !== undefined ? delay : null;
}

// ── HTTP send ─────────────────────────────────────────────────────────────────

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface SendOptions {
  timeoutMs?: number;
  resolve?: DnsResolver;
  /** Injected fetch for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/**
 * POST the signed payload to the endpoint.
 *
 * Used directly in tests to exercise the SSRF guard logic. Production code
 * uses sendWithEventUid (below) which adds the X-Stablerails-EventUid header.
 *
 * 1. SSRF-guard the URL via guardedFetch (redirect:"manual", per-hop re-validation,
 *    DNS-pinning to prevent rebinding).
 * 2. Sign the raw body with HMAC-SHA256.
 * 3. POST with a timeout.
 * 4. 2xx → ok, otherwise → error.
 */
export async function sendWebhook(
  url: string,
  secret: string,
  rawBody: string,
  opts: SendOptions = {},
): Promise<SendResult> {
  const {
    timeoutMs = 10_000,
    resolve,
    fetchFn,
  } = opts;

  const ts = Math.floor(Date.now() / 1000);
  const sigHeader = sign(rawBody, secret, ts);

  try {
    const response = await guardedFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stablerails-Signature": sigHeader,
        },
        body: rawBody,
      },
      { timeoutMs, resolve, fetchFn },
    );

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    return {
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
    };
  } catch (err) {
    return { ok: false, error: `SSRF guard: ${(err as Error).message}` };
  }
}

/**
 * POST with the full eventUid header. This is the internal send used by drainPending.
 *
 * Routes through guardedFetch: redirect:"manual" + per-hop SSRF re-validation
 * + DNS pinning via undici (buildPinnedFetch resolves once, then TCP connections
 * are pinned to the pre-validated IP via undici Agent — prevents DNS-rebinding).
 */
export async function sendWithEventUid(
  url: string,
  secret: string,
  rawBody: string,
  eventUid: string,
  opts: SendOptions = {},
): Promise<SendResult> {
  const {
    timeoutMs = 10_000,
    resolve,
    fetchFn,
  } = opts;

  const ts = Math.floor(Date.now() / 1000);
  const sigHeader = sign(rawBody, secret, ts);

  try {
    const response = await guardedFetch(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Stablerails-Signature": sigHeader,
          "X-Stablerails-EventUid": eventUid,
        },
        body: rawBody,
      },
      { timeoutMs, resolve, fetchFn },
    );

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, status: response.status };
    }
    return { ok: false, status: response.status, error: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: `SSRF guard: ${(err as Error).message}` };
  }
}

// ── Worker ────────────────────────────────────────────────────────────────────

export interface DrainOptions {
  batchSize?: number;
  timeoutMs?: number;
  resolve?: DnsResolver;
  fetchFn?: typeof fetch;
  /** Injected clock. Defaults to Date.now(). */
  now?: () => Date;
}

export interface DrainResult {
  processed: number;
  delivered: number;
  failed: number;
  dead: number;
}

function isStaleClaimError(err: unknown): boolean {
  return err instanceof Error && /stale claim token/i.test(err.message);
}

/**
 * Drain pending WebhookDelivery rows.
 *
 * For each due row:
 * 1. Load the endpoint (skip if endpoint missing or inactive).
 * 2. Serialize the payload (include version + eventUid).
 * 3. Send via SSRF-guarded POST with HMAC signature.
 * 4. On 2xx: markDelivered.
 * 5. On error: compute next retry delay; if exhausted → markDead (DLQ).
 */
export async function drainPending(
  repo: DeliveryWorkerRepository,
  opts: DrainOptions = {},
): Promise<DrainResult> {
  // Kill-switch: skip drain when webhooks are paused.
  // isPausedAsync consults the DB-backed shared store (TTL cached) so the
  // webhook worker process responds to admin toggle without a restart.
  if (await isPausedAsync("webhooks")) {
    log.debug("webhook delivery paused — skipping drain");
    return { processed: 0, delivered: 0, failed: 0, dead: 0 };
  }

  const {
    batchSize = 50,
    timeoutMs = 10_000,
    resolve,
    fetchFn,
    now = () => new Date(),
  } = opts;

  const result: DrainResult = { processed: 0, delivered: 0, failed: 0, dead: 0 };

  const claimLeaseMs = Math.max(60_000, batchSize * timeoutMs + CLAIM_LEASE_MARGIN_MS);
  const rows = await repo.claimPending({ batchSize, now: now(), leaseMs: claimLeaseMs });

  for (const row of rows) {
    result.processed++;
    try {
      await processRow(row, repo, { timeoutMs, resolve, fetchFn, now });
    } catch (err) {
      if (isStaleClaimError(err)) {
        log.warn("Webhook claim was superseded before mark; skipping stale row", {
          deliveryId: row.id,
          eventUid: row.eventUid,
        });
        continue;
      }
      throw err;
    }

    // Re-read the row to tally final status
    const updated = await repo.findByEventUid(row.eventUid);
    if (!updated) continue;
    if (updated.status === "delivered") result.delivered++;
    else if (updated.status === "dead") result.dead++;
    else result.failed++;
  }

  return result;
}

async function processRow(
  row: WebhookDeliveryRow,
  repo: DeliveryWorkerRepository,
  opts: Pick<DrainOptions, "timeoutMs" | "resolve" | "fetchFn" | "now">,
): Promise<void> {
  const currentNow = opts.now ? opts.now() : new Date();

  // Load endpoint
  const endpoint = row.endpoint ?? (await repo.getEndpointById(row.endpointId));
  if (!endpoint) {
    log.warn("Endpoint not found, marking dead", { deliveryId: row.id, endpointId: row.endpointId });
    await repo.markDead(row.id, "Endpoint not found", row.claimToken);
    return;
  }
  if (!endpoint.active) {
    log.warn("Endpoint inactive, marking dead", { deliveryId: row.id, endpointId: row.endpointId });
    await repo.markDead(row.id, "Endpoint is inactive", row.claimToken);
    return;
  }

  // Build raw body — include version + eventUid for idempotency
  const bodyObj = {
    eventUid: row.eventUid,
    eventType: row.eventType,
    version: row.version,
    ...(typeof row.payload === "object" && row.payload !== null ? row.payload : { payload: row.payload }),
  };
  const rawBody = JSON.stringify(bodyObj);

  log.info("Dispatching webhook", {
    deliveryId: row.id,
    eventUid: row.eventUid,
    attempt: row.attempts + 1,
    url: endpoint.url,
  });

  // Decrypt the endpoint secret at the point of use (at-rest envelope
  // encryption, src/lib/secretBox.ts). Plaintext legacy rows pass through
  // unchanged. Fail closed: a decrypt failure (wrong key / tampered
  // ciphertext) routes into the normal failure path — we never sign with the
  // raw stored value.
  let sendResult: SendResult;
  try {
    const endpointSecret = openSecret(endpoint.secret);
    sendResult = await sendWithEventUid(
      endpoint.url,
      endpointSecret,
      rawBody,
      row.eventUid,
      { timeoutMs: opts.timeoutMs, resolve: opts.resolve, fetchFn: opts.fetchFn },
    );
  } catch (err) {
    if (!(err instanceof SecretBoxError)) throw err;
    log.error("Webhook secret decryption failed — failing closed", {
      deliveryId: row.id,
      endpointId: row.endpointId,
    });
    sendResult = { ok: false, error: `secret decryption failed: ${err.message}` };
  }

  if (sendResult.ok) {
    await repo.markDelivered({ id: row.id, deliveredAt: currentNow, claimToken: row.claimToken });
    log.info("Webhook delivered", { deliveryId: row.id, eventUid: row.eventUid });
    return;
  }

  // Failure path
  const attemptsDone = row.attempts + 1; // after this attempt
  const nextDelay = retryDelayMs(attemptsDone);

  if (nextDelay === null) {
    // Exhausted retries → DLQ
    await repo.markDead(row.id, sendResult.error ?? "Unknown error after retry exhaustion", row.claimToken);
    log.error("Webhook moved to DLQ", {
      deliveryId: row.id,
      eventUid: row.eventUid,
      attempts: attemptsDone,
      error: sendResult.error,
    });
    return;
  }

  const nextAttempt = nextAttemptTime(nextDelay, currentNow);
  await repo.markFailed({
    id: row.id,
    lastError: sendResult.error ?? "Unknown error",
    nextAttemptAt: nextAttempt,
    claimToken: row.claimToken,
  });

  log.warn("Webhook delivery failed, scheduled retry", {
    deliveryId: row.id,
    eventUid: row.eventUid,
    attempts: attemptsDone,
    nextAttemptAt: nextAttempt.toISOString(),
    error: sendResult.error,
  });
}

// ── Manual replay ─────────────────────────────────────────────────────────────

export interface ReplayResult {
  ok: boolean;
  error?: string;
  delivery?: WebhookDeliveryRow;
}

/**
 * Manually replay a dead or failed delivery.
 *
 * Resets the delivery to `pending` with `nextAttemptAt = now` so the next
 * drainPending run will pick it up.
 */
export async function replayDelivery(
  repo: DeliveryWorkerRepository,
  eventUid: string,
  now: Date = new Date(),
): Promise<ReplayResult> {
  const row = await repo.findByEventUid(eventUid);
  if (!row) {
    return { ok: false, error: `Delivery not found: ${eventUid}` };
  }

  if (row.status === "delivered") {
    return { ok: false, error: "Cannot replay an already-delivered webhook" };
  }

  const updated = await repo.recordAttempt({
    id: row.id,
    nextAttemptAt: now,
    lastError: null,
    status: "pending" as WebhookDeliveryStatus,
  });

  log.info("Webhook replay queued", {
    deliveryId: row.id,
    eventUid: row.eventUid,
    previousStatus: row.status,
  });

  return { ok: true, delivery: updated };
}

// Note: assignVersion / incrementVersion were dead helpers (no prod callers) and
// have been intentionally removed. Version assignment is owned exclusively by
// the watcher's in-tx maxVersionForInvoice(invoiceId, tx)+1 path.
