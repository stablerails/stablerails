-- Persistent invoice creation idempotency cache.
CREATE TABLE "InvoiceIdempotency" (
  "id" TEXT NOT NULL,
  "apiKeyId" TEXT,
  "scopeKey" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "responseBody" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InvoiceIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvoiceIdempotency_scopeKey_idempotencyKey_key"
  ON "InvoiceIdempotency"("scopeKey", "idempotencyKey");

CREATE INDEX "InvoiceIdempotency_expiresAt_idx"
  ON "InvoiceIdempotency"("expiresAt");

ALTER TABLE "InvoiceIdempotency"
  ADD CONSTRAINT "InvoiceIdempotency_apiKeyId_fkey"
  FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
