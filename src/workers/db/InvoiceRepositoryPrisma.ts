/**
 * Worker InvoiceRepository shim — re-exports from the unified shared impl.
 *
 * The canonical implementation now lives in src/db/InvoiceRepositoryPrisma.ts.
 * This file exists only to avoid changing imports in src/workers/index.ts.
 */

export { PrismaInvoiceRepository as InvoiceRepositoryPrisma } from "../../db/InvoiceRepositoryPrisma.js";
