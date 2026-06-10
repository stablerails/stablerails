/**
 * API authentication (spec §4).
 *
 * Bearer auth:  Authorization: Bearer <raw-key>
 *   - Raw key is sha256-hashed (hex) before DB lookup.
 *   - Admin keys can do everything; merchant keys can only create/query invoices.
 *
 * Operator session:  POST /v1/auth/login → Argon2 verify → set-cookie
 *   - Cookie-based session for the web UI (api-key management page).
 *   - Session stored in a signed cookie (server-side Map, no DB needed for MVP).
 */

import { createHash, randomBytes } from "crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

// ── Scopes ────────────────────────────────────────────────────────────────────

/**
 * API key scope hierarchy (ascending capability):
 *   readonly < merchant < admin
 *
 * readonly:  agent/MCP host — read-only access to events, invoices, webhooks,
 *            api-key metadata, and sweep status. CANNOT mint keys, register
 *            webhooks, create/cancel invoices, or prepare sweeps.
 *            Grant this scope to MCP hosts (via STABLERAILS_MCP_KEY) so a leak
 *            cannot move money or alter system configuration.
 * merchant:  payment integration — create/cancel invoices + all readonly ops.
 * admin:     full control — all operations including key management + sweeps.
 */
export type ApiKeyScope = "admin" | "merchant" | "readonly";

/** Numeric level for each scope (higher = more capable). */
const SCOPE_LEVEL: Record<ApiKeyScope, number> = {
  readonly: 0,
  merchant: 1,
  admin:    2,
};

// ── API Key identity attached to the request ──────────────────────────────────

export interface AuthenticatedKey {
  id: string;
  prefix: string;
  scope: ApiKeyScope;
  /** Event-scoped key (main line): null = not confined to a single event. */
  eventId: string | null;
  /**
   * Tenant this key is confined to (merchant/readonly scopes).
   * null = legacy single-tenant key → confined to the "default tenant"
   * (resources whose merchantId is also null). Ignored for admin keys.
   */
  merchantId: string | null;
}

// ── Tenancy (multi-merchant isolation — BOLA fix) ─────────────────────────────
//
// Tenancy semantics:
//   - admin scope: sees and manages EVERYTHING. merchantId on an admin key is
//     ignored — tenantOf() returns undefined ("no tenant filtering").
//   - merchant / readonly keys: tenant = key.merchantId. A key with
//     merchantId = null is a LEGACY single-tenant key: it sees only resources
//     whose merchantId is also null (the "default tenant"). This keeps existing
//     deployments working while making cross-tenant reads impossible.
//   - Events carry merchantId; invoices and sweep intents inherit tenancy
//     through their event (invoice.eventId → event.merchantId).

/**
 * Resolve the tenant a key is confined to.
 *
 * @returns undefined for admin keys (no tenant filtering); otherwise the key's
 *          merchantId (null = legacy default tenant).
 */
export function tenantOf(key: AuthenticatedKey): string | null | undefined {
  return key.scope === "admin" ? undefined : key.merchantId;
}

/**
 * Check whether a resource owned by `resourceMerchantId` is visible to `tenant`
 * (as returned by tenantOf()). undefined tenant = admin = always visible.
 * Missing resource merchantId (legacy rows) is normalized to null.
 */
export function matchesTenant(
  tenant: string | null | undefined,
  resourceMerchantId: string | null | undefined,
): boolean {
  return tenant === undefined || tenant === (resourceMerchantId ?? null);
}

declare module "fastify" {
  interface FastifyRequest {
    apiKey?: AuthenticatedKey;
  }
}

// ── Key hashing (sha256 hex) ──────────────────────────────────────────────────

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateRawKey(): string {
  return randomBytes(32).toString("hex"); // 64-char hex
}

export function extractPrefix(raw: string): string {
  return raw.slice(0, 8); // first 8 chars shown as identifier
}

// ── API Key record shape (as stored / returned from DB port) ──────────────────

