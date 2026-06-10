CREATE TYPE "InvoiceIdempotencyState" AS ENUM ('processing', 'completed');

ALTER TABLE "InvoiceIdempotency"
  ADD COLUMN "state" "InvoiceIdempotencyState" NOT NULL DEFAULT 'completed',
  ALTER COLUMN "statusCode" DROP NOT NULL,
  ALTER COLUMN "responseBody" DROP NOT NULL,
  ADD COLUMN "processingExpiresAt" TIMESTAMP(3);

CREATE INDEX "InvoiceIdempotency_state_processingExpiresAt_idx"
  ON "InvoiceIdempotency"("state", "processingExpiresAt");

ALTER TABLE "WebhookDelivery"
  ADD COLUMN "claimToken" TEXT,
  ADD COLUMN "claimedAt" TIMESTAMP(3),
  ADD COLUMN "claimExpiresAt" TIMESTAMP(3);

CREATE INDEX "WebhookDelivery_status_nextAttemptAt_claimExpiresAt_idx"
  ON "WebhookDelivery"("status", "nextAttemptAt", "claimExpiresAt");

CREATE INDEX "WebhookDelivery_claimToken_idx"
  ON "WebhookDelivery"("claimToken");
