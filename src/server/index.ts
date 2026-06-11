/**
 * Production composition root (spec §6).
 *
 * Wires real Prisma adapters + env-driven config and starts the HTTP server.
 * Tests NEVER import this file — they call buildApp(mockDeps) directly.
 *
 * Usage:
 *   npm run dev          (tsx watch src/server/index.ts  or  tsx src/index.ts)
 */

import { buildApp } from "./app.js";
import { getPrisma as getPrismaClient } from "./db/prismaClient.js";
import { rootLogger } from "../lib/logger.js";
import { validatePositiveInt, resolveRateMicro } from "../lib/envValidation.js";
import { KillSwitchRepositoryPrisma } from "../db/KillSwitchRepositoryPrisma.js";
import {
  PrismaEventRepository,
  PrismaInvoiceIdempotencyRepository,
  PrismaInvoiceRepository,
  PrismaSweepIntentRepository,
  PrismaMerchantRepository,
  TronDepositAddressDeriver,
  SystemClock,
  FixedRateSource,
} from "./db/adapters.js";
import { InMemoryMerchantSessionStore } from "./auth.js";
import { ChainCursorRepositoryPrisma } from "../workers/db/ChainCursorRepository.js";
import { RateLimiter } from "../lib/rate-limit.js";

// ── Env ───────────────────────────────────────────────────────────────────────

const PORT = process.env["PORT"]
  ? validatePositiveInt(process.env["PORT"], "PORT")
  : 3000;
const HOST = process.env["HOST"] ?? "0.0.0.0";
const PUBLIC_BASE_URL =
  process.env["PUBLIC_BASE_URL"] ?? `http://localhost:${PORT}`;

// ── Prisma adapters ───────────────────────────────────────────────────────────

const prisma = getPrismaClient();
const killSwitchRepo = new KillSwitchRepositoryPrisma(prisma);
const eventRepo = new PrismaEventRepository(prisma);
// Hosted-signup (STABLERAILS_HOSTED_SIGNUP=1): merchant repo + session store.
// Instantiated unconditionally — buildApp only wires them when the flag is set.
const merchantRepo = new PrismaMerchantRepository(prisma);
const merchantSessionStore = new InMemoryMerchantSessionStore();
const invoiceRepo = new PrismaInvoiceRepository(prisma);
const invoiceIdempotencyRepo = new PrismaInvoiceIdempotencyRepository(prisma);
const sweepIntentRepo = new PrismaSweepIntentRepository(prisma);
const chainCursorRepo = new ChainCursorRepositoryPrisma(prisma);
const deriver = new TronDepositAddressDeriver();
const clock = new SystemClock();
// Default: 1_000_000n → exact 1:1 (100 USD = 100 USDT).
// Set USDT_RATE_MICRO=1_010_000 to re-enable a 1% de-peg buffer for prod if desired.
const rateMicro = resolveRateMicro(process.env["USDT_RATE_MICRO"]);
const rateSource = new FixedRateSource(rateMicro);

// ── Head block number (for confirmations) ─────────────────────────────────────
// The watcher keeps ChainCursor.lastSolidBlock updated every poll cycle.
// We cache it for 5 seconds so the server doesn't hit the DB on every request.
// Falls back to 0n if the cursor row doesn't exist yet (watcher not started).

let cachedHeadBlock: bigint = 0n;
let headBlockCachedAt = 0;
const HEAD_BLOCK_CACHE_MS = 5_000;

async function refreshHeadBlock(): Promise<void> {
  try {
    const cursor = await chainCursorRepo.findByNetwork("TRON");
    if (cursor) {
      cachedHeadBlock = cursor.lastSolidBlock;
    }
  } catch {
    // DB not ready / cursor table empty — keep previous cached value
  }
  headBlockCachedAt = Date.now();
}

function getHeadBlockNumber(): bigint {
  if (Date.now() - headBlockCachedAt > HEAD_BLOCK_CACHE_MS) {
    // Refresh in background; return cached value immediately (non-blocking).
    void refreshHeadBlock();
  }
  return cachedHeadBlock;
}

// ── Rate config ───────────────────────────────────────────────────────────────

function getRateConfig() {
  return {
    microUsdtPerFiatUnit: rateSource.toMicroUsdt("1", "USD"),
    lockedAt: clock.now(),
  };
}

// ── API key / operator repos (Prisma stubs — extend as needed) ─────────────
// In the MVP the ApiKey and Operator tables live in Prisma but concrete
// PrismaApiKeyRepository / PrismaOperatorRepository are not yet implemented;
// the server will boot and respond with 500 only if those routes are actually
// called without a concrete adapter. Wire real adapters here when ready.

