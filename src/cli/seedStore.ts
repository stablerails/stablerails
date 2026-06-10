/**
 * Load the encrypted seed blob from the environment / local config.
 *
 * The operator stores the encrypted seed blob as JSON in one of:
 *   1. STABLERAILS_ENCRYPTED_SEED env var (JSON string of EncryptedSeedBlob)
 *   2. STABLERAILS_SEED_FILE env var (path to a JSON file containing the blob)
 *
 * The blob is produced by the `seed init` command (not yet implemented — see
 * the Stablerails operator setup guide). It is safe to commit the encrypted blob
 * (passphrase-gated AES-256-GCM + Argon2id), but operators should keep it
 * in a local file rather than in env vars for better secret hygiene.
 */

import { readFileSync } from "node:fs";
import type { EncryptedSeedBlob } from "../signer/seed.js";

/**
 * Load the EncryptedSeedBlob from the environment.
 *
 * @throws If neither STABLERAILS_ENCRYPTED_SEED nor STABLERAILS_SEED_FILE is set,
 *         or if the blob cannot be parsed.
 */
export function encryptedSeedFromEnv(): EncryptedSeedBlob {
  const inlineJson = process.env["STABLERAILS_ENCRYPTED_SEED"];
  if (inlineJson) {
    try {
      return JSON.parse(inlineJson) as EncryptedSeedBlob;
    } catch {
      throw new Error(
        "STABLERAILS_ENCRYPTED_SEED is set but could not be parsed as JSON",
      );
    }
  }

  const seedFile = process.env["STABLERAILS_SEED_FILE"];
  if (seedFile) {
    try {
      const contents = readFileSync(seedFile, "utf-8");
      return JSON.parse(contents) as EncryptedSeedBlob;
    } catch (err) {
      throw new Error(
        `Could not read seed file at ${seedFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  throw new Error(
    "Encrypted seed not found. Set STABLERAILS_ENCRYPTED_SEED (JSON) or STABLERAILS_SEED_FILE (path to JSON file).",
  );
}
