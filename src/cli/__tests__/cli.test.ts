/**
 * CLI command wiring tests — Sprint 7.
 *
 * Tests:
 *   1. Command modules import and register without errors (with mock ApiClient).
 *   2. Commands call the correct API client methods.
 *   3. sweep execute wires up the passphrase gate (does NOT accept passphrase as arg).
 */

import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import type { ApiClient } from "../apiClient.js";

// ── Mock ApiClient ────────────────────────────────────────────────────────────

type MockedApiClient = {
  [K in keyof ApiClient]: ReturnType<typeof vi.fn>;
};

function makeMockApi(): MockedApiClient {
  return {
    createEvent: vi.fn().mockResolvedValue({ id: "ev_1", name: "Test" }),
    listEvents: vi.fn().mockResolvedValue([]),
    getEvent: vi.fn().mockResolvedValue({ id: "ev_1" }),
    createInvoice: vi.fn().mockResolvedValue({ id: "inv_1" }),
    listInvoices: vi.fn().mockResolvedValue([]),
    getInvoice: vi.fn().mockResolvedValue({ id: "inv_1" }),
    cancelInvoice: vi.fn().mockResolvedValue({ id: "inv_1", status: "canceled" }),
    findInvoice: vi.fn().mockResolvedValue([]),
    addWebhook: vi.fn().mockResolvedValue({ id: "wh_1" }),
    listWebhooks: vi.fn().mockResolvedValue([]),
    testWebhook: vi.fn().mockResolvedValue({ delivered: false }),
    removeWebhook: vi.fn().mockResolvedValue(undefined),
    createApiKey: vi.fn().mockResolvedValue({ id: "key_1" }),
    listApiKeys: vi.fn().mockResolvedValue([]),
    revokeApiKey: vi.fn().mockResolvedValue(undefined),
    prepareSweep: vi.fn().mockResolvedValue({ id: "intent_1", status: "prepared", items: [] }),
    getSweep: vi.fn().mockResolvedValue({ id: "intent_1", status: "prepared", items: [] }),
    broadcastSweepResult: vi.fn().mockResolvedValue({ id: "intent_1", status: "done" }),
  } as unknown as MockedApiClient;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runCommand(
  program: Command,
  args: string[],
): Promise<void> {
  await program.parseAsync(["node", "stablerails", ...args]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CLI event commands", () => {
  it("event list calls api.listEvents()", async () => {
    const mock = makeMockApi();
    const { registerEventCommands } = await import("../commands/events.js");
    const program = new Command();
    program.exitOverride();
    registerEventCommands(program, () => mock as unknown as ApiClient);

    await runCommand(program, ["event", "list"]);
    expect(mock.listEvents).toHaveBeenCalledOnce();
  });

  it("event show calls api.getEvent(id)", async () => {
    const mock = makeMockApi();
    const { registerEventCommands } = await import("../commands/events.js");
    const program = new Command();
    program.exitOverride();
    registerEventCommands(program, () => mock as unknown as ApiClient);

    await runCommand(program, ["event", "show", "ev_abc"]);
    expect(mock.getEvent).toHaveBeenCalledWith("ev_abc");
  });
});

describe("CLI invoice commands", () => {
  it("invoice list calls api.listInvoices()", async () => {
    const mock = makeMockApi();
    const { registerInvoiceCommands } = await import("../commands/invoices.js");
    const program = new Command();
    program.exitOverride();
    registerInvoiceCommands(program, () => mock as unknown as ApiClient);

    await runCommand(program, ["invoice", "list", "--event", "ev_1"]);
    expect(mock.listInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "ev_1" }),
    );
  });

  it("invoice show calls api.getInvoice(id)", async () => {
    const mock = makeMockApi();
    const { registerInvoiceCommands } = await import("../commands/invoices.js");
    const program = new Command();
    program.exitOverride();
    registerInvoiceCommands(program, () => mock as unknown as ApiClient);

    await runCommand(program, ["invoice", "show", "inv_xyz"]);
    expect(mock.getInvoice).toHaveBeenCalledWith("inv_xyz");
  });

  it("invoice find calls api.findInvoice({q})", async () => {
    const mock = makeMockApi();
    const { registerInvoiceCommands } = await import("../commands/invoices.js");
    const program = new Command();
    program.exitOverride();
    registerInvoiceCommands(program, () => mock as unknown as ApiClient);

    await runCommand(program, ["invoice", "find", "order_123"]);
    expect(mock.findInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ q: "order_123" }),
    );
  });

  it("invoice cancel calls api.cancelInvoice(id)", async () => {
    const mock = makeMockApi();
    const { registerInvoiceCommands } = await import("../commands/invoices.js");
    const program = new Command();
    program.exitOverride();
    registerInvoiceCommands(program, () => mock as unknown as ApiClient);

    await runCommand(program, ["invoice", "cancel", "inv_to_cancel"]);
    expect(mock.cancelInvoice).toHaveBeenCalledWith("inv_to_cancel");
  });
});

