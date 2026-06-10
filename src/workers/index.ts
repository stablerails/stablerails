/**
 * Production worker entrypoint.
 *
 * Constructs real Prisma adapters + TronHttpClient instances and starts BOTH:
 *   1. TronWatcher poll loop — credits on-chain payments
 *   2. Webhook delivery loop — drains pending WebhookDelivery rows and POSTs
 *      the signed payload to each registered endpoint
 *
 * Environment variables:
 *   DATABASE_URL                — PostgreSQL connection string (required)
 *   TRON_RPC_PRIMARY_URL        — Primary TronGrid full-node URL (required)
 *   TRON_RPC_PRIMARY_API_KEY    — Primary TronGrid API key (optional)
 *   TRON_RPC_SECONDARY_URL      — Secondary TronGrid full-node URL (required)
 *   TRON_RPC_SECONDARY_API_KEY  — Secondary TronGrid API key (optional)
 *   WATCHER_POLL_INTERVAL_MS    — Poll interval in ms (default: 5000)
 *   WEBHOOK_POLL_INTERVAL_MS    — Webhook delivery drain interval in ms (default: 5000)
 *
 * Two-RPC independence: primary and secondary clients are constructed with
 * pinned, dedicated endpoints.  There is NO silent failover between them for
 * the agreement path — an error from either node = skip this tick.
 *
 * Receipt-based agreement: credit decisions come EXCLUSIVELY from BOTH providers
 * independently parsing on-chain tx receipt event logs via gettransactioninfobyid.
 * /v1 (TronGrid) is DISCOVERY ONLY (primary). No single-provider relaxations exist.
 */

import { rootLogger } from "../lib/logger.js";
import { TronHttpClient } from "../lib/http.js";
import { validatePositiveInt } from "../lib/envValidation.js";
import { TronWatcher } from "./watcher.js";
import { drainPending } from "./webhookDelivery.js";
import { InvoiceRepositoryPrisma } from "./db/InvoiceRepositoryPrisma.js";
import { PaymentRepositoryPrisma } from "./db/PaymentRepositoryPrisma.js";
import { ChainCursorRepositoryPrisma } from "./db/ChainCursorRepository.js";
import { PrismaWebhookDeliveryRepository } from "./db/WebhookDeliveryRepository.js";
import { PrismaTransactionRunner } from "./db/PrismaTransactionRunner.js";
import { getPrismaClient } from "./db/prismaClient.js";
import { KillSwitchRepositoryPrisma } from "../db/KillSwitchRepositoryPrisma.js";
import { initKillSwitchRepo } from "../server/killswitch.js";

const log = rootLogger.child("worker");

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

