/**
 * CLI command: seed init
 *
 * Encrypts a BIP39 mnemonic with a passphrase and writes the encrypted blob
 * to STABLERAILS_SEED_FILE (or prints to stdout if the env var is unset).
 *
 * SECURITY:
 *   - The mnemonic and passphrase are ALWAYS read via hidden TTY readline.
 *   - They are NEVER accepted as CLI flags, arguments, or env vars.
 *   - promptPassphrase() enforces process.stdin.isTTY === true and rejects
 *     any non-interactive (piped/automated) invocation.
 *   - The mnemonic is NEVER logged. The passphrase is NEVER logged.
 *   - The command is intentionally NOT an MCP tool.
 *
 * WARNING: Write down your mnemonic and keep it offline in a safe place.
 *          The encrypted blob is only as secure as your passphrase.
 *          If you lose your mnemonic AND your passphrase, funds are unrecoverable.
 *
 * Usage:
 *   stablerails seed init
 *   STABLERAILS_SEED_FILE=/path/to/seed.json stablerails seed init
 */

import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { decryptSeed, encryptSeed } from "../../signer/seed.js";
import { checkBiometricAvailability, runBiometricGate } from "../biometric.js";
import {
  deleteKeychainPassphrase,
  keychainEntryExists,
  storeKeychainPassphrase,
} from "../keychain.js";
import { promptPassphrase } from "../prompt.js";
import { encryptedSeedFromEnv } from "../seedStore.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Prompt for the mnemonic via hidden TTY readline.
 * Reuses the same TTY enforcement as promptPassphrase.
 */
async function promptMnemonic(): Promise<string> {
  return promptPassphrase(
    "Enter your BIP39 mnemonic (12 or 24 words, hidden input — or press Enter to generate one): ",
  );
}

// ── Interactive seed init flow (shared with `stablerails init`) ───────────────

/**
 * Interactive seed-init flow: prompt for (or generate) a BIP39 mnemonic,
 * encrypt it with a TTY-entered passphrase, write the blob to
 * STABLERAILS_SEED_FILE (or stdout).
 *
 * Exported so `stablerails init` can reuse the EXACT same flow (no duplicated
 * crypto, no weakened gates). All prompts go through promptPassphrase(), which
 * rejects non-TTY stdin — automation can never feed the passphrase.
 */