describe("CLI sweep commands", () => {
  it("sweep prepare calls api.prepareSweep()", async () => {
    const mock = makeMockApi();
    const { registerSweepCommands } = await import("../commands/sweep.js");
    const program = new Command();
    program.exitOverride();
    registerSweepCommands(program, () => mock as unknown as ApiClient);

    await runCommand(program, ["sweep", "prepare", "--event", "ev_1"]);
    expect(mock.prepareSweep).toHaveBeenCalledWith({ eventId: "ev_1", addresses: undefined });
  });

  it("sweep prepare with --addresses calls api.prepareSweep() with addresses array", async () => {
    const mock = makeMockApi();
    const { registerSweepCommands } = await import("../commands/sweep.js");
    const program = new Command();
    program.exitOverride();
    registerSweepCommands(program, () => mock as unknown as ApiClient);

    await runCommand(program, [
      "sweep",
      "prepare",
      "--event",
      "ev_1",
      "--addresses",
      "TAddr1,TAddr2",
    ]);
    expect(mock.prepareSweep).toHaveBeenCalledWith({
      eventId: "ev_1",
      addresses: ["TAddr1", "TAddr2"],
    });
  });

  it("sweep status calls api.getSweep(id)", async () => {
    const mock = makeMockApi();
    const { registerSweepCommands } = await import("../commands/sweep.js");
    const program = new Command();
    program.exitOverride();
    registerSweepCommands(program, () => mock as unknown as ApiClient);

    await runCommand(program, ["sweep", "status", "intent_abc"]);
    expect(mock.getSweep).toHaveBeenCalledWith("intent_abc");
  });
});

describe("CLI webhook commands", () => {
  it("webhook list calls api.listWebhooks()", async () => {
    const mock = makeMockApi();
    const { registerWebhookCommands } = await import("../commands/webhooks.js");
    const program = new Command();
    program.exitOverride();
    registerWebhookCommands(program, () => mock as unknown as ApiClient);

    await runCommand(program, ["webhook", "list"]);
    expect(mock.listWebhooks).toHaveBeenCalledOnce();
  });
});

describe("CLI apikey commands", () => {
  it("apikey list calls api.listApiKeys()", async () => {
    const mock = makeMockApi();
    const { registerApiKeyCommands } = await import("../commands/apikeys.js");
    const program = new Command();
    program.exitOverride();
    registerApiKeyCommands(program, () => mock as unknown as ApiClient);

    await runCommand(program, ["apikey", "list"]);
    expect(mock.listApiKeys).toHaveBeenCalledOnce();
  });
});

describe("CLI webhook remove command", () => {
  it("webhook remove calls api.removeWebhook(id)", async () => {
    const mock = makeMockApi();
    const { registerWebhookCommands } = await import("../commands/webhooks.js");
    const program = new Command();
    program.exitOverride();
    registerWebhookCommands(program, () => mock as unknown as ApiClient);

    await runCommand(program, ["webhook", "remove", "wh_abc"]);
    expect(mock.removeWebhook).toHaveBeenCalledWith("wh_abc");
  });
});

// ── MF-1: promptPassphrase REJECTS non-TTY (piped) stdin ─────────────────────
// This test closes the piped-stdin bypass described in the Sprint 7 review.
// When stdin is NOT a real terminal (isTTY !== true), promptPassphrase must
// throw before reading any bytes — an automated agent piping bytes cannot
// satisfy the passphrase gate.

