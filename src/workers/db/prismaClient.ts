/**
 * Worker-side Prisma client — re-exports from the shared singleton factory.
 *
 * All server and worker code should import from src/db/prismaClient instead.
 * This shim exists to avoid breaking imports in src/workers/index.ts and other
 * workers/db/* adapters that still reference this path.
 */

export { getPrismaClient, _resetPrismaClient } from "../../db/prismaClient.js";