async function main(): Promise<void> {
  log.info("starting Stablerails watcher worker");

  // Hard startup failure if the removed single-provider testnet flag is still set.
  // This env var was part of the old testnetRelaxation.ts design which has been
  // deleted. Continuing with it set would silently ignore the flag — instead we
  // fail loudly so the operator removes it from the deployment config.
  if (process.env["WATCHER_TESTNET_SINGLE_TRANSFER_PROVIDER"]) {
    throw new Error(
      "WATCHER_TESTNET_SINGLE_TRANSFER_PROVIDER is no longer supported. " +
        "The receipt-based dual-provider agreement design replaced testnet relaxation. " +
        "Remove this environment variable from your deployment configuration.",
    );
  }

  // Validate required env vars early
  requireEnv("DATABASE_URL");
  const primaryUrl = requireEnv("TRON_RPC_PRIMARY_URL");
  const secondaryUrl = requireEnv("TRON_RPC_SECONDARY_URL");

  if (primaryUrl === secondaryUrl) {
    throw new Error(
      "TRON_RPC_PRIMARY_URL and TRON_RPC_SECONDARY_URL must be DIFFERENT endpoints. " +
        "Using the same node for both providers defeats two-RPC agreement (self-agreement vector).",
    );
  }

  // 1_000ms minimum poll interval: avoids tight-loops on misconfiguration.
  const MIN_POLL_MS = 1_000;
  const pollIntervalMs = process.env["WATCHER_POLL_INTERVAL_MS"]
    ? validatePositiveInt(process.env["WATCHER_POLL_INTERVAL_MS"], "WATCHER_POLL_INTERVAL_MS", MIN_POLL_MS)
    : 5_000;

  const webhookPollIntervalMs = process.env["WEBHOOK_POLL_INTERVAL_MS"]
    ? validatePositiveInt(process.env["WEBHOOK_POLL_INTERVAL_MS"], "WEBHOOK_POLL_INTERVAL_MS", MIN_POLL_MS)
    : 5_000;

  // Construct two INDEPENDENT TronHttpClient instances.
  // Each is pinned to its own endpoint; no failover between them.
  // The secondary field in each config is set to a dummy URL that is never used
  // (TronHttpClient's internal failover is only triggered by the request() method
  // on errors — the watcher bypasses this by using fetchTransfersForAddress which
  // calls client.get() directly; errors from get() are caught at the invoice level
  // in processInvoice and skip the invoice for that tick, not falling over).
  const primaryClient = new TronHttpClient({
    primary: {
      url: primaryUrl,
      apiKey: process.env["TRON_RPC_PRIMARY_API_KEY"],
    },
    secondary: {
      // Pinned: the watcher never uses internal failover for the agreement path.
      // We still need to provide a secondary because TronHttpClient requires it.
      // Set it to the same primary URL so that IF TronHttpClient's internal retry
      // path ever fires (e.g. a non-agreement read like solidBlock), it goes to
      // the same node rather than accidentally using the secondary agreement node.
      url: primaryUrl,
      apiKey: process.env["TRON_RPC_PRIMARY_API_KEY"],
    },
    timeoutMs: 10_000,
    maxRetries: 0, // no retries — errors surface immediately for agreement logic
  });

  const secondaryClient = new TronHttpClient({
    primary: {
      url: secondaryUrl,
      apiKey: process.env["TRON_RPC_SECONDARY_API_KEY"],
    },
    secondary: {
      url: secondaryUrl,
      apiKey: process.env["TRON_RPC_SECONDARY_API_KEY"],
    },
    timeoutMs: 10_000,
    maxRetries: 0,
  });

  const db = getPrismaClient();

  // Wire DB-backed kill-switch repo so isPausedAsync in this process consults
  // the shared DB store. Without this, admin toggle via HTTP would never halt
  // watcher crediting or webhook delivery in this separate process.
  initKillSwitchRepo(new KillSwitchRepositoryPrisma(db));
  log.info("kill-switch repo wired", { type: "KillSwitchRepositoryPrisma" });

  // One unified repo instance shared by both the watcher and the delivery loop.
  const webhookRepo = new PrismaWebhookDeliveryRepository(db);

  const watcher = new TronWatcher(
    {
      network: "TRON",
      pollIntervalMs,
    },
    {
      invoiceRepo: new InvoiceRepositoryPrisma(db),
      paymentRepo: new PaymentRepositoryPrisma(db),
      chainCursorRepo: new ChainCursorRepositoryPrisma(db),
      webhookRepo,
      endpointRepo: webhookRepo,
      txRunner: new PrismaTransactionRunner(db),
      primaryClient,
      secondaryClient,
    },
  );

  let webhookLoopRunning = true;

  // Graceful shutdown
  const shutdown = (): void => {
    log.info("shutdown signal received — stopping watcher and delivery loop");
    watcher.stop();
    webhookLoopRunning = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start the webhook delivery drain loop independently of the watcher loop.
  // Both loops run concurrently; the delivery loop processes pending rows on
  // each tick even if a watcher tick is still running.
  const webhookLoop = async (): Promise<void> => {
    log.info("webhook delivery loop started", { webhookPollIntervalMs });
    while (webhookLoopRunning) {
      try {
        const result = await drainPending(webhookRepo);
        if (result.processed > 0) {
          log.info("webhook drain tick", { ...result });
        }
      } catch (err) {
        log.error("webhook drain error", { error: String(err) });
      }
      if (webhookLoopRunning) {
        await new Promise<void>((resolve) => setTimeout(resolve, webhookPollIntervalMs));
      }
    }
    log.info("webhook delivery loop stopped");
  };

  // Run both loops concurrently; wait for the watcher (primary) to exit.
  const webhookLoopPromise = webhookLoop();
  await watcher.start();
  log.info("watcher exited cleanly");

  // Stop delivery loop if watcher returned (e.g. stop() was called).
  webhookLoopRunning = false;
  await webhookLoopPromise;
}

main().catch((err: unknown) => {
  rootLogger.child("worker").error("worker crashed", { error: String(err) });
  process.exit(1);
});
