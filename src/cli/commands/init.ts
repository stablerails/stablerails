/**
 * CLI command: stablerails init
 *
 * One-command bootstrap: takes a fresh deployment to "ready to accept
 * payments". Runs ON the operator's server box with direct DB access
 * (DATABASE_URL), because no API key exists yet — same pattern as
 * `operator init` (src/cli/commands/operator.ts).
 *
 * Designed to be AGENT-FRIENDLY: an AI agent can run it non-interactively
 * (`--format json`) and gets machine-readable output. Every step that
 * requires a HUMAN at a terminal (seed passphrase) is skipped with a clear
 * follow-up instruction instead of failing the whole init.
 *
 * SECURITY INVARIANTS:
 *   - The seed passphrase is NEVER accepted via flag, env var, or pipe —
 *     the interactive seed flow reuses runSeedInitInteractive(), which
 *     enforces process.stdin.isTTY === true (src/cli/prompt.ts gate).
 *   - The magic-link token (256-bit random) is printed to STDOUT/STDERR
 *     only — never through the logger. Only its SHA-256 hash is stored.
 *   - The placeholder operator password is 32 random bytes that are hashed
 *     and immediately discarded — password login is unusable until the
 *     operator sets a real one; auth happens via the magic link.
 *
 * Steps (idempotent — safe to re-run):
 *   1. DB connectivity check
 *   2. Operator record (create if none)
 *   3. Seed (skip if configured; TTY → interactive init; else instructions)
 *   4. Event (create if none; needs seed + TTY + STABLERAILS_MAIN_WALLET)
 *   5. API keys (mint admin + readonly/MCP if none exist; shown ONCE)
 *   6. Magic login link (fresh on every run; 15-min TTL, single-use)
 *   7. Output (json | text) on stdout; progress lines go to stderr
 */

import type { Command } from "commander";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import {
  generateRawKey,
  hashApiKey,
  extractPrefix,
} from "../../server/auth.js";
import { mintLoginLink } from "../loginLink.js";
import type { LoginTokenWriter } from "../loginLink.js";

// ── Ports (injected; Prisma-backed in production, in-memory in tests) ─────────

export interface InitDb extends LoginTokenWriter {
  /** Cheap connectivity probe (SELECT 1). Throws when the DB is unreachable. */
  ping(): Promise<void>;
  findFirstOperator(): Promise<{ id: string; email: string } | null>;
  createOperator(email: string, passwordHash: string): Promise<{ id: string; email: string }>;
  countApiKeys(): Promise<number>;
  insertApiKey(input: {
    label: string;
    hashedKey: string;
    prefix: string;
    scope: "admin" | "readonly";
  }): Promise<{ id: string }>;
  findFirstEvent(): Promise<{ id: string; name: string } | null>;
  createEvent(input: {
    name: string;
    mainWalletAddress: string;
    derivationAccount: number;
    xpubAccount: string;
  }): Promise<{ id: string }>;
}

export interface InitHooks {
  /** True only for a real interactive terminal (process.stdin.isTTY === true). */
  isTTY: boolean;
  /** Whether STABLERAILS_ENCRYPTED_SEED / STABLERAILS_SEED_FILE resolve to a blob. */
  isSeedConfigured: () => boolean;
  /** Interactive seed init (TTY-gated) — reuses `stablerails seed init` flow. */
  runSeedInit: () => Promise<void>;
  /** Prompt passphrase at TTY, decrypt seed, derive account-0 xpub. */
  deriveXpubInteractive: () => Promise<string>;
  /** STABLERAILS_MAIN_WALLET (sweep destination, SIGN-2 posture). */
  mainWallet: string | undefined;
  /** Final result writer (stdout). */
  out: (s: string) => void;
  /** Progress / warning writer (stderr). */
  err: (s: string) => void;
}

export interface InitOptions {
  eventName: string;
  format: "json" | "text";
  publicUrl: string;
}

/** JSON contract emitted with --format json (one object on stdout). */
export interface InitResult {
  operatorId: string;
  /** Raw admin API key — present ONLY when minted on this run, else null. */
  adminKey: string | null;
  /** Raw readonly (MCP) API key — present ONLY when minted on this run, else null. */
  mcpKey: string | null;
  eventId: string | null;
  seedStatus: "ready" | "needs_human";
  magicLinkUrl: string;
  /** ISO timestamp — magic link expiry (15 minutes). */
  expiresAt: string;
}