export interface ApiKeyRecord {
  id: string;
  label: string;
  hashedKey: string;
  prefix: string;
  scope: ApiKeyScope;
  /** Event-scoped key (main line): null = not confined to a single event. */
  eventId: string | null;
  /** Tenant binding. Optional for backward compatibility; null = legacy key. */
  merchantId?: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

// ── Auth port (injected into routes, mockable in tests) ───────────────────────

export interface ApiKeyRepository {
  findByHash(hashedKey: string): Promise<ApiKeyRecord | null>;
  insert(input: {
    label: string;
    hashedKey: string;
    prefix: string;
    scope: ApiKeyScope;
    eventId?: string | null;
    merchantId?: string | null;
  }): Promise<ApiKeyRecord>;
  list(): Promise<ApiKeyRecord[]>;
  revoke(id: string): Promise<ApiKeyRecord | null>;
  /** Get full key record by id (for delete-by-id). */
  findById(id: string): Promise<ApiKeyRecord | null>;
}

// ── Operator (session-based) login ────────────────────────────────────────────

export interface OperatorRecord {
  id: string;
  email: string;
  passwordHash: string;
}

export interface OperatorRepository {
  findByEmail(email: string): Promise<OperatorRecord | null>;
  /** Lookup by id (magic-link login resolves the token's operator). */
  findById(id: string): Promise<OperatorRecord | null>;
  /** Create a new operator. Throws on duplicate email. */
  create(email: string, passwordHash: string): Promise<OperatorRecord>;
}

// ── Magic-link login tokens ───────────────────────────────────────────────────
//
// SECURITY MODEL:
//   - The raw token is 32 random bytes (256-bit), hex-encoded in the URL only.
//   - The DB stores ONLY the SHA-256 hash (tokenHash) — a DB leak cannot be
//     replayed into a session.
//   - Single-use: consume() is an atomic guarded update (usedAt IS NULL AND
//     expiresAt > now) so two concurrent requests cannot both win.
//   - 15-minute TTL, set at mint time by the CLI (`stablerails init` /
//     `stablerails operator login-link`).

export interface LoginTokenRecord {
  id: string;
  tokenHash: string;
  operatorId: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface LoginTokenRepository {
  /** Persist a freshly minted token hash (raw token never stored). */
  create(input: {
    tokenHash: string;
    operatorId: string;
    expiresAt: Date;
  }): Promise<LoginTokenRecord>;
  /**
   * Atomically consume an unused, unexpired token: set usedAt = now and
   * return the record. Returns null when the token does not exist, was
   * already used (replay), or has expired. Implementations MUST make the
   * used/expiry check and the usedAt write a single atomic operation.
   */
  consume(tokenHash: string, now: Date): Promise<LoginTokenRecord | null>;
}

/** SHA-256 hex of the raw magic-link token (same construction as API keys). */
export function hashLoginToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// ── Session store (in-memory, MVP) ───────────────────────────────────────────

export interface SessionData {
  operatorId: string;
  email: string;
  createdAt: number;
}

export class InMemorySessionStore {
  private readonly sessions = new Map<string, SessionData>();
  private readonly ttlMs: number;

  constructor(ttlMs = 8 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  create(data: Omit<SessionData, "createdAt">): string {
    const id = randomBytes(32).toString("hex");
    this.sessions.set(id, { ...data, createdAt: Date.now() });
    return id;
  }

  get(id: string): SessionData | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (Date.now() - s.createdAt > this.ttlMs) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }
}

export const SESSION_COOKIE_NAME = "stablerails_session";

// ── Bearer token extraction ───────────────────────────────────────────────────

export function extractBearerToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const parts = auth.split(" ");
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") return null;
  return parts[1] ?? null;
}

// ── Fastify preHandler hooks ─────────────────────────────────────────────────

/**
 * Require a valid API key of at least the specified scope.
 * Hierarchy (ascending): readonly < merchant < admin.
 *
 * A key passes if its scope level >= the required scope level.
 * Examples:
 *   requireScope("readonly") — accepts admin, merchant, and readonly keys.
 *   requireScope("merchant") — accepts admin and merchant; rejects readonly.
 *   requireScope("admin")    — accepts only admin; rejects merchant and readonly.
 */
export function requireScope(
  scope: ApiKeyScope,
  apiKeyRepo: ApiKeyRepository,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    const raw = extractBearerToken(req);
    if (!raw) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Bearer token required" } });
    }
    const hashed = hashApiKey(raw);
    const key = await apiKeyRepo.findByHash(hashed);
    if (!key || key.revokedAt !== null) {
      return reply.code(401).send({ error: { code: "INVALID_API_KEY", message: "Invalid or revoked API key" } });
    }
    // Scope check: key must have at least the required capability level.
    if (SCOPE_LEVEL[key.scope] < SCOPE_LEVEL[scope]) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: `${scope} scope required` } });
    }
    req.apiKey = {
      id: key.id,
      prefix: key.prefix,
      scope: key.scope,
      eventId: key.eventId ?? null,
      merchantId: key.merchantId ?? null,
    };
  };
}
