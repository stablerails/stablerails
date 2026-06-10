/**
 * At-rest envelope encryption for short secrets (AES-256-GCM).
 *
 * Threat model: a read-only DB compromise must not yield usable webhook HMAC
 * secrets (an attacker with `WebhookEndpoint.secret` could forge "paid"
 * webhook signatures). Secrets are sealed under a server-held 32-byte data
 * key (`STABLERAILS_DATA_KEY`, 64 hex chars) before persisting.
 *
 * Storage format (single string, fits the existing `secret` column):
 *   enc:v1:<base64(iv)>:<base64(ciphertext)>:<base64(authTag)>
 *
 * Backward compatibility / lazy migration:
 *   - `STABLERAILS_DATA_KEY` unset → sealSecret() returns the plaintext as-is
 *     (today's behaviour) and logs a single warning the first time.
 *   - openSecret() passes plaintext legacy values through unchanged; only
 *     `enc:v1:` values are decrypted — old rows keep working.
 *   - Decrypt failure (wrong key / tampered ciphertext) throws SecretBoxError:
 *     fail closed, never sign with the raw stored value.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { rootLogger } from "./logger.js";
import { validateOptionalHexKey32 } from "./envValidation.js";

const log = rootLogger.child("secret-box");

export const ENC_PREFIX = "enc:v1:";
const DATA_KEY_ENV = "STABLERAILS_DATA_KEY";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

/** True if the stored value is in the `enc:v1:` envelope format. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

/**
 * Read the data key from the environment (lazily, per call — env can be
 * stubbed in tests). Returns null when unset (feature disabled); throws a
 * clear error when set but malformed (wrong length / non-hex).
 */
function loadDataKey(): Buffer | null {
  const hex = validateOptionalHexKey32(process.env[DATA_KEY_ENV], DATA_KEY_ENV);
  return hex === null ? null : Buffer.from(hex, "hex");
}

// One-time warning when storing plaintext secrets without a data key.
let warnedPlaintextStorage = false;

/**
 * Seal a secret for storage.
 *
 * - Data key set: AES-256-GCM with a fresh random 12-byte IV per call.
 * - Data key unset: returns the plaintext unchanged (legacy behaviour) and
 *   logs a single warning.
 */
export function sealSecret(plaintext: string): string {
  const key = loadDataKey();
  if (key === null) {
    if (!warnedPlaintextStorage) {
      warnedPlaintextStorage = true;
      log.warn(
        `${DATA_KEY_ENV} is not set — webhook secrets are stored in PLAINTEXT. ` +
          "Set a 64-hex-char data key to enable encryption at rest.",
      );
    }
    return plaintext;
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${ciphertext.toString("base64")}:${authTag.toString("base64")}`;
}

/**
 * Open a stored secret.
 *
 * - Plaintext legacy values (no `enc:v1:` prefix) are returned as-is.
 * - `enc:v1:` values are decrypted with the data key; the GCM auth tag is
 *   verified, so any tampering or a wrong key throws SecretBoxError
 *   (fail closed — callers must never use the raw stored value on failure).
 */
export function openSecret(stored: string): string {
  if (!isEncrypted(stored)) {
    return stored; // legacy plaintext row — lazy migration
  }

  const key = loadDataKey();
  if (key === null) {
    throw new SecretBoxError(
      `Encrypted secret found but ${DATA_KEY_ENV} is not set — cannot decrypt`,
    );
  }

  const parts = stored.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) {
    throw new SecretBoxError("Malformed encrypted secret: expected iv:ciphertext:authTag");
  }
  const iv = Buffer.from(parts[0]!, "base64");
  const ciphertext = Buffer.from(parts[1]!, "base64");
  const authTag = Buffer.from(parts[2]!, "base64");
  if (iv.length !== IV_BYTES) {
    throw new SecretBoxError(`Malformed encrypted secret: IV must be ${IV_BYTES} bytes`);
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new SecretBoxError(`Malformed encrypted secret: auth tag must be ${AUTH_TAG_BYTES} bytes`);
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // GCM auth failure: wrong key or tampered ciphertext. Never fall back.
    throw new SecretBoxError("Secret decryption failed: wrong data key or tampered ciphertext");
  }
}
