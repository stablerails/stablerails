/**
 * Merchant domain types and in-memory repository.
 *
 * Used by the hosted-signup feature (STABLERAILS_HOSTED_SIGNUP=1).
 * Production deployments use a Prisma-backed implementation; tests and
 * the in-memory path use InMemoryMerchantRepository.
 *
 * Prisma model (migration 0000000000008_merchant):
 *   model Merchant { id cuid, email unique, passwordHash, status active|suspended, createdAt }
 */

import { randomBytes } from "crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MerchantStatus = "active" | "suspended";

export interface MerchantRecord {
  id: string;
  email: string;
  passwordHash: string;
  status: MerchantStatus;
  createdAt: Date;
}

// ── Repository port ───────────────────────────────────────────────────────────

export interface MerchantRepository {
  /** Find merchant by email. Returns null when not found. */
  findByEmail(email: string): Promise<MerchantRecord | null>;
  /** Find merchant by id. Returns null when not found. */
  findById(id: string): Promise<MerchantRecord | null>;
  /** Create a new merchant. Throws on duplicate email. */
  create(email: string, passwordHash: string): Promise<MerchantRecord>;
}

// ── In-memory implementation (tests + dev) ─────────────────────────────────────

export class InMemoryMerchantRepository implements MerchantRepository {
  readonly store = new Map<string, MerchantRecord>();

  async findByEmail(email: string): Promise<MerchantRecord | null> {
    for (const m of this.store.values()) {
      if (m.email === email) return m;
    }
    return null;
  }

  async findById(id: string): Promise<MerchantRecord | null> {
    return this.store.get(id) ?? null;
  }

  async create(email: string, passwordHash: string): Promise<MerchantRecord> {
    // Reject duplicate emails (mirrors Postgres @unique constraint).
    for (const m of this.store.values()) {
      if (m.email === email) {
        const err = new Error(`Unique constraint violation: Merchant email "${email}" already exists`);
        (err as Error & { code?: string }).code = "P2002";
        throw err;
      }
    }
    const id = randomBytes(8).toString("hex");
    const record: MerchantRecord = {
      id,
      email,
      passwordHash,
      status: "active",
      createdAt: new Date(),
    };
    this.store.set(id, record);
    return record;
  }
}
