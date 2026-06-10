#!/usr/bin/env node
/**
 * Stablerails CLI
 *
 * Operator tool for managing events, invoices, webhooks, API keys, and sweeps.
 * Connects to the Stablerails server via the admin API.
 *
 * Environment variables:
 *   STABLERAILS_API_URL      — Server base URL (default: http://localhost:3000)
 *   STABLERAILS_ADMIN_KEY    — Admin bearer key (required)
 *   STABLERAILS_ENCRYPTED_SEED — Encrypted seed blob JSON (required for seed ops)
 *   STABLERAILS_SEED_FILE    — Path to encrypted seed blob JSON file (alt to above)
 *
 * SECURITY: The `sweep execute` and `event create` commands require the seed
 * passphrase, which is always prompted interactively on the TTY. The passphrase
 * is NEVER a CLI flag, env var, or MCP tool parameter.
 */

import { Command } from "commander";
import { ApiClient } from "./apiClient.js";
import { registerEventCommands } from "./commands/events.js";
import { registerInvoiceCommands } from "./commands/invoices.js";
import { registerWebhookCommands } from "./commands/webhooks.js";
import { registerApiKeyCommands } from "./commands/apikeys.js";
import { registerReconcileCommands } from "./commands/reconcile.js";
import { registerSweepCommands } from "./commands/sweep.js";
import { registerGasCommands } from "./commands/gas.js";
import { registerSeedCommands } from "./commands/seed.js";
import { registerOperatorCommands } from "./commands/operator.js";
import { registerInitCommand } from "./commands/init.js";

const program = new Command();

program
  .name("stablerails")
  .description("Stablerails operator CLI")
  .version("0.1.0");

// Build API client once on first use (deferred so tests can register commands
// without needing STABLERAILS_ADMIN_KEY in the environment at import time).
let _api: ApiClient | null = null;
function api(): ApiClient {
  if (!_api) {
    _api = ApiClient.fromEnv();
  }
  return _api;
}

// Register all commands.
// Each command module receives a lazy getter; the ApiClient is instantiated
// only when a command actually executes — not at parse time.
registerEventCommands(program, api);
registerInvoiceCommands(program, api);
registerWebhookCommands(program, api);
registerApiKeyCommands(program, api);
registerReconcileCommands(program, api);
registerSweepCommands(program, api);
registerGasCommands(program, api);
registerSeedCommands(program);
registerOperatorCommands(program);
registerInitCommand(program);

// Global error handler.
process.on("unhandledRejection", (err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
