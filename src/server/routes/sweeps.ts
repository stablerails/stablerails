/**
 * Sweep routes (spec §6.3 / §9 sweeps).
 *
 * SECURITY — WATCH-ONLY SERVER:
 *   This module builds UNSIGNED transactions via buildTransfer() from
 *   src/chain/tron/buildTransfer. It MUST NEVER import src/signer/**
 *   (ESLint rule "import/no-restricted-paths" enforces this hard boundary).
 *   Signing happens ONLY locally in src/signer, invoked by src/cli.
 *
 * Routes:
 *   POST /v1/sweeps/prepare            — Build unsigned txs for all paid deposit
 *                                        addresses of an event, persist SweepIntent
 *                                        (readonly+ so MCP agents can prepare).
 *   POST /v1/sweeps/:id/broadcast-result — Record broadcast hashes (advisory until
 *                                          the watcher confirms on-chain; admin only).
 *   GET  /v1/sweeps/:id               — Get a SweepIntent by id (readonly+).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import { buildTransfer } from "../../chain/tron/buildTransfer.js";
import type { UnsignedTrc20Transfer } from "../../chain/tron/buildTransfer.js";
import type { EventRepository, InvoiceRepository } from "../../core/ports.js";
import type { RateLimiter } from "../../lib/rate-limit.js";
import { parseMicro } from "../../lib/decimal.js";
import { requireScope, tenantOf, matchesTenant } from "../auth.js";
import type { ApiKeyRepository } from "../auth.js";

// ── Domain types ──────────────────────────────────────────────────────────────

/**
 * SweepIntentStatus aligned to the Prisma schema enum:
 *   prepared | partially_broadcast | broadcast | confirmed | failed
 *
 * The route uses "partially_broadcast" and "broadcast" in place of the old
 * "broadcasting" / "done" names to match the DB enum exactly.
 */
export type SweepIntentStatus = "prepared" | "partially_broadcast" | "broadcast" | "confirmed" | "failed";

/** One address entry inside a SweepIntent. */
export interface SweepIntentItem {
  /** Deposit address (Base58). */
  address: string;
  /** HD derivation account (matches event.derivationAccount). */
  account: number;
  /** HD derivation index (matches invoice.derivationIndex). */
  index: number;
  /** Amount to sweep in micro-USDT. Serialized as string for JSON safety. */
  amountMicroStr: string;
  /** Unsigned TRC-20 transfer payload built by buildTransfer(). */
  unsignedTx: UnsignedTrc20Transfer;
  /** Broadcast txHash — populated by POST broadcast-result. null until then. */
  txHash: string | null;
}

export interface SweepIntentRow {
  id: string;
  eventId: string;
  /** Destination wallet address (= event.mainWalletAddress). Required by Prisma model. */
  destination: string;
  status: SweepIntentStatus;
  items: SweepIntentItem[];
  createdAt: Date;
}

// ── Port: SweepIntentRepository ───────────────────────────────────────────────

export interface SweepIntentRepository {
  insert(intent: Omit<SweepIntentRow, "id" | "createdAt">): Promise<SweepIntentRow>;
  findById(id: string): Promise<SweepIntentRow | null>;
  updateStatus(id: string, status: SweepIntentStatus): Promise<SweepIntentRow>;
  updateItems(id: string, items: SweepIntentItem[]): Promise<SweepIntentRow>;
}

// ── Route opts ────────────────────────────────────────────────────────────────

