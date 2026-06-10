/**
 * Keychain / Touch ID opt-in passphrase flow tests.
 *
 * Covers the gate order of `promptSeedPassphrase`:
 *   TTY check → STABLERAILS_NO_KEYCHAIN → darwin → keychain entry exists
 *   → Touch ID success → keychain read → fallback to typed prompt.
 *
 * All tests are OFFLINE:
 *   - `node:child_process` execFile is mocked (no real `security` / `swiftc`).
 *   - `../biometric.js` is mocked at module level (no Swift compile, no prompt).
 *   - `node:readline` is mocked so the typed-prompt fallback resolves a fixed
 *     string instead of waiting on a real terminal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { execFileMock, runBiometricGateMock, checkBiometricAvailabilityMock, TYPED_ANSWER } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    runBiometricGateMock: vi.fn(),
    checkBiometricAvailabilityMock: vi.fn(),
    // The typed-prompt fallback uses readline on the TTY; the readline mock
    // below resolves TYPED_ANSWER.value immediately (no real terminal in vitest).
    TYPED_ANSWER: { value: "typed-passphrase" },
  }));

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock("../biometric.js", () => ({
  runBiometricGate: (...args: unknown[]) => runBiometricGateMock(...args),
  checkBiometricAvailability: (...args: unknown[]) =>
    checkBiometricAvailabilityMock(...args),
}));

vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => {
      setImmediate(() => cb(TYPED_ANSWER.value));
    },
    close: () => {},
    on: () => {},
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

function fakeChild(): { stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } } {
  return { stdin: { write: vi.fn(), end: vi.fn() } };
}

/** Extract the trailing callback regardless of whether options were passed. */
function pickCallback(optsOrCb: unknown, maybeCb: unknown): ExecCallback {
  return (typeof optsOrCb === "function" ? optsOrCb : maybeCb) as ExecCallback;
}

function notFoundError(): Error {
  return Object.assign(
    new Error("security: The specified item could not be found in the keychain."),
    { code: 44 },
  );
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function setIsTTY(value: boolean | undefined): void {
  (process.stdin as NodeJS.ReadStream & { isTTY: boolean | undefined }).isTTY =
    value as unknown as boolean;
}

const savedPlatform = process.platform;
const savedIsTTY = process.stdin.isTTY;
const SAVED_ENV_KEYS = [
  "STABLERAILS_NO_KEYCHAIN",
  "STABLERAILS_ENCRYPTED_SEED",
  "STABLERAILS_SEED_FILE",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of SAVED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  TYPED_ANSWER.value = "typed-passphrase";
  execFileMock.mockReset();
  runBiometricGateMock.mockReset();
  checkBiometricAvailabilityMock.mockReset();
});

afterEach(() => {
  setPlatform(savedPlatform);
  setIsTTY(savedIsTTY);
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
    else delete process.env[key];
  }
});

// ── promptSeedPassphrase gate order ──────────────────────────────────────────

