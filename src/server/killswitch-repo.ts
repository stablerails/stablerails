/**
 * KillSwitch repository port + in-memory implementation.
 *
 * The port abstracts DB access so tests can use the in-memory impl
 * without a real database connection.
 *
 * Prisma implementation lives in src/db/KillSwitchRepositoryPrisma.ts
 * and is wired in src/server/index.ts (production bootstrap).
 */

import type { KillswitchArea } from "./killswitch.js";

// ── Port ──────────────────────────────────────────────────────────────────────

export interface KillSwitchRepository {
  /**
   * Read the paused flag for one area.
   * Returns false if the area row does not exist yet.
   */
  getFlag(area: KillswitchArea): Promise<boolean>;

  /**
   * Upsert the paused flag for one area.
   * Creates the row if it does not exist.
   */
  setFlag(area: KillswitchArea, paused: boolean): Promise<void>;

  /**
   * Read all area flags.
   * Areas with no DB row are treated as not-paused.
   */
  getAllFlags(): Promise<Record<KillswitchArea, boolean>>;
}

// ── In-memory implementation (for tests) ─────────────────────────────────────

export class InMemoryKillSwitchRepository implements KillSwitchRepository {
  private readonly store = new Map<KillswitchArea, boolean>();

  async getFlag(area: KillswitchArea): Promise<boolean> {
    return this.store.get(area) ?? false;
  }

  async setFlag(area: KillswitchArea, paused: boolean): Promise<void> {
    this.store.set(area, paused);
  }

  async getAllFlags(): Promise<Record<KillswitchArea, boolean>> {
    return {
      invoices: this.store.get("invoices") ?? false,
      watcher:  this.store.get("watcher")  ?? false,
      webhooks: this.store.get("webhooks") ?? false,
    };
  }

  /** Test helper: reset all flags. */
  reset(): void {
    this.store.clear();
  }
}
