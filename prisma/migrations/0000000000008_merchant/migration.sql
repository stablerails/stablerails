-- Migration: 0000000000008_merchant
-- Adds the Merchant table for hosted v1 self-serve merchant onboarding
-- (STABLERAILS_HOSTED_SIGNUP=1 feature).
--
-- Existing ApiKey.merchantId and Event.merchantId string columns already
-- reference tenant ids for new signups by value — no FK constraint added here
-- so legacy string tenants keep working without referential-integrity errors.
--
-- The `status` enum controls active/suspended state for future enforcement.

-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('active', 'suspended');

-- CreateTable
CREATE TABLE "Merchant" (
    "id"           TEXT           NOT NULL,
    "email"        TEXT           NOT NULL,
    "passwordHash" TEXT           NOT NULL,
    "status"       "MerchantStatus" NOT NULL DEFAULT 'active',
    "createdAt"    TIMESTAMP(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_email_key" ON "Merchant"("email");
