/**
 * Kill-switch: pause invoice creation, chain-watcher, and webhook delivery.
 *
 * Three control planes (OR-ed — any one being set pauses the area):
 *   1. Environment variables (static, read at boot):
 *        STABLERAILS_PAUSE_INVOICES=1  → pause invoice creation
 *        STABLERAILS_PAUSE_WATCHER=1   → pause chain-watcher poll loop
 *        STABLERAILS_PAUSE_WEBHOOKS=1  → pause webhook delivery drain
 *      NOTE: env flags are boot-time only; changing them requires a process
 *      restart. Use the admin route POST /v1/admin/killswitch for runtime control.
 *
 *   2. In-memory flags (process-local, settable at runtime via pauseArea/resumeArea):
 *        Useful for test helpers. Cleared on process restart.
 *        NOT visible to other processes (workers run in a separate process).
 *
 *   3. DB-backed shared store (cross-process runtime control):
 *        Accessible via POST /v1/admin/killswitch (authenticated admin route).
 *        The watcher and webhook workers poll via isPaused() which reads the
 *        shared store with a short TTL cache (~1-2s) to avoid DB hammering.
 *        This is the RECOMMENDED runtime control plane.
 *
 * Usage:
 *   // Wire the shared repo at startup (production):
 *   initKillSwitchRepo(new KillSwitchRepositoryPrisma(prisma));
 *
 *   // In tests use the in-memory repo:
 *   initKillSwitchRepo(new InMemoryKillSwitchRepository());
 *
 *   // Hot path (synchronous fast path for already-cached state):
 *   if (isPaused("invoices")) { ... }
 *
 *   // Async path (for callers that can await):
 *   if (await isPausedAsync("invoices")) { ... }
 *
 * Thread-safety note: the in-memory store is a plain Set, which is single-
 * threaded safe in Node.js (no concurrent writes). No lock needed.
 */

import type { KillSwitchRepository } from "./killswitch-repo.js";

// ── Area names ────────────────────────────────────────────────────────────────

export type KillswitchArea = "invoices" | "watcher" | "webhooks";

// ── Environment-variable map ──────────────────────────────────────────────────

const ENV_VAR_MAP: Record<KillswitchArea, string> = {
  invoices: "STABLERAILS_PAUSE_INVOICES",
  watcher:  "STABLERAILS_PAUSE_WATCHER",
  webhooks: "STABLERAILS_PAUSE_WEBHOOKS",
};

// ── In-memory flag store (process-local) ─────────────────────────────────────

const _paused = new Set<KillswitchArea>();

// ── DB-backed shared store ────────────────────────────────────────────────────

let _repo: KillSwitchRepository | null = null;

/** Cache entry: { value, expiresAt } */
interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

// Per-area TTL cache so the hot watcher loop doesn't hit the DB every tick.
const _cache = new Map<KillswitchArea, CacheEntry>();

/** Cache TTL in milliseconds (configurable; default 1500ms). */
let _cacheTtlMs = 1500;

/**
 * Wire the DB-backed shared repository. Call once at server/worker startup.
 * Idempotent — calling again replaces the repo and flushes the cache.
 */
export function initKillSwitchRepo(repo: KillSwitchRepository, cacheTtlMs = 1500): void {
  _repo = repo;
  _cacheTtlMs = cacheTtlMs;
  _cache.clear();
}

/** Flush the DB cache (useful in tests after setting a flag). */
export function flushKillSwitchCache(): void {
  _cache.clear();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return true if the area is paused.
 *
 * Fast synchronous check against env flags and in-memory flags.
 * If both are clear, falls back to the CACHED DB value (if a repo is wired).
 * The cache is updated by the last `await isPausedAsync()` call — the sync
 * version never hits the DB itself; it reads the last-known cached state.
 *
 * Callers on the hot path (watcher tick, invoice route) should prefer
 * `isPausedAsync()` to get a fresh DB read (subject to TTL).
 */
export function isPaused(area: KillswitchArea): boolean {
  // 1. Env flag (boot-time).
  if (_isEnvPaused(area)) return true;
  // 2. In-memory flag (process-local).
  if (_paused.has(area)) return true;
  // 3. Last-known cached DB state (populated by isPausedAsync).
  const cached = _cache.get(area);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }
  return false;
}

/**
 * Async version of isPaused that also consults the DB-backed shared store.
 * Cached with a ~1-2s TTL to avoid DB hammering in the watcher hot loop.
 *
 * Callers that can await (watcher tick, webhook drain) SHOULD use this
 * to get the cross-process runtime control.
 */
export async function isPausedAsync(area: KillswitchArea): Promise<boolean> {
  // Fast path: env or in-memory flags avoid a DB round-trip entirely.
  if (_isEnvPaused(area)) return true;
  if (_paused.has(area)) return true;

  // If no repo is wired, fall back to sync state only.
  if (!_repo) return false;

  // Check cache.
  const now = Date.now();
  const cached = _cache.get(area);
  if (cached && now < cached.expiresAt) {
    return cached.value;
  }

  // Cache miss or stale — query the DB and refresh.
  const dbValue = await _repo.getFlag(area);
  _cache.set(area, { value: dbValue, expiresAt: now + _cacheTtlMs });
  return dbValue;
}

/**
 * Dynamically pause an area at runtime (in-memory flag).
 * Idempotent. Not visible across processes — use the admin route for that.
 */
export function pauseArea(area: KillswitchArea): void {
  _paused.add(area);
}

/**
 * Dynamically resume an area at runtime (clears the in-memory flag).
 * Does NOT clear the environment variable (restart required).
 * Does NOT clear the DB flag — use the admin route for that.
 * Idempotent.
 */
export function resumeArea(area: KillswitchArea): void {
  _paused.delete(area);
}

/**
 * Reset all in-memory flags and flush the DB cache. Useful in tests.
 * Does NOT affect environment variables or DB state.
 */
export function resetAll(): void {
  _paused.clear();
  _cache.clear();
}

/**
 * Return a snapshot of which areas are currently paused (all planes combined).
 * Synchronous — uses cached DB state.
 */
export function pausedAreas(): KillswitchArea[] {
  const all: KillswitchArea[] = ["invoices", "watcher", "webhooks"];
  return all.filter(isPaused);
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _isEnvPaused(area: KillswitchArea): boolean {
  const envVal = process.env[ENV_VAR_MAP[area]];
  return (
    envVal !== undefined &&
    envVal !== "" &&
    envVal !== "0" &&
    envVal.toLowerCase() !== "false"
  );
}
