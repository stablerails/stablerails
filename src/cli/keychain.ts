/**
 * macOS Keychain storage for the seed passphrase (OPT-IN convenience).
 *
 * SECURITY MODEL:
 *   - This module only stores/reads/deletes the passphrase. It does NOT decide
 *     when the passphrase may be read — that decision lives in
 *     `promptSeedPassphrase` (src/cli/prompt.ts), which requires a TTY and a
 *     fresh Touch ID success (src/cli/biometric.ts) before calling
 *     `readKeychainPassphrase`.
 *   - The passphrase is NEVER passed as an argv element on the write path:
 *     `security add-generic-password ... -w <password>` would expose the
 *     secret to any local user via `ps`. Instead we spawn `security -i`
 *     (interactive mode) and write the command line to its stdin.
 *   - On the read path, `security find-generic-password ... -w` prints the
 *     secret to stdout; no secret appears in argv.
 *   - `security -i` may exit 0 even when the inner command failed, so every
 *     store is verified by reading the entry back and comparing. A mismatch
 *     deletes the entry and throws (fail-closed).
 *
 *   macOS ONLY: every exported function throws off-darwin.
 */

import { execFile } from "node:child_process";
import * as os from "node:os";

/** Keychain "service" name for the stablerails seed passphrase entry. */
export const KEYCHAIN_SERVICE = "stablerails-seed";

// ── Helpers ───────────────────────────────────────────────────────────────────

function assertDarwin(fn: string): void {
  if (process.platform !== "darwin") {
    throw new Error(
      `${fn} is macOS only (Keychain integration requires darwin; current platform: ${process.platform})`,
    );
  }
}

function keychainAccount(): string {
  return os.userInfo().username;
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Run `security <args>` (no secrets in argv on this path). */
function execSecurity(args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile("security", args, { encoding: "utf-8" }, (err, stdout, stderr) => {
      if (err) {
        reject(
          new Error(
            `security ${args[0] ?? ""} failed: ${String(stderr || err.message).trim()}`,
          ),
        );
      } else {
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    });
  });
}

/**
 * Quote a value for the `security -i` interactive command parser.
 *
 * The interactive tokenizer's quoting/escaping rules are not formally
 * documented, so we are deliberately conservative: only printable ASCII
 * WITHOUT double quotes or backslashes is accepted, wrapped in double quotes.
 * Anything else is rejected with a clear error directing the operator to the
 * typed-passphrase mode. The post-store read-back verification in
 * `storeKeychainPassphrase` backstops any residual quoting mismatch.
 */
function quoteForSecurityInteractive(value: string, what: string): string {
  if (!/^[\x20-\x7e]*$/.test(value) || value.includes('"') || value.includes("\\")) {
    throw new Error(
      `${what} contains characters that cannot be safely stored via the Keychain ` +
        'integration (allowed: printable ASCII without `"` or `\\`); ' +
        "use typed passphrase mode instead",
    );
  }
  return `"${value}"`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether the stablerails seed passphrase entry exists in the Keychain.
 * The entry doubles as the opt-in marker: it only exists if the operator ran
 * `seed keychain enable`. Does NOT read the secret (no `-w`).
 */
export async function keychainEntryExists(): Promise<boolean> {
  assertDarwin("keychainEntryExists");
  try {
    await execSecurity([
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      keychainAccount(),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the seed passphrase from the Keychain.
 *
 * SECURITY: callers MUST gate this behind a fresh Touch ID success in the
 * same process (see promptSeedPassphrase) — this function performs no
 * human-presence check itself.
 */
export async function readKeychainPassphrase(): Promise<string> {
  assertDarwin("readKeychainPassphrase");
  const { stdout } = await execSecurity([
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    keychainAccount(),
    "-w",
  ]);
  // `security ... -w` prints the secret followed by a single newline.
  return stdout.replace(/\n$/, "");
}

/**
 * Store the seed passphrase in the Keychain (upsert via `-U`).
 *
 * The secret travels via `security -i` stdin — never argv (ps exposure).
 * After the write, the entry is read back and compared; on mismatch the
 * entry is deleted and an error is thrown (fail-closed).
 */
export async function storeKeychainPassphrase(passphrase: string): Promise<void> {
  assertDarwin("storeKeychainPassphrase");
  if (passphrase.length === 0) {
    throw new Error("refusing to store an empty passphrase in the Keychain");
  }

  const quotedSecret = quoteForSecurityInteractive(passphrase, "passphrase");
  const quotedService = quoteForSecurityInteractive(KEYCHAIN_SERVICE, "keychain service name");
  const quotedAccount = quoteForSecurityInteractive(keychainAccount(), "keychain account name");

  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "security",
      ["-i"],
      { encoding: "utf-8" },
      (err, _stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `security -i add-generic-password failed: ${String(stderr || err.message).trim()}`,
            ),
          );
        } else {
          resolve();
        }
      },
    );
    // Secret goes through stdin of the interactive parser, NOT argv.
    child.stdin?.write(
      `add-generic-password -U -s ${quotedService} -a ${quotedAccount} -w ${quotedSecret}\n`,
    );
    child.stdin?.end();
  });

  // `security -i` can exit 0 even if the inner command failed (errors are
  // printed and the interactive loop continues to EOF) — verify by read-back.
  let readBack: string;
  try {
    readBack = await readKeychainPassphrase();
  } catch (err) {
    throw new Error(
      `Keychain store verification failed (could not read the entry back): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (readBack !== passphrase) {
    // Remove the corrupt entry so a wrong secret can never be served later.
    await deleteKeychainPassphrase().catch(() => undefined);
    throw new Error(
      "Keychain store verification failed: read-back mismatch; entry removed — " +
        "use typed passphrase mode",
    );
  }
}

/**
 * Delete the seed passphrase entry from the Keychain.
 *
 * @returns true if an entry was removed, false if none existed (idempotent).
 */
export async function deleteKeychainPassphrase(): Promise<boolean> {
  assertDarwin("deleteKeychainPassphrase");
  try {
    await execSecurity([
      "delete-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      keychainAccount(),
    ]);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/could not be found/i.test(message)) return false;
    throw err;
  }
}
