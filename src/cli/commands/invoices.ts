/**
 * CLI commands for invoices.
 */

import type { Command } from "commander";
import type { ApiClient } from "../apiClient.js";

export function registerInvoiceCommands(parent: Command, getApi: () => ApiClient): void {
  const invoice = parent.command("invoice").description("Manage invoices");

  invoice
    .command("create")
    .description("Create an invoice")
    .requiredOption("--event <id>", "Event id")
    .requiredOption("--amount <n>", "Fiat amount (e.g. 100.00)")
    .option("--currency <code>", "Fiat currency ISO 4217", "USD")
    .option("--ttl <minutes>", "TTL in minutes", "30")
    .action(async (opts: { event: string; amount: string; currency: string; ttl: string }) => {
      const result = await getApi().createInvoice({
        eventId: opts.event,
        priceFiat: opts.amount,
        fiatCurrency: opts.currency,
        ttlMinutes: parseInt(opts.ttl, 10),
      });
      console.log(JSON.stringify(result, null, 2));
    });

  invoice
    .command("list")
    .description("List invoices")
    .option("--event <id>", "Filter by event id")
    .option("--status <s>", "Filter by status")
    .option("--limit <n>", "Max results", "20")
    .action(async (opts: { event?: string; status?: string; limit: string }) => {
      const result = await getApi().listInvoices({
        eventId: opts.event,
        status: opts.status,
        limit: parseInt(opts.limit, 10),
      });
      console.log(JSON.stringify(result, null, 2));
    });

  invoice
    .command("show <id>")
    .description("Show an invoice by id")
    .action(async (id: string) => {
      const result = await getApi().getInvoice(id);
      console.log(JSON.stringify(result, null, 2));
    });

  invoice
    .command("find <query>")
    .description("Search invoices by query string, metadata, or orderId")
    .option("--order-id <id>", "Find by metadata.orderId value (shorthand)")
    .option("--metadata <json>", 'Filter by metadata key/value pairs (JSON object, e.g. \'{"k":"v"}\'))')
    .action(async (q: string, opts: { orderId?: string; metadata?: string }) => {
      let metadata: Record<string, string> | undefined;
      if (opts.metadata) {
        try {
          metadata = JSON.parse(opts.metadata) as Record<string, string>;
        } catch {
          console.error("--metadata must be a valid JSON object");
          process.exit(1);
        }
      }
      const result = await getApi().findInvoice({ q, metadata, orderId: opts.orderId });
      console.log(JSON.stringify(result, null, 2));
    });

  invoice
    .command("cancel <id>")
    .description("Cancel a pending invoice")
    .action(async (id: string) => {
      const result = await getApi().cancelInvoice(id);
      console.log(JSON.stringify(result, null, 2));
    });
}
