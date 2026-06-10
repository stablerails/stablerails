/**
 * ChainCursor DB adapter.
 *
 * Reads/writes the ChainCursor row for a given network.
 * The cursor tracks:
 *   - lastScannedBlock: the highest block we've scanned for transfers.
 *   - lastSolidBlock:   the latest irreversible block at poll time.
 *
 * Prisma adapter — gated behind DATABASE_URL.
 */

import type { PrismaClient } from "@prisma/client";
import type { Network } from "../../core/ports.js";
import { getPrismaClient } from "./prismaClient.js";

export interface ChainCursorRow {
  network: Network;
  lastScannedBlock: bigint;
  lastSolidBlock: bigint;
  updatedAt: Date;
}

export interface ChainCursorRepository {
  findByNetwork(network: Network): Promise<ChainCursorRow | null>;
  upsert(
    network: Network,
    lastScannedBlock: bigint,
    lastSolidBlock: bigint,
  ): Promise<ChainCursorRow>;
}

function toDomain(row: {
  network: string;
  lastScannedBlock: bigint;
  lastSolidBlock: bigint;
  updatedAt: Date;
}): ChainCursorRow {
  return {
    network: row.network as Network,
    lastScannedBlock: row.lastScannedBlock,
    lastSolidBlock: row.lastSolidBlock,
    updatedAt: row.updatedAt,
  };
}

export class ChainCursorRepositoryPrisma implements ChainCursorRepository {
  private readonly db: PrismaClient;

  constructor(db?: PrismaClient) {
    this.db = db ?? getPrismaClient();
  }

  async findByNetwork(network: Network): Promise<ChainCursorRow | null> {
    const row = await this.db.chainCursor.findUnique({
      where: { network },
    });
    return row ? toDomain(row) : null;
  }

  async upsert(
    network: Network,
    lastScannedBlock: bigint,
    lastSolidBlock: bigint,
  ): Promise<ChainCursorRow> {
    const row = await this.db.chainCursor.upsert({
      where: { network },
      update: {
        lastScannedBlock,
        lastSolidBlock,
      },
      create: {
        network,
        lastScannedBlock,
        lastSolidBlock,
      },
    });
    return toDomain(row);
  }
}
