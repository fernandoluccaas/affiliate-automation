ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'WHATSAPP_CLOUD_API';
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'WHATSAPP_GROUPS_API';
ALTER TYPE "PublicationStatus" ADD VALUE IF NOT EXISTS 'EXPORTED';
ALTER TYPE "PublicationStatus" ADD VALUE IF NOT EXISTS 'PUBLICATION_FAILED';
ALTER TYPE "PublicationAttemptStatus" ADD VALUE IF NOT EXISTS 'EXPORTED';

ALTER TABLE "Channel" ADD COLUMN "configuration" JSONB;
ALTER TABLE "Channel" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'America/Fortaleza';
ALTER TABLE "Channel" ADD COLUMN "dailyPublicationLimit" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "Channel" ADD COLUMN "minimumIntervalMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "Channel" ADD COLUMN "allowedStartTime" TEXT;
ALTER TABLE "Channel" ADD COLUMN "allowedEndTime" TEXT;
ALTER TABLE "Channel" ADD COLUMN "minimumScore" INTEGER NOT NULL DEFAULT 70;
ALTER TABLE "Channel" ADD COLUMN "productRepeatIntervalDays" INTEGER NOT NULL DEFAULT 7;

UPDATE "Channel"
SET
  "dailyPublicationLimit" = "dailyLimit",
  "minimumIntervalMinutes" = "minIntervalMinutes",
  "minimumScore" = "minScore",
  "productRepeatIntervalDays" = "minRepeatDays";

ALTER TABLE "AffiliateLink" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "Publication" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "Publication" ADD COLUMN "errorMessage" TEXT;

UPDATE "Publication"
SET "idempotencyKey" = CONCAT('legacy:', "channelId", ':', "offerId", ':', "id")
WHERE "idempotencyKey" IS NULL;

ALTER TABLE "Publication" ALTER COLUMN "idempotencyKey" SET NOT NULL;
CREATE UNIQUE INDEX "Publication_idempotencyKey_key" ON "Publication"("idempotencyKey");

ALTER TABLE "PublicationAttempt" ADD COLUMN "attemptNumber" INTEGER NOT NULL DEFAULT 1;
