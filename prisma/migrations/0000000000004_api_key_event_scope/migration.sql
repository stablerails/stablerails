-- Optional event ownership scope for API keys.
ALTER TABLE "ApiKey"
  ADD COLUMN "eventId" TEXT;

CREATE INDEX "ApiKey_eventId_idx"
  ON "ApiKey"("eventId");

ALTER TABLE "ApiKey"
  ADD CONSTRAINT "ApiKey_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
