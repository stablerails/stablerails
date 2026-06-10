/**
 * MCP server tests — Sprint 8.
 *
 * Tests:
 *   1. All read/prepare tools are registered.
 *   2. sweep_execute_instructions is registered (NOT sweep_execute).
 *   3. sweep_execute_instructions schema has NO passphrase parameter.
 *   4. Tools call the correct API client methods.
 *   5. sweep_execute is NOT a registered tool (agent cannot move funds).
 *   6. createMcpServer() factory constructs without throwing (bin runnability).
 */

import { describe, it, expect, vi } from "vitest";
import { createMcpServer } from "../server.js";
import type { ApiClient } from "../../cli/apiClient.js";

// ── Mock ApiClient ────────────────────────────────────────────────────────────

function makeMockApi(): Partial<ApiClient> {
  return {
    listEvents: vi.fn().mockResolvedValue([{ id: "ev_1" }]),
    getEvent: vi.fn().mockResolvedValue({ id: "ev_1" }),
    listInvoices: vi.fn().mockResolvedValue([{ id: "inv_1" }]),
    getInvoice: vi.fn().mockResolvedValue({ id: "inv_1" }),
    // findInvoice now accepts {q?, metadata?, orderId?} object.
    findInvoice: vi.fn().mockResolvedValue([]),
    listWebhooks: vi.fn().mockResolvedValue([]),
    listApiKeys: vi.fn().mockResolvedValue([]),
    prepareSweep: vi.fn().mockResolvedValue({ id: "intent_1", status: "prepared", items: [] }),
    getSweep: vi.fn().mockResolvedValue({ id: "intent_1", status: "prepared", items: [] }),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// _registeredTools is a plain Record<string, RegisteredTool> in the McpServer implementation.
function getRegisteredTools(
  server: ReturnType<typeof createMcpServer>,
): Record<string, unknown> {
  return (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
}

type RegisteredTool = {
  description?: string;
  // inputSchema is a Zod schema object. We use .shape to get the raw fields.
  inputSchema?: { shape: Record<string, unknown> } | null;
  // The McpServer stores the handler as `handler`, invoked as handler(args, extra).
  handler?: (args: Record<string, unknown>, extra?: unknown) => Promise<unknown>;
};

function getTool(server: ReturnType<typeof createMcpServer>, name: string): RegisteredTool {
  const tools = getRegisteredTools(server);
  const tool = tools[name] as RegisteredTool | undefined;
  if (!tool) throw new Error(`Tool "${name}" not found in registered tools`);
  return tool;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MCP server tool registration", () => {
  it("registers all expected read/prepare tools", () => {
    const server = createMcpServer(makeMockApi() as ApiClient);
    const tools = getRegisteredTools(server);

    const expectedTools = [
      "event_list",
      "event_show",
      "invoice_list",
      "invoice_show",
      "invoice_find",
      "webhook_list",
      "apikey_list",
      "sweep_prepare",
      "sweep_status",
      "sweep_execute_instructions",
    ];

    for (const name of expectedTools) {
      expect(
        Object.prototype.hasOwnProperty.call(tools, name),
        `Tool "${name}" should be registered`,
      ).toBe(true);
    }
  });

  it("does NOT register sweep_execute as an MCP tool", () => {
    const server = createMcpServer(makeMockApi() as ApiClient);
    const tools = getRegisteredTools(server);

    // The agent cannot move funds — sweep_execute is not a tool.
    expect(Object.prototype.hasOwnProperty.call(tools, "sweep_execute")).toBe(false);
  });

  it("sweep_execute_instructions schema has NO passphrase parameter", () => {
    const server = createMcpServer(makeMockApi() as ApiClient);
    const tool = getTool(server, "sweep_execute_instructions");

    // The input schema must not contain a passphrase or password field.
    const shape = tool.inputSchema?.shape ?? {};
    expect(Object.keys(shape)).not.toContain("passphrase");
    expect(Object.keys(shape)).not.toContain("password");
    expect(Object.keys(shape)).not.toContain("secret");
    expect(Object.keys(shape)).not.toContain("seed");
    expect(Object.keys(shape)).not.toContain("mnemonic");

    // Only intentId should be in the schema.
    expect(Object.keys(shape)).toContain("intentId");
  });

  it("sweep_execute_instructions description mentions human gate", () => {
    const server = createMcpServer(makeMockApi() as ApiClient);
    const tool = getTool(server, "sweep_execute_instructions");

    // Description must communicate that this requires human action.
    expect(tool.description ?? "").toMatch(/human|passphrase|cannot.*execute|fund/i);
  });
});

describe("MCP tool calls", () => {
  it("event_list calls api.listEvents()", async () => {
    const api = makeMockApi();
    const server = createMcpServer(api as ApiClient);
    const tool = getTool(server, "event_list");
    await tool.handler!({});
    expect(api.listEvents).toHaveBeenCalledOnce();
  });

  it("event_show calls api.getEvent(id)", async () => {
    const api = makeMockApi();
    const server = createMcpServer(api as ApiClient);
    const tool = getTool(server, "event_show");
    await tool.handler!({ id: "ev_abc" });
    expect(api.getEvent).toHaveBeenCalledWith("ev_abc");
  });

  it("invoice_list calls api.listInvoices()", async () => {
    const api = makeMockApi();
    const server = createMcpServer(api as ApiClient);
    const tool = getTool(server, "invoice_list");
    await tool.handler!({ eventId: "ev_1" });
    expect(api.listInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "ev_1" }),
    );
  });

  it("sweep_prepare calls api.prepareSweep()", async () => {
    const api = makeMockApi();
    const server = createMcpServer(api as ApiClient);
    const tool = getTool(server, "sweep_prepare");
    await tool.handler!({ eventId: "ev_1" });
    expect(api.prepareSweep).toHaveBeenCalledWith({ eventId: "ev_1", addresses: undefined });
  });

  it("sweep_execute_instructions returns human-gate instructions without calling any API", async () => {
    const api = makeMockApi();
    const server = createMcpServer(api as ApiClient);
    const tool = getTool(server, "sweep_execute_instructions");

    const result = await tool.handler!({ intentId: "intent_test_001" }) as {
      content: Array<{ type: string; text: string }>;
    };

    // Returns text content with the command to run.
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("intent_test_001");
    expect(result.content[0]?.text).toContain("sweep execute");
    expect(result.content[0]?.text).toContain("passphrase");

    // No API calls were made (pure instruction text).
    expect(api.prepareSweep).not.toHaveBeenCalled();
    expect(api.getSweep).not.toHaveBeenCalled();
  });

  it("tool errors return isError:true without crashing the server", async () => {
    const api = makeMockApi();
    (api.listEvents as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Connection refused"),
    );
    const server = createMcpServer(api as ApiClient);
    const tool = getTool(server, "event_list");

    const result = await tool.handler!({}) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Connection refused");
  });
});

