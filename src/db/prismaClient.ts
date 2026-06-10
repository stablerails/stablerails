/**
 * Shared Prisma client factory — lazy singleton used by both the server and the
 * worker entrypoints.
 *
 * Import order: this file is intentionally NOT imported from src/core, src/chain,
 * or src/signer. Only adapters in src/db, src/server, and src/workers may use it.
 */

import { PrismaClient } from "@prisma/client";

let _prisma: PrismaClient | undefined;

/**
 * Return the singleton Prisma client.
 *
 * @throws Error if DATABASE_URL is not set.
 */
export function getPrismaClient(): PrismaClient {
  if (_prisma) return _prisma;

  if (!process.env["DATABASE_URL"]) {
    throw new Error(
      "DATABASE_URL is not set — cannot create Prisma client. " +
        "Inject an in-memory mock repo in tests instead.",
    );
  }

  _prisma = new PrismaClient({
    log: process.env["NODE_ENV"] === "production" ? ["error"] : [],
  });

  return _prisma;
}

/** Reset singleton — for test cleanup only. */
export function _resetPrismaClient(): void {
  _prisma = undefined;
}