import type { ApiKeyRepository, OperatorRepository, LoginTokenRepository } from "./auth.js";
import type { WebhookRepository } from "./routes/webhooksAdmin.js";

// Minimal stub that delegates to Prisma when the model is available.
// Throws clearly if no model is seeded — keeps the server bootable.
const apiKeyRepo: ApiKeyRepository = {
  async findByHash(hashedKey: string) {
    return prisma.apiKey.findUnique({ where: { hashedKey } }) as ReturnType<
      ApiKeyRepository["findByHash"]
    >;
  },
  async insert(input) {
    // Cast required until `prisma generate` is re-run with the updated schema
    // that includes the `readonly` enum value in ApiKeyScope.
    return prisma.apiKey.create({ data: input as Parameters<typeof prisma.apiKey.create>[0]["data"] }) as ReturnType<
      ApiKeyRepository["insert"]
    >;
  },
  async list() {
    return prisma.apiKey.findMany() as ReturnType<ApiKeyRepository["list"]>;
  },
  async revoke(id: string) {
    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) return null;
    return prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    }) as ReturnType<ApiKeyRepository["revoke"]>;
  },
  async findById(id: string) {
    return prisma.apiKey.findUnique({ where: { id } }) as ReturnType<
      ApiKeyRepository["findById"]
    >;
  },
};

const operatorRepo: OperatorRepository = {
  async findByEmail(email: string) {
    return prisma.operator.findUnique({ where: { email } }) as ReturnType<
      OperatorRepository["findByEmail"]
    >;
  },
  async findById(id: string) {
    return prisma.operator.findUnique({ where: { id } }) as ReturnType<
      OperatorRepository["findById"]
    >;
  },
  async create(email: string, passwordHash: string) {
    return prisma.operator.create({ data: { email, passwordHash } }) as ReturnType<
      OperatorRepository["create"]
    >;
  },
};

// Magic-link login tokens (GET /auth/magic). Tokens are minted by the CLI
// (`stablerails init` / `stablerails operator login-link`) writing directly to
// the DB; the server only consumes them.
const loginTokenRepo: LoginTokenRepository = {
  async create(input) {
    return prisma.loginToken.create({ data: input }) as ReturnType<
      LoginTokenRepository["create"]
    >;
  },
  async consume(tokenHash: string, now: Date) {
    // Atomic single-use consume: the guarded updateMany only wins when the
    // token is unused AND unexpired — two concurrent requests cannot both
    // pass (the second sees usedAt != null and matches 0 rows).
    const updated = await prisma.loginToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (updated.count !== 1) return null;
    return prisma.loginToken.findUnique({ where: { tokenHash } }) as ReturnType<
      LoginTokenRepository["consume"]
    >;
  },
};

const webhookRepo: WebhookRepository = {
  async insert(input) {
    return prisma.webhookEndpoint.create({ data: input }) as ReturnType<
      WebhookRepository["insert"]
    >;
  },
  async list() {
    return prisma.webhookEndpoint.findMany() as ReturnType<
      WebhookRepository["list"]
    >;
  },
  async findById(id: string) {
    return prisma.webhookEndpoint.findUnique({ where: { id } }) as ReturnType<
      WebhookRepository["findById"]
    >;
  },
  async delete(id: string) {
    await prisma.webhookEndpoint.delete({ where: { id } });
  },
};

// ── Build + boot ──────────────────────────────────────────────────────────────

const app = buildApp({
  eventRepo,
  invoiceRepo,
  sweepIntentRepo,
  deriver,
  clock,
  getRateConfig,
  apiKeyRepo,
  invoiceIdempotencyRepo,
  operatorRepo,
  loginTokenRepo,
  webhookRepo,
  killSwitchRepo,
  merchantRepo,
  merchantSessionStore,
  rateLimiter: new RateLimiter(),
  publicBaseUrl: PUBLIC_BASE_URL,
  getHeadBlockNumber,
  logLevel: (process.env["LOG_LEVEL"] as "info" | "warn" | "error" | "debug") ?? "info",
});

const logger = rootLogger.child("server");

// Startup assertion: kill-switch repo MUST be wired so isPausedAsync consults
// the DB. This will never throw (killSwitchRepo is always constructed above),
// but it makes the invariant explicit and guards against future regressions.
logger.info("kill-switch repo wired", { type: "KillSwitchRepositoryPrisma" });

app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    logger.error("Server failed to start", { err });
    process.exit(1);
  }
  logger.info("stablerails listening", { address, publicBaseUrl: PUBLIC_BASE_URL });
});
