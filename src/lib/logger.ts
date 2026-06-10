/**
 * Structured JSON logger with secret scrubbing.
 * Uses process.stdout.write to avoid console noise-in-CI rules.
 * Never interpolates raw values — everything serialized through scrub().
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

// ── Secret scrubbing ─────────────────────────────────────────────────────────

// Patterns that indicate a field contains a secret value.
const SECRET_KEY_PATTERNS: RegExp[] = [
  /key/i,
  /secret/i,
  /token/i,
  /password/i,
  /passwd/i,
  /mnemonic/i,
  /seed/i,
  /private/i,
  /credential/i,
  /auth/i,
  /apikey/i,
];

const REDACTED = "[REDACTED]";
const REDACTED_MAX_DEPTH = "[REDACTED:max-depth]";

// Maximum object traversal depth before we redact instead of returning raw.
const MAX_SCRUB_DEPTH = 20;

// ── Content-based secret detection ───────────────────────────────────────────

/**
 * Returns true if the string value looks like a secret that should be
 * redacted regardless of its key name.
 *
 * Patterns covered:
 *   - API/bearer tokens starting with "sk-" anywhere in the string
 *   - BIP32 extended private/public keys ("xprv" / "xpub") anywhere
 *   - Ethereum-style "0x" + 64 hex chars (private key)
 *   - Raw 64-char hex (no 0x prefix) — raw private key / seed bytes
 *   - BIP39 mnemonic: ≥12 space-separated lowercase a-z words (3–8 chars each)
 */
function isSecretString(value: string): boolean {
  // xprv/xpub/sk- anywhere in the string (un-anchored)
  if (/(xprv|xpub|sk-)/.test(value) && value.length > 20) return true;
  // 0x + 64 hex chars (Ethereum private key)
  if (/0x[0-9a-fA-F]{64}/.test(value)) return true;
  // Raw 64-char hex (bare private key / seed without 0x prefix)
  if (/\b[0-9a-fA-F]{64}\b/.test(value)) return true;
  // BIP39 mnemonic heuristic: ≥12 space-separated lowercase alpha words,
  // each between 3 and 8 characters (BIP39 word list range: 3–8 letters).
  const words = value.trim().split(/\s+/);
  if (
    words.length >= 12 &&
    words.every((w) => /^[a-z]{3,8}$/.test(w))
  ) return true;
  return false;
}

function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Redact secret-looking tokens inside a free-text log message.
 *
 * Unlike scrub() — which replaces a whole string value — this scans the message
 * token-by-token (whitespace-delimited) and replaces only the tokens that match
 * the content-based secret heuristics (64-hex key, 0x-prefixed key, xprv/xpub,
 * sk- token), so the rest of the message survives. A message that is itself a
 * 12+-word mnemonic is redacted entirely (the secret IS the whole message).
 *
 * Performance: a single split + one regex pass per token over the (short) msg
 * string — no deep traversal.
 */
function redactSecretsInMessage(msg: string): string {
  // Token-level pass: split keeps whitespace separators so joins are lossless.
  const out = msg
    .split(/(\s+)/)
    .map((part) =>
      part.length > 0 && !/^\s+$/.test(part) && isSecretString(part) ? REDACTED : part,
    )
    .join("");
  // Whole-message pass: catches mnemonics (no single token matches on its own).
  return isSecretString(out) ? REDACTED : out;
}

export function scrub<T>(value: T, depth = 0): T {
  // Guard against deeply nested / circular objects: redact instead of returning raw.
  if (depth > MAX_SCRUB_DEPTH) return REDACTED_MAX_DEPTH as unknown as T;
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (isSecretString(value)) {
      return REDACTED as unknown as T;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, depth + 1)) as unknown as T;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : scrub(v, depth + 1);
    }
    return out as T;
  }

  return value;
}

// ── Level handling ────────────────────────────────────────────────────────────

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function resolveLogLevel(): LogLevel {
  const env = process.env["LOG_LEVEL"]?.toLowerCase();
  if (env && env in LEVEL_ORDER) return env as LogLevel;
  return "info";
}

// ── Logger ────────────────────────────────────────────────────────────────────

export interface LogRecord {
  level: LogLevel;
  ts: string;
  msg: string;
  [key: string]: unknown;
}

export class Logger {
  readonly name: string;
  readonly minLevel: LogLevel;

  constructor(name: string, minLevel?: LogLevel) {
    this.name = name;
    this.minLevel = minLevel ?? resolveLogLevel();
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel];
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const record: LogRecord = {
      level,
      ts: new Date().toISOString(),
      logger: this.name,
      // The free-text message goes through the same content-based secret
      // heuristics as structured fields — token-wise, so legitimate context
      // around an accidentally interpolated secret is preserved.
      msg: redactSecretsInMessage(msg),
      ...(fields ? scrub(fields) : {}),
    };

    const line = JSON.stringify(record) + "\n";
    if (level === "error" || level === "warn") {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit("debug", msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit("info", msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit("warn", msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit("error", msg, fields);
  }

  child(name: string): Logger {
    return new Logger(`${this.name}:${name}`, this.minLevel);
  }
}

export const rootLogger = new Logger("stablerails");