const OPERATOR_PLACEHOLDER_EMAIL = "operator@local";

/** Tron Base58 main-wallet shape check (same heuristic as the server). */
function looksLikeTronAddress(addr: string): boolean {
  return addr.startsWith("T") && addr.length >= 33 && addr.length <= 36;
}

// ── Core flow (pure orchestration over injected ports — fully testable) ───────

export async function runInit(
  opts: InitOptions,
  db: InitDb,
  hooks: InitHooks,
): Promise<InitResult> {
  const { err } = hooks;

  // ── Step 1: DB connectivity ────────────────────────────────────────────────
  err("[1/6] Checking database connectivity...\n");
  try {
    await db.ping();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      [
        "Cannot reach the database.",
        `  Detail: ${detail}`,
        "  Check that:",
        "    - DATABASE_URL is set and points at your Postgres instance",
        "    - Postgres is running (docker compose up -d postgres)",
        "    - migrations are applied (npx prisma migrate deploy)",
        "  Then re-run: stablerails init",
      ].join("\n"),
    );
  }
  err("      OK\n");

  // ── Step 2: Operator record ────────────────────────────────────────────────
  err("[2/6] Operator account...\n");
  let operator = await db.findFirstOperator();
  if (operator) {
    err(`      Operator already exists (${operator.email}) — continuing.\n`);
  } else {
    // Random, unused password: hashed and discarded. Login happens via the
    // magic link — we NEVER prompt for (or accept) a password here.
    const throwawayPassword = randomBytes(32).toString("hex");
    const passwordHash = await argon2.hash(throwawayPassword, { type: argon2.argon2id });
    operator = await db.createOperator(OPERATOR_PLACEHOLDER_EMAIL, passwordHash);
    err(`      Created operator ${operator.email} (id=${operator.id}).\n`);
  }

  // ── Step 3: Seed ───────────────────────────────────────────────────────────
  err("[3/6] Encrypted seed...\n");
  let seedStatus: InitResult["seedStatus"];
  if (hooks.isSeedConfigured()) {
    err("      Seed already configured (STABLERAILS_ENCRYPTED_SEED / STABLERAILS_SEED_FILE) — skipping.\n");
    seedStatus = "ready";
  } else if (hooks.isTTY) {
    // Human at the terminal: run the existing interactive seed-init flow
    // (mnemonic + passphrase, both via hidden TTY prompts).
    await hooks.runSeedInit();
    // Re-check: if the blob went to a file referenced by STABLERAILS_SEED_FILE
    // it is usable right away; if it was printed to stdout the operator
    // still has to export it.
    seedStatus = hooks.isSeedConfigured() ? "ready" : "needs_human";
    if (seedStatus === "needs_human") {
      err(
        "      Seed blob printed above — export STABLERAILS_ENCRYPTED_SEED (or set\n" +
          "      STABLERAILS_SEED_FILE) and re-run: stablerails init\n",
      );
    }
  } else {
    // An agent (non-TTY) is running init. The passphrase gate is a HUMAN
    // gate — never accept it non-interactively. Continue with other steps.
    seedStatus = "needs_human";
    err(
      [
        "      ┌─────────────────────────────────────────────────────────────┐",
        "      │ Seed encryption requires a human at a terminal.             │",
        "      │ Run:    stablerails seed init                               │",
        "      │ — then re-run: stablerails init                             │",
        "      │ (The passphrase is never accepted via flag, env, or pipe.)  │",
        "      └─────────────────────────────────────────────────────────────┘",
        "",
      ].join("\n"),
    );
  }

  // ── Step 4: Event ──────────────────────────────────────────────────────────
  err("[4/6] Payment event...\n");
  let eventId: string | null = null;
  const existingEvent = await db.findFirstEvent();
  if (existingEvent) {
    eventId = existingEvent.id;
    err(`      Event already exists ("${existingEvent.name}", id=${existingEvent.id}) — skipping.\n`);
  } else if (seedStatus !== "ready" || !hooks.isTTY) {
    err(
      "      Skipped (needs the seed + a human at the terminal to derive the xpub).\n" +
        "      Follow-up: stablerails event create --name " +
        JSON.stringify(opts.eventName) +
        " --main-wallet <T...>\n",
    );
  } else if (!hooks.mainWallet || !looksLikeTronAddress(hooks.mainWallet)) {
    err(
      "      Skipped: STABLERAILS_MAIN_WALLET is not set (or not a valid T... address).\n" +
        "      The main wallet is the sweep destination — it must be chosen by you.\n" +
        "      Set STABLERAILS_MAIN_WALLET=T... and re-run, or run:\n" +
        "        stablerails event create --name " +
        JSON.stringify(opts.eventName) +
        " --main-wallet <T...>\n",
    );
  } else {
    const xpub = await hooks.deriveXpubInteractive();
    const created = await db.createEvent({
      name: opts.eventName,
      mainWalletAddress: hooks.mainWallet,
      derivationAccount: 0,
      xpubAccount: xpub,
    });
    eventId = created.id;
    err(`      Created event "${opts.eventName}" (id=${created.id}).\n`);
  }

  // ── Step 5: API keys ───────────────────────────────────────────────────────
  err("[5/6] API keys...\n");
  let adminKey: string | null = null;
  let mcpKey: string | null = null;
  const keyCount = await db.countApiKeys();
  if (keyCount > 0) {
    err(
      `      ${keyCount} API key(s) already exist — not minting new ones.\n` +
        "      (Mint more via the dashboard at /api-keys or POST /v1/api-keys.)\n",
    );
  } else {
    adminKey = generateRawKey();
    mcpKey = generateRawKey();
    await db.insertApiKey({
      label: "init-admin",
      hashedKey: hashApiKey(adminKey),
      prefix: extractPrefix(adminKey),
      scope: "admin",
    });
    await db.insertApiKey({
      label: "init-mcp-readonly",
      hashedKey: hashApiKey(mcpKey),
      prefix: extractPrefix(mcpKey),
      scope: "readonly",
    });
    err(
      [
        "      Minted 2 keys. SAVE THESE NOW — they are shown ONCE and stored",
        "      only as hashes:",
        "        admin    → export STABLERAILS_ADMIN_KEY=<adminKey>",
        "        readonly → export STABLERAILS_MCP_KEY=<mcpKey>   (for AI agents/MCP)",
        "      (Raw values are in the summary below.)",
        "",
      ].join("\n"),
    );
  }

  // ── Step 6: Magic login link (fresh on every run) ──────────────────────────
  err("[6/6] Magic login link...\n");
  const link = await mintLoginLink(db, operator.id, opts.publicUrl);
  err("      Minted (single-use, expires in 15 minutes).\n");

  const result: InitResult = {
    operatorId: operator.id,
    adminKey,
    mcpKey,
    eventId,
    seedStatus,
    magicLinkUrl: link.url,
    expiresAt: link.expiresAt.toISOString(),
  };

  // ── Output ────────────────────────────────────────────────────────────────
  if (opts.format === "json") {
    // ONE json object on stdout — agents should store the raw keys in env
    // (STABLERAILS_ADMIN_KEY / STABLERAILS_MCP_KEY); they cannot be retrieved again.
    hooks.out(JSON.stringify(result) + "\n");
  } else {
    hooks.out(
      [
        "",
        "=== Stablerails init — summary ===",
        "",
        `Operator:    ${operator.email} (id=${operator.id})`,
        `Seed:        ${seedStatus === "ready" ? "ready" : "NEEDS HUMAN — run: stablerails seed init"}`,
        `Event:       ${eventId ?? "not created yet (see follow-up above)"}`,
        adminKey
          ? `Admin key:   ${adminKey}\nMCP key:     ${mcpKey}\n             ^ SAVE THESE NOW — shown once, stored only as hashes.`
          : "API keys:    already exist (not re-minted)",
        "",
        "Dashboard login (single-use, 15 min):",
        `  ${link.url}`,
        "",
        "Need a new link later? Run: stablerails operator login-link",
        "",
      ].join("\n"),
    );
  }

  return result;
}