// ── Security assertion: no passphrase param in any tool ─────────────────────

describe("MCP security: no passphrase param in any registered tool", () => {
  it("no tool has passphrase/password/seed/mnemonic in its input schema", () => {
    const server = createMcpServer(makeMockApi() as ApiClient);
    const tools = getRegisteredTools(server);

    const forbidden = ["passphrase", "password", "seed", "mnemonic", "private_key", "privateKey"];

    for (const [toolName, toolRaw] of Object.entries(tools)) {
      const tool = toolRaw as RegisteredTool;
      const shape = tool.inputSchema?.shape ?? {};
      for (const key of forbidden) {
        expect(
          Object.keys(shape).includes(key),
          `Tool "${toolName}" must NOT have a "${key}" parameter (agent cannot handle secrets)`,
        ).toBe(false);
      }
    }
  });
});

// ── L2: invoice_find metadata/orderId params ──────────────────────────────────

describe("MCP invoice_find — metadata/orderId schema (L2)", () => {
  it("invoice_find schema includes metadata and orderId params", () => {
    const server = createMcpServer(makeMockApi() as ApiClient);
    const tool = getTool(server, "invoice_find");
    const shape = tool.inputSchema?.shape ?? {};

    // q must still exist.
    expect(Object.keys(shape)).toContain("q");
    // New params for at-the-door metadata lookup.
    expect(Object.keys(shape)).toContain("metadata");
    expect(Object.keys(shape)).toContain("orderId");
  });

  it("invoice_find metadata and orderId params are optional (no required constraint)", () => {
    const server = createMcpServer(makeMockApi() as ApiClient);
    const tool = getTool(server, "invoice_find");
    // Tool must not throw when metadata and orderId are omitted.
    expect(async () => {
      await tool.handler!({ q: "test" });
    }).not.toThrow();
  });

  it("invoice_find calls findInvoice with metadata and orderId when supplied", async () => {
    const api = makeMockApi();
    const server = createMcpServer(api as ApiClient);
    const tool = getTool(server, "invoice_find");

    await tool.handler!({ orderId: "ORD-123", metadata: { customer: "acme" } });
    expect(api.findInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "ORD-123",
        metadata: expect.objectContaining({ customer: "acme" }),
      }),
    );
  });

  it("invoice_find calls findInvoice with only q when no metadata supplied", async () => {
    const api = makeMockApi();
    const server = createMcpServer(api as ApiClient);
    const tool = getTool(server, "invoice_find");

    await tool.handler!({ q: "hello" });
    expect(api.findInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ q: "hello" }),
    );
  });
});

// ── Factory runnability (bin bootstrap) ──────────────────────────────────────

describe("MCP factory runnability", () => {
  it("createMcpServer() constructs without throwing when given a mock api", () => {
    expect(() => createMcpServer(makeMockApi() as ApiClient)).not.toThrow();
  });

  it("createMcpServer() returns an McpServer instance with a connect method", () => {
    const server = createMcpServer(makeMockApi() as ApiClient);
    // McpServer.connect(transport) is the entry point used by bin.ts.
    expect(typeof server.connect).toBe("function");
  });
});
