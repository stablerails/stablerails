import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { scrub, Logger } from "../logger.js";

describe("logger.ts — scrub()", () => {
  it("does not alter plain strings", () => {
    expect(scrub("hello world")).toBe("hello world");
  });

  it("does not alter numbers or booleans", () => {
    expect(scrub(42)).toBe(42);
    expect(scrub(true)).toBe(true);
  });

  it("does not alter null/undefined", () => {
    expect(scrub(null)).toBeNull();
    expect(scrub(undefined)).toBeUndefined();
  });

  it("redacts sensitive keys in objects", () => {
    const obj = {
      apiKey: "secret-value",
      password: "hunter2",
      token: "Bearer abc123",
      mnemonic: "word1 word2 word3",
      username: "alice",
      amount: "1.000000",
    };
    const result = scrub(obj);
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.password).toBe("[REDACTED]");
    expect(result.token).toBe("[REDACTED]");
    expect(result.mnemonic).toBe("[REDACTED]");
    // Non-sensitive fields preserved
    expect(result.username).toBe("alice");
    expect(result.amount).toBe("1.000000");
  });

  it("redacts nested sensitive keys", () => {
    const obj = {
      config: {
        apiKey: "secret",
        host: "localhost",
      },
    };
    const result = scrub(obj);
    expect(result.config.apiKey).toBe("[REDACTED]");
    expect(result.config.host).toBe("localhost");
  });

  it("redacts xprv/xpub strings by content", () => {
    const result = scrub("xprv9s21ZrQH143K3abcdefg1234567890abcdefg1234567890abcdef");
    expect(result).toBe("[REDACTED]");
  });

  it("redacts xprv even when mid-string (un-anchored match)", () => {
    expect(scrub("prefix-xprv9s21ZrQH143K3abcdefg1234567890-suffix")).toBe("[REDACTED]");
  });

  it("redacts sk- even when mid-string (un-anchored match)", () => {
    expect(scrub("Bearer sk-abc1234567890xyz_extra_padding_here")).toBe("[REDACTED]");
  });

  it("redacts 0x + 64 hex chars (private key pattern)", () => {
    const privKey = "0x" + "a".repeat(64);
    expect(scrub(privKey)).toBe("[REDACTED]");
  });

  it("redacts bare 64-char hex string (raw private key without 0x prefix)", () => {
    const rawKey = "a".repeat(64);
    expect(scrub(rawKey)).toBe("[REDACTED]");
  });

  it("does NOT redact short hex strings (not 64 chars)", () => {
    const shortHex = "deadbeef";
    expect(scrub(shortHex)).toBe("deadbeef");
  });

  it("redacts a 12-word BIP39 mnemonic", () => {
    const mnemonic =
      "abandon ability able about above absent absorb abstract absurd abuse access accident";
    expect(scrub(mnemonic)).toBe("[REDACTED]");
  });

  it("redacts a 24-word BIP39 mnemonic", () => {
    const mnemonic = Array(24).fill("abandon").join(" ");
    expect(scrub(mnemonic)).toBe("[REDACTED]");
  });

  it("does NOT redact an 11-word phrase (below BIP39 threshold)", () => {
    const phrase = Array(11).fill("word").join(" ");
    expect(scrub(phrase)).toBe(phrase);
  });

  it("does NOT redact plain English sentences even if long", () => {
    // "the" is 3 chars, "quick" 5, "brown" 5, "fox" 3, "jumps" 5, "over" 4,
    // "the" 3, "lazy" 4, "dog" 3 = 9 words — below the 12-word threshold.
    const sentence = "the quick brown fox jumps over the lazy dog";
    expect(scrub(sentence)).toBe(sentence);
  });

  it("returns [REDACTED:max-depth] at depth limit instead of raw value", () => {
    // Call scrub() with a depth already beyond the limit.
    // Cast via (v: unknown, d: number) => unknown to avoid relying on overloads.
    const result = (scrub as (v: unknown, d: number) => unknown)("sensitive-raw-value", 21);
    expect(result).toBe("[REDACTED:max-depth]");
  });

  it("handles arrays by scrubbing elements", () => {
    const arr = [{ apiKey: "secret" }, { name: "safe" }];
    const result = scrub(arr);
    expect(result[0].apiKey).toBe("[REDACTED]");
    expect(result[1].name).toBe("safe");
  });
});

