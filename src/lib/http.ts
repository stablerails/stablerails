/**
 * Minimal dual-provider Tron RPC HTTP client.
 *
 * Wraps native fetch (Node 22 built-in).
 * Configures TWO providers: primary (TronGrid) + secondary (fallback).
 * No axios dependency in this module — uses Node's built-in fetch.
 */

export interface RpcProvider {
  url: string;
  apiKey?: string;
}

export interface HttpClientConfig {
  primary: RpcProvider;
  secondary: RpcProvider;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface JsonRpcRequest {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface JsonRpcResponse<T = unknown> {
  data: T;
  provider: "primary" | "secondary";
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 1; // try primary, then secondary

/**
 * Redact credentials and query parameters from a provider URL before embedding
 * it in error messages or logs.
 *
 * Strips:
 *   - userinfo (user:pass@) from authority
 *   - entire query string (may contain ?apikey=, ?api_key=, etc.)
 *
 * Keeps: scheme + hostname + port + path (origin + pathname).
 *
 * @param rawUrl  The full URL string (may contain credentials).
 * @returns       Redacted URL string (origin + pathname only).
 */
export function redactProviderUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    // Keep only origin (scheme + host + port) + pathname — drop search and hash.
    return `${u.origin}${u.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

function buildProviderFromEnv(): HttpClientConfig {
  const primaryUrl = process.env["TRON_RPC_PRIMARY_URL"];
  const primaryKey = process.env["TRON_RPC_PRIMARY_API_KEY"];
  const secondaryUrl = process.env["TRON_RPC_SECONDARY_URL"];
  const secondaryKey = process.env["TRON_RPC_SECONDARY_API_KEY"];

  if (!primaryUrl || !secondaryUrl) {
    throw new Error(
      "Missing Tron RPC config: TRON_RPC_PRIMARY_URL and TRON_RPC_SECONDARY_URL required",
    );
  }

  // Single source of truth for the distinctness check — the worker also validates
  // this, but catching it here means the server fails fast too if misconfigured.
  if (primaryUrl === secondaryUrl) {
    throw new Error(
      "TRON_RPC_PRIMARY_URL and TRON_RPC_SECONDARY_URL must be different (identical URLs " +
        "defeat two-RPC agreement — self-agreement vector).",
    );
  }

  return {
    primary: { url: primaryUrl, apiKey: primaryKey },
    secondary: { url: secondaryUrl, apiKey: secondaryKey },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRetries: DEFAULT_MAX_RETRIES,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function callProvider<T>(
  provider: RpcProvider,
  req: JsonRpcRequest,
  timeoutMs: number,
): Promise<T> {
  const url = `${provider.url.replace(/\/$/, "")}${req.path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(req.headers ?? {}),
  };

  // TronGrid uses TRON-PRO-API-KEY header
  if (provider.apiKey) {
    headers["TRON-PRO-API-KEY"] = provider.apiKey;
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
  };

  const response = await fetchWithTimeout(url, init, timeoutMs);

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    // KS-4: log only origin+pathname to avoid leaking ?apikey= or user:pass@ credentials.
    const safeUrl = redactProviderUrl(url);
    const err = new Error(`RPC ${response.status} from ${safeUrl}: ${text}`);
    // Attach status so the caller can distinguish 4xx from 5xx/network errors.
    (err as NodeJS.ErrnoException & { status?: number }).status = response.status;
    throw err;
  }

  return (await response.json()) as T;
}

export class TronHttpClient {
  private readonly config: HttpClientConfig;

  constructor(config?: HttpClientConfig) {
    this.config = config ?? buildProviderFromEnv();
  }

  /**
   * Execute a request against the primary provider.
   * Falls back to secondary ONLY on network errors, timeouts, or 5xx responses.
   * 4xx responses (client errors) are surfaced immediately — they indicate a
   * request problem that the secondary provider cannot fix.
   */
  async request<T>(req: JsonRpcRequest): Promise<JsonRpcResponse<T>> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const data = await callProvider<T>(this.config.primary, req, timeoutMs);
      return { data, provider: "primary" };
    } catch (primaryErr) {
      // Extract HTTP status if present (set by callProvider on non-ok responses)
      const primaryStatus = (primaryErr as { status?: number }).status;

      // Do NOT fall back on 4xx — the client request is invalid.
      if (primaryStatus !== undefined && primaryStatus >= 400 && primaryStatus < 500) {
        throw primaryErr;
      }

      // Fall back to secondary on network error, timeout, or 5xx
      try {
        const data = await callProvider<T>(this.config.secondary, req, timeoutMs);
        return { data, provider: "secondary" };
      } catch (secondaryErr) {
        // Both failed — surface primary error with secondary context.
        // KS-4: individual provider errors already use redactProviderUrl in callProvider.
        const err = new Error(
          `Both Tron RPC providers failed.\n` +
            `Primary: ${String(primaryErr)}\n` +
            `Secondary: ${String(secondaryErr)}`,
        );
        throw err;
      }
    }
  }

  /** Convenience GET shorthand. */
  async get<T>(path: string, headers?: Record<string, string>): Promise<JsonRpcResponse<T>> {
    return this.request<T>({ method: "GET", path, headers });
  }

  /** Convenience POST shorthand. */
  async post<T>(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<JsonRpcResponse<T>> {
    return this.request<T>({ method: "POST", path, body, headers });
  }
}

/** Singleton built from env — use in server/worker code. */
let _singleton: TronHttpClient | undefined;

export function getTronHttpClient(): TronHttpClient {
  if (!_singleton) {
    _singleton = new TronHttpClient();
  }
  return _singleton;
}

export { buildProviderFromEnv };
