/**
 * Sliding-window rate limiter (spec §4 — §5 rate limits).
 *
 * Pure in-memory implementation (Map + timestamps). One instance per process.
 * Buckets are keyed by (bucketName, entityId) — e.g. ("invoice_create", apiKeyPrefix).
 *
 * Bucket definitions:
 *   public_status   — 60 req/min per INVOICE ID (payer privacy: payer-facing
 *                     routes never key on client IP; see publicStatus.ts)
 *   invoice_create  — 120 req/min per API key
 *   admin           — 300 req/min per API key
 */

export interface RateLimitBucket {
  /** Maximum requests allowed within the window. */
  maxRequests: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

export const RATE_LIMIT_BUCKETS: Record<string, RateLimitBucket> = {
  public_status: { maxRequests: 60, windowMs: 60_000 },
  invoice_create: { maxRequests: 120, windowMs: 60_000 },
  admin: { maxRequests: 300, windowMs: 60_000 },
  /** Merchant invoice reads — keyed by API key prefix, separate from admin. */
  merchant_read: { maxRequests: 300, windowMs: 60_000 },
  /**
   * Login attempts — keyed by TCP socket IP (NOT X-Forwarded-For).
   * Strict limit: 10 attempts per 10 minutes per IP.
   * This gate fires BEFORE findByEmail/argon2.verify so the expensive Argon2
   * hash never runs for rate-limited requests (AUTH-1).
   *
   * // TODO(SF): add account-level lockout (track failed attempts per email in
   * // the OperatorRepository, lock after N consecutive failures for a fixed
   * // duration). This requires new storage; the per-IP limit covers the
   * // brute-force case. Per-account lockout prevents targeted credential stuffing.
   */
  login: { maxRequests: 10, windowMs: 600_000 },
  /**
   * Operator dashboard page and CSV export — keyed by TCP socket IP.
   * Rate-limit check runs BEFORE the session gate (same pattern as login),
   * so the bucket fires even for unauthenticated requests (which are then
   * redirected by the session gate).
   */
  dashboard: { maxRequests: 120, windowMs: 60_000 },
};

/** Injectable clock for testing. */
export interface RateLimitClock {
  now(): number;
}

export const SystemRateLimitClock: RateLimitClock = {
  now: () => Date.now(),
};

export class RateLimiter {
  /** Map<bucketKey, timestamps[]> — rolling window per entity. */
  private readonly windows = new Map<string, number[]>();
  /** Smallest bucket window — used as the global sweep cadence. */
  private readonly sweepIntervalMs: number;
  /** Timestamp of the last full sweep of abandoned keys. */
  private lastSweepAt = 0;

  constructor(
    private readonly buckets: Record<string, RateLimitBucket> = RATE_LIMIT_BUCKETS,
    private readonly clock: RateLimitClock = SystemRateLimitClock,
  ) {
    const windows = Object.values(this.buckets).map((b) => b.windowMs);
    this.sweepIntervalMs = windows.length ? Math.min(...windows) : 60_000;
  }

  /**
   * Evict fully-expired windows that are never revisited. Without this, a key
   * keyed on attacker-controlled input (e.g. an unguessable-but-arbitrary
   * invoice id in the URL) leaks one Map entry per distinct value forever —
   * an unbounded-memory DoS. Runs at most once per smallest window.
   */
  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.sweepIntervalMs) return;
    this.lastSweepAt = now;
    for (const [key, ts] of this.windows) {
      const sep = key.indexOf(":");
      const bucket = sep >= 0 ? this.buckets[key.slice(0, sep)] : undefined;
      const windowMs = bucket ? bucket.windowMs : this.sweepIntervalMs;
      // ts is append-only ascending → last element is the newest hit.
      if (ts.length === 0 || ts[ts.length - 1]! <= now - windowMs) {
        this.windows.delete(key);
      }
    }
  }

  /**
   * Check and consume one request token.
   * @returns true if allowed, false if rate-limited.
   */
  check(bucketName: string, entityId: string): boolean {
    const bucket = this.buckets[bucketName];
    if (!bucket) {
      // Unknown bucket — fail CLOSED (refuse the request rather than silently
      // allowing it; callers must declare all buckets they use).
      throw new Error(`RateLimiter: unknown bucket "${bucketName}"`);
    }

    const key = `${bucketName}:${entityId}`;
    const now = this.clock.now();
    this.maybeSweep(now);
    const windowStart = now - bucket.windowMs;

    // Evict expired timestamps (sliding window). Never store an empty array —
    // a fully-expired key is dropped so the Map cannot grow unbounded.
    const existing = this.windows.get(key);
    const fresh = existing ? existing.filter((t) => t > windowStart) : [];

    if (fresh.length >= bucket.maxRequests) {
      this.windows.set(key, fresh); // non-empty (>= maxRequests >= 1)
      return false;
    }

    fresh.push(now);
    this.windows.set(key, fresh); // non-empty (just pushed)
    return true;
  }

  /** Reset a specific key (useful in tests). */
  reset(bucketName: string, entityId: string): void {
    this.windows.delete(`${bucketName}:${entityId}`);
  }

  /** Reset all windows. */
  resetAll(): void {
    this.windows.clear();
  }

  /** Number of tracked windows. Exposed for tests/monitoring of memory bounds. */
  size(): number {
    return this.windows.size;
  }
}

/** Singleton instance used by the server (tests inject their own). */
export const rateLimiter = new RateLimiter();