export interface SweepRouteOpts {
  eventRepo: EventRepository;
  invoiceRepo: InvoiceRepository;
  sweepIntentRepo: SweepIntentRepository;
  apiKeyRepo: ApiKeyRepository;
  rateLimiter: RateLimiter;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid(): string {
  return randomBytes(8).toString("hex");
}

function badBroadcastResult(message: string): { error: { code: string; message: string } } {
  return { error: { code: "INVALID_BROADCAST_RESULT", message } };
}

function isValidTxHash(txHash: unknown): txHash is string {
  return typeof txHash === "string" && /^[0-9a-fA-F]{64}$/.test(txHash);
}

function isEventAllowed(key: { eventId: string | null }, eventId: string): boolean {
  return key.eventId === null || key.eventId === eventId;
}

function forbiddenEventBody(eventId: string): { error: { code: string; message: string } } {
  return {
    error: {
      code: "EVENT_FORBIDDEN",
      message: `API key is not allowed to access event "${eventId}"`,
    },
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerSweepRoutes(
  app: FastifyInstance,
  opts: SweepRouteOpts,
): Promise<void> {
  const { eventRepo, invoiceRepo, sweepIntentRepo, apiKeyRepo, rateLimiter } = opts;
  const adminAuth = requireScope("admin", apiKeyRepo);
  // Read-only endpoints accept readonly, merchant, and admin keys.
  const readonlyAuth = requireScope("readonly", apiKeyRepo);

  // ── POST /v1/sweeps/prepare ────────────────────────────────────────────────
  app.post(
    "/v1/sweeps/prepare",
    { preHandler: readonlyAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const k = req.apiKey!;
      if (!rateLimiter.check("admin", k.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }

      const body = req.body as {
        eventId?: string;
        addresses?: string[];
      };

      if (!body?.eventId) {
        return reply.code(400).send({
          error: { code: "BAD_REQUEST", message: "eventId is required" },
        });
      }

      if (!isEventAllowed(k, body.eventId)) {
        return reply.code(403).send(forbiddenEventBody(body.eventId));
      }

      const event = await eventRepo.findById(body.eventId);
      if (!event) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: `Event "${body.eventId}" not found` },
        });
      }

      // Tenancy (BOLA fix): a readonly/merchant key may only prepare sweeps for
      // events in its OWN tenant. Cross-tenant attempts return the same 404 as
      // not-found — no existence leak. (Preparing is harmless by itself — funds
      // only move via the operator CLI + passphrase + STABLERAILS_MAIN_WALLET pin —
      // but cross-tenant prepare would leak event/invoice balances.)
      const tenant = tenantOf(k);
      if (tenant !== undefined && !matchesTenant(tenant, event.merchantId)) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: `Event "${body.eventId}" not found` },
        });
      }

      // H2 fix: collect ALL fund-holding invoices (paid, overpaid, underpaid, overdue)
      // using amountReceived (actual on-chain funds), NOT amountUsdt (billed amount).
      // This ensures overpaid excess is swept and overdue/underpaid invoices are included.
      let sweepableItems = await invoiceRepo.listSweepableForEvent(body.eventId);

      // Filter by addresses if specified.
      if (body.addresses && body.addresses.length > 0) {
        const addressSet = new Set(body.addresses);
        sweepableItems = sweepableItems.filter((p) => addressSet.has(p.depositAddress));
      }

      if (sweepableItems.length === 0) {
        return reply.code(422).send({
          error: {
            code: "NO_PAID_INVOICES",
            message: "No fund-holding invoices found with balances to sweep",
          },
        });
      }

      // Build unsigned TRC-20 transfers (KEYLESS — no signer import).
      // Use amountReceived (actual received funds) to sweep the real balance.
      const items: SweepIntentItem[] = sweepableItems.map((inv, i) => {
        const amountMicro = parseMicro(inv.amountReceived);
        const unsignedTx = buildTransfer({
          fromAddress: inv.depositAddress,
          toAddress: event.mainWalletAddress,
          amountMicro,
        });
        const item: SweepIntentItem = {
          address: inv.depositAddress,
          account: event.derivationAccount,
          index: inv.derivationIndex,
          amountMicroStr: amountMicro.toString(),
          unsignedTx,
          txHash: null,
        };
        void i; // suppress unused variable warning
        return item;
      });

      const intent = await sweepIntentRepo.insert({
        eventId: event.id,
        destination: event.mainWalletAddress,
        status: "prepared",
        items,
      });

      return reply.code(201).send({ data: serializeIntent(intent) });
    },
  );

  // ── GET /v1/sweeps/:id — readonly+ (agent-facing read: sweep status) ──────
  app.get(
    "/v1/sweeps/:id",
    { preHandler: readonlyAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const k = req.apiKey!;
      if (!rateLimiter.check("admin", k.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }
      const { id } = req.params as { id: string };
      const intent = await sweepIntentRepo.findById(id);
      if (!intent) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: `SweepIntent "${id}" not found` },
        });
      }
      // Tenancy (BOLA fix): sweep intent tenant = its event's merchantId.
      // Cross-tenant reads return the same 404 as not-found — no existence leak.
      const tenant = tenantOf(k);
      if (tenant !== undefined) {
        const owningEvent = await eventRepo.findById(intent.eventId);
        if (!matchesTenant(tenant, owningEvent?.merchantId)) {
          return reply.code(404).send({
            error: { code: "NOT_FOUND", message: `SweepIntent "${id}" not found` },
          });
        }
      }
      return reply.code(200).send({ data: serializeIntent(intent) });
    },
  );

  // ── POST /v1/sweeps/:id/broadcast-result ──────────────────────────────────
  app.post(
    "/v1/sweeps/:id/broadcast-result",
    { preHandler: adminAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const k = req.apiKey!;
      if (!rateLimiter.check("admin", k.prefix)) {
        return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
      }

      const { id } = req.params as { id: string };
      const intent = await sweepIntentRepo.findById(id);
      if (!intent) {
        return reply.code(404).send({
          error: { code: "NOT_FOUND", message: `SweepIntent "${id}" not found` },
        });
      }

      if (intent.status === "broadcast" || intent.status === "confirmed") {
        return reply.code(409).send({
          error: { code: "ALREADY_DONE", message: "SweepIntent already finalized" },
        });
      }

      const body = req.body as {
        items?: Array<{ address: string; txHash: string }>;
      };

      if (!body?.items || !Array.isArray(body.items)) {
        return reply.code(400).send({
          error: { code: "BAD_REQUEST", message: "items array is required" },
        });
      }

      const knownAddresses = new Set(intent.items.map((item) => item.address));
      const seenAddresses = new Set<string>();
      for (const item of body.items) {
        if (typeof item?.address !== "string" || item.address.length === 0) {
          return reply.code(400).send(badBroadcastResult("item address must be a non-empty string"));
        }
        if (!knownAddresses.has(item.address)) {
          return reply.code(400).send(badBroadcastResult("item address is not part of this sweep intent"));
        }
        if (seenAddresses.has(item.address)) {
          return reply.code(400).send(badBroadcastResult("duplicate item address"));
        }
        seenAddresses.add(item.address);
        if (!isValidTxHash(item.txHash)) {
          return reply.code(400).send(badBroadcastResult("item txHash must be a 64-character hex string"));
        }
      }

      // Merge txHashes into existing items.
      const txHashByAddress = new Map(
        body.items.map((i) => [i.address, i.txHash]),
      );

      const updatedItems: SweepIntentItem[] = intent.items.map((item) => ({
        ...item,
        txHash: txHashByAddress.get(item.address) ?? item.txHash,
      }));

      const allBroadcasted = updatedItems.every(
        (item) => item.txHash !== null,
      );
      // Use schema-aligned enum values: "broadcast" (all done) or "partially_broadcast".
      const newStatus: SweepIntentStatus = allBroadcasted ? "broadcast" : "partially_broadcast";

      let updated = await sweepIntentRepo.updateItems(id, updatedItems);
      updated = await sweepIntentRepo.updateStatus(id, newStatus);

      return reply.code(200).send({ data: serializeIntent(updated) });
    },
  );
}

// ── Serializer ────────────────────────────────────────────────────────────────

/**
 * Serialize a SweepIntentRow for JSON output.
 * BigInt amountMicro is already stored as string (amountMicroStr).
 */
function serializeIntent(intent: SweepIntentRow): unknown {
  return {
    id: intent.id,
    eventId: intent.eventId,
    status: intent.status,
    createdAt: intent.createdAt,
    items: intent.items.map((item) => ({
      address: item.address,
      account: item.account,
      index: item.index,
      amountMicroStr: item.amountMicroStr,
      txHash: item.txHash,
      unsignedTx: {
        ...item.unsignedTx,
        // Convert bigint fields to string for safe JSON serialization.
        amountMicro: item.unsignedTx.amountMicro.toString(),
        feeLimitSun: item.unsignedTx.feeLimitSun.toString(),
      },
    })),
  };
}