describe("promptSeedPassphrase", () => {
  it("rejects when stdin is not a TTY (same gate as promptPassphrase)", async () => {
    const { promptSeedPassphrase } = await import("../prompt.js");
    setPlatform("darwin");
    setIsTTY(undefined);

    await expect(promptSeedPassphrase("Enter passphrase: ")).rejects.toThrow(
      /passphrase must be entered interactively/,
    );
    // Nothing else was consulted before the TTY gate.
    expect(execFileMock).not.toHaveBeenCalled();
    expect(runBiometricGateMock).not.toHaveBeenCalled();
  });

  it("(a) falls back to typed prompt when no keychain entry exists", async () => {
    const { promptSeedPassphrase } = await import("../prompt.js");
    setPlatform("darwin");
    setIsTTY(true);

    // find-generic-password (existence probe) fails → no entry.
    execFileMock.mockImplementation(
      (_file: string, _args: string[], optsOrCb: unknown, maybeCb: unknown) => {
        const cb = pickCallback(optsOrCb, maybeCb);
        setImmediate(() => cb(notFoundError(), "", "not found"));
        return fakeChild();
      },
    );

    await expect(promptSeedPassphrase("Enter passphrase: ")).resolves.toBe(
      "typed-passphrase",
    );
    // Biometric gate must NOT run when there is no keychain entry.
    expect(runBiometricGateMock).not.toHaveBeenCalled();
  });

  it("(b) reads keychain only AFTER biometric success", async () => {
    const { promptSeedPassphrase } = await import("../prompt.js");
    setPlatform("darwin");
    setIsTTY(true);

    const order: string[] = [];
    runBiometricGateMock.mockImplementation(async () => {
      order.push("biometric");
      return { ok: true, detail: "" };
    });
    execFileMock.mockImplementation(
      (_file: string, args: string[], optsOrCb: unknown, maybeCb: unknown) => {
        const cb = pickCallback(optsOrCb, maybeCb);
        if (args.includes("find-generic-password") && args.includes("-w")) {
          order.push("keychain-read");
          setImmediate(() => cb(null, "kc-secret\n", ""));
        } else if (args.includes("find-generic-password")) {
          // Existence probe (no -w): entry exists.
          setImmediate(() => cb(null, "", ""));
        } else {
          setImmediate(() => cb(new Error(`unexpected security call: ${args.join(" ")}`), "", ""));
        }
        return fakeChild();
      },
    );

    await expect(promptSeedPassphrase("Enter passphrase: ")).resolves.toBe("kc-secret");
    expect(runBiometricGateMock).toHaveBeenCalledOnce();
    // The secret read happens strictly after a fresh biometric success.
    expect(order).toEqual(["biometric", "keychain-read"]);
  });

  it("(c) biometric failure → typed fallback, keychain secret NOT read", async () => {
    const { promptSeedPassphrase } = await import("../prompt.js");
    setPlatform("darwin");
    setIsTTY(true);

    runBiometricGateMock.mockResolvedValue({ ok: false, detail: "user cancelled" });
    execFileMock.mockImplementation(
      (_file: string, args: string[], optsOrCb: unknown, maybeCb: unknown) => {
        const cb = pickCallback(optsOrCb, maybeCb);
        if (args.includes("find-generic-password") && !args.includes("-w")) {
          setImmediate(() => cb(null, "", "")); // entry exists
        } else {
          setImmediate(() => cb(new Error("should not be called"), "", ""));
        }
        return fakeChild();
      },
    );

    await expect(promptSeedPassphrase("Enter passphrase: ")).resolves.toBe(
      "typed-passphrase",
    );
    // FAIL-CLOSED: no execFile call ever included `-w` (no secret read).
    const secretReads = execFileMock.mock.calls.filter((call) =>
      (call[1] as string[]).includes("-w"),
    );
    expect(secretReads).toHaveLength(0);
  });

  it("(d) STABLERAILS_NO_KEYCHAIN=1 forces typed mode (keychain never consulted)", async () => {
    const { promptSeedPassphrase } = await import("../prompt.js");
    setPlatform("darwin");
    setIsTTY(true);
    process.env["STABLERAILS_NO_KEYCHAIN"] = "1";

    await expect(promptSeedPassphrase("Enter passphrase: ")).resolves.toBe(
      "typed-passphrase",
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(runBiometricGateMock).not.toHaveBeenCalled();
  });

  it("(e) non-darwin platform → typed mode (keychain never consulted)", async () => {
    const { promptSeedPassphrase } = await import("../prompt.js");
    setPlatform("linux");
    setIsTTY(true);

    await expect(promptSeedPassphrase("Enter passphrase: ")).resolves.toBe(
      "typed-passphrase",
    );
    expect(execFileMock).not.toHaveBeenCalled();
    expect(runBiometricGateMock).not.toHaveBeenCalled();
  });
});

// ── seed keychain enable ──────────────────────────────────────────────────────

describe("seed keychain enable", () => {
  it("(f) refuses to store when the passphrase does not decrypt the configured seed", async () => {
    // Load the native argon2 binding (via signer/seed.js) BEFORE mocking
    // process.platform: node-gyp-build resolves the prebuild from
    // process.platform at first load, so importing under a faked "darwin"
    // makes a Linux CI runner pick the Mach-O binary (invalid ELF header).
    // Once loaded, the module is cached and the platform mock is safe.
    const { encryptSeed } = await import("../../signer/seed.js");
    const TEST_MNEMONIC =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    // Configure a real encrypted seed blob whose passphrase is NOT the typed one.
    const blob = await encryptSeed(TEST_MNEMONIC, "correct-passphrase");

    setPlatform("darwin");
    setIsTTY(true);
    checkBiometricAvailabilityMock.mockResolvedValue({ ok: true, detail: "Touch ID available" });

    process.env["STABLERAILS_ENCRYPTED_SEED"] = JSON.stringify(blob);
    TYPED_ANSWER.value = "wrong-passphrase";

    const { registerSeedCommands } = await import("../commands/seed.js");
    const program = new Command();
    program.exitOverride();
    registerSeedCommands(program);

    await expect(
      program.parseAsync(["node", "stablerails", "seed", "keychain", "enable"]),
    ).rejects.toThrow(/does not decrypt/);

    // Nothing was stored and no Touch ID evaluation ran after the failed verify.
    expect(runBiometricGateMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ── storeKeychainPassphrase quoting safety ────────────────────────────────────

describe("KEYCHAIN_SERVICE contract", () => {
  it("uses the stablerails-seed Keychain service name", async () => {
    const { KEYCHAIN_SERVICE } = await import("../keychain.js");
    expect(KEYCHAIN_SERVICE).toBe("stablerails-seed");
  });
});

describe("storeKeychainPassphrase quoting safety", () => {
  it("rejects passphrases with characters that cannot be safely quoted for `security -i`", async () => {
    const { storeKeychainPassphrase } = await import("../keychain.js");
    setPlatform("darwin");

    await expect(storeKeychainPassphrase('pass"phrase')).rejects.toThrow(
      /cannot be safely stored/,
    );
    await expect(storeKeychainPassphrase("pass\nphrase")).rejects.toThrow(
      /cannot be safely stored/,
    );
    await expect(storeKeychainPassphrase("pass\\phrase")).rejects.toThrow(
      /cannot be safely stored/,
    );
    // The secret never reached the `security` process.
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
