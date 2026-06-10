-- Migration: 0000000000001_killswitch
-- Adds the KillSwitch table for DB-backed cross-process kill-switch flags.
-- One row per area ("invoices", "watcher", "webhooks").
-- The admin route upserts rows; isPaused() reads with a short TTL cache.

-- CreateTable
CREATE TABLE "KillSwitch" (
    "area"      TEXT        NOT NULL,
    "paused"    BOOLEAN     NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KillSwitch_pkey" PRIMARY KEY ("area")
);

-- AlterEnum: add 'readonly' to ApiKeyScope
-- (Prisma generates ALTER TYPE for enum changes)
ALTER TYPE "ApiKeyScope" ADD VALUE IF NOT EXISTS 'readonly';
