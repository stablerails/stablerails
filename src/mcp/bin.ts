#!/usr/bin/env node
/**
 * MCP stdio entry point.
 *
 * Starts the Stablerails MCP server on stdio transport so that an AI agent
 * (Claude Desktop, etc.) can connect via the MCP protocol.
 *
 * Usage:
 *   npm run cli:mcp          # dev — via tsx
 *   stablerails-mcp             # production — compiled binary
 *
 * Environment variables (same as CLI):
 *   STABLERAILS_API_URL      — Server base URL (default: http://localhost:3000)
 *   STABLERAILS_ADMIN_KEY    — Admin bearer key (required)
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

const server = createMcpServer();
const transport = new StdioServerTransport();

await server.connect(transport);
