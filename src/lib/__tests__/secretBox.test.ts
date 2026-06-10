/**
 * Tests for src/lib/secretBox.ts — at-rest envelope encryption (AES-256-GCM)
 * for webhook HMAC secrets.
 *
 * Fully offline. The STABLERAILS_DATA_KEY env var is saved/restored around every
 * test so other test files are unaffected.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  sealSecret,
  openSecret,
  isEncrypted,
  SecretBoxError,
  ENC_PREFIX,
} from "../secretBox.js";

// 32-byte (64 hex chars) test data keys.
const DATA_KEY_A = "a".repeat(64);
const DATA_KEY_B = "b".repeat(64);

const ENV_NAME = "STABLERAILS_DATA_KEY";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_NAME];
  delete process.env[ENV_NAME];
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_NAME];
  } else {
    process.env[ENV_NAME] = savedEnv;
  }
});

// ── isEncrypted() ─────────────────────────────────────────────────────────────

describe("isEncrypted()", () => {
  it("returns true for enc:v1:-prefixed values", () => {
    expect(isEncrypted("enc:v1:abc:def:ghi")).toBe(true);
  });

  it("returns false for plaintext values", () => {
    expect(isEncrypted("my-plain-webhook-secret")).toBe(false);
    expect(isEncrypted("")).toBe(false);
    expect(isEncrypted("enc:v2:something")).toBe(false);
  });
});

// ── Round trip with data key set ──────────────────────────────────────────────

describe("sealSecret() / openSecret() — round trip", () => {
  it("encrypts and decrypts back to the original plaintext", () => {
    process.env[ENV_NAME] = DATA_KEY_A;
    const plaintext = "a-strong-webhook-secret-0123456789";

    const stored = sealSecret(plaintext);
    expect(stored).not.toBe(plaintext);
    expect(isEncrypted(stored)).toBe(true);
    expect(stored.startsWith(ENC_PREFIX)).toBe(true);
    // Format: enc:v1:<b64 iv>:<b64 ciphertext>:<b64 tag>
    expect(stored.slice(ENC_PREFIX.length).split(":")).toHaveLength(3);

    expect(openSecret(stored)).toBe(plaintext);
  });

  it("uses a fresh random IV per encryption (two seals differ)", () => {
    process.env[ENV_NAME] = DATA_KEY_A;
    const plaintext = "same-secret-sealed-twice";
    const a = sealSecret(plaintext);
    const b = sealSecret(plaintext);
    expect(a).not.toBe(b);
    // Both still decrypt correctly
    expect(openSecret(a)).toBe(plaintext);
    expect(openSecret(b)).toBe(plaintext);
  });
});

// ── No data key: plaintext passthrough (legacy behaviour) ─────────────────────

describe("no STABLERAILS_DATA_KEY — plaintext passthrough", () => {
  it("sealSecret returns the plaintext unchanged", () => {
    const plaintext = "legacy-plaintext-secret-123456";
    expect(sealSecret(plaintext)).toBe(plaintext);
  });

  it("openSecret passes plaintext through unchanged", () => {
    expect(openSecret("legacy-plaintext-secret-123456")).toBe(
      "legacy-plaintext-secret-123456",
    );
  });

  it("openSecret fails closed on an encrypted value when the key is missing", () => {
    process.env[ENV_NAME] = DATA_KEY_A;
    const stored = sealSecret("secret-needing-a-key-12345");
    delete process.env[ENV_NAME];
    expect(() => openSecret(stored)).toThrow(SecretBoxError);
  });
});

// ── Lazy migration: plaintext rows keep working with key set ──────────────────

describe("lazy migration", () => {
  it("openSecret returns plaintext legacy rows as-is even when a key is set", () => {
    process.env[ENV_NAME] = DATA_KEY_A;
    expect(openSecret("old-plaintext-row-secret-9876")).toBe(
      "old-plaintext-row-secret-9876",
    );
  });
});

// ── Tamper / wrong key: fail closed ───────────────────────────────────────────

describe("tamper resistance — fail closed", () => {
  it("throws SecretBoxError when the ciphertext is tampered", () => {
    process.env[ENV_NAME] = DATA_KEY_A;
    const stored = sealSecret("tamper-me-secret-0123456789");
    const parts = stored.slice(ENC_PREFIX.length).split(":");
    // Flip bits in the ciphertext segment
    const ct = Buffer.from(parts[1]!, "base64");
    ct[0] = ct[0]! ^ 0xff;
    const tampered = `${ENC_PREFIX}${parts[0]}:${ct.toString("base64")}:${parts[2]}`;
    expect(() => openSecret(tampered)).toThrow(SecretBoxError);
  });

  it("throws SecretBoxError when decrypting with the wrong key", () => {
    process.env[ENV_NAME] = DATA_KEY_A;
    const stored = sealSecret("sealed-under-key-A-0123456789");
    process.env[ENV_NAME] = DATA_KEY_B;
    expect(() => openSecret(stored)).toThrow(SecretBoxError);
  });

  it("throws SecretBoxError on a structurally malformed envelope", () => {
    process.env[ENV_NAME] = DATA_KEY_A;
    expect(() => openSecret("enc:v1:only-one-part")).toThrow(SecretBoxError);
    expect(() => openSecret("enc:v1:a:b")).toThrow(SecretBoxError);
  });
});

// ── Malformed data key ────────────────────────────────────────────────────────

describe("malformed STABLERAILS_DATA_KEY", () => {
  it("rejects a key with the wrong length", () => {
    process.env[ENV_NAME] = "abcd1234"; // too short
    expect(() => sealSecret("some-secret-0123456789")).toThrow(/STABLERAILS_DATA_KEY/);
  });

  it("rejects a non-hex key of the right length", () => {
    process.env[ENV_NAME] = "z".repeat(64);
    expect(() => sealSecret("some-secret-0123456789")).toThrow(/STABLERAILS_DATA_KEY/);
  });

  it("rejects a malformed key on the decrypt path too", () => {
    process.env[ENV_NAME] = DATA_KEY_A;
    const stored = sealSecret("sealed-then-key-broken-123456");
    process.env[ENV_NAME] = "not-hex";
    expect(() => openSecret(stored)).toThrow(/STABLERAILS_DATA_KEY/);
  });
});
