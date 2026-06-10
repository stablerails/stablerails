/**
 * Magic-link login token minting (shared by `stablerails init` and
 * `stablerails operator login-link`).
 *
 * SECURITY:
 *   - Raw token: 32 random bytes (256-bit), hex-encoded — appears ONLY in the
 *     returned URL. It is never persisted and never passed to the logger
 *     (callers print via process.stdout/stderr directly).
 *   - The DB stores only the SHA-256 hash of the token.
 *   - 15-minute TTL; the server consumes tokens single-use and atomically
 *     (see GET /auth/magic in src/server/routes/auth.ts).
 */

import { createHash, randomBytes } from "node:crypto";

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Minimal write port — backed by Prisma in the CLI, in-memory in tests. */
export interface LoginTokenWriter {
  createLoginToken(input: {
    tokenHash: string;
    operatorId: string;
    expiresAt: Date;
  }): Promise<void>;
}

export interface MintedLoginLink {
  /** Clickable URL containing the RAW token — print once, never log. */
  url: string;
  expiresAt: Date;
}

/** Build the magic-link URL from a base public URL and a raw token. */
export function buildMagicLinkUrl(publicUrl: string, rawToken: string): string {
  const base = publicUrl.replace(/\/+$/, "");
  return `${base}/auth/magic?token=${rawToken}`;
}

/**
 * Mint a fresh single-use login token: 32 random bytes, store SHA-256 hash
 * with a 15-minute expiry, return the clickable URL.
 */
export async function mintLoginLink(
  db: LoginTokenWriter,
  operatorId: string,
  publicUrl: string,
  now: Date = new Date(),
): Promise<MintedLoginLink> {
  const rawToken = randomBytes(32).toString("hex"); // 256-bit
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(now.getTime() + LOGIN_TOKEN_TTL_MS);
  await db.createLoginToken({ tokenHash, operatorId, expiresAt });
  return { url: buildMagicLinkUrl(publicUrl, rawToken), expiresAt };
}