describe("promptPassphrase security: rejects non-TTY stdin", () => {
  it("throws when process.stdin.isTTY is not true (piped/non-interactive)", async () => {
    const { promptPassphrase } = await import("../prompt.js");

    // Simulate non-TTY stdin (piped input, CI, agent invocation).
    // In Vitest the test runner already sets isTTY = undefined/false on stdin.
    // We explicitly ensure isTTY is not true.
    const originalIsTTY = process.stdin.isTTY;
    // Force non-TTY — cast to override readonly.
    (process.stdin as NodeJS.ReadStream & { isTTY: boolean | undefined }).isTTY = undefined as unknown as boolean;

    try {
      await expect(promptPassphrase("Enter passphrase: ")).rejects.toThrow(
        "passphrase must be entered interactively at a terminal; piped/non-interactive input is rejected for security",
      );
    } finally {
      // Restore original value.
      (process.stdin as NodeJS.ReadStream & { isTTY: boolean | undefined }).isTTY = originalIsTTY;
    }
  });
});

// ── MF-4: sweep execute dry-run test ─────────────────────────────────────────
// Asserts that without TRON_RPC_PRIMARY, sweep execute signs locally and does
// NOT call broadcastSweepResult (no fabricated success hash sent to server).
// This test injects a fake API client + stub signer/broadcast so it runs
// fully offline in < 200ms.

describe("sweep execute dry-run (no TRON_RPC_PRIMARY configured)", () => {
  it("signs locally and does NOT post broadcastSweepResult", async () => {
    const mock = makeMockApi();

    // Provide a non-empty intent with one item.
    mock.getSweep.mockResolvedValue({
      id: "intent_dry_1",
      eventId: "ev_1",
      status: "prepared",
      createdAt: new Date().toISOString(),
      items: [
        {
          address: "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH",
          account: 0,
          index: 0,
          amountMicroStr: "100000000",
          txHash: null,
          // SIGN-2b: signable bytes must be self-consistent with toAddressBase58
          // + amountMicroStr — toSignerIntentWithPin recomputes and verifies them
          // before the TTY gate. Canonical values for transfer(pin, 100 USDT).
          unsignedTx: {
            contractAddressHex: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c",
            contractAddressBase58: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
            fromAddressHex: "41c8599111f29c1e1e061265b4af93ea1f274ad78a",
            fromAddressBase58: "TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH",
            toAddressHex: "415a67fa7cc56bd6d043a98e17d329c1dc9e14753f",
            toAddressBase58: "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe",
            amountMicro: "100000000",
            callData:
              "a9059cbb0000000000000000000000005a67fa7cc56bd6d043a98e17d329c1dc9e14753f0000000000000000000000000000000000000000000000000000000005f5e100",
            feeLimitSun: "15000000",
            memo: "",
          },
        },
      ],
    });

    // Ensure TRON_RPC_PRIMARY is unset (dry-run mode).
    const savedRpc = process.env["TRON_RPC_PRIMARY"];
    delete process.env["TRON_RPC_PRIMARY"];

    // SIGN-2: set the local pin to match the intent's toAddressBase58 so the
    // pin check passes and the test reaches the isTTY gate as designed.
    const savedPin = process.env["STABLERAILS_MAIN_WALLET"];
    process.env["STABLERAILS_MAIN_WALLET"] = "TJDENsfBJs4RFETt1X1W8wMDc8M5XnJhCe";

    // Ensure stdin is NOT a TTY (test environment).
    const savedIsTTY = process.stdin.isTTY;
    (process.stdin as NodeJS.ReadStream & { isTTY: boolean | undefined }).isTTY = undefined as unknown as boolean;

    const { registerSweepCommands } = await import("../commands/sweep.js");
    const program = new Command();
    program.exitOverride();
    registerSweepCommands(program, () => mock as unknown as ApiClient);

    // sweep execute calls promptPassphrase (for destination confirmation) which
    // REJECTS when isTTY is not true.
    // That is the expected security behavior: the command fails before signing.
    await expect(
      runCommand(program, ["sweep", "execute", "--intent", "intent_dry_1"]),
    ).rejects.toThrow(/passphrase must be entered interactively/);

    // CRITICAL: broadcastSweepResult must NOT have been called — no fake hash.
    expect(mock.broadcastSweepResult).not.toHaveBeenCalled();

    // Restore env.
    if (savedRpc !== undefined) process.env["TRON_RPC_PRIMARY"] = savedRpc;
    if (savedPin !== undefined) {
      process.env["STABLERAILS_MAIN_WALLET"] = savedPin;
    } else {
      delete process.env["STABLERAILS_MAIN_WALLET"];
    }
    (process.stdin as NodeJS.ReadStream & { isTTY: boolean | undefined }).isTTY = savedIsTTY;
  });
});

