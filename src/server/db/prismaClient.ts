/**
 * Server-side Prisma client — re-exports from the shared singleton factory.
 *
 * All server and worker code should import from src/db/prismaClient instead.
 * This shim exists to avoid breaking imports in src/server/index.ts.
 */

export { getPrismaClient as getPrisma, _resetPrismaClient } from "../../db/prismaClient.js";
export type { } from "../../db/prismaClient.js";
