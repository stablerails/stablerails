-- Migration: 0000000000003_multi_merchant
-- BOLA fix: multi-merchant tenant isolation.
--
-- Adds nullable merchantId to ApiKey and Event:
--   - ApiKey.merchantId: tenant a merchant/readonly key is confined to.
--     null = legacy single-tenant key (sees only null-tenant resources).
--     Ignored for admin-scope keys.
--   - Event.merchantId: owner tenant of the event. Invoices and sweep intents
--     inherit tenancy through their event (Invoice.eventId → Event.merchantId).
--
-- Additive only: nullable columns, no data backfill. Existing rows stay at
-- NULL ("default tenant") so single-merchant deployments keep working.

ALTER TABLE "ApiKey" ADD COLUMN "merchantId" TEXT;

ALTER TABLE "Event" ADD COLUMN "merchantId" TEXT;

-- Tenant-scoped listing filters on Event.merchantId (directly and via the
-- Invoice → Event join), so index it.
CREATE INDEX "Event_merchantId_idx" ON "Event"("merchantId");