describe("logger.ts — Logger", () => {
  let stdoutLines: string[];
  let stderrLines: string[];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutLines = [];
    stderrLines = [];
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("emits JSON to stdout for info level", () => {
    const logger = new Logger("test", "debug");
    logger.info("test message", { foo: "bar" });

    expect(stdoutLines.length).toBe(1);
    const record = JSON.parse(stdoutLines[0]!);
    expect(record.level).toBe("info");
    expect(record.msg).toBe("test message");
    expect(record.foo).toBe("bar");
    expect(record.logger).toBe("test");
    expect(typeof record.ts).toBe("string");
  });

  it("emits to stderr for error level", () => {
    const logger = new Logger("test", "debug");
    logger.error("something broke");

    expect(stderrLines.length).toBe(1);
    const record = JSON.parse(stderrLines[0]!);
    expect(record.level).toBe("error");
  });

  it("emits to stderr for warn level", () => {
    const logger = new Logger("test", "debug");
    logger.warn("watch out");
    expect(stderrLines.length).toBe(1);
  });

  it("suppresses debug messages when minLevel is info", () => {
    const logger = new Logger("test", "info");
    logger.debug("debug msg");
    expect(stdoutLines.length).toBe(0);
  });

  it("redacts sensitive fields in emitted records", () => {
    const logger = new Logger("test", "info");
    logger.info("user action", { apiKey: "super-secret", action: "login" });

    const record = JSON.parse(stdoutLines[0]!);
    expect(record.apiKey).toBe("[REDACTED]");
    expect(record.action).toBe("login");
  });

  it("child logger prefixes parent name", () => {
    const parent = new Logger("parent", "info");
    const child = parent.child("worker");
    child.info("hello");

    const record = JSON.parse(stdoutLines[0]!);
    expect(record.logger).toBe("parent:worker");
  });

  // ── Free-text msg redaction (content-based heuristics on the message) ──────

  it("redacts a 64-hex token inside msg, keeping the rest of the message", () => {
    const logger = new Logger("test", "info");
    const hexKey = "a".repeat(64);
    logger.info(`imported key ${hexKey} successfully`);

    const record = JSON.parse(stdoutLines[0]!);
    expect(record.msg).toBe("imported key [REDACTED] successfully");
    expect(record.msg).not.toContain(hexKey);
  });

  it("redacts a 0x-prefixed private key token inside msg", () => {
    const logger = new Logger("test", "info");
    const privKey = "0x" + "b".repeat(64);
    logger.info(`signing with ${privKey} failed`);

    const record = JSON.parse(stdoutLines[0]!);
    expect(record.msg).toBe("signing with [REDACTED] failed");
  });

  it("redacts an sk- token inside msg", () => {
    const logger = new Logger("test", "info");
    logger.info("auth failed for sk-abc1234567890xyz_padding token");

    const record = JSON.parse(stdoutLines[0]!);
    expect(record.msg).toBe("auth failed for [REDACTED] token");
  });

  it("redacts the whole msg when it is a bare 12-word mnemonic", () => {
    const logger = new Logger("test", "info");
    logger.info(Array(12).fill("abandon").join(" "));

    const record = JSON.parse(stdoutLines[0]!);
    expect(record.msg).toBe("[REDACTED]");
  });

  it("leaves normal messages unchanged", () => {
    const logger = new Logger("test", "info");
    logger.info("invoice status changed");

    const record = JSON.parse(stdoutLines[0]!);
    expect(record.msg).toBe("invoice status changed");
  });
});