export async function runSeedInitInteractive(): Promise<void> {
  // ── SECURITY GATE ──────────────────────────────────────────────────────
  // Both prompts below call promptPassphrase(), which throws if
  // process.stdin.isTTY !== true — non-interactive invocations are rejected
  // before any seed or passphrase bytes are read.
  // ── END GATE ───────────────────────────────────────────────────────────

  process.stderr.write(
    [
      "",
      "=== Stablerails seed init ===",
      "",
      "You will be prompted for your BIP39 mnemonic.",
      "Leave blank and press Enter to GENERATE a new 24-word mnemonic.",
      "",
      "WARNING: Write down your mnemonic and store it offline.",
      "         Do not share it with anyone.",
      "         If you lose the mnemonic, funds are unrecoverable.",
      "",
    ].join("\n"),
  );

  // Step 1: read (or generate) the mnemonic.
  const rawInput = await promptMnemonic();
  let mnemonic: string;

  if (!rawInput.trim()) {
    // Generate a fresh 24-word mnemonic (256 bits of entropy).
    mnemonic = generateMnemonic(wordlist, 256);
    process.stderr.write(
      [
        "",
        "Generated mnemonic (24 words):",
        "──────────────────────────────────────────────────────────────",
        mnemonic,
        "──────────────────────────────────────────────────────────────",
        "",
        "WRITE THIS DOWN NOW and store it in a secure offline location.",
        "You will NOT see it again after this command completes.",
        "",
      ].join("\n"),
    );
  } else {
    mnemonic = rawInput.trim();
  }

  // Validate before encrypting — catch typos early.
  if (!validateMnemonic(mnemonic, wordlist)) {
    process.stderr.write(
      "\nERROR: The mnemonic you entered is not a valid BIP39 mnemonic.\n" +
        "       Check for typos and try again.\n\n",
    );
    process.exit(1);
  }

  // Step 2: read passphrase (with confirmation).
  const passphrase = await promptPassphrase("Enter a strong passphrase to encrypt the seed: ");
  if (!passphrase) {
    process.stderr.write(
      "\nERROR: Passphrase cannot be empty. Choose a strong passphrase.\n\n",
    );
    process.exit(1);
  }

  const passphrase2 = await promptPassphrase("Confirm passphrase: ");
  if (passphrase !== passphrase2) {
    process.stderr.write("\nERROR: Passphrases do not match. Run `seed init` again.\n\n");
    process.exit(1);
  }

  // Step 3: encrypt.
  const blob = await encryptSeed(mnemonic, passphrase);
  const blobJson = JSON.stringify(blob, null, 2);

  // Step 4: write to file or stdout.
  const seedFile = process.env["STABLERAILS_SEED_FILE"];
  if (seedFile) {
    writeFileSync(seedFile, blobJson + "\n", { encoding: "utf-8", mode: 0o600 });
    process.stderr.write(`\nEncrypted seed written to: ${seedFile}\n`);
    process.stderr.write("Permissions set to 0600 (owner-only read).\n");
    process.stderr.write(
      "\nNext step: set STABLERAILS_SEED_FILE=" + seedFile + " in your environment\n" +
        "or set STABLERAILS_ENCRYPTED_SEED to the JSON blob from that file.\n\n",
    );
  } else {
    // Print to stdout — operator stores it manually.
    process.stdout.write(blobJson + "\n");
    process.stderr.write(
      [
        "",
        "No STABLERAILS_SEED_FILE set — blob printed to stdout.",
        "Store the JSON blob in a secure location and set one of:",
        "  STABLERAILS_SEED_FILE=/path/to/seed.json",
        "  STABLERAILS_ENCRYPTED_SEED='<the JSON blob>'",
        "",
      ].join("\n"),
    );
  }

  process.stderr.write("seed init complete.\n\n");
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerSeedCommands(parent: Command): void {
  const seed = parent.command("seed").description("Seed management (self-custody setup)");

  seed
    .command("init")
    .description(
      [
        "Encrypt a BIP39 mnemonic and write the blob to STABLERAILS_SEED_FILE (or stdout).",
        "",
        "SECURITY: mnemonic and passphrase are read via hidden TTY input — NEVER as",
        "flags, arguments, or env vars. Requires an interactive terminal (not piped).",
        "",
        "WARNING: Write down your mnemonic offline. If you lose both the mnemonic",
        "and the passphrase, funds locked to those addresses are unrecoverable.",
      ].join("\n"),
    )
    .action(runSeedInitInteractive);

  // ── seed keychain — macOS Keychain + Touch ID convenience (OPT-IN) ─────────

  const keychainCmd = seed
    .command("keychain")
    .description(
      "macOS Keychain + Touch ID passphrase convenience (opt-in; typed passphrase always works)",
    );

  keychainCmd
    .command("enable")
    .description(
      [
        "Store the seed passphrase in the macOS Keychain (opt-in).",
        "",
        "At signing time the passphrase is read from the Keychain ONLY after a",
        "fresh Touch ID success (biometrics-only policy — no macOS-password",
        "fallback). Requires an interactive terminal and working Touch ID.",
        "Escape hatch: STABLERAILS_NO_KEYCHAIN=1 forces typed passphrase mode.",
      ].join("\n"),
    )
    .action(async () => {
      if (process.platform !== "darwin") {
        throw new Error("seed keychain enable is macOS only");
      }

      // Refuse early if biometrics cannot work on this machine — the keychain
      // mode is only safe when Touch ID is the human-presence check.
      const availability = await checkBiometricAvailability();
      if (!availability.ok) {
        throw new Error(
          `Keychain mode requires Touch ID on this Mac (${availability.detail})`,
        );
      }

      // ── SECURITY GATE ──────────────────────────────────────────────────────
      // promptPassphrase enforces process.stdin.isTTY === true — the passphrase
      // is typed at a real terminal, never piped.
      // ── END GATE ───────────────────────────────────────────────────────────
      const passphrase = await promptPassphrase(
        "Enter the seed passphrase to store in the Keychain: ",
      );

      // Verify the passphrase against the configured encrypted seed BEFORE
      // storing anything — a typo stored in the Keychain would brick sweeps.
      const blob = encryptedSeedFromEnv();
      try {
        await decryptSeed(blob, passphrase);
      } catch {
        throw new Error(
          "passphrase verification failed: it does not decrypt the configured " +
            "encrypted seed — nothing was stored",
        );
      }

      // One real Touch ID evaluation proves biometrics work end-to-end here.
      const gate = await runBiometricGate(
        "enable Keychain storage of the Stablerails seed passphrase",
      );
      if (!gate.ok) {
        throw new Error(`Touch ID check failed (${gate.detail}) — nothing was stored`);
      }

      await storeKeychainPassphrase(passphrase);
      process.stderr.write(
        [
          "",
          "Seed passphrase stored in the macOS Keychain (service: stablerails-seed).",
          "At signing time you will confirm with Touch ID instead of typing it.",
          "Disable any time with: stablerails seed keychain disable",
          "Force typed mode without disabling: STABLERAILS_NO_KEYCHAIN=1",
          "",
        ].join("\n"),
      );
    });

  keychainCmd
    .command("disable")
    .description("Delete the stored seed passphrase from the macOS Keychain.")
    .action(async () => {
      if (process.platform !== "darwin") {
        throw new Error("seed keychain disable is macOS only");
      }
      const removed = await deleteKeychainPassphrase();
      process.stderr.write(
        removed
          ? "Keychain entry deleted — typed passphrase mode is back in effect.\n"
          : "No Keychain entry found — nothing to delete.\n",
      );
    });

  keychainCmd
    .command("status")
    .description(
      "Report Keychain/Touch ID availability and entry presence (no secrets).",
    )
    .action(async () => {
      const isDarwin = process.platform === "darwin";
      const lines: string[] = [`platform: ${process.platform} (macOS: ${isDarwin ? "yes" : "no"})`];

      if (isDarwin) {
        const availability = await checkBiometricAvailability();
        lines.push(
          `touch id: ${availability.ok ? "available" : `unavailable (${availability.detail})`}`,
        );
        const hasEntry = await keychainEntryExists();
        lines.push(`keychain entry (stablerails-seed): ${hasEntry ? "present" : "absent"}`);
      } else {
        lines.push("touch id: unavailable (macOS only)");
        lines.push("keychain entry (stablerails-seed): n/a (macOS only)");
      }
      lines.push(
        `typed-mode override (STABLERAILS_NO_KEYCHAIN=1): ${
          process.env["STABLERAILS_NO_KEYCHAIN"] === "1" ? "active" : "off"
        }`,
      );

      process.stdout.write(lines.join("\n") + "\n");
    });
}
