/**
 * Prisma-backed KillSwitchRepository.
 *
 * Used in production to provide a cross-process shared store for kill-switch
 * flags. The watcher and webhook workers run in a separate process from
 * Fastify — an in-memory flag can't reach them; DB is the shared truth.
 *
 * NOTE: The PrismaClient type below does not yet include `killSwitch` because
 * `prisma generate` hasn't been run against the updated schema (no local DB).
 * The CI `migrations` job runs `prisma migrate deploy` + `prisma generate`
 * which will add `killSwitch` to the generated client and remove the cast.
 */

import type { PrismaClient } from "@prisma/client";
import type { KillSwitchRepository } from "../server/killswitch-repo.js";
import type { KillswitchArea } from "../server/killswitch.js";

// Cast to access killSwitch before prisma generate runs.
// After `prisma generate` with the updated schema, killSwitch is typed.
type DB = { killSwitch: { findUnique: (a: unknown) => Promise<{ paused: boolean } | null>; upsert: (a: unknown) => Promise<unknown>; findMany: () => Promise<Array<{ area: string; paused: boolean }>> } };

export class KillSwitchRepositoryPrisma implements KillSwitchRepository {
  private readonly db: DB;

  constructor(prisma: PrismaClient) {
    this.db = prisma as unknown as DB;
  }

  async getFlag(area: KillswitchArea): Promise<boolean> {
    const row = await this.db.killSwitch.findUnique({ where: { area } });
    return row?.paused ?? false;
  }

  async setFlag(area: KillswitchArea, paused: boolean): Promise<void> {
    await this.db.killSwitch.upsert({
      where: { area },
      create: { area, paused },
      update: { paused },
    });
  }

  async getAllFlags(): Promise<Record<KillswitchArea, boolean>> {
    const rows = await this.db.killSwitch.findMany();
    const map = new Map(rows.map((r) => [r.area as KillswitchArea, r.paused]));
    return {
      invoices: map.get("invoices") ?? false,
      watcher:  map.get("watcher")  ?? false,
      webhooks: map.get("webhooks") ?? false,
    };
  }
}
