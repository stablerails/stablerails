-- Migration: 0000000000007_login_token
-- Adds the LoginToken table for magic-link dashboard auth.
--
-- SECURITY:
--   - Only the SHA-256 hash of the raw 256-bit token is stored (tokenHash).
--   - Tokens are single-use: GET /auth/magic consumes them with an atomic
--     guarded UPDATE (usedAt IS NULL AND expiresAt > now) — replay-safe.
--   - 15-minute TTL set at mint time (`stablerails init` / `operator login-link`).
--   - Cascade delete: removing an operator invalidates all their tokens.

-- CreateTable
CREATE TABLE "LoginToken" (
    "id"         TEXT         NOT NULL,
    "tokenHash"  TEXT         NOT NULL,
    "operatorId" TEXT         NOT NULL,
    "expiresAt"  TIMESTAMP(3) NOT NULL,
    "usedAt"     TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoginToken_tokenHash_key" ON "LoginToken"("tokenHash");

-- CreateIndex (expiry sweep / housekeeping queries)
CREATE INDEX "LoginToken_expiresAt_idx" ON "LoginToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "LoginToken" ADD CONSTRAINT "LoginToken_operatorId_fkey"
    FOREIGN KEY ("operatorId") REFERENCES "Operator"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
