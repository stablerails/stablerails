/**
 * CLI commands for API key management.
 */

import type { Command } from "commander";
import type { ApiClient } from "../apiClient.js";

export function registerApiKeyCommands(parent: Command, getApi: () => ApiClient): void {
  const apikey = parent.command("apikey").description("Manage API keys");

  apikey
    .command("create")
    .description("Create an API key (raw key shown once)")
    .requiredOption("--label <label>", "Key label")
    .requiredOption("--scope <scope>", "Scope: admin or merchant")
    .action(async (opts: { label: string; scope: string }) => {
      if (opts.scope !== "admin" && opts.scope !== "merchant") {
        console.error('--scope must be "admin" or "merchant"');
        process.exit(1);
      }
      const result = await getApi().createApiKey({
        label: opts.label,
        scope: opts.scope as "admin" | "merchant",
      });
      console.log(JSON.stringify(result, null, 2));
    });

  apikey
    .command("list")
    .description("List API keys")
    .action(async () => {
      const result = await getApi().listApiKeys();
      console.log(JSON.stringify(result, null, 2));
    });

  apikey
    .command("revoke <id>")
    .description("Revoke an API key by id")
    .action(async (id: string) => {
      await getApi().revokeApiKey(id);
      console.log(JSON.stringify({ revoked: id }, null, 2));
    });
}
