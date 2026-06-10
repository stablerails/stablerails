/**
 * Stablerails MCP Server.
 *
 * Exposes all read/prepare CLI commands as MCP tools so that an AI agent
 * (Claude, etc.) can query events, invoices, webhooks, API keys, and prepare
 * sweeps — WITHOUT being able to move funds.
 *
 * SECURITY — THE AGENT CANNOT MOVE FUNDS:
 *   `sweep_execute` is intentionally NOT registered as an MCP tool.
 *   When an agent asks to execute a sweep, the tool `sweep_execute_instructions`
 *   returns a human-readable instruction telling the operator to run
 *   `stablerails sweep execute --intent <id>` locally on their terminal and enter
 *   the passphrase there. The passphrase is NEVER an MCP tool parameter.
 *
 * Tools registered (read/prepare — safe for agent use):
 *   event_list, event_show
 *   invoice_list, invoice_show, invoice_find
 *   webhook_list
 *   apikey_list
 *   sweep_prepare, sweep_status
 *   sweep_execute_instructions  (returns human-gate instructions, never executes)
 *
 * Tools NOT registered (require human passphrase):
 *   event_create  (derives xpub — seed op)
 *   invoice_cancel  (destructive)
 *   apikey_revoke   (destructive)
 *   sweep_execute   (FUND MOVEMENT — NEVER an MCP tool)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient } from "../cli/apiClient.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonText(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorText(err: unknown): { isError: true; content: Array<{ type: "text"; text: string }> } {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
  };
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create and configure the MCP server.
 *
 * @param api  API client instance. Defaults to ApiClient.fromEnv().
 */
export function createMcpServer(api?: ApiClient): McpServer {
  const client = api ?? ApiClient.fromEnv();

  const server = new McpServer({
    name: "stablerails",
    version: "0.1.0",
  });

  // ── Events ──────────────────────────────────────────────────────────────────

  server.tool(
    "event_list",
    "List all payment events",
    {},
    async () => {
      try {
        const result = await client.listEvents();
        return jsonText(result);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.tool(
    "event_show",
    "Get a payment event by id",
    { id: z.string().describe("Event id") },
    async ({ id }) => {
      try {
        const result = await client.getEvent(id);
        return jsonText(result);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // ── Invoices ────────────────────────────────────────────────────────────────

  server.tool(
    "invoice_list",
    "List invoices with optional filters",
    {
      eventId: z.string().optional().describe("Filter by event id"),
      status: z.string().optional().describe("Filter by status"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
      cursor: z.string().optional().describe("Pagination cursor"),
    },
    async ({ eventId, status, limit, cursor }) => {
      try {
        const result = await client.listInvoices({ eventId, status, limit, cursor });
        return jsonText(result);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.tool(
    "invoice_show",
    "Get an invoice by id (includes payments and confirmations)",
    { id: z.string().describe("Invoice id") },
    async ({ id }) => {
      try {
        const result = await client.getInvoice(id);
        return jsonText(result);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.tool(
    "invoice_find",
    [
      "Search invoices by query string, metadata key/value pairs, or orderId.",
      "Supports at-the-door lookup: pass orderId to find the invoice for a specific order.",
      "metadata is a key/value map (e.g. {\"orderId\": \"ORD-123\"} or {\"customer\": \"acme\"}).",
    ].join(" "),
    {
      q: z.string().optional().describe("Free-text search query (searches JSON-stringified metadata)"),
      metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe("Metadata key/value pairs to filter on (e.g. {\"customer\": \"acme\"})"),
      orderId: z.string().optional().describe("Convenience shorthand: looks up metadata.orderId === <value>"),
    },
    async ({ q, metadata, orderId }) => {
      try {
        const result = await client.findInvoice({
          q: q as string | undefined,
          metadata: metadata as Record<string, string> | undefined,
          orderId: orderId as string | undefined,
        });
        return jsonText(result);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // ── Webhooks ────────────────────────────────────────────────────────────────

  server.tool(
    "webhook_list",
    "List registered webhook endpoints",
    {},
    async () => {
      try {
        const result = await client.listWebhooks();
        return jsonText(result);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // ── API keys ────────────────────────────────────────────────────────────────

  server.tool(
    "apikey_list",
    "List API keys (prefix and scope only — raw keys are never returned)",
    {},
    async () => {
      try {
        const result = await client.listApiKeys();
        return jsonText(result);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // ── Sweeps ──────────────────────────────────────────────────────────────────

  server.tool(
    "sweep_prepare",
    [
      "Prepare a sweep intent: build unsigned TRC-20 transfers for all paid",
      "deposit addresses of an event. No private keys involved.",
      "Returns a SweepIntent id that the operator uses with `sweep execute` locally.",
    ].join(" "),
    {
      eventId: z.string().describe("Event id"),
      addresses: z
        .array(z.string())
        .optional()
        .describe("Specific deposit addresses to sweep (default: all paid)"),
    },
    async ({ eventId, addresses }) => {
      try {
        const result = await client.prepareSweep({ eventId, addresses });
        return jsonText(result);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.tool(
    "sweep_status",
    "Get the status of a sweep intent by id",
    { id: z.string().describe("SweepIntent id") },
    async ({ id }) => {
      try {
        const result = await client.getSweep(id);
        return jsonText(result);
      } catch (err) {
        return errorText(err);
      }
    },
  );

  // ── SECURITY GATE: sweep_execute ───────────────────────────────────────────
  //
  // sweep_execute is NOT registered as an MCP tool that takes a passphrase.
  // The agent CANNOT move funds — it can only prepare intents and then tell
  // the human to run the command locally.
  //
  // This tool returns human-readable instructions. The passphrase is NEVER
  // a parameter of any MCP tool.
  server.tool(
    "sweep_execute_instructions",
    [
      "HUMAN GATE: The agent cannot execute a sweep directly. Fund movement",
      "requires a passphrase that only a human can supply at a terminal.",
      "",
      "To execute a prepared sweep, the operator must run this command locally:",
      "  stablerails sweep execute --intent <intentId>",
      "",
      "The command will prompt for the seed passphrase (hidden terminal input).",
      "The passphrase is NEVER a CLI flag, env var, or MCP tool parameter.",
      "This tool returns the instruction — it does NOT execute the sweep.",
    ].join("\n"),
    {
      intentId: z.string().describe("SweepIntent id from sweep_prepare"),
    },
    async ({ intentId }) => {
      const instructions = [
        "To execute this sweep, run the following command on your local terminal:",
        "",
        `  stablerails sweep execute --intent ${intentId}`,
        "",
        "You will be prompted to enter your seed passphrase (hidden input).",
        "The passphrase is required to decrypt your HD wallet seed and sign the",
        "transactions locally. It is NEVER transmitted to the server or MCP host.",
        "",
        "The agent cannot supply the passphrase — this is an intentional security",
        "gate that ensures only a human with physical access to the passphrase can",
        "move funds.",
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: instructions }],
      };
    },
  );

  return server;
}
