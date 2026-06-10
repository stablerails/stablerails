/**
 * CLI command: operator init --email <email>
 *
 * Creates the first Operator record in the database.
 * SECURITY:
 *   - Password is read via hidden TTY readline — NEVER as a flag or env var.
 *   - promptPassphrase() enforces process.stdin.isTTY === true and rejects
 *     any non-interactive (piped/automated) invocation.
 *   - Uses Argon2id for password hashing (same library as the server login route).
 *   - Connects directly to the database via DATABASE_URL (not via the admin API),
 *     because no admin API key exists on a clean DB.
 *   - Refuses to create a duplicate operator (graceful error on P2002).
 *
 * Usage (first run, clean DB):
 *   DATABASE_URL=postgres://... npx tsx src/cli/index.ts operator init --email admin@example.com
 */

import type { Command } from "commander";
import argon2 from "argon2";
import { promptPassphrase } from "../prompt.js";

// ── Command registration ──────────────────────────────────────────────────────

export function registerOperatorCommands(parent: Command): void {
  const operator = parent
    .command("operator")
    .description("Operator management (first-run bootstrap, direct DB access)");

  operator
    .command("init")
    .description(
      [
        "Create the first operator account in the database.",
        "",
        "SECURITY: password is read via hidden TTY input — NEVER as a flag or env var.",
        "Requires DATABASE_URL in the environment (direct DB connection, no admin key needed).",
        "",
        "Use this ONCE on a clean database to bootstrap the M2 admin-key flow:",
        "  1. operator init --email <email>   ← this command",
        "  2. seed init                       ← encrypt seed",
        "  3. Login at /login → mint first admin key at /api-keys",
        "  4. Export STABLERAILS_ADMIN_KEY",
        "  5. event create --name ...",
      ].join("\n"),
    )
    .requiredOption("--email <email>", "Operator email address")
    .action(async (opts: { email: string }) => {
      const email = opts.email.trim();

      if (!email || !email.includes("@")) {
        process.stderr.write("\nERROR: Invalid email address.\n\n");
        process.exit(1);
      }

      // Verify DATABASE_URL is set before prompting for a password.
      if (!process.env["DATABASE_URL"]) {
        process.stderr.write(
          "\nERROR: DATABASE_URL is not set.\n" +
            "       Set it before running operator init:\n" +
            "         DATABASE_URL=postgres://... stablerails operator init --email ...\n\n",
        );
        process.exit(1);
      }

      process.stderr.write(
        [
          "",
          "=== Stablerails operator init ===",
          "",
          `Creating operator account for: ${email}`,
          "",
        ].join("\n"),
      );

      // ── SECURITY GATE ──────────────────────────────────────────────────────
      // promptPassphrase() throws if process.stdin.isTTY !== true, preventing
      // automated/piped invocations from bypassing this gate.
      // ── END GATE ───────────────────────────────────────────────────────────
      const password = await promptPassphrase("Enter password for this operator account: ");
      if (!password) {
        process.stderr.write("\nERROR: Password cannot be empty.\n\n");
        process.exit(1);
      }

      const password2 = await promptPassphrase("Confirm password: ");
      if (password !== password2) {
        process.stderr.write("\nERROR: Passwords do not match. Run operator init again.\n\n");
        process.exit(1);
      }

      // Hash with Argon2id (same algorithm used in the server login route).
      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

      // Import Prisma client lazily so this module doesn't load DB machinery at parse time.
      const { getPrisma } = await import("../../server/db/prismaClient.js");
      const prisma = getPrisma();

      try {
        const operator = await prisma.operator.create({
          data: { email, passwordHash },
        });
        process.stderr.write(
          [
            "",
            `Operator created: id=${operator.id} email=${operator.email}`,
            "",
            "Next steps:",
            "  1. Ensure STABLERAILS_ENCRYPTED_SEED is set (run: stablerails seed init)",
            "  2. Start the server: npm run dev",
            "  3. Log in at http://localhost:3000/login",
            "  4. Mint your first admin API key at http://localhost:3000/api-keys",
            "  5. Export STABLERAILS_ADMIN_KEY=<your-new-key>",
            "  6. Create your first event: stablerails event create --name ...",
            "",
          ].join("\n"),
        );
      } catch (err: unknown) {
        // Duplicate email: Prisma P2002 unique constraint.
        const code = (err as { code?: string }).code;
        if (code === "P2002") {
          process.stderr.write(
            `\nERROR: An operator with email "${email}" already exists.\n` +
              "       Each email must be unique. Use a different email or log in.\n\n",
          );
          process.exit(1);
        }
        throw err;
      } finally {
        await prisma.$disconnect();
      }
    });

  operator
    .command("login-link")
    .description(
      [
        "Mint a fresh single-use magic login link for the dashboard.",
        "",
        "Direct DB access (DATABASE_URL) — works without an API key.",
        "The link is valid for 15 minutes and can be used exactly once.",
        "SECURITY: only the SHA-256 hash of the token is stored in the DB.",
      ].join("\n"),
    )
    .option(
      "--public-url <url>",
      "Public base URL for the link (default: PUBLIC_BASE_URL or http://localhost:3000)",
    )
    .action(async (opts: { publicUrl?: string }) => {
      if (!process.env["DATABASE_URL"]) {
        process.stderr.write(
          "\nERROR: DATABASE_URL is not set.\n" +
            "       Set it before running operator login-link:\n" +
            "         DATABASE_URL=postgres://... stablerails operator login-link\n\n",
        );
        process.exit(1);
      }

      const publicUrl =
        opts.publicUrl ?? process.env["PUBLIC_BASE_URL"] ?? "http://localhost:3000";

      const { getPrisma } = await import("../../server/db/prismaClient.js");
      const { mintLoginLink } = await import("../loginLink.js");
      const prisma = getPrisma();

      try {
        const op = await prisma.operator.findFirst({ select: { id: true, email: true } });
        if (!op) {
          process.stderr.write(
            "\nERROR: No operator account exists yet.\n" +
              "       Run: stablerails init   (or: stablerails operator init --email ...)\n\n",
          );
          process.exit(1);
        }

        const link = await mintLoginLink(
          {
            async createLoginToken(input) {
              await prisma.loginToken.create({ data: input });
            },
          },
          op.id,
          publicUrl,
        );

        // Raw token goes to STDOUT only — never through the logger.
        process.stderr.write(
          `\nMagic login link for ${op.email} (single-use, expires ` +
            `${link.expiresAt.toISOString()}):\n\n`,
        );
        process.stdout.write(link.url + "\n");
      } finally {
        await prisma.$disconnect();
      }
    });
}
