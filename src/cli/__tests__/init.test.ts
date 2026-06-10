/**
 * `stablerails init` — bootstrap flow tests.
 *
 * runInit() is exercised against an in-memory InitDb and injected hooks —
 * no real DB, no TTY, no network. Covers:
 *   - non-TTY (agent) run: seedStatus "needs_human", human-gate NOT bypassed
 *   - keys minted once, stored as SHA-256 hashes, raw shown only on first run
 *   - idempotent re-run (operator/keys/events not duplicated)
 *   - fresh single-use magic link on EVERY run (hash-only storage, 15-min TTL)
 *   - DB-down friendly error
 *   - TTY + seed + main wallet → event created with account-0 xpub
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { runInit } from "../commands/init.js";
import type { InitDb, InitHooks, InitResult } from "../commands/init.js";
import { LOGIN_TOKEN_TTL_MS } from "../loginLink.js";

// ── In-memory InitDb ──────────────────────────────────────────────────────────

function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

class FakeInitDb implements InitDb {
  operators: Array<{ id: string; email: string; passwordHash: string }> = [];
  apiKeys: Array<{
    id: string;
    label: string;
    hashedKey: string;
    prefix: string;
    scope: "admin" | "readonly";
  }> = [];
  events: Array<{
    id: string;
    name: string;
    mainWalletAddress: string;
    derivationAccount: number;
    xpubAccount: string;
  }> = [];
  loginTokens: Array<{ tokenHash: string; operatorId: string; expiresAt: Date }> = [];
  failPing = false;
  private seq = 0;

  private nextId(prefix: string): string {
    return `${prefix}_${++this.seq}`;
  }

  async ping(): Promise<void> {
    if (this.failPing) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
  }
  async findFirstOperator() {
    const op = this.operators[0];
    return op ? { id: op.id, email: op.email } : null;
  }
  async createOperator(email: string, passwordHash: string) {
    const op = { id: this.nextId("op"), email, passwordHash };
    this.operators.push(op);
    return { id: op.id, email: op.email };
  }
  async countApiKeys() {
    return this.apiKeys.length;
  }
  async insertApiKey(input: {
    label: string;
    hashedKey: string;
    prefix: string;
    scope: "admin" | "readonly";
  }) {
    const key = { id: this.nextId("key"), ...input };
    this.apiKeys.push(key);
    return { id: key.id };
  }
  async findFirstEvent() {
    const ev = this.events[0];
    return ev ? { id: ev.id, name: ev.name } : null;
  }
  async createEvent(input: {
    name: string;
    mainWalletAddress: string;
    derivationAccount: number;
    xpubAccount: string;
  }) {
    const ev = { id: this.nextId("ev"), ...input };
    this.events.push(ev);
    return { id: ev.id };
  }
  async createLoginToken(input: { tokenHash: string; operatorId: string; expiresAt: Date }) {
    this.loginTokens.push(input);
  }
}

// ── Hook builder ──────────────────────────────────────────────────────────────

interface HookCapture {
  hooks: InitHooks;
  stdout: string[];
  stderr: string[];
  runSeedInit: ReturnType<typeof vi.fn>;
  deriveXpub: ReturnType<typeof vi.fn>;
}

function makeHooks(overrides?: Partial<InitHooks>): HookCapture {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runSeedInit = vi.fn().mockResolvedValue(undefined);
  const deriveXpub = vi.fn().mockResolvedValue("xpub_test_account0");
  const hooks: InitHooks = {
    isTTY: false,
    isSeedConfigured: () => false,
    runSeedInit,
    deriveXpubInteractive: deriveXpub,
    mainWallet: undefined,
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
    ...overrides,
  };
  return { hooks, stdout, stderr, runSeedInit, deriveXpub };
}

const OPTS = {
  eventName: "My Store",
  format: "json" as const,
  publicUrl: "https://pay.example.com",
};

// ── Non-TTY (agent) run ───────────────────────────────────────────────────────

describe("stablerails init — non-TTY agent run on a fresh DB", () => {
  it("completes with seedStatus needs_human and never touches the seed flow", async () => {
    const db = new FakeInitDb();
    const { hooks, stderr, runSeedInit, deriveXpub } = makeHooks();

    const result = await runInit(OPTS, db, hooks);

    expect(result.seedStatus).toBe("needs_human");
    // The HUMAN gate is respected: no interactive flow was invoked.
    expect(runSeedInit).not.toHaveBeenCalled();
    expect(deriveXpub).not.toHaveBeenCalled();
    // Clear follow-up instruction for the human.
    expect(stderr.join("")).toContain("stablerails seed init");
    // No event without seed+TTY.
    expect(result.eventId).toBeNull();
    expect(db.events).toHaveLength(0);
  });

  it("creates the operator with a placeholder email and no usable password prompt", async () => {
    const db = new FakeInitDb();
    const { hooks } = makeHooks();

    const result = await runInit(OPTS, db, hooks);

    expect(db.operators).toHaveLength(1);
    expect(db.operators[0]!.email).toBe("operator@local");
    expect(result.operatorId).toBe(db.operators[0]!.id);
    // Argon2id hash of a random throwaway — not empty, not the raw password.
    expect(db.operators[0]!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("mints admin + readonly (MCP) keys, stored only as SHA-256 hashes", async () => {
    const db = new FakeInitDb();
    const { hooks } = makeHooks();

    const result = await runInit(OPTS, db, hooks);

    expect(result.adminKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.mcpKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.adminKey).not.toBe(result.mcpKey);

    expect(db.apiKeys).toHaveLength(2);
    const admin = db.apiKeys.find((k) => k.scope === "admin")!;
    const readonly = db.apiKeys.find((k) => k.scope === "readonly")!;
    expect(admin.hashedKey).toBe(sha256hex(result.adminKey!));
    expect(readonly.hashedKey).toBe(sha256hex(result.mcpKey!));
    expect(admin.prefix).toBe(result.adminKey!.slice(0, 8));
  });

  it("mints a magic link: raw token in URL only, hash in DB, 15-minute TTL", async () => {
    const db = new FakeInitDb();
    const { hooks } = makeHooks();
    const before = Date.now();

    const result = await runInit(OPTS, db, hooks);

    expect(result.magicLinkUrl).toMatch(
      /^https:\/\/pay\.example\.com\/auth\/magic\?token=[0-9a-f]{64}$/,
    );
    const rawToken = result.magicLinkUrl.split("token=")[1]!;

    expect(db.loginTokens).toHaveLength(1);
    const stored = db.loginTokens[0]!;
    // Hash-only storage: the raw token never lands in the DB.
    expect(stored.tokenHash).toBe(sha256hex(rawToken));
    expect(stored.tokenHash).not.toBe(rawToken);
    expect(stored.operatorId).toBe(result.operatorId);

    const expiresAt = new Date(result.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + LOGIN_TOKEN_TTL_MS - 5_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + LOGIN_TOKEN_TTL_MS + 5_000);
  });

  it("--format json emits exactly one parseable JSON object on stdout", async () => {
    const db = new FakeInitDb();
    const { hooks, stdout, stderr } = makeHooks();

    const result = await runInit(OPTS, db, hooks);

    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0]!) as InitResult;
    expect(parsed).toEqual(result);
    expect(Object.keys(parsed).sort()).toEqual(
      ["adminKey", "eventId", "expiresAt", "magicLinkUrl", "mcpKey", "operatorId", "seedStatus"].sort(),
    );
    // Raw secrets go to stdout only — progress lines on stderr never carry them.
    expect(stderr.join("")).not.toContain(result.adminKey!);
    expect(stderr.join("")).not.toContain(result.mcpKey!);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("stablerails init — idempotent re-run", () => {
  it("does not duplicate operator/keys; mints only a fresh login link", async () => {
    const db = new FakeInitDb();
    const first = await runInit(OPTS, db, makeHooks().hooks);
    const second = await runInit(OPTS, db, makeHooks().hooks);

    // Operator and keys created exactly once.
    expect(db.operators).toHaveLength(1);
    expect(db.apiKeys).toHaveLength(2);
    expect(second.operatorId).toBe(first.operatorId);

    // Keys are NOT re-minted (and cannot be re-shown — hash-only storage).
    expect(second.adminKey).toBeNull();
    expect(second.mcpKey).toBeNull();

    // A fresh single-use link is minted on every run.
    expect(db.loginTokens).toHaveLength(2);
    expect(second.magicLinkUrl).not.toBe(first.magicLinkUrl);
  });
});

// ── DB connectivity ───────────────────────────────────────────────────────────

describe("stablerails init — DB down", () => {
  it("fails fast with retry guidance before touching any other step", async () => {
    const db = new FakeInitDb();
    db.failPing = true;
    const { hooks } = makeHooks();

    await expect(runInit(OPTS, db, hooks)).rejects.toThrow(/DATABASE_URL[\s\S]*re-run/);
    expect(db.operators).toHaveLength(0);
    expect(db.loginTokens).toHaveLength(0);
  });
});

// ── TTY operator run ──────────────────────────────────────────────────────────

describe("stablerails init — TTY with seed configured", () => {
  it("creates the event with the account-0 xpub when STABLERAILS_MAIN_WALLET is set", async () => {
    const db = new FakeInitDb();
    const { hooks, runSeedInit, deriveXpub } = makeHooks({
      isTTY: true,
      isSeedConfigured: () => true,
      mainWallet: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
    });

    const result = await runInit(OPTS, db, hooks);

    expect(result.seedStatus).toBe("ready");
    expect(runSeedInit).not.toHaveBeenCalled(); // seed already configured
    expect(deriveXpub).toHaveBeenCalledTimes(1);

    expect(db.events).toHaveLength(1);
    expect(db.events[0]!.name).toBe("My Store");
    expect(db.events[0]!.derivationAccount).toBe(0);
    expect(db.events[0]!.xpubAccount).toBe("xpub_test_account0");
    expect(result.eventId).toBe(db.events[0]!.id);
  });

  it("skips event creation (with instructions) when STABLERAILS_MAIN_WALLET is missing", async () => {
    const db = new FakeInitDb();
    const { hooks, stderr, deriveXpub } = makeHooks({
      isTTY: true,
      isSeedConfigured: () => true,
      mainWallet: undefined,
    });

    const result = await runInit(OPTS, db, hooks);

    expect(result.eventId).toBeNull();
    expect(db.events).toHaveLength(0);
    expect(deriveXpub).not.toHaveBeenCalled();
    expect(stderr.join("")).toContain("STABLERAILS_MAIN_WALLET");
  });

  it("runs the interactive seed flow on a TTY when the seed is not configured", async () => {
    const db = new FakeInitDb();
    let configured = false;
    const { hooks, runSeedInit } = makeHooks({
      isTTY: true,
      isSeedConfigured: () => configured,
    });
    runSeedInit.mockImplementation(async () => {
      configured = true; // simulates STABLERAILS_SEED_FILE being written
    });

    const result = await runInit(OPTS, db, hooks);

    expect(runSeedInit).toHaveBeenCalledTimes(1);
    expect(result.seedStatus).toBe("ready");
  });
});
