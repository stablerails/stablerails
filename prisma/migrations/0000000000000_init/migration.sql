-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('pending', 'payment_detected', 'paid', 'underpaid', 'overpaid', 'expired', 'canceled', 'overdue');

-- CreateEnum
CREATE TYPE "Network" AS ENUM ('TRON');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('detected', 'confirmed', 'orphaned');

-- CreateEnum
CREATE TYPE "ApiKeyScope" AS ENUM ('admin', 'merchant');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'delivered', 'failed', 'dead');

-- CreateEnum
CREATE TYPE "SweepIntentStatus" AS ENUM ('prepared', 'partially_broadcast', 'broadcast', 'confirmed', 'failed');

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'active',
    "mainWalletAddress" TEXT NOT NULL,
    "derivationAccount" INTEGER NOT NULL,
    "xpubAccount" TEXT NOT NULL,
    "nextInvoiceIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'pending',
    "priceFiat" TEXT NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "amountUsdt" TEXT NOT NULL,
    "amountReceived" TEXT NOT NULL DEFAULT '0',
    "rateLockedAt" TIMESTAMP(3) NOT NULL,
    "network" "Network" NOT NULL DEFAULT 'TRON',
    "depositAddress" TEXT NOT NULL,
    "derivationIndex" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "network" "Network" NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "amountUsdt" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'detected',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "hashedKey" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scope" "ApiKeyScope" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "eventId" TEXT,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "invoiceId" TEXT,
    "payload" JSONB NOT NULL,
    "eventUid" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainCursor" (
    "network" "Network" NOT NULL,
    "lastScannedBlock" BIGINT NOT NULL,
    "lastSolidBlock" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChainCursor_pkey" PRIMARY KEY ("network")
);

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SweepIntent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "SweepIntentStatus" NOT NULL DEFAULT 'prepared',
    "items" JSONB NOT NULL,
    "destination" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "SweepIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Event_derivationAccount_key" ON "Event"("derivationAccount");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_depositAddress_key" ON "Invoice"("depositAddress");

-- CreateIndex
CREATE INDEX "Invoice_eventId_status_idx" ON "Invoice"("eventId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_eventId_derivationIndex_key" ON "Invoice"("eventId", "derivationIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_network_txHash_logIndex_key" ON "Payment"("network", "txHash", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_hashedKey_key" ON "ApiKey"("hashedKey");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_eventUid_key" ON "WebhookDelivery"("eventUid");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_invoiceId_endpointId_version_key" ON "WebhookDelivery"("invoiceId", "endpointId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Operator_email_key" ON "Operator"("email");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SweepIntent" ADD CONSTRAINT "SweepIntent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
