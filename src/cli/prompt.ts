/**
 * Secure TTY readline prompt for passphrases.
 *
 * SECURITY: The passphrase MUST come from a human at an interactive terminal.
 * This module enforces `process.stdin.isTTY === true` and REJECTS any
 * non-interactive input (piped stdin, redirected input, CI, MCP tool invocation).
 *
 * Rationale: an automated agent spawning the CLI process can pipe bytes into
 * stdin (e.g. `echo "secret" | stablerails sweep execute --intent X`), which
 * would bypass the intended human gate. The `isTTY` check closes that bypass —
 * if stdin is not a real terminal the command fails before reading any bytes.
 *
 * Input echo is suppressed by hooking the readline `_writeToOutput` hook
 * (portable across Node.js versions).
 */

import * as readline from "node:readline";
import { runBiometricGate } from "./biometric.js";
import { keychainEntryExists, readKeychainPassphrase } from "./keychain.js";

/**
 * Single source for the non-interactive rejection so promptPassphrase and
 * promptSeedPassphrase enforce the EXACT same TTY gate.
 */
function nonInteractiveError(): Error {
  return new Error(
    "passphrase must be entered interactively at a terminal; " +
      "piped/non-interactive input is rejected for security",
  );
}

/**
 * Prompt for a passphrase on the terminal with hidden input (no echo).
 *
 * SECURITY: Throws if `process.stdin.isTTY` is not `true`. This rejects
 * piped stdin, redirected input, and any non-interactive invocation so that
 * an automated agent cannot feed the passphrase non-interactively.
 *
 * @param prompt  Text to display (e.g. "Enter passphrase: ")
 * @returns       The passphrase string (trimmed).
 * @throws        If stdin is not an interactive TTY.
 */
export function promptPassphrase(prompt: string): Promise<string> {
  // ── SECURITY GATE ────────────────────────────────────────────────────────
  // Reject non-interactive input BEFORE creating the readline interface.
  // This prevents piped stdin (`echo "secret" | stablerails sweep execute`) from
  // satisfying the passphrase prompt — an attack an automated agent controls.
  if (process.stdin.isTTY !== true) {
    return Promise.reject(nonInteractiveError());
  }
  // ── END GATE ─────────────────────────────────────────────────────────────

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    // Hide input by writing the prompt ourselves and suppressing echo.
    process.stderr.write(prompt);

    // Use the _writeToOutput hook to suppress echoed characters.
    (rl as unknown as { _writeToOutput: (value: string) => void })._writeToOutput = (value: string) => {
      // Allow only the newline that follows Enter — suppress all else.
      if (value === "\n" || value === "\r\n" || value === "\r") {
        process.stderr.write("\n");
      }
    };

    rl.question("", (answer: string) => {
      rl.close();
      resolve(answer);
    });

    rl.on("error", (err: Error) => {
      reject(err);
    });
  });
}

/**
 * Prompt for the SEED passphrase, with the opt-in macOS Keychain + Touch ID
 * convenience (see src/cli/keychain.ts and src/cli/biometric.ts).
 *
 * GATE ORDER (each step fails closed to the next / to typed input):
 *   1. TTY gate — identical to promptPassphrase: `process.stdin.isTTY === true`
 *      or reject. The human gate is NEVER weakened by the keychain mode.
 *   2. `STABLERAILS_NO_KEYCHAIN=1` env escape hatch → typed prompt.
 *   3. Non-darwin platform → typed prompt.
 *   4. No keychain entry (the entry IS the opt-in marker, created only by
 *      `seed keychain enable`) → typed prompt.
 *   5. Touch ID gate (biometrics-only policy). The biometric prompt is the
 *      human-presence check in keychain mode.
 *   6. ONLY after a fresh biometric success in this same process: read the
 *      passphrase from the Keychain.
 *
 * FAIL-CLOSED: if the keychain HAS the passphrase but biometrics are
 * unavailable or fail, the Keychain is NOT read — the operator types the
 * passphrase instead.
 *
 * @param promptText  Text for the typed-prompt fallback (e.g. "Enter passphrase: ")
 * @returns           The passphrase (from Keychain after Touch ID, or typed).
 * @throws            If stdin is not an interactive TTY.
 */
export async function promptSeedPassphrase(promptText: string): Promise<string> {
  // ── SECURITY GATE (same as promptPassphrase) ─────────────────────────────
  if (process.stdin.isTTY !== true) {
    throw nonInteractiveError();
  }
  // ── END GATE ─────────────────────────────────────────────────────────────

  if (process.env["STABLERAILS_NO_KEYCHAIN"] === "1") {
    return promptPassphrase(promptText);
  }
  if (process.platform !== "darwin") {
    return promptPassphrase(promptText);
  }

  let hasEntry = false;
  try {
    hasEntry = await keychainEntryExists();
  } catch {
    hasEntry = false; // any keychain probe error → typed mode
  }
  if (!hasEntry) {
    return promptPassphrase(promptText);
  }

  process.stderr.write("Using Keychain passphrase — confirm with Touch ID…\n");
  const gate = await runBiometricGate("unlock the Stablerails seed passphrase");
  if (!gate.ok) {
    process.stderr.write(
      `Touch ID failed or unavailable (${gate.detail}) — falling back to typed passphrase.\n`,
    );
    return promptPassphrase(promptText);
  }

  try {
    return await readKeychainPassphrase();
  } catch (err) {
    process.stderr.write(
      `Keychain read failed (${err instanceof Error ? err.message : String(err)}) — ` +
        "falling back to typed passphrase.\n",
    );
    return promptPassphrase(promptText);
  }
}
