/**
 * Prisma implementation of the TransactionRunner port.
 *
 * Opens a Prisma interactive transaction, acquires a SELECT ... FOR UPDATE
 * row lock on the Invoice row, then calls fn(tx) with the transaction client.
 * Every repo call inside fn receives the same Prisma tx client, so the entire
 * credit sequence (payment upsert, status promotions, invoice updateStatus,
 * webhook enqueue, maxVersionForInvoice) runs inside ONE Postgres transaction.
 *
 * The FOR UPDATE lock prevents concurrent watcher ticks from interleaving
 * mutations on the same invoice row between the credit steps.
 *
 * Gated behind DATABASE_URL — only constructed in the production worker.
 * Tests inject InMemoryTransactionRunner instead.
 */

import type { PrismaClient } from "@prisma/client";
import type { TransactionRunner } from "../watcher.js";
import { getPrismaClient } from "./prismaClient.js";

export class PrismaTransactionRunner implements TransactionRunner {
  private readonly db: PrismaClient;

  constructor(db?: PrismaClient) {
    this.db = db ?? getPrismaClient();
  }

  async runInCredit<T>(
    invoiceId: string,
    fn: (tx: unknown) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(async (tx) => {
      // Acquire a row-level exclusive lock on the Invoice row for the duration
      // of this transaction. This prevents two concurrent watcher ticks from
      // racing through the credit sequence on the same invoice.
      await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;

      // Call the credit body with the transaction client so every repo operation
      // inside it participates in the same Postgres transaction.
      return fn(tx);
    });
  }
}