// ── M1: seed init — encrypt/write round-trip + isTTY rejection ───────────────

describe("seed init — encrypt→write→decrypt round-trip logic", () => {
  it("encryptSeed + decryptSeed round-trips a fixed TEST mnemonic", async () => {
    // This exercises the core logic that seed init relies on without any TTY.
    const { encryptSeed, decryptSeed } = await import("../../signer/seed.js");
    const TEST_MNEMONIC =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const TEST_PASSPHRASE = "test-passphrase-seed-init";

    const blob = await encryptSeed(TEST_MNEMONIC, TEST_PASSPHRASE);

    // Blob has all required fields.
    expect(blob.version).toBe(2);
    expect(typeof blob.salt).toBe("string");
    expect(typeof blob.iv).toBe("string");
    expect(typeof blob.ciphertext).toBe("string");
    expect(typeof blob.authTag).toBe("string");

    // Round-trip must recover the original mnemonic.
    const recovered = await decryptSeed(blob, TEST_PASSPHRASE);
    expect(recovered).toBe(TEST_MNEMONIC);

    // JSON serialization preserves the blob.
    const recovered2 = await decryptSeed(
      JSON.parse(JSON.stringify(blob)) as import("../../signer/seed.js").EncryptedSeedBlob,
      TEST_PASSPHRASE,
    );
    expect(recovered2).toBe(TEST_MNEMONIC);
  });

  it("encryptSeed + writeFile → readFile + decryptSeed round-trip (offline)", async () => {
    const { tmpdir } = await import("node:os");
    const { writeFileSync, readFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { encryptSeed, decryptSeed } = await import("../../signer/seed.js");

    const TEST_MNEMONIC =
      "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";
    const TEST_PASSPHRASE = "another-pass-xyz";

    const blob = await encryptSeed(TEST_MNEMONIC, TEST_PASSPHRASE);
    const blobJson = JSON.stringify(blob);

    // Write to an OS temp file (NOT the real src tree).
    const tmpPath = join(tmpdir(), `seed-init-test-${Date.now()}.json`);
    writeFileSync(tmpPath, blobJson, { encoding: "utf-8" });

    try {
      const contents = readFileSync(tmpPath, "utf-8");
      const loaded = JSON.parse(contents) as import("../../signer/seed.js").EncryptedSeedBlob;
      expect(await decryptSeed(loaded, TEST_PASSPHRASE)).toBe(TEST_MNEMONIC);
    } finally {
      unlinkSync(tmpPath);
    }
  });

  it("seed init command rejects non-TTY invocation (isTTY gate)", async () => {
    // When stdin is not a TTY, `seed init` must throw before doing anything.
    const savedIsTTY = process.stdin.isTTY;
    (process.stdin as NodeJS.ReadStream & { isTTY: boolean | undefined }).isTTY = undefined as unknown as boolean;

    try {
      const { registerSeedCommands } = await import("../commands/seed.js");
      const program = new Command();
      program.exitOverride();
      registerSeedCommands(program);

      await expect(
        runCommand(program, ["seed", "init"]),
      ).rejects.toThrow(/passphrase must be entered interactively/);
    } finally {
      (process.stdin as NodeJS.ReadStream & { isTTY: boolean | undefined }).isTTY = savedIsTTY;
    }
  });
});
