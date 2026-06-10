/**
 * Prisma adapter for PaymentRepository port.
 *
 * Gated behind DATABASE_URL — only constructed when a real DB is present.
 * Tests inject the in-memory mock (InMemoryPaymentRepository) instead.
 *
 * Idempotent upsert on (network, txHash, logIndex) uses Prisma's
 * `createMany` with skipDuplicates=true approach, OR `findFirst` then
 * `create` inside a transaction for clear `created` flag semantics.
 */

import type { PrismaClient } from "@prisma/client";
import { UNCONFIRMED_BLOCK_SENTINEL } from "../../core/ports.js";
import type {
  PaymentRepository,
  PaymentRow,
  PaymentStatus,
  RecordPaymentInput,
} from "../../core/ports.js";
import { getPrismaClient } from "./prismaClient.js";

// Map Prisma types to our domain types
function toDomainPayment(p: {
  id: string;
  invoiceId: string;
  txHash: string;
  logIndex: number;
  network: string;
  fromAddress: string;
  amountUsdt: string;
  blockNumber: bigint;
  blockHash: string;
  status: string;
  detectedAt: Date;
  confirmedAt: Date | null;
}): PaymentRow {
  return {
    id: p.id,
    invoiceId: p.invoiceId,
    txHash: p.txHash,
    logIndex: p.logIndex,
    network: p.network as PaymentRow["network"],
    fromAddress: p.fromAddress,
    amountUsdt: p.amountUsdt,
    blockNumber: p.blockNumber,
    blockHash: p.blockHash,
    status: p.status as PaymentStatus,
    detectedAt: p.detectedAt,
    confirmedAt: p.confirmedAt,
  };
}

export class PaymentRepositoryPrisma implements PaymentRepository {
  private readonly db: PrismaClient;

  constructor(db?: PrismaClient) {
    this.db = db ?? getPrismaClient();
  }

  async upsert(
    input: RecordPaymentInput,
    tx?: unknown,
  ): Promise<{ row: PaymentRow; created: boolean }> {
    // When called inside an outer TransactionRunner transaction, use that client
    // directly (no nested $transaction). Otherwise open a short internal transaction
    // for atomic check-then-insert.
    if (tx) {
      const client = tx as PrismaClient;
      const existing = await client.payment.findUnique({
        where: {
          network_txHash_logIndex: {
            network: input.network,
            txHash: input.txHash,
            logIndex: input.logIndex,
          },
        },
      });
      if (existing) {
        // Refresh blockNumber while the payment is still pre-credit (detected).
        // On tick 1 a transient secondary lag may persist MAX_BN as the block number.
        // On tick 2, both providers agree on the real block; we update blockNumber so
        // the M-4 replay gate (paymentRow.blockNumber <= latestSolidBlock) fires.
        //
        // blockHash is intentionally NOT updated here: checkReorg (called after upsert)
        // compares the original stored blockHash against the incoming one to detect
        // chain reorganisations. Updating blockHash here would mask that comparison.
        //
        // Never-revert invariant: only update while status = "detected" (pre-credit).
        // confirmed rows are immutable.
        if (existing.status === "detected") {
          const refreshed = await client.payment.update({
            where: { id: existing.id },
            data: { blockNumber: input.blockNumber },
          });
          return { row: toDomainPayment(refreshed), created: false };
        }
        // Orphan revival: the same (network, txHash, logIndex) re-observed by BOTH
        // providers (the watcher only calls upsert on the agreement path) with a
        // confirmed placement (real block number from both providers, non-empty
        // blockHash) — the tx was re-mined after a pre-solid reorg. Revive to
        // "detected" with the fresh block coordinates so the normal
        // detected→confirmed solid gate can credit it. Status is forced to
        // "detected" regardless of input.status (never jump straight to
        // confirmed/paid); amountUsdt stays immutable.
        if (
          existing.status === "orphaned" &&
          input.blockNumber < UNCONFIRMED_BLOCK_SENTINEL &&
          input.blockHash.length > 0
        ) {
          const revived = await client.payment.update({
            where: { id: existing.id },
            data: {
              status: "detected",
              blockNumber: input.blockNumber,
              blockHash: input.blockHash,
            },
          });
          return { row: toDomainPayment(revived), created: false };
        }
        return { row: toDomainPayment(existing), created: false };
      }
      const created = await client.payment.create({
        data: {
          invoiceId: input.invoiceId,
          txHash: input.txHash,
          logIndex: input.logIndex,
          network: input.network,
          fromAddress: input.fromAddress,
          amountUsdt: input.amountUsdt,
          blockNumber: input.blockNumber,
          blockHash: input.blockHash,
          status: input.status,
        },
      });
      return { row: toDomainPayment(created), created: true };
    }

    // Standalone: use an internal transaction for atomic check-then-insert/update
    const result = await this.db.$transaction(async (innerTx) => {
      const existing = await innerTx.payment.findUnique({
        where: {
          network_txHash_logIndex: {
            network: input.network,
            txHash: input.txHash,
            logIndex: input.logIndex,
          },
        },
      });

      if (existing) {
        // Same blockNumber-only refresh as the tx path (see above for rationale).
        if (existing.status === "detected") {
          const refreshed = await innerTx.payment.update({
            where: { id: existing.id },
            data: { blockNumber: input.blockNumber },
          });
          return { row: toDomainPayment(refreshed), created: false };
        }
        // Same orphan-revival rule as the tx path (see above for rationale).
        if (
          existing.status === "orphaned" &&
          input.blockNumber < UNCONFIRMED_BLOCK_SENTINEL &&
          input.blockHash.length > 0
        ) {
          const revived = await innerTx.payment.update({
            where: { id: existing.id },
            data: {
              status: "detected",
              blockNumber: input.blockNumber,
              blockHash: input.blockHash,
            },
          });
          return { row: toDomainPayment(revived), created: false };
        }
        return { row: toDomainPayment(existing), created: false };
      }

      const created = await innerTx.payment.create({
        data: {
          invoiceId: input.invoiceId,
          txHash: input.txHash,
          logIndex: input.logIndex,
          network: input.network,
          fromAddress: input.fromAddress,
          amountUsdt: input.amountUsdt,
          blockNumber: input.blockNumber,
          blockHash: input.blockHash,
          status: input.status,
        },
      });

      return { row: toDomainPayment(created), created: true };
    });

    return result;
  }

  async updateStatus(
    id: string,
    status: PaymentStatus,
    confirmedAt?: Date,
    tx?: unknown,
  ): Promise<PaymentRow> {
    const client = (tx as PrismaClient | undefined) ?? this.db;
    const updated = await client.payment.update({
      where: { id },
      data: {
        status,
        confirmedAt: confirmedAt ?? undefined,
      },
    });
    return toDomainPayment(updated);
  }

  async markUnconfirmed(id: string, tx?: unknown): Promise<void> {
    const client = (tx as PrismaClient | undefined) ?? this.db;
    // updateMany so the "still detected" guard lives in the WHERE clause —
    // an atomic conditional update with no read-then-write race window.
    // 0 rows affected (status changed concurrently / row gone) = safe no-op.
    await client.payment.updateMany({
      where: { id, status: "detected" },
      data: { blockNumber: UNCONFIRMED_BLOCK_SENTINEL },
    });
  }
}
