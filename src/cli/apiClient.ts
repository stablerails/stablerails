/**
 * Thin HTTP client for the Stablerails server API.
 *
 * Reads the admin bearer key from the STABLERAILS_ADMIN_KEY environment variable.
 * All requests go to STABLERAILS_API_URL (defaults to http://localhost:3000).
 *
 * This is intentionally minimal — no retry logic, no caching. The CLI is
 * an operator tool and connection failures should be surfaced immediately.
 */

export interface ApiClientConfig {
  baseUrl: string;
  adminKey: string;
}

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: { code: string; message: string };
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(`API error ${statusCode} [${code}]: ${message}`);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly adminKey: string;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.adminKey = config.adminKey;
  }

  /**
   * Build an ApiClient from environment variables.
   *
   * Reads:
   *   STABLERAILS_API_URL   — server base URL (default: http://localhost:3000)
   *   STABLERAILS_MCP_KEY   — readonly bearer key for MCP/agent host (preferred)
   *   STABLERAILS_ADMIN_KEY — admin bearer key (fallback when MCP key is absent)
   *
   * The MCP host SHOULD be given a `readonly` API key (STABLERAILS_MCP_KEY), NOT
   * an admin key. With a readonly key, a credential leak cannot mint keys, move
   * money, register webhooks, or prepare sweeps — it can only read.
   *
   * STABLERAILS_ADMIN_KEY is accepted as a backward-compatible fallback so that
   * existing deployments without STABLERAILS_MCP_KEY continue to work.
   *
   * @throws If neither STABLERAILS_MCP_KEY nor STABLERAILS_ADMIN_KEY is set.
   */
  static fromEnv(): ApiClient {
    // Prefer STABLERAILS_MCP_KEY (readonly key for least-privilege agent operation).
    // Fall back to STABLERAILS_ADMIN_KEY for backward compatibility.
    const mcpKey = process.env["STABLERAILS_MCP_KEY"];
    const adminKey = process.env["STABLERAILS_ADMIN_KEY"];
    const bearerKey = mcpKey ?? adminKey;
    if (!bearerKey) {
      throw new Error(
        "Neither STABLERAILS_MCP_KEY nor STABLERAILS_ADMIN_KEY is set. " +
        "Set STABLERAILS_MCP_KEY to a readonly key for least-privilege agent access, " +
        "or STABLERAILS_ADMIN_KEY for backward compatibility.",
      );
    }
    const baseUrl =
      process.env["STABLERAILS_API_URL"] ?? "http://localhost:3000";
    return new ApiClient({ baseUrl, adminKey: bearerKey });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.adminKey}`,
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let json: ApiResponse<T>;
    try {
      json = (await res.json()) as ApiResponse<T>;
    } catch {
      throw new ApiError(
        res.status,
        "PARSE_ERROR",
        `Non-JSON response from ${method} ${path}`,
      );
    }

    if (!res.ok || json.error) {
      throw new ApiError(
        res.status,
        json.error?.code ?? "HTTP_ERROR",
        json.error?.message ?? `HTTP ${res.status}`,
      );
    }

    return json.data as T;
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  async createEvent(body: {
    name: string;
    mainWalletAddress: string;
    derivationAccount: number;
    xpubAccount: string;
  }): Promise<unknown> {
    return this.request("POST", "/v1/events", body);
  }

  async listEvents(): Promise<unknown[]> {
    return this.request("GET", "/v1/events") as Promise<unknown[]>;
  }

  async getEvent(id: string): Promise<unknown> {
    return this.request("GET", `/v1/events/${id}`);
  }

  // ── Invoices ────────────────────────────────────────────────────────────────

  async createInvoice(body: {
    eventId: string;
    priceFiat: string;
    fiatCurrency: string;
    metadata?: Record<string, unknown>;
    ttlMinutes?: number;
  }): Promise<unknown> {
    return this.request("POST", "/v1/invoices", body);
  }

  async listInvoices(opts?: {
    eventId?: string;
    status?: string;
    q?: string;
    metadata?: Record<string, string>;
    cursor?: string;
    limit?: number;
  }): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (opts?.eventId) params.set("eventId", opts.eventId);
    if (opts?.status) params.set("status", opts.status);
    if (opts?.q) params.set("q", opts.q);
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.metadata) {
      for (const [k, v] of Object.entries(opts.metadata)) {
        params.set(`metadata.${k}`, v);
      }
    }
    const qs = params.toString();
    return this.request("GET", `/v1/invoices${qs ? `?${qs}` : ""}`) as Promise<unknown[]>;
  }

  async getInvoice(id: string): Promise<unknown> {
    return this.request("GET", `/v1/invoices/${id}`);
  }

  async cancelInvoice(id: string): Promise<unknown> {
    return this.request("POST", `/v1/invoices/${id}/cancel`);
  }

  async findInvoice(opts: {
    q?: string;
    metadata?: Record<string, string>;
    orderId?: string;
  }): Promise<unknown[]> {
    const { q, metadata, orderId } = opts;
    // orderId is a convenience alias for metadata.orderId lookup.
    const metadataFilter: Record<string, string> | undefined =
      orderId
        ? { ...(metadata ?? {}), orderId }
        : metadata && Object.keys(metadata).length > 0
          ? metadata
          : undefined;
    return this.listInvoices({ q, metadata: metadataFilter });
  }

  // ── Webhooks ────────────────────────────────────────────────────────────────

  async addWebhook(body: {
    url: string;
    eventId?: string;
    secret?: string;
  }): Promise<unknown> {
    return this.request("POST", "/v1/webhooks", body);
  }

  async listWebhooks(): Promise<unknown[]> {
    return this.request("GET", "/v1/webhooks") as Promise<unknown[]>;
  }

  async testWebhook(endpointId: string): Promise<unknown> {
    return this.request("POST", "/v1/webhooks/test", { endpointId });
  }

  async removeWebhook(id: string): Promise<void> {
    await this.request("DELETE", `/v1/webhooks/${id}`);
  }

  // ── API keys ────────────────────────────────────────────────────────────────

  async createApiKey(body: { label: string; scope: "admin" | "merchant" | "readonly" }): Promise<unknown> {
    return this.request("POST", "/v1/api-keys", body);
  }

  async listApiKeys(): Promise<unknown[]> {
    return this.request("GET", "/v1/api-keys") as Promise<unknown[]>;
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.request("DELETE", `/v1/api-keys/${id}`);
  }

  // ── Sweeps ──────────────────────────────────────────────────────────────────

  async prepareSweep(body: {
    eventId: string;
    addresses?: string[];
  }): Promise<unknown> {
    return this.request("POST", "/v1/sweeps/prepare", body);
  }

  async getSweep(id: string): Promise<unknown> {
    return this.request("GET", `/v1/sweeps/${id}`);
  }

  async broadcastSweepResult(
    id: string,
    items: Array<{ address: string; txHash: string }>,
  ): Promise<unknown> {
    return this.request("POST", `/v1/sweeps/${id}/broadcast-result`, { items });
  }
}
