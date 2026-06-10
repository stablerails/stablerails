/**
 * CLI commands for webhooks.
 */

import type { Command } from "commander";
import type { ApiClient } from "../apiClient.js";

export function registerWebhookCommands(parent: Command, getApi: () => ApiClient): void {
  const webhook = parent.command("webhook").description("Manage webhooks");

  webhook
    .command("add")
    .description("Register a webhook endpoint")
    .requiredOption("--url <url>", "Webhook URL")
    .option("--event <id>", "Scope to a specific event id")
    .option("--secret <s>", "Custom signing secret (auto-generated if not set)")
    .action(async (opts: { url: string; event?: string; secret?: string }) => {
      const result = await getApi().addWebhook({
        url: opts.url,
        eventId: opts.event,
        secret: opts.secret,
      });
      console.log(JSON.stringify(result, null, 2));
    });

  webhook
    .command("list")
    .description("List registered webhooks")
    .action(async () => {
      const result = await getApi().listWebhooks();
      console.log(JSON.stringify(result, null, 2));
    });

  webhook
    .command("test <endpointId>")
    .description("Send a test event to a webhook endpoint")
    .action(async (endpointId: string) => {
      const result = await getApi().testWebhook(endpointId);
      console.log(JSON.stringify(result, null, 2));
    });

  webhook
    .command("remove <id>")
    .description("Delete a webhook endpoint")
    .action(async (id: string) => {
      await getApi().removeWebhook(id);
      console.log(JSON.stringify({ deleted: id }, null, 2));
    });
}
