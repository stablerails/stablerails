/**
 * CLI command: reconcile --event <id>
 *
 * Produces a full §9 reconciliation summary for an event:
 *   - Per-status counts and Σ USDT (paid / underpaid / overpaid / expired /
 *     canceled / overdue) using integer micro-USDT math (no floating-point).
 *   - Swept vs. unswept breakdown for invoices that hold real funds.
 *   - "collected ≈ $X of expected $Y" summary line.
 *
 * Paginates via the list cursor so all invoices are counted regardless of
 * event size — no hard 100-invoice cap.
 */

import type { Command } from "commander";
import { parseMicro, addMicro, formatMicro } from "../../lib/decimal.js";
import type { ApiClient } from "../apiClient.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface InvoiceRecord {
  id: string;
  status: string;
  amountUsdt: string;
  amountReceived: string;
  depositAddress: string;
}

interface StatusBucket {
  count: number;
  totalMicro: bigint;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyBucket(): StatusBucket {
  return { count: 0, totalMicro: 0n };
}

/**
 * Encode a cursor from the last item in a page.
 * Matches the Prisma adapter's base64url({id}) format.
 */
function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id })).toString("base64url");
}

/**
 * Fetch ALL invoices for an event by paginating through the list endpoint.
 * Uses page size of 100 (server max). Stops when a page returns fewer items
 * than requested (last page).
 */
async function fetchAllInvoices(
  api: ApiClient,
  eventId: string,
): Promise<InvoiceRecord[]> {
  const PAGE_SIZE = 100;
  const all: InvoiceRecord[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = (await api.listInvoices({
      eventId,
      limit: PAGE_SIZE,
      cursor,
    })) as InvoiceRecord[];

    all.push(...page);

    // If fewer items were returned than requested, we've reached the last page.
    if (page.length < PAGE_SIZE) break;

    // Encode cursor from last item for next page.
    const lastItem = page[page.length - 1];
    if (!lastItem) break;
    cursor = encodeCursor(lastItem.id);
  }

  return all;
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerReconcileCommands(parent: Command, getApi: () => ApiClient): void {
  parent
    .command("reconcile")
    .description("Show full invoice reconciliation summary for an event (§9)")
    .requiredOption("--event <id>", "Event id")
    .action(async (opts: { event: string }) => {
      const allInvoices = await fetchAllInvoices(getApi(), opts.event);

      // ── Per-status buckets ────────────────────────────────────────────────
      const buckets: Record<string, StatusBucket> = {};
      const ensureBucket = (status: string): StatusBucket => {
        if (!buckets[status]) buckets[status] = emptyBucket();
        return buckets[status]!;
      };

      // Statuses that hold real (received) funds and should be swept.
      const SWEEPABLE_STATUSES = new Set(["paid", "underpaid", "overpaid", "overdue"]);

      let totalExpectedMicro = 0n;   // Σ amountUsdt across all invoices
      let totalCollectedMicro = 0n;  // Σ amountReceived for fund-holding statuses

      for (const inv of allInvoices) {
        const bucket = ensureBucket(inv.status);
        bucket.count += 1;

        // Use amountReceived for fund-holding statuses (actual funds on deposit),
        // use amountUsdt for non-sweepable statuses (expected/billed only).
        const expectedMicro = parseMicro(inv.amountUsdt);
        const receivedMicro = parseMicro(inv.amountReceived);

        if (SWEEPABLE_STATUSES.has(inv.status)) {
          bucket.totalMicro = addMicro(bucket.totalMicro, receivedMicro);
          totalCollectedMicro = addMicro(totalCollectedMicro, receivedMicro);
        } else {
          bucket.totalMicro = addMicro(bucket.totalMicro, expectedMicro);
        }

        totalExpectedMicro = addMicro(totalExpectedMicro, expectedMicro);
      }

      // Funds-on-deposit breakdown.
      // NOTE: "swept" here means "paid" status — it is a heuristic because
      // Stablerails does not yet track per-invoice sweep confirmation.
      // A paid invoice may still hold funds on its deposit address until a sweep
      // is executed and confirmed. Use `sweep prepare --event` to see unswept
      // deposit balances, and `sweep execute` to move them to the destination wallet.
      const paidCount = buckets["paid"]?.count ?? 0;
      const sweepableTotal = Array.from(Object.entries(buckets))
        .filter(([s]) => SWEEPABLE_STATUSES.has(s))
        .reduce((acc, [, b]) => acc + b.count, 0);
      const unsweptCount = sweepableTotal - paidCount;

      // ── Build per-status summary ──────────────────────────────────────────
      const byStatus: Record<string, { count: number; totalUsdt: string }> = {};
      for (const [status, bucket] of Object.entries(buckets)) {
        byStatus[status] = {
          count: bucket.count,
          totalUsdt: formatMicro(bucket.totalMicro),
        };
      }

      const summary = {
        eventId: opts.event,
        total: allInvoices.length,
        byStatus,
        collected: {
          totalCollectedUsdt: formatMicro(totalCollectedMicro),
          totalExpectedUsdt: formatMicro(totalExpectedMicro),
          summary: `collected ≈ ${formatMicro(totalCollectedMicro)} USDT of expected ${formatMicro(totalExpectedMicro)} USDT`,
        },
        swept: {
          sweptCount: paidCount,
          unsweptCount,
          note: "sweptCount = paid invoices (heuristic — paid ≠ swept until sweep is confirmed); " +
            "unsweptCount = other sweepable (overpaid/underpaid/overdue). " +
            "Run `sweep prepare --event <id>` to see actual unswept deposit balances.",
        },
      };

      console.log(JSON.stringify(summary, null, 2));
    });
}
