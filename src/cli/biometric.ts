/**
 * Touch ID (biometric) gate for the macOS Keychain passphrase flow.
 *
 * A tiny Swift helper (embedded below, compiled on first use) evaluates
 * `LAContext().evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, ...)`.
 *
 * WHY `.deviceOwnerAuthenticationWithBiometrics` (biometrics ONLY):
 *   The alternative policy `.deviceOwnerAuthentication` silently falls back
 *   to the typed macOS account password, which would weaken the human gate
 *   from "physically present operator with an enrolled fingerprint" to
 *   "anyone who knows the Mac password". We refuse that downgrade — if
 *   biometrics are unavailable or fail, the caller falls back to the TYPED
 *   SEED passphrase prompt, never to the Keychain secret.
 *
 * FAIL-CLOSED CONTRACT (enforced by promptSeedPassphrase in prompt.ts):
 *   missing swiftc, compile failure, unavailable biometrics, cancelled or
 *   failed evaluation — all map to `{ ok: false }` and the Keychain is NOT
 *   read. These functions never throw; they report unavailability instead.
 *
 * COMPILE / CACHE SCHEME:
 *   The helper binary is cached at
 *   `~/.stablerails/bin/stablerails-biometric-<8-char-sha256-of-source>` (dir mode
 *   0700, binary mode 0700). The source hash in the filename makes the cache
 *   self-invalidating: changing the embedded Swift source changes the path,
 *   forcing a recompile; stale siblings are best-effort cleaned up.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

export interface BiometricResult {
  /** true only on a fresh successful biometric evaluation (or `--check` pass). */
  ok: boolean;
  /** Human-readable reason when ok === false ("" on success). */
  detail: string;
}

// ── Embedded Swift helper ─────────────────────────────────────────────────────
// Exit codes: 0 = success (or --check: biometrics available),
//             1 = biometric evaluation failed / cancelled,
//             2 = biometrics unavailable on this machine.
// String.raw keeps Swift's `\(...)` interpolation and `\n` escapes intact.
const SWIFT_SOURCE = String.raw`// Stablerails Touch ID gate helper (generated from src/cli/biometric.ts).
//
// Policy: .deviceOwnerAuthenticationWithBiometrics — biometrics ONLY.
// .deviceOwnerAuthentication is deliberately NOT used: it silently falls back
// to the typed macOS account password, weakening the human-presence gate to
// "knows the Mac password".
import Foundation
import LocalAuthentication

let args = CommandLine.arguments
let context = LAContext()
var availabilityError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &availabilityError) else {
    let detail = availabilityError?.localizedDescription ?? "biometrics unavailable"
    FileHandle.standardError.write((detail + "\n").data(using: .utf8)!)
    exit(2)
}
if args.count > 1 && args[1] == "--check" {
    exit(0)
}
let reason = args.count > 1 ? args[1] : "authenticate to Stablerails"
let semaphore = DispatchSemaphore(value: 0)
var success = false
var failureDetail = "authentication failed"
context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, error in
    success = ok
    if !ok, let error = error {
        failureDetail = error.localizedDescription
    }
    semaphore.signal()
}
semaphore.wait()
if !success {
    FileHandle.standardError.write((failureDetail + "\n").data(using: .utf8)!)
    exit(1)
}
exit(0)
`;

// ── Compile cache ─────────────────────────────────────────────────────────────

const HELPER_PREFIX = "stablerails-biometric-";

function sourceHash8(): string {
  return createHash("sha256").update(SWIFT_SOURCE, "utf-8").digest("hex").slice(0, 8);
}

function helperDir(): string {
  return join(os.homedir(), ".stablerails", "bin");
}

function helperPath(): string {
  return join(helperDir(), `${HELPER_PREFIX}${sourceHash8()}`);
}

interface ExecOutcome {
  stdout: string;
  stderr: string;
}

function execFileP(file: string, args: string[]): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf-8" }, (err, stdout, stderr) => {
      if (err) {
        reject(
          Object.assign(new Error(String(stderr || err.message).trim()), {
            stderr: String(stderr ?? ""),
          }),
        );
      } else {
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    });
  });
}

/** Compile (if needed) and return the cached helper binary path. */
async function ensureHelperBinary(): Promise<string> {
  const bin = helperPath();
  if (existsSync(bin)) return bin;

  mkdirSync(helperDir(), { recursive: true, mode: 0o700 });
  const srcPath = `${bin}.swift`;
  writeFileSync(srcPath, SWIFT_SOURCE, { encoding: "utf-8", mode: 0o600 });
  try {
    try {
      await execFileP("xcrun", ["swiftc", "-O", "-o", bin, srcPath]);
    } catch {
      // No xcrun (or it failed) — try a bare swiftc on PATH.
      await execFileP("swiftc", ["-O", "-o", bin, srcPath]);
    }
  } finally {
    rmSync(srcPath, { force: true });
  }
  chmodSync(bin, 0o700);

  // Best-effort cleanup of stale binaries from previous source versions.
  try {
    for (const entry of readdirSync(helperDir())) {
      if (entry.startsWith(HELPER_PREFIX) && join(helperDir(), entry) !== bin) {
        rmSync(join(helperDir(), entry), { force: true });
      }
    }
  } catch {
    // Cleanup is cosmetic; never fail the gate over it.
  }
  return bin;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function runHelper(args: string[]): Promise<BiometricResult> {
  if (process.platform !== "darwin") {
    return { ok: false, detail: "Touch ID is macOS only" };
  }
  let bin: string;
  try {
    bin = await ensureHelperBinary();
  } catch (err) {
    return {
      ok: false,
      detail:
        "could not build the Touch ID helper (swiftc missing or compile failed): " +
        (err instanceof Error ? err.message : String(err)),
    };
  }
  try {
    await execFileP(bin, args);
    return { ok: true, detail: "" };
  } catch (err) {
    const detail = err instanceof Error && err.message ? err.message : "biometric check failed";
    return { ok: false, detail };
  }
}

/**
 * Report whether biometrics are available on this machine (no prompt shown —
 * the helper's `--check` mode only calls `canEvaluatePolicy`).
 */
export async function checkBiometricAvailability(): Promise<BiometricResult> {
  return runHelper(["--check"]);
}

/**
 * Show the Touch ID prompt and wait for the operator.
 *
 * @param reason  Shown in the system biometric dialog (helper argv[1]).
 * @returns       ok === true ONLY on a fresh successful biometric evaluation
 *                in this process. Never throws.
 */
export async function runBiometricGate(reason: string): Promise<BiometricResult> {
  // Never forward the helper's no-prompt "--check" mode as a reason string —
  // that would skip the actual biometric evaluation.
  const safeReason = reason === "--check" || reason.length === 0 ? "authenticate to Stablerails" : reason;
  return runHelper([safeReason]);
}
