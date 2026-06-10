-- DB-3: Canonicalize amountReceived default to "0.000000" (six-decimal form).
--
-- The previous default "0" is functionally equal to "0.000000" for parseMicro
-- but the string comparison `NOT amountReceived = "0.000000"` in the sweepable
-- filter would silently skip rows inserted with the old default.
-- Setting the DB default to the canonical form ensures new rows always match
-- the value-based filter and any string comparison that uses the canonical form.

ALTER TABLE "Invoice" ALTER COLUMN "amountReceived" SET DEFAULT '0.000000';