// ── Command registration (Prisma-backed ports) ────────────────────────────────

export function registerInitCommand(parent: Command): void {
  parent
    .command("init")
    .description(
      [
        "Bootstrap a fresh deployment to \"ready to accept payments\".",
        "",
        "Runs with direct DB access (DATABASE_URL) — no API key needed.",
        "Idempotent: safe to re-run; existing operator/event/keys are kept.",
        "Agent-friendly: non-TTY runs skip the human-only seed step with",
        "clear follow-up instructions and still emit machine-readable output.",
        "",
        "SECURITY: the seed passphrase is only ever typed at a terminal —",
        "never accepted via flag, env var, or piped stdin.",
      ].join("\n"),
    )
    .option("--event <name>", "Name for the first payment event", "My Store")
    .option("--format <format>", "Output format: json | text", "text")
    .option(
      "--public-url <url>",
      "Public base URL for the magic login link (default: PUBLIC_BASE_URL or http://localhost:3000)",
    )
    .action(async (opts: { event: string; format: string; publicUrl?: string }) => {
      if (opts.format !== "json" && opts.format !== "text") {
        process.stderr.write("\nERROR: --format must be json or text.\n\n");
        process.exit(1);
      }
      if (!process.env["DATABASE_URL"]) {
        process.stderr.write(
          "\nERROR: DATABASE_URL is not set.\n" +
            "       stablerails init talks to the database directly (no API key\n" +
            "       exists yet). Set it and re-run:\n" +
            "         DATABASE_URL=postgres://... stablerails init\n\n",
        );
        process.exit(1);
      }

      const publicUrl =
        opts.publicUrl ?? process.env["PUBLIC_BASE_URL"] ?? "http://localhost:3000";

      // Lazy imports keep DB/signer machinery out of CLI parse time.
      const { getPrisma } = await import("../../server/db/prismaClient.js");
      const prisma = getPrisma();

      const db: InitDb = {
        async ping() {
          await prisma.$queryRaw`SELECT 1`;
        },
        async findFirstOperator() {
          return prisma.operator.findFirst({ select: { id: true, email: true } });
        },
        async createOperator(email, passwordHash) {
          return prisma.operator.create({
            data: { email, passwordHash },
            select: { id: true, email: true },
          });
        },
        async countApiKeys() {
          return prisma.apiKey.count();
        },
        async insertApiKey(input) {
          return prisma.apiKey.create({ data: input, select: { id: true } });
        },
        async findFirstEvent() {
          return prisma.event.findFirst({ select: { id: true, name: true } });
        },
        async createEvent(input) {
          return prisma.event.create({ data: input, select: { id: true } });
        },
        async createLoginToken(input) {
          await prisma.loginToken.create({ data: input });
        },
      };

      // Lazy import (parse-time hygiene): throws when neither
      // STABLERAILS_ENCRYPTED_SEED nor STABLERAILS_SEED_FILE resolves to a blob.
      const { encryptedSeedFromEnv } = await import("../seedStore.js");

      const hooks: InitHooks = {
        isTTY: process.stdin.isTTY === true,
        isSeedConfigured: () => {
          try {
            encryptedSeedFromEnv();
            return true;
          } catch {
            return false;
          }
        },
        runSeedInit: async () => {
          const { runSeedInitInteractive } = await import("./seed.js");
          await runSeedInitInteractive();
        },
        deriveXpubInteractive: async () => {
          const { promptSeedPassphrase } = await import("../prompt.js");
          const { decryptSeed } = await import("../../signer/seed.js");
          const { deriveAccountXpub } = await import("../../signer/provision.js");
          const blob = encryptedSeedFromEnv();
          const passphrase = await promptSeedPassphrase(
            "Enter seed passphrase to derive the event xpub: ",
          );
          let mnemonic: string;
          try {
            mnemonic = await decryptSeed(blob, passphrase);
          } catch {
            process.stderr.write("\nERROR: Wrong passphrase — aborting event creation.\n\n");
            process.exit(1);
          }
          return deriveAccountXpub(mnemonic, 0).xpub;
        },
        mainWallet: process.env["STABLERAILS_MAIN_WALLET"],
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      };

      try {
        await runInit(
          { eventName: opts.event, format: opts.format, publicUrl },
          db,
          hooks,
        );
      } catch (e) {
        process.stderr.write(`\nERROR: ${e instanceof Error ? e.message : String(e)}\n\n`);
        process.exit(1);
      } finally {
        await prisma.$disconnect();
      }
    });
}
